import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Gate tests for the token-efficiency wiring in orchestrator.ts /
// build-scheduler.ts (docs/plans/pipeline-token-efficiency.md O-3…O-11).
// Same fake-driver harness as orchestrator-pipeline.test.ts: db.ts captures
// AGETOR_DATA_DIR at first import, the fake claude driver resolves ~20ms
// after spawn, verdicts are injected as assistant events.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-token-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
// Never run a real package-manager install from a test.
process.env.AGETOR_PIPELINE_AUTO_INSTALL = "0";

const { startTask, resolveRunEffort } = await import("./orchestrator.ts");
const { tasks, runs } = await import("./db.ts");
const { pipelineState } = await import("./pipeline-state.ts");
const { tickBuild } = await import("./build-scheduler.ts");

async function settle(ms = 80) { await new Promise((r) => setTimeout(r, ms)); }

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await settle(2);
  }
}

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-token-wd-"));
  writeFileSync(path.join(dir, "SPEC.md"), "# Spec\n\nAC-1: The thing works.\nAC-2: The other thing works.\n");
  writeFileSync(path.join(dir, "PLAN.md"), "# Plan\n\nDo the thing.\n");
  return dir;
}

function insertPipelineTask(workdir: string, over: Partial<import("../shared/types.ts").Task>): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id, title: "tok", prompt: "ticket", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    fast: false, maxMode: false, plans: [],
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "planning", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
    ...over,
  });
  return id;
}

async function start(taskId: string): Promise<string> {
  const r = await startTask(taskId);
  if ("error" in r) throw new Error(r.error);
  return r.runId;
}

function firstUserPrompt(runId: string): string {
  return runs.events(runId).find((e) => e.stream === "user")?.data ?? "";
}

function statusLines(runId: string): string[] {
  return runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
}

/** Seed a satisfied one-subtask barrier so building/code-review/testing
 *  transitions stay reachable (same shape orchestrator-pipeline.test.ts uses). */
function seedBarrier(parentTaskId: string, workdir: string): void {
  writeFileSync(path.join(workdir, "TASKS.json"), JSON.stringify({ subtasks: [{ id: "s1", title: "S1", prompt: "do s1", dependsOn: [], acceptanceCriteria: [] }] }));
  const now = Date.now();
  tasks.insert({
    id: crypto.randomUUID(), title: "child s1", prompt: "do s1", column: "done", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    fast: false, maxMode: false, plans: [],
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: null, planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId, planSubtaskId: "s1", childMergeStatus: "merged",
  });
}

function writePackageJson(dir: string, scripts: Record<string, string>): void {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts }));
  mkdirSync(path.join(dir, "node_modules"), { recursive: true }); // "installed" — no real install in tests
}

// ─── O-8 effort tiering ──────────────────────────────────────────────────────

test("resolveRunEffort: verdict stages → low, children → medium, others unchanged; null stays null; gemini untouched; kill switch", () => {
  const base = { effort: "high", pipelineStage: null, parentTaskId: null } as Parameters<typeof resolveRunEffort>[0];
  expect(resolveRunEffort({ ...base, pipelineStage: "plan-review" }, "claude-code")).toBe("low");
  expect(resolveRunEffort({ ...base, pipelineStage: "code-review" }, "codex")).toBe("low");
  expect(resolveRunEffort({ ...base, pipelineStage: "testing" }, "claude-code")).toBe("low");
  expect(resolveRunEffort({ ...base, parentTaskId: "p" }, "claude-code")).toBe("medium");
  expect(resolveRunEffort({ ...base, pipelineStage: "planning" }, "claude-code")).toBe("high");
  expect(resolveRunEffort({ ...base, pipelineStage: "building" }, "claude-code")).toBe("high");
  expect(resolveRunEffort(base, "claude-code")).toBe("high");
  expect(resolveRunEffort({ ...base, effort: null, pipelineStage: "testing" }, "claude-code")).toBeNull();
  expect(resolveRunEffort({ ...base, pipelineStage: "testing" }, "gemini")).toBe("high");
  const prior = process.env.AGETOR_PIPELINE_EFFORT_TIERING;
  try {
    process.env.AGETOR_PIPELINE_EFFORT_TIERING = "0";
    expect(resolveRunEffort({ ...base, pipelineStage: "testing" }, "claude-code")).toBe("high");
  } finally {
    if (prior === undefined) delete process.env.AGETOR_PIPELINE_EFFORT_TIERING; else process.env.AGETOR_PIPELINE_EFFORT_TIERING = prior;
  }
});

// ─── O-11 stage handoff ──────────────────────────────────────────────────────

test("handoff: files the Planner Read (and commands that worked) are captured at settle and injected into the Critic's prompt", async () => {
  const workdir = makeWorkdir();
  const taskId = insertPipelineTask(workdir, { pipelineStage: "planning" });
  const planRunId = await start(taskId);
  // Simulate the Planner's tool traffic in the persisted event shape the
  // drivers write (claude-tmux.ts: tool_use {id,name,input}, tool_result
  // {toolUseId,content,isError}).
  runs.appendEvent(planRunId, "tool_use", JSON.stringify({ id: "t1", name: "Read", input: { file_path: path.join(workdir, "src/state.ts") }, serverSide: false }));
  runs.appendEvent(planRunId, "tool_result", JSON.stringify({ toolUseId: "t1", content: "export const x = 1;", isError: false }));
  runs.appendEvent(planRunId, "tool_use", JSON.stringify({ id: "t2", name: "Bash", input: { command: "npm run typecheck" }, serverSide: false }));
  runs.appendEvent(planRunId, "tool_result", JSON.stringify({ toolUseId: "t2", content: "ok", isError: false }));
  runs.appendEvent(planRunId, "tool_use", JSON.stringify({ id: "t3", name: "Bash", input: { command: "npm run nope" }, serverSide: false }));
  runs.appendEvent(planRunId, "tool_result", JSON.stringify({ toolUseId: "t3", content: "missing script", isError: true }));
  await waitFor(() => tasks.get(taskId)?.pipelineStage === "plan-review" && tasks.get(taskId)?.runId !== planRunId);

  const stored = pipelineState.getHandoffs(taskId);
  expect(stored.map((h) => h.stage)).toEqual(["planning"]);
  expect(stored[0]!.filesRead.map((f) => f.path)).toEqual(["src/state.ts"]);
  expect(stored[0]!.commandsOk).toEqual(["npm run typecheck"]);

  const criticPrompt = firstUserPrompt(tasks.get(taskId)!.runId!);
  expect(criticPrompt.startsWith("You are the Critic")).toBe(true);
  expect(criticPrompt).toContain("## From earlier stages");
  expect(criticPrompt).toContain("src/state.ts");
  expect(criticPrompt).toContain("npm run typecheck");
  expect(criticPrompt).not.toContain("npm run nope");
});

test("handoff: the specify stage gets none (nothing before it) and a stage with no reads adds nothing to the next prompt", async () => {
  const workdir = makeWorkdir();
  const taskId = insertPipelineTask(workdir, { pipelineStage: "specify" });
  const specRunId = await start(taskId);
  expect(firstUserPrompt(specRunId)).not.toContain("## From earlier stages");
  await waitFor(() => tasks.get(taskId)?.pipelineStage === "clarify" && tasks.get(taskId)?.runId !== specRunId);
  expect(pipelineState.getHandoffs(taskId)).toEqual([]);
  expect(firstUserPrompt(tasks.get(taskId)!.runId!)).not.toContain("## From earlier stages");
});

test("handoff: a build child's prompt carries the parent's handoff filtered to the paths it owns", async () => {
  const workdir = makeWorkdir();
  const parentId = insertPipelineTask(workdir, { pipelineStage: "building", column: "building", planApproved: true });
  writeFileSync(path.join(workdir, "TASKS.json"), JSON.stringify({
    subtasks: [{ id: "ui", title: "UI slice", prompt: "build the ui", dependsOn: [], acceptanceCriteria: ["AC-1"], files: ["src/ui/"] }],
  }));
  pipelineState.appendHandoff(parentId, {
    stage: "planning",
    filesRead: [{ path: "src/ui/App.tsx", ranges: [] }, { path: "src/api/client.ts", ranges: [] }],
    commandsOk: ["npm run typecheck"],
  });
  await tickBuild(parentId);
  const child = tasks.list().find((t) => t.parentTaskId === parentId)!;
  expect(child).toBeDefined();
  expect(child.prompt).toContain("## From earlier stages");
  expect(child.prompt).toContain("src/ui/App.tsx");
  expect(child.prompt).not.toContain("src/api/client.ts");
  expect(child.prompt).toContain("npm run typecheck");
});

// ─── O-4 project commands ────────────────────────────────────────────────────

test("project commands: a command-running stage's prompt names the repo's typecheck/test commands and the install state", async () => {
  const workdir = makeWorkdir();
  writePackageJson(workdir, { typecheck: "echo tc", test: "echo test" });
  seedBarrier("unused", workdir);
  const taskId = insertPipelineTask(workdir, { pipelineStage: "building", planApproved: true, pipelineFeedback: "code review: fix x" });
  const runId = await start(taskId);
  const prompt = firstUserPrompt(runId);
  expect(prompt.startsWith("You are the Builder")).toBe(true);
  expect(prompt).toContain("## Project commands");
  expect(prompt).toContain("npm run typecheck");
  expect(prompt).toContain("already installed");
});

test("project commands: the Planner (read-only stage) and a repo without package.json get no block", async () => {
  const workdir = makeWorkdir();
  writePackageJson(workdir, { test: "echo test" });
  const planner = insertPipelineTask(workdir, { pipelineStage: "planning" });
  expect(firstUserPrompt(await start(planner))).not.toContain("## Project commands");
  const bare = makeWorkdir();
  const tester = insertPipelineTask(bare, { pipelineStage: "testing", planApproved: true });
  expect(firstUserPrompt(await start(tester))).not.toContain("## Project commands");
});

// ─── O-5 tester gate ─────────────────────────────────────────────────────────

test("tester gate: green precheck + every AC referenced from a test file skips the Tester and lands done", async () => {
  const workdir = makeWorkdir();
  writePackageJson(workdir, { typecheck: "echo tc-ok", test: "echo tests-ok" });
  writeFileSync(path.join(workdir, "a.test.js"), "// AC-1 and AC-2 covered\n");
  const taskId = insertPipelineTask(workdir, { pipelineStage: "code-review", planApproved: true });
  seedBarrier(taskId, workdir);
  const reviewRunId = await start(taskId);
  runs.appendEvent(reviewRunId, "assistant", "fine\nPIPELINE_VERDICT: approve");
  await waitFor(() => tasks.get(taskId)?.column === "done");
  const task = tasks.get(taskId)!;
  expect(task.implementationApproved).toBe(true);
  expect(task.pipelineStage).toBe("code-review"); // never entered testing
  expect(runs.listForTask(taskId).length).toBe(1); // no Tester run was spawned
  const status = statusLines(reviewRunId);
  expect(status.some((l) => l.includes("running the project's own checks"))).toBe(true);
  expect(status.some((l) => l.includes("precheck: typecheck ok"))).toBe(true);
  expect(status.some((l) => l.includes("Tester turn skipped"))).toBe(true);
  expect(pipelineState.getPrecheck(taskId)).toBeNull();
});

test("tester gate: a failing command spawns the Tester with the failure output folded into its prompt", async () => {
  const workdir = makeWorkdir();
  writePackageJson(workdir, { typecheck: "echo tc-ok", test: "echo assertion-boom >&2; exit 2" });
  writeFileSync(path.join(workdir, "a.test.js"), "// AC-1 AC-2\n");
  const taskId = insertPipelineTask(workdir, { pipelineStage: "code-review", planApproved: true });
  seedBarrier(taskId, workdir);
  const reviewRunId = await start(taskId);
  runs.appendEvent(reviewRunId, "assistant", "fine\nPIPELINE_VERDICT: approve");
  await waitFor(() => tasks.get(taskId)?.pipelineStage === "testing" && tasks.get(taskId)?.runId !== reviewRunId);
  const testerPrompt = firstUserPrompt(tasks.get(taskId)!.runId!);
  expect(testerPrompt.startsWith("You are the Tester")).toBe(true);
  expect(testerPrompt).toContain("## Pre-run checks");
  expect(testerPrompt).toContain("- typecheck: ok");
  expect(testerPrompt).toContain("- test: FAILED (exit 2)");
  expect(testerPrompt).toContain("assertion-boom");
  expect(testerPrompt).toContain("Start from the failures");
  expect(statusLines(reviewRunId).some((l) => l.includes("precheck: test failed"))).toBe(true);
  // The Tester's settle clears the stored precheck either way.
  runs.appendEvent(tasks.get(taskId)!.runId!, "assistant", "fixed\nPIPELINE_VERDICT: pass");
  await waitFor(() => tasks.get(taskId)?.column === "done");
  expect(pipelineState.getPrecheck(taskId)).toBeNull();
});

test("tester gate: green commands but an AC no test mentions still spawns the Tester, naming the AC", async () => {
  const workdir = makeWorkdir();
  writePackageJson(workdir, { test: "echo ok" });
  writeFileSync(path.join(workdir, "a.test.js"), "// only AC-1 here\n");
  const taskId = insertPipelineTask(workdir, { pipelineStage: "code-review", planApproved: true });
  seedBarrier(taskId, workdir);
  const reviewRunId = await start(taskId);
  runs.appendEvent(reviewRunId, "assistant", "PIPELINE_VERDICT: approve");
  await waitFor(() => tasks.get(taskId)?.pipelineStage === "testing" && tasks.get(taskId)?.runId !== reviewRunId);
  const testerPrompt = firstUserPrompt(tasks.get(taskId)!.runId!);
  expect(testerPrompt).toContain("not mentioned by any test file: AC-2");
  expect(testerPrompt).not.toContain("AC-1,");
});

test("tester gate: AGETOR_PIPELINE_TESTER_SKIP=0 keeps the precheck but always spawns the Tester", async () => {
  const prior = process.env.AGETOR_PIPELINE_TESTER_SKIP;
  process.env.AGETOR_PIPELINE_TESTER_SKIP = "0";
  try {
    const workdir = makeWorkdir();
    writePackageJson(workdir, { test: "echo ok" });
    writeFileSync(path.join(workdir, "a.test.js"), "// AC-1 AC-2\n");
    const taskId = insertPipelineTask(workdir, { pipelineStage: "code-review", planApproved: true });
    seedBarrier(taskId, workdir);
    const reviewRunId = await start(taskId);
    runs.appendEvent(reviewRunId, "assistant", "PIPELINE_VERDICT: approve");
    await waitFor(() => tasks.get(taskId)?.pipelineStage === "testing" && tasks.get(taskId)?.runId !== reviewRunId);
    expect(firstUserPrompt(tasks.get(taskId)!.runId!)).toContain("- test: ok");
  } finally {
    if (prior === undefined) delete process.env.AGETOR_PIPELINE_TESTER_SKIP; else process.env.AGETOR_PIPELINE_TESTER_SKIP = prior;
  }
});

test("tester gate: no package.json → the Tester is spawned exactly as before (no precheck block)", async () => {
  const workdir = makeWorkdir();
  const taskId = insertPipelineTask(workdir, { pipelineStage: "code-review", planApproved: true });
  seedBarrier(taskId, workdir);
  const reviewRunId = await start(taskId);
  runs.appendEvent(reviewRunId, "assistant", "PIPELINE_VERDICT: approve");
  await waitFor(() => tasks.get(taskId)?.pipelineStage === "testing" && tasks.get(taskId)?.runId !== reviewRunId);
  expect(firstUserPrompt(tasks.get(taskId)!.runId!)).not.toContain("## Pre-run checks");
});

// ─── O-6 precomputed review diff ─────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

test("review diff: the Code Reviewer is pointed at a precomputed diff file outside the worktree; a revision pass diffs since the last review", async () => {
  const workdir = makeWorkdir();
  const taskId = insertPipelineTask(workdir, { pipelineStage: "code-review", planApproved: true });
  seedBarrier(taskId, workdir); // TASKS.json must be part of the base commit, not an untracked file
  await git(["init", "-q", "-b", "main"], workdir);
  await git(["config", "user.email", "t@t"], workdir);
  await git(["config", "user.name", "t"], workdir);
  await git(["add", "-A"], workdir);
  await git(["commit", "-q", "-m", "base"], workdir);
  const base = await git(["rev-parse", "HEAD"], workdir);
  writeFileSync(path.join(workdir, "feature.ts"), "export const built = true;\n");
  await git(["add", "-A"], workdir);
  await git(["commit", "-q", "-m", "feature: build it"], workdir);
  const head1 = await git(["rev-parse", "HEAD"], workdir);
  tasks.update(taskId, { baseRef: base });
  const runId = await start(taskId);
  const prompt = firstUserPrompt(runId);
  expect(prompt).toContain("has already been written to");
  expect(prompt).toContain("this branch's base");
  const file = prompt.match(/written to `([^`]+)`/)?.[1];
  expect(file).toBeDefined();
  expect(file!.startsWith(workdir)).toBe(false);
  expect(existsSync(file!)).toBe(true);
  expect(readFileSync(file!, "utf8")).toContain("+export const built = true;");
  expect(prompt).toContain("feature.ts");
  expect(pipelineState.getReviewSha(taskId)).toBe(head1);
  expect(await git(["status", "--porcelain"], workdir)).toBe(""); // worktree untouched

  // Revision pass: another commit, then the reviewer sees only the delta.
  writeFileSync(path.join(workdir, "fix.ts"), "export const fixed = true;\n");
  await git(["add", "-A"], workdir);
  await git(["commit", "-q", "-m", "fix"], workdir);
  tasks.update(taskId, { revisionCount: 1, pipelineFeedback: "code review: missing fix", runId: null });
  const runId2 = await start(taskId);
  const prompt2 = firstUserPrompt(runId2);
  expect(prompt2).toContain(`your previous review (${head1.slice(0, 7)})`);
  const file2 = prompt2.match(/written to `([^`]+)`/)?.[1]!;
  const body2 = readFileSync(file2, "utf8");
  expect(body2).toContain("fix.ts");
  expect(body2).not.toContain("feature.ts");
});

test("review diff: without a baseRef or a git repo the prompt falls back to 'run git diff yourself'", async () => {
  const workdir = makeWorkdir();
  const taskId = insertPipelineTask(workdir, { pipelineStage: "code-review", planApproved: true, baseRef: null });
  seedBarrier(taskId, workdir);
  const prompt = firstUserPrompt(await start(taskId));
  expect(prompt).toContain("run `git diff");
  expect(prompt).not.toContain("has already been written to");
});

// ─── O-3 decomposition warnings ──────────────────────────────────────────────

test("decompose: an oversized decomposition passes the gate but logs a warning status event", async () => {
  const workdir = makeWorkdir();
  const taskId = insertPipelineTask(workdir, { pipelineStage: "decompose", planApproved: true });
  const subtasks = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, prompt: "do it", dependsOn: [], acceptanceCriteria: i === 0 ? ["AC-1", "AC-2"] : [] }));
  writeFileSync(path.join(workdir, "TASKS.json"), JSON.stringify({ subtasks }));
  const runId = await start(taskId);
  await waitFor(() => tasks.get(taskId)?.pipelineStage === "building");
  expect(statusLines(runId).some((l) => l.startsWith("decomposition warning:") && l.includes("9"))).toBe(true);
});
