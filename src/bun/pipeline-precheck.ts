import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runCheck, type RepoProfile, type CheckName } from "./repo-profile.ts";
import type { PrecheckSummary, PrecheckResult } from "./pipeline-state.ts";

/**
 * Deterministic pre-Tester check (O-5 in docs/plans/pipeline-token-
 * efficiency.md). The Tester stage was 17% of all measured pipeline tokens,
 * most of it an agent discovering how to install and run the project and
 * then reading the full test output. "Does typecheck/lint/test pass" is
 * same-input-same-output work, so agetor runs it itself and hands the
 * Tester only the failures. When everything is green AND every acceptance
 * criterion is referenced from a test file, the Tester turn is skipped
 * outright — the deterministic half already proved what the agent would
 * have been asked to verify.
 *
 * The AC-reference scan is deliberately literal: an `AC-N` id must appear
 * verbatim somewhere under a test path. Conservative on purpose — a spec
 * whose ACs nobody wrote into a test name or assertion still gets a Tester,
 * which is the case where a human-like check earns its tokens.
 */

/** Paths that count as "test files" for the AC-reference scan. */
export const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /_test\.(py|go|rb)$/,
  /(^|\/)test_[^/]+\.py$/,
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "target", "vendor"]);
const MAX_SCAN_FILES = 5000;

/** Pure: which spec AC ids appear in NONE of the given test-file contents. */
export function findUnreferencedAcs(acIds: string[], testFileContents: string[]): string[] {
  const joined = testFileContents.join("\n");
  return acIds.filter((id) => !new RegExp(`\\b${id}\\b`).test(joined));
}

/** Pure: is `rel` (a worktree-relative path) a test file? */
export function isTestPath(rel: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(rel));
}

/** Walk `cwd` for test files (skipping dependency/build dirs) and return
 *  their contents. Bounded by MAX_SCAN_FILES so a pathological tree can't
 *  wedge the settle path. */
export function readTestFiles(cwd: string): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (seen++ > MAX_SCAN_FILES) return;
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (st.size > 2_000_000) continue;
      if (isTestPath(relative(cwd, full))) {
        try { out.push(readFileSync(full, "utf8")); } catch { /* unreadable — skip */ }
      }
    }
  };
  walk(cwd);
  return out;
}

/** Pure: a summary passes when every command that exists succeeded and no
 *  AC is unreferenced. A profile with NO commands at all never passes —
 *  there is nothing deterministic to stand on, so the Tester runs. */
export function precheckPasses(summary: PrecheckSummary): boolean {
  return summary.results.length > 0 && summary.results.every((r) => r.ok) && summary.unreferencedAcs.length === 0;
}

/** Which of a precheck's commands passed — the skip-set `renderProjectCommands` uses to
 *  drop an already-confirmed-green check's runnable line for this Tester turn (Finding 1 /
 *  O-12). */
export function precheckPassedChecks(summary: PrecheckSummary): Set<CheckName> {
  return new Set(summary.results.filter((r) => r.ok).map((r) => r.name));
}

/** Env kill-switch: `AGETOR_PIPELINE_TESTER_SKIP=0` keeps the precheck
 *  (its failures still shrink the Tester's discovery) but never skips the
 *  Tester turn. */
export function testerSkipEnabled(): boolean {
  return process.env.AGETOR_PIPELINE_TESTER_SKIP !== "0";
}

/** Env kill-switch for the whole precheck: `AGETOR_PIPELINE_PRECHECK=0`. */
export function precheckEnabled(): boolean {
  return process.env.AGETOR_PIPELINE_PRECHECK !== "0";
}

export const PRECHECK_TIMEOUT_MS = 15 * 60_000;
export const PRECHECK_TAIL_BYTES = 6000;

/**
 * Run the profile's typecheck, lint and test commands in order (each
 * bounded by `timeoutMs`), then scan test files for the spec's AC ids.
 * Commands the profile doesn't know are simply absent from `results`.
 */
export async function runPipelinePrecheck(opts: {
  cwd: string;
  profile: RepoProfile;
  specAcIds: string[];
  timeoutMs?: number;
  onProgress?: (line: string) => void;
}): Promise<PrecheckSummary> {
  const results: PrecheckResult[] = [];
  const steps: Array<[PrecheckResult["name"], string | null]> = [
    ["typecheck", opts.profile.typecheck],
    ["lint", opts.profile.lint],
    ["test", opts.profile.test],
  ];
  for (const [name, cmd] of steps) {
    if (!cmd) continue;
    opts.onProgress?.(`precheck: running ${name} (${cmd})`);
    const r = await runCheck(opts.cwd, cmd, { timeoutMs: opts.timeoutMs ?? PRECHECK_TIMEOUT_MS, tailBytes: PRECHECK_TAIL_BYTES });
    results.push({ name, cmd, ok: r.ok, exitCode: r.exitCode, tail: r.ok ? "" : r.tail });
    opts.onProgress?.(`precheck: ${name} ${r.ok ? "ok" : `FAILED (exit ${r.exitCode ?? "timeout"})`}`);
  }
  const unreferencedAcs = findUnreferencedAcs(opts.specAcIds, readTestFiles(opts.cwd));
  return { results, unreferencedAcs, ranAt: Date.now() };
}

/** Pure: the block `testingPrompt` renders when a precheck ran. Failing
 *  commands carry their output tail; passing ones are one word each. */
export function renderPrecheck(summary: PrecheckSummary): string {
  const lines: string[] = ["## Pre-run checks (already executed by the pipeline — do not repeat the ones that passed)"];
  for (const r of summary.results) {
    if (r.ok) {
      lines.push(`- ${r.name}: ok (\`${r.cmd}\`)`);
    } else {
      lines.push(`- ${r.name}: FAILED (exit ${r.exitCode ?? "timeout"}) — \`${r.cmd}\`. Last output:`);
      lines.push("```");
      lines.push(r.tail.trimEnd());
      lines.push("```");
    }
  }
  if (summary.unreferencedAcs.length > 0) {
    lines.push(`- Acceptance criteria not mentioned by any test file: ${summary.unreferencedAcs.join(", ")}. Verify each of these yourself (a manual check is fine) and say how.`);
  } else if (summary.results.length > 0) {
    lines.push("- Every AC-N id is referenced from a test file.");
  }
  return lines.join("\n");
}
