/* ────────────────────────────────────────────────────────────────────────────
 * Pipeline token report — deterministic, free, local. Reads the agetor
 * sqlite (read-only) to find every pipeline stage / build-child run with a
 * claude session id, then takes its token totals from the `run_usage`
 * table (recorded live by the claude tail, O-10) and falls back to summing
 * `message.usage` out of claude's own JSONL transcript when the table has
 * no row for the run. The JSON report says which per run (`source`). The
 * transcript is still walked when present for tool counts and Read paths.
 * No LLM calls, no network. This is the
 * measurement that docs/plans/pipeline-token-efficiency.md ties every
 * optimisation to: run it before and after a change, compare the columns.
 *
 * Run:  bun run eval:pipeline:tokens
 *       AGETOR_DATA_DIR=~/.agetor bun evals/pipeline/token-report.ts
 *       bun evals/pipeline/token-report.ts --parent <task-id-prefix>
 *
 * Output: a per-stage table + per-pipeline totals on stdout, and a JSON
 * report at evals/pipeline/token-report.json (gitignored).
 *
 * The pure functions (classifyStage, summarizeTranscript, aggregate) are
 * exported and gate-tested in token-report.test.ts; only main() touches IO.
 * ──────────────────────────────────────────────────────────────────────────── */

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── pure: stage classification ──────────────────────────────────────────────

/** Stage label for a run, derived from the FIRST user event's text (the
 *  stage prompt opens with a fixed "You are the <Role>" sentence — see
 *  pipeline-prompts.ts) and the run's origin. Children are classified by
 *  their parent link, not their prompt. */
export type StageLabel =
  | "specify" | "clarify" | "planning" | "plan-review" | "decompose"
  | "building(fixup)" | "code-review" | "testing" | "merge-resolution"
  | "child-build" | "continuation" | "conversation";

const ROLE_TO_STAGE: Array<[string, StageLabel]> = [
  ["Spec Author", "specify"],
  ["Clarifier", "clarify"],
  ["Planner", "planning"],
  ["Critic", "plan-review"],
  ["Decomposer", "decompose"],
  ["Builder", "building(fixup)"],
  ["Code Reviewer", "code-review"],
  ["Tester", "testing"],
];

export function classifyStage(
  firstUserText: string,
  ctx: { isChild: boolean; origin: string | null },
): StageLabel {
  if (ctx.isChild) return "child-build";
  if (ctx.origin === "pipeline-merge" || firstUserText.startsWith("A git merge is IN PROGRESS")) return "merge-resolution";
  for (const [role, stage] of ROLE_TO_STAGE) {
    if (firstUserText.startsWith(`You are the ${role}`)) return stage;
  }
  if (ctx.origin === "continuation") return "continuation";
  return "conversation";
}

// ─── pure: transcript summarisation ──────────────────────────────────────────

export interface TranscriptSummary {
  /** Distinct API messages (dedup on message.id — claude writes one JSONL
   *  line per content block, so the same usage block repeats). */
  messages: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** input + cacheWrite + cacheRead summed over every message: the total
   *  context the model actually processed. THE number to minimise. */
  context: number;
  /** Context of the first API message: the fixed per-session bootstrap
   *  (system prompt + tool schemas + CLAUDE.md + skill listing + prompt). */
  bootstrap: number;
  /** tool_use count by tool name. */
  tools: Record<string, number>;
  /** Files passed to the Read tool (verbatim paths). */
  readPaths: string[];
  /** Bytes of tool_result content fed back into context, by tool name. */
  resultBytes: Record<string, number>;
  models: string[];
}

export function summarizeTranscript(jsonl: string): TranscriptSummary {
  const s: TranscriptSummary = {
    messages: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, context: 0, bootstrap: 0,
    tools: {}, readPaths: [], resultBytes: {}, models: [],
  };
  const seen = new Set<string>();
  const toolById = new Map<string, string>();
  const models = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    const m = j?.message;
    if (j.type === "assistant" && m?.usage && typeof m.id === "string" && !seen.has(m.id)) {
      seen.add(m.id);
      const u = m.usage;
      const input = num(u.input_tokens), cw = num(u.cache_creation_input_tokens), cr = num(u.cache_read_input_tokens);
      const ctx = input + cw + cr;
      if (s.messages === 0) s.bootstrap = ctx;
      s.messages++;
      s.input += input; s.cacheWrite += cw; s.cacheRead += cr; s.output += num(u.output_tokens); s.context += ctx;
      if (typeof m.model === "string") models.add(m.model);
    }
    if (j.type === "assistant" && Array.isArray(m?.content)) {
      for (const c of m.content) {
        if (c?.type !== "tool_use") continue;
        toolById.set(c.id, c.name);
        s.tools[c.name] = (s.tools[c.name] ?? 0) + 1;
        if (c.name === "Read" && typeof c.input?.file_path === "string") s.readPaths.push(c.input.file_path);
      }
    }
    if (j.type === "user" && Array.isArray(m?.content)) {
      for (const c of m.content) {
        if (c?.type !== "tool_result") continue;
        const name = toolById.get(c.tool_use_id) ?? "?";
        const txt = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
        s.resultBytes[name] = (s.resultBytes[name] ?? 0) + Buffer.byteLength(txt);
      }
    }
  }
  s.models = [...models].sort();
  return s;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ─── pure: aggregation ───────────────────────────────────────────────────────

export interface RunRow {
  runId: string;
  taskId: string;
  parentId: string;
  title: string;
  stage: StageLabel;
  status: string;
  promptBytes: number;
  summary: TranscriptSummary;
  /** Where the token numbers came from: the `run_usage` table (O-10, fed
   *  live by the claude tail — survives claude's transcript retention
   *  deleting the JSONL) or a walk of the JSONL transcript (older runs,
   *  pre-migration-043 data). Optional: the pure aggregators never read it. */
  source?: "db" | "jsonl";
}

export interface StageAgg {
  stage: StageLabel;
  runs: number;
  messages: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  context: number;
  bootstrapSum: number;
  share: number;
}

export function aggregateByStage(rows: RunRow[]): StageAgg[] {
  const total = rows.reduce((a, r) => a + r.summary.context, 0) || 1;
  const by = new Map<StageLabel, StageAgg>();
  for (const r of rows) {
    const a = by.get(r.stage) ?? { stage: r.stage, runs: 0, messages: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, context: 0, bootstrapSum: 0, share: 0 };
    a.runs++; a.messages += r.summary.messages; a.input += r.summary.input; a.cacheWrite += r.summary.cacheWrite;
    a.cacheRead += r.summary.cacheRead; a.output += r.summary.output; a.context += r.summary.context; a.bootstrapSum += r.summary.bootstrap;
    by.set(r.stage, a);
  }
  return [...by.values()]
    .map((a) => ({ ...a, share: a.context / total }))
    .sort((x, y) => y.context - x.context);
}

/** Files read by two or more distinct stage-agents inside ONE pipeline
 *  (children count individually — two children reading the same file is
 *  duplicated work). Paths are made worktree-relative so a parent's and a
 *  child's read of the same repo file compare equal. */
export function duplicateReads(rows: RunRow[]): Array<{ path: string; readers: string[] }> {
  const readers = new Map<string, Set<string>>();
  for (const r of rows) {
    const who = r.stage === "child-build" ? `child:${r.taskId.slice(0, 4)}` : r.stage;
    for (const p of r.summary.readPaths) {
      const rel = p.replace(/^.*\/worktrees\/[^/]+\//, "");
      const set = readers.get(rel) ?? new Set();
      set.add(who);
      readers.set(rel, set);
    }
  }
  return [...readers.entries()]
    .filter(([, s]) => s.size >= 2)
    .map(([path, s]) => ({ path, readers: [...s] }))
    .sort((a, b) => b.readers.length - a.readers.length);
}

// ─── IO: main ────────────────────────────────────────────────────────────────

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

async function main(): Promise<void> {
  const { Database } = await import("bun:sqlite");
  const dataDir = process.env.AGETOR_DATA_DIR ?? join(homedir(), ".agetor-dev");
  const args = process.argv.slice(2);
  const onlyParent = args.includes("--parent") ? args[args.indexOf("--parent") + 1] ?? null : null;

  const dbPath = join(dataDir, "agetor.sqlite");
  if (!existsSync(dbPath)) { console.error(`no sqlite at ${dbPath}`); process.exit(2); }
  const db = new Database(dbPath, { readonly: true });

  // Transcripts live under <claude config dir>/projects/<encoded-cwd>/<sid>.jsonl.
  // The config dir is the HARNESS's `home` (agents.ts passes `harness.home`
  // as configDir), defaulting to ~/.claude — NOT this process's own
  // CLAUDE_CONFIG_DIR, which may point at a different account entirely.
  const indexCache = new Map<string, Map<string, string>>();
  function jsonlIndex(configDir: string): Map<string, string> {
    let idx = indexCache.get(configDir);
    if (idx) return idx;
    idx = new Map();
    const projects = join(configDir, "projects");
    if (existsSync(projects)) {
      for (const dir of readdirSync(projects)) {
        const p = join(projects, dir);
        if (!statSync(p).isDirectory()) continue;
        for (const f of readdirSync(p)) if (f.endsWith(".jsonl")) idx.set(f.slice(0, -6), join(p, f));
      }
    }
    indexCache.set(configDir, idx);
    return idx;
  }

  const runs = db.query(`
    select r.id run_id, r.task_id, r.claude_session_id sid, r.status, r.origin,
           t.title, t.parent_task_id, h.home harness_home
    from runs r join tasks t on t.id = r.task_id
    left join harnesses h on h.id = r.agent
    where (t.pipeline_stage is not null or t.parent_task_id is not null)
      and r.claude_session_id is not null
    order by r.started_at`).all() as Array<{ run_id: string; task_id: string; sid: string; status: string; origin: string | null; title: string; parent_task_id: string | null; harness_home: string | null }>;
  const firstUser = db.query(`select data from run_events where run_id = ? and stream = 'user' order by id limit 1`);

  // Per-run totals recorded live by the claude tail (`run_usage`, migration
  // 043). Preferred over the JSONL walk: they survive claude's transcript
  // retention and cost one indexed read. A pre-043 sqlite has no table —
  // fall back to the walk for every run rather than fail.
  type UsageRow = { messages: number; input: number; cacheWrite: number; cacheRead: number; output: number; bootstrap: number };
  const usageStmt = (() => {
    try {
      return db.query(`select messages, input_tokens input, cache_write_tokens "cacheWrite", cache_read_tokens "cacheRead",
                              output_tokens output, bootstrap_tokens bootstrap from run_usage where run_id = ?`);
    } catch { return null; }
  })();
  const dbUsage = (runId: string): UsageRow | null => (usageStmt?.get(runId) as UsageRow | null) ?? null;

  const rows: RunRow[] = [];
  let missing = 0;
  let fromDb = 0;
  for (const r of runs) {
    const parentId = r.parent_task_id ?? r.task_id;
    if (onlyParent && !parentId.startsWith(onlyParent)) continue;
    const text = (firstUser.get(r.run_id) as { data: string } | null)?.data ?? "";
    const path = jsonlIndex(r.harness_home ?? join(homedir(), ".claude")).get(r.sid);
    const usage = dbUsage(r.run_id);
    if (!path && !usage) { missing++; continue; }
    // The transcript still supplies what the table doesn't hold (tool
    // counts, Read paths for the duplicate-read metric, result bytes);
    // when the table has the run, its token columns win over the walk's.
    const walked = path ? summarizeTranscript(readFileSync(path, "utf8")) : summarizeTranscript("");
    const summary: TranscriptSummary = usage
      ? { ...walked, messages: usage.messages, input: usage.input, cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead,
          output: usage.output, context: usage.input + usage.cacheWrite + usage.cacheRead, bootstrap: usage.bootstrap }
      : walked;
    if (usage) fromDb++;
    rows.push({
      runId: r.run_id, taskId: r.task_id, parentId, title: r.title, status: r.status,
      stage: classifyStage(text, { isChild: r.parent_task_id != null, origin: r.origin }),
      promptBytes: Buffer.byteLength(text),
      summary,
      source: usage ? "db" : "jsonl",
    });
  }

  const agg = aggregateByStage(rows);
  const T = agg.reduce((a, s) => ({ context: a.context + s.context, output: a.output + s.output, messages: a.messages + s.messages, cacheRead: a.cacheRead + s.cacheRead, bootstrap: a.bootstrap + s.bootstrapSum }), { context: 0, output: 0, messages: 0, cacheRead: 0, bootstrap: 0 });

  console.log(`pipeline token report — data ${dataDir}, ${rows.length} runs (${fromDb} from run_usage, ${rows.length - fromDb} from JSONL, ${missing} with neither)\n`);
  console.log("stage            runs  msgs   context      cache-read   output    share  bootstrap/run");
  for (const s of agg) {
    console.log(`${s.stage.padEnd(16)} ${String(s.runs).padStart(4)} ${String(s.messages).padStart(5)}  ${fmt(s.context).padStart(11)}  ${fmt(s.cacheRead).padStart(11)}  ${fmt(s.output).padStart(7)}  ${(s.share * 100).toFixed(1).padStart(5)}%  ${fmt(s.bootstrapSum / s.runs).padStart(8)}`);
  }
  console.log(`${"TOTAL".padEnd(16)} ${String(rows.length).padStart(4)} ${String(T.messages).padStart(5)}  ${fmt(T.context).padStart(11)}  ${fmt(T.cacheRead).padStart(11)}  ${fmt(T.output).padStart(7)}`);
  if (T.messages > 0) {
    const meanBoot = T.bootstrap / Math.max(rows.length, 1);
    console.log(`\nmean bootstrap per session: ${fmt(meanBoot)} tokens; re-read on every message ≈ ${fmt(meanBoot * T.messages)} (${((meanBoot * T.messages) / T.context * 100).toFixed(0)}% of all context)`);
    console.log(`mean context per message:   ${fmt(T.context / T.messages)}`);
  }

  const byParent = new Map<string, RunRow[]>();
  for (const r of rows) byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
  console.log("\nper pipeline:");
  for (const [id, rs] of byParent) {
    const title = (db.query(`select title from tasks where id = ?`).get(id) as { title: string } | null)?.title ?? "?";
    const ctx = rs.reduce((a, r) => a + r.summary.context, 0);
    const msgs = rs.reduce((a, r) => a + r.summary.messages, 0);
    const dups = duplicateReads(rs);
    const distinct = new Set(rs.flatMap((r) => r.summary.readPaths.map((p) => p.replace(/^.*\/worktrees\/[^/]+\//, "")))).size;
    console.log(`  ${id.slice(0, 8)} "${title}"  runs=${rs.length} msgs=${msgs} context=${fmt(ctx)} children=${rs.filter((r) => r.stage === "child-build").length} files-read=${distinct} read-by-2+agents=${dups.length}`);
    for (const d of dups.slice(0, 5)) console.log(`      ${d.readers.length}x ${d.path}`);
  }

  const reportPath = join(import.meta.dir, "token-report.json");
  writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), dataDir, stages: agg, runs: rows.map((r) => ({ ...r, summary: { ...r.summary, readPaths: undefined } })) }, null, 2));
  console.log(`\nreport: ${reportPath}`);
}

if (import.meta.main) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
