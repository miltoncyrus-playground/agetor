/* ────────────────────────────────────────────────────────────────────────────
 * Pipeline prompt evals — the PAID, LLM-calling quality lane (distinct from
 * the free deterministic gate tests in src/bun/*.test.ts).
 *
 * What this measures: whether the REAL pipeline prompts (built by
 * src/bun/pipeline-prompts.ts, verbatim — not test approximations) drive a
 * real claude run to produce artifacts with the properties the pipeline
 * depends on. Generation is latent; every SCORE is deterministic code over
 * the resulting files/git state — no LLM judges, no rubric prompts.
 *
 * Evals:
 *   decompose-files   — decomposePrompt on a fixture SPEC/PLAN produces a
 *                       TASKS.json that parses, declares non-overlapping
 *                       per-subtask `files`, covers every AC, and is
 *                       committed. (The 2dot2dot-redesign conflict class.)
 *   decompose-single  — decomposePrompt on a 2-AC / 2-file fixture emits
 *                       exactly ONE subtask (O-3 right-sizing; the
 *                       "ten children for a colour change" class).
 *   merge-resolution  — mergeResolutionPrompt on a repo with a real parked
 *                       conflicted merge concludes the merge (git-verified
 *                       via isBranchMerged), preserves BOTH sides' intent,
 *                       and lands the branch's other files.
 *   builder-commit    — buildingPrompt implements a one-file plan AND leaves
 *                       the tree committed (the commit-discipline change).
 *
 * Run:  bun run eval:pipeline            (all evals, 1 run each)
 *       bun evals/pipeline/run-evals.ts --only decompose --runs 3
 *       bun evals/pipeline/run-evals.ts --model claude-sonnet-5
 *       bun evals/pipeline/run-evals.ts --effort low --only tester-precheck
 *
 *   tester-precheck   — testingPrompt with a real precheck summary folded in
 *                       (O-5) fixes the failing test it was handed, commits,
 *                       and emits PIPELINE_VERDICT: pass.
 *
 * Pass threshold: every eval run must score >= PASS_THRESHOLD (0.8). The
 * process exits non-zero if any run fails — wire into pre-ship / nightly.
 * A JSON report lands at evals/pipeline/last-report.json (gitignored).
 *
 * Cost note: each eval is one headless `claude -p` call (defaults to
 * claude-opus-5, effort high — same defaults agetor itself runs with).
 * `claude -p` draws from Agent SDK credit (not the interactive subscription
 * quota) as of 2026-06-15 — a handful of calls per nightly run.
 * ──────────────────────────────────────────────────────────────────────────── */

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// MUST precede any import that transitively loads src/bun/db.ts (worktree.ts
// does) — the DB opens and migrates on module load, and without this it
// would open the real ~/.agetor db.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-eval-data-"));

const { stagePrompt, mergeResolutionPrompt, parseBuildPlan, parseSpecAcceptanceCriteria, analyzeCoverage, parsePipelineVerdict } =
  await import("../../src/bun/pipeline-prompts.ts");
const { runPipelinePrecheck } = await import("../../src/bun/pipeline-precheck.ts");
const { readRepoProfile } = await import("../../src/bun/repo-profile.ts");
const { isBranchMerged } = await import("../../src/bun/worktree.ts");
type Task = import("../../src/shared/types.ts").Task;

const PASS_THRESHOLD = 0.8;
const CLAUDE_TIMEOUT_MS = 10 * 60_000;

const args = process.argv.slice(2);
function argValue(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
}
const ONLY = argValue("--only");
const RUNS = Number(argValue("--runs") ?? "1") || 1;
// Best available model by default — same as agetor's own claude-code default.
const MODEL = argValue("--model") ?? "claude-opus-5";
// Effort for every eval call. O-8 tiers verdict stages to "low" and build
// children to "medium" in production; `--effort low` here is how that
// tiering earns its place (the builder/decompose evals must still hold 0.8).
const EFFORT = argValue("--effort") ?? "high";
const CLAUDE_BIN = process.env.AGETOR_CLAUDE_BIN ?? "claude";

// ─── plumbing ────────────────────────────────────────────────────────────────

async function git(cmdArgs: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> {
  const proc = Bun.spawn(["git", ...cmdArgs], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { ok: code === 0, stdout };
}

async function makeRepo(branch: string): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-eval-repo-"));
  await git(["init", "-b", branch], repo);
  await git(["config", "user.email", "eval@agetor.local"], repo);
  await git(["config", "user.name", "agetor-eval"], repo);
  return repo;
}

async function commitAllIn(repo: string, message: string): Promise<void> {
  await git(["add", "-A"], repo);
  await git(["commit", "-m", message], repo);
}

/** One headless claude call with the REAL prompt, tools enabled, in the
 *  fixture repo. Returns stderr+stdout tail for the report on failure. */
async function runClaude(prompt: string, cwd: string): Promise<{ ok: boolean; detail: string; stdout: string }> {
  const proc = Bun.spawn(
    [CLAUDE_BIN, "-p", prompt, "--model", MODEL, "--dangerously-skip-permissions"],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: EFFORT },
    },
  );
  const timer = setTimeout(() => proc.kill(), CLAUDE_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const tail = (stderr || stdout).slice(-500);
  return { ok: code === 0, detail: code === 0 ? "" : `claude exited ${code}: ${tail}`, stdout };
}

/** Minimal Task shape the prompt builders need — mirrors the test fixtures. */
function fakeTask(overrides: Partial<Task>): Task {
  return {
    id: "eval", title: "Eval fixture", prompt: "n/a",
    column: "building", agent: "claude-code", workdir: "/tmp", isolation: "worktree",
    taskType: "task", branch: "feature/eval", branchSource: "created",
    worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: null, effort: null,
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: 0, updatedAt: 0, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pipelineBounceFingerprint: null,
    pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
    ...overrides,
  } as Task;
}

interface Check { name: string; pass: boolean; note?: string }
interface EvalResult { eval: string; run: number; score: number; pass: boolean; checks: Check[]; error?: string }

function score(checks: Check[]): number {
  return checks.length === 0 ? 0 : checks.filter((c) => c.pass).length / checks.length;
}

// ─── eval: decompose-files ───────────────────────────────────────────────────

const DECOMPOSE_SPEC = `# Recipe box — SPEC

A tiny recipe-collection web app.

AC-1: The home route lists every recipe title from the fixture data.
AC-2: A recipe detail route renders one recipe's ingredients and steps.
AC-3: A search box on the home route filters the list by title, live.
AC-4: A shared header with the app name appears on every route.
AC-5: The build produces no console errors on either route.
`;

const DECOMPOSE_PLAN = `# Recipe box — PLAN

Vanilla Vite + vanilla JS, no framework. Fixture recipes in \`src/data/recipes.js\`.
Structure: \`src/routes/home.js\` (list + search), \`src/routes/detail.js\`,
\`src/components/header.js\`, shared styles in \`src/styles.css\`, entry
\`src/main.js\` wiring a tiny hash router, \`index.html\`, \`package.json\`.
The work decomposes naturally into: data fixtures, the header component,
the home route (list + search), the detail route, and final wiring/global
files (router entry, index.html, package.json, styles).
`;

async function evalDecomposeFiles(run: number): Promise<EvalResult> {
  const repo = await makeRepo("feature/eval");
  writeFileSync(path.join(repo, "SPEC.md"), DECOMPOSE_SPEC);
  writeFileSync(path.join(repo, "PLAN.md"), DECOMPOSE_PLAN);
  await commitAllIn(repo, "chore: fixture spec + plan");

  const prompt = stagePrompt(fakeTask({ pipelineStage: "decompose" }), "decompose");
  const invoked = await runClaude(prompt, repo);
  if (!invoked.ok) return { eval: "decompose-files", run, score: 0, pass: false, checks: [], error: invoked.detail };

  const checks: Check[] = [];
  const tasksPath = path.join(repo, "TASKS.json");
  checks.push({ name: "TASKS.json exists", pass: existsSync(tasksPath) });
  let plan: ReturnType<typeof parseBuildPlan> | null = null;
  if (existsSync(tasksPath)) {
    plan = parseBuildPlan(readFileSync(tasksPath, "utf8"));
    checks.push({
      name: "parses + no cross-subtask file overlap",
      pass: plan.ok,
      note: plan.ok ? undefined : plan.reason,
    });
    if (plan.ok) {
      const subs = plan.plan.subtasks;
      checks.push({
        name: "every subtask declares files ownership",
        pass: subs.every((s) => s.files.length > 0),
      });
      checks.push({
        name: "multi-slice decomposition (plan decomposes naturally)",
        pass: subs.length >= 3,
        note: `subtasks: ${subs.length}`,
      });
      const coverage = analyzeCoverage(parseSpecAcceptanceCriteria(DECOMPOSE_SPEC), plan.plan);
      checks.push({
        name: "AC coverage clean (no gaps, no phantoms)",
        pass: coverage.ok,
        note: coverage.ok ? undefined : coverage.reason,
      });
      // Shared/global files (entry, index.html, package.json, styles) should
      // be owned — and by exactly one subtask each (overlap already fails
      // parse, so here we check they weren't silently left unowned).
      const owned = new Set(subs.flatMap((s) => s.files));
      const sharedCovered = ["package.json", "index.html"].filter((f) =>
        [...owned].some((o) => o === f || o.endsWith(`/${f}`)));
      checks.push({
        name: "shared files (package.json, index.html) have an owner",
        pass: sharedCovered.length === 2,
        note: `owned: ${sharedCovered.join(", ") || "none"}`,
      });
    }
  }
  const status = await git(["status", "--porcelain"], repo);
  checks.push({ name: "artifacts committed (clean tree)", pass: status.stdout.trim() === "" });

  return { eval: "decompose-files", run, score: score(checks), pass: score(checks) >= PASS_THRESHOLD, checks };
}

// ─── eval: decompose-single ──────────────────────────────────────────────────
// O-3 (docs/plans/pipeline-token-efficiency.md): a small ticket — 2 ACs, a
// plan naming 2 files — must come back as exactly ONE subtask. The failure
// this guards is the "ten children for a background-colour change" class,
// where each child pays a full bootstrap for no parallelism gain.

const DECOMPOSE_SINGLE_SPEC = `# Recipe box — SPEC

A tiny recipe-collection web app that already renders a list of recipes.

AC-1: The home route shows a "Recipe box" heading above the list.
AC-2: Each recipe title in the list links to \`#/recipe/<id>\`.
`;

const DECOMPOSE_SINGLE_PLAN = `# Recipe box — PLAN

Two small edits, both in the existing home route. In \`src/routes/home.js\`
render an \`<h1>Recipe box</h1>\` before the list and wrap each title in an
\`<a href="#/recipe/<id>">\`. Add a matching \`h1\` rule to \`src/styles.css\`.
No new files, no new dependencies, no other routes touched.
`;

async function evalDecomposeSingle(run: number): Promise<EvalResult> {
  const repo = await makeRepo("feature/eval");
  writeFileSync(path.join(repo, "SPEC.md"), DECOMPOSE_SINGLE_SPEC);
  writeFileSync(path.join(repo, "PLAN.md"), DECOMPOSE_SINGLE_PLAN);
  await commitAllIn(repo, "chore: fixture spec + plan");

  const prompt = stagePrompt(fakeTask({ pipelineStage: "decompose" }), "decompose");
  const invoked = await runClaude(prompt, repo);
  if (!invoked.ok) return { eval: "decompose-single", run, score: 0, pass: false, checks: [], error: invoked.detail };

  const checks: Check[] = [];
  const tasksPath = path.join(repo, "TASKS.json");
  checks.push({ name: "TASKS.json exists", pass: existsSync(tasksPath) });
  if (existsSync(tasksPath)) {
    const plan = parseBuildPlan(readFileSync(tasksPath, "utf8"));
    checks.push({
      name: "parses + no cross-subtask file overlap",
      pass: plan.ok,
      note: plan.ok ? undefined : plan.reason,
    });
    if (plan.ok) {
      const subs = plan.plan.subtasks;
      checks.push({
        name: "exactly 1 subtask (2 files, 2 ACs is below the split threshold)",
        pass: subs.length === 1,
        note: `subtasks: ${subs.length}`,
      });
      const coverage = analyzeCoverage(parseSpecAcceptanceCriteria(DECOMPOSE_SINGLE_SPEC), plan.plan);
      checks.push({
        name: "AC coverage clean (no gaps, no phantoms)",
        pass: coverage.ok,
        note: coverage.ok ? undefined : coverage.reason,
      });
    }
  }
  const status = await git(["status", "--porcelain"], repo);
  checks.push({ name: "artifacts committed (clean tree)", pass: status.stdout.trim() === "" });

  return { eval: "decompose-single", run, score: score(checks), pass: score(checks) >= PASS_THRESHOLD, checks };
}

// ─── eval: merge-resolution ──────────────────────────────────────────────────

async function evalMergeResolution(run: number): Promise<EvalResult> {
  const repo = await makeRepo("main");
  writeFileSync(path.join(repo, "features.txt"), "base\n");
  await commitAllIn(repo, "chore: init");
  await git(["checkout", "-b", "feature/slice-search"], repo);
  writeFileSync(path.join(repo, "features.txt"), "base\nsearch: filter recipes by title\n");
  writeFileSync(path.join(repo, "search.js"), "export function search(list, q) { return list.filter(r => r.title.includes(q)); }\n");
  await commitAllIn(repo, "feature: search slice");
  await git(["checkout", "main"], repo);
  writeFileSync(path.join(repo, "features.txt"), "base\ndetail: render one recipe\n");
  await commitAllIn(repo, "feature: detail slice");
  await git(["merge", "--no-ff", "--no-edit", "feature/slice-search"], repo); // conflicts, parks

  const prompt = mergeResolutionPrompt(
    fakeTask({ branch: "feature/eval-parent" }),
    { branch: "feature/slice-search", planSubtaskId: "search", title: "Search slice" },
  );
  const invoked = await runClaude(prompt, repo);
  if (!invoked.ok) return { eval: "merge-resolution", run, score: 0, pass: false, checks: [], error: invoked.detail };

  const checks: Check[] = [];
  checks.push({ name: "merge concluded (git-verified, isBranchMerged)", pass: await isBranchMerged(repo, "feature/slice-search") });
  const features = existsSync(path.join(repo, "features.txt")) ? readFileSync(path.join(repo, "features.txt"), "utf8") : "";
  checks.push({ name: "kept the branch side's intent (search line)", pass: features.includes("search:") });
  checks.push({ name: "kept the worktree side's intent (detail line)", pass: features.includes("detail:") });
  checks.push({ name: "no conflict markers left", pass: !features.includes("<<<<<<<") });
  checks.push({ name: "branch's other file landed (search.js)", pass: existsSync(path.join(repo, "search.js")) });
  const status = await git(["status", "--porcelain"], repo);
  checks.push({ name: "clean tree after resolution", pass: status.stdout.trim() === "" });

  return { eval: "merge-resolution", run, score: score(checks), pass: score(checks) >= PASS_THRESHOLD, checks };
}

// ─── eval: builder-commit ────────────────────────────────────────────────────

async function evalBuilderCommit(run: number): Promise<EvalResult> {
  const repo = await makeRepo("feature/eval");
  writeFileSync(path.join(repo, "SPEC.md"), "# SPEC\n\nAC-1: greeting.txt exists at the repo root containing exactly the line `hello world`.\n");
  writeFileSync(path.join(repo, "PLAN.md"), "# PLAN\n\nCreate `greeting.txt` at the repository root containing the single line `hello world`. Nothing else.\n");
  await commitAllIn(repo, "chore: fixture spec + plan");
  const before = (await git(["rev-list", "--count", "HEAD"], repo)).stdout.trim();

  const prompt = stagePrompt(fakeTask({ pipelineStage: "building" }), "building");
  const invoked = await runClaude(prompt, repo);
  if (!invoked.ok) return { eval: "builder-commit", run, score: 0, pass: false, checks: [], error: invoked.detail };

  const checks: Check[] = [];
  const greeting = existsSync(path.join(repo, "greeting.txt")) ? readFileSync(path.join(repo, "greeting.txt"), "utf8") : "";
  checks.push({ name: "greeting.txt has the exact content", pass: greeting.trim() === "hello world" });
  const status = await git(["status", "--porcelain"], repo);
  checks.push({ name: "work committed (clean tree — the commit-discipline change)", pass: status.stdout.trim() === "" });
  const after = (await git(["rev-list", "--count", "HEAD"], repo)).stdout.trim();
  checks.push({ name: "a new commit exists", pass: Number(after) > Number(before) });
  const subject = (await git(["log", "-1", "--format=%s"], repo)).stdout.trim();
  checks.push({ name: 'commit subject uses the "feature:" prefix', pass: subject.startsWith("feature:") });
  checks.push({ name: "no AI attribution in the commit", pass: !/claude|anthropic|co-authored/i.test((await git(["log", "-1", "--format=%B"], repo)).stdout) });

  return { eval: "builder-commit", run, score: score(checks), pass: score(checks) >= PASS_THRESHOLD, checks };
}

// ─── eval: tester-precheck ───────────────────────────────────────────────────
//
// O-5: agetor runs the project's checks BEFORE the Tester and folds the
// failures into testingPrompt. Fixture: a one-function lib with a bug and a
// node test that catches it. Score: the Tester fixes the bug (the test now
// passes), commits, and ends with PIPELINE_VERDICT: pass — starting from the
// failure it was handed rather than re-discovering the project.

async function evalTesterPrecheck(run: number): Promise<EvalResult> {
  const repo = await makeRepo("feature/eval");
  writeFileSync(path.join(repo, "SPEC.md"), "# SPEC\n\nAC-1: add(a, b) returns the arithmetic sum of its two arguments.\n");
  writeFileSync(path.join(repo, "PLAN.md"), "# PLAN\n\n`lib.js` exports add(); `test.js` exercises AC-1.\n");
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { test: "node test.js" } }, null, 2));
  writeFileSync(path.join(repo, "lib.js"), "module.exports.add = (a, b) => a + b + 1;\n"); // the bug
  writeFileSync(path.join(repo, "test.js"),
    "// AC-1\nconst { add } = require('./lib.js');\nif (add(2, 2) !== 4) { console.error('AC-1 failed: add(2,2) =', add(2, 2)); process.exit(1); }\nconsole.log('ok');\n");
  await commitAllIn(repo, "chore: fixture with a failing test");

  const precheck = await runPipelinePrecheck({ cwd: repo, profile: readRepoProfile(repo), specAcIds: ["AC-1"] });
  const prompt = stagePrompt(fakeTask({ pipelineStage: "testing", planApproved: true }), "testing", null, { precheck });
  const invoked = await runClaude(prompt, repo);
  if (!invoked.ok) return { eval: "tester-precheck", run, score: 0, pass: false, checks: [], error: invoked.detail };

  const checks: Check[] = [];
  checks.push({ name: "precheck handed the Tester the failing test output", pass: prompt.includes("## Pre-run checks") && prompt.includes("AC-1 failed") });
  const testProc = Bun.spawn(["node", "test.js"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  await new Response(testProc.stdout).text();
  checks.push({ name: "the failing test now passes", pass: (await testProc.exited) === 0 });
  checks.push({ name: "the fix landed in lib.js (not by weakening the test)", pass: readFileSync(path.join(repo, "test.js"), "utf8").includes("!== 4") && !readFileSync(path.join(repo, "lib.js"), "utf8").includes("+ 1") });
  const status = await git(["status", "--porcelain"], repo);
  checks.push({ name: "fix committed (clean tree)", pass: status.stdout.trim() === "" });
  const verdict = parsePipelineVerdict("testing", invoked.stdout);
  checks.push({ name: "ends with PIPELINE_VERDICT: pass", pass: verdict.ok && verdict.kind === "pass", note: verdict.ok ? verdict.kind : "no verdict" });

  return { eval: "tester-precheck", run, score: score(checks), pass: score(checks) >= PASS_THRESHOLD, checks };
}

// ─── runner ──────────────────────────────────────────────────────────────────

const EVALS: Record<string, (run: number) => Promise<EvalResult>> = {
  "decompose-files": evalDecomposeFiles,
  "decompose-single": evalDecomposeSingle,
  "merge-resolution": evalMergeResolution,
  "builder-commit": evalBuilderCommit,
  "tester-precheck": evalTesterPrecheck,
};

const selected = Object.entries(EVALS).filter(([name]) => !ONLY || name.includes(ONLY));
if (selected.length === 0) {
  console.error(`no eval matches --only "${ONLY}" (have: ${Object.keys(EVALS).join(", ")})`);
  process.exit(2);
}

console.log(`pipeline evals — model ${MODEL}, effort ${EFFORT}, ${RUNS} run(s) each: ${selected.map(([n]) => n).join(", ")}\n`);
const results: EvalResult[] = [];
for (const [name, fn] of selected) {
  for (let run = 1; run <= RUNS; run++) {
    const started = Date.now();
    process.stdout.write(`  ${name} (run ${run}/${RUNS}) … `);
    const result = await fn(run).catch((err): EvalResult => (
      { eval: name, run, score: 0, pass: false, checks: [], error: String(err) }
    ));
    results.push(result);
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`${result.pass ? "PASS" : "FAIL"} ${(result.score * 100).toFixed(0)}% [${secs}s]`);
    for (const c of result.checks) {
      console.log(`      ${c.pass ? "✓" : "✗"} ${c.name}${c.note ? ` — ${c.note}` : ""}`);
    }
    if (result.error) console.log(`      error: ${result.error}`);
  }
}

const reportPath = path.join(import.meta.dir, "last-report.json");
writeFileSync(reportPath, JSON.stringify({ model: MODEL, effort: EFFORT, runs: RUNS, at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} eval runs passed (threshold ${PASS_THRESHOLD * 100}%) — report: ${reportPath}`);
process.exit(failed.length === 0 ? 0 : 1);
