import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Guard-rail tests for the pipeline fixes from
// docs/plans/pipeline-build-stage-postmortem.md: verdict provenance (F-6),
// the gate override route (F-6), merge-deferral for late-settling children
// (F-3), the child boot-flake retry (F-1.4), and the DAG-aware bounce
// (F-4). Same fake-driver, temp-dir, isolation:"none" harness as
// orchestrator-pipeline.test.ts; the behaviors needing REAL git (deferred
// merges landing, tree-fingerprint no-progress blocking) live in
// orchestrator-pipeline-merge.test.ts instead.

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-guards-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-guards-wd-"));
  writeFileSync(path.join(dir, "SPEC.md"), "# Spec\n\nAC-1: The thing works.\n");
  writeFileSync(path.join(dir, "PLAN.md"), "# Plan\n\nDo the thing.\n");
  return dir;
}

function writeTasksPlan(dir: string, plan: unknown) {
  writeFileSync(path.join(dir, "TASKS.json"), JSON.stringify(plan));
}

type SeedOverrides = Partial<import("../shared/types.ts").Task>;

async function seedTask(overrides: SeedOverrides): Promise<string> {
  const { tasks } = await import("./db.ts");
  const id = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id, title: "t", prompt: "x", column: "backlog", agent: "claude-code",
    workdir: makeWorkdir(), isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: null, planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
    ...overrides,
  });
  return id;
}

/** Insert a run row with the given origin and point the task at it —
 *  simulates how a run of that provenance would be wired at settle time. */
async function seedRun(taskId: string, origin: "pipeline-stage" | "continuation" | null): Promise<string> {
  const { tasks, runs } = await import("./db.ts");
  const runId = crypto.randomUUID();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "running",
    startedAt: Date.now(), endedAt: null, exitCode: null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, geminiSessionId: null,
    origin,
  });
  tasks.update(taskId, { runId });
  return runId;
}

// ─── F-6: verdict provenance ─────────────────────────────────────────────────

test("provenance: an unstamped (user follow-up) run success does NOT advance a verdict stage, even with an approve verdict in it", async () => {
  const { advancePipelineStage } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await seedTask({ pipelineStage: "code-review", column: "code-review", planApproved: true });
  const runId = await seedRun(taskId, null);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: approve");

  advancePipelineStage(taskId, runId, { kind: "success" });
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("code-review"); // unmoved
  expect(task.column).toBe("code-review"); // re-affirmed to the stage
  const status = runs.events(runId).filter((e) => e.stream === "status");
  expect(status.some((e) => e.data.includes("not advanced"))).toBe(true);
});

test("provenance: a continuation run success at building does NOT advance — the 2DOT2DOT incident replay", async () => {
  const { advancePipelineStage } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  // Barrier deliberately SATISFIED: before the provenance gate, this exact
  // setup advanced to code-review (the barrier check alone wouldn't stop a
  // fully-merged build from being advanced by a stray conversation turn).
  const taskId = await seedTask({ pipelineStage: "building", column: "building", planApproved: true });
  const workdir = tasks.get(taskId)!.workdir;
  writeTasksPlan(workdir, { subtasks: [{ id: "s1", title: "S1", prompt: "p", dependsOn: [], acceptanceCriteria: [] }] });
  await seedTask({ parentTaskId: taskId, planSubtaskId: "s1", childMergeStatus: "merged", column: "building", workdir });
  const runId = await seedRun(taskId, "continuation");

  advancePipelineStage(taskId, runId, { kind: "success" });
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("building"); // continuation runs move nothing
  expect(task.column).toBe("building");
});

test("provenance: the same success WITH the pipeline-stage stamp advances normally", async () => {
  const { advancePipelineStage } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await seedTask({ pipelineStage: "code-review", column: "code-review", planApproved: true });
  const runId = await seedRun(taskId, "pipeline-stage");
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: approve");

  advancePipelineStage(taskId, runId, { kind: "success" });
  await settle();

  expect(tasks.get(taskId)!.pipelineStage).toBe("testing");
});

test("provenance: an unstamped run success on a CHILD does not trigger a merge", async () => {
  const { settleChildRun } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const parentId = await seedTask({ pipelineStage: "building", column: "building" });
  const childId = await seedTask({ parentTaskId: parentId, planSubtaskId: "s1", childMergeStatus: "pending", column: "running" });
  const runId = await seedRun(childId, null);

  settleChildRun(childId, runId, { kind: "success" });
  await settle();

  // No merge attempt: status stays pending (a merge attempt on this
  // isolation:"none" child would have flipped it to merge-failed and
  // blocked the parent).
  expect(tasks.get(childId)!.childMergeStatus).toBe("pending");
  expect(tasks.get(parentId)!.column).toBe("building");
});

// ─── F-6: gate override ──────────────────────────────────────────────────────

test("override: code-review gate forced to testing, with a durable audit event", async () => {
  const { overridePipelineGate } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await seedTask({ pipelineStage: "code-review", column: "blocked", planApproved: true, blockReason: "revision-cap", revisionCount: 7 });
  const runId = await seedRun(taskId, "pipeline-stage");
  runs.update(runId, { status: "succeeded", endedAt: Date.now(), exitCode: 0 });

  const result = overridePipelineGate(taskId);
  if ("error" in result) throw new Error(result.error);
  await settle();

  expect(tasks.get(taskId)!.pipelineStage).toBe("testing");
  const status = runs.events(runId).filter((e) => e.stream === "status");
  expect(status.some((e) => e.data.includes("overridden by user"))).toBe(true);
});

test("override: testing gate forced straight to ready", async () => {
  const { overridePipelineGate } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const taskId = await seedTask({ pipelineStage: "testing", column: "blocked", planApproved: true, blockReason: "revision-cap" });
  const result = overridePipelineGate(taskId);
  if ("error" in result) throw new Error(result.error);

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("ready");
  expect(task.implementationApproved).toBe(true);
});

test("override: artifact-gated stages refuse (nothing to overrule)", async () => {
  const { overridePipelineGate } = await import("./orchestrator.ts");
  const taskId = await seedTask({ pipelineStage: "specify", column: "blocked" });
  const result = overridePipelineGate(taskId);
  expect("error" in result).toBe(true);
});

test("override: non-pipeline task refuses", async () => {
  const { overridePipelineGate } = await import("./orchestrator.ts");
  const taskId = await seedTask({});
  const result = overridePipelineGate(taskId);
  expect("error" in result).toBe(true);
});

// ─── F-3: merge-deferred children ────────────────────────────────────────────

test("late settle: a child completing after the parent left building is parked merge-deferred on review, not stranded", async () => {
  const { completeChildBuild } = await import("./orchestrator.ts").then(() => import("./build-scheduler.ts"));
  const { tasks, runs } = await import("./db.ts");

  // Parent already moved on to code-review — the exact 2DOT2DOT state when
  // its two children finally succeeded (they froze on running/pending
  // forever; RC-3).
  const parentId = await seedTask({ pipelineStage: "code-review", column: "code-review" });
  const parentRunId = await seedRun(parentId, "pipeline-stage");
  const childId = await seedTask({ parentTaskId: parentId, planSubtaskId: "s1", childMergeStatus: "pending", column: "running" });

  await completeChildBuild(childId);

  const child = tasks.get(childId)!;
  expect(child.childMergeStatus).toBe("merge-deferred");
  expect(child.column).toBe("review"); // visible, not a forever-running card
  const status = runs.events(parentRunId).filter((e) => e.stream === "status");
  expect(status.some((e) => e.data.includes("merge deferred"))).toBe(true);
});

// ─── F-1.4: child boot-flake retry ───────────────────────────────────────────

test("boot flake: a child hard-failure with zero agent output retries the spawn once instead of aborting the build", async () => {
  const { settleChildRun } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const parentId = await seedTask({ pipelineStage: "building", column: "building" });
  const childId = await seedTask({ parentTaskId: parentId, planSubtaskId: "s1", childMergeStatus: "pending", column: "running" });
  const runId = await seedRun(childId, "pipeline-stage");
  runs.appendEvent(runId, "stderr", "claude session JSONL never appeared: …"); // no assistant/tool_use output

  settleChildRun(childId, runId, { kind: "hard-failure", reason: "pipeline-failed" });
  await settle(200); // let the retry's startTask persist its run row

  // Retry happened: a second run exists, the child was never landed on
  // `blocked` by the flake, and the failure did not cascade a build abort.
  // (The fake retry run then resolves and takes the normal merge path — its
  // isolation:"none" outcome is out of scope here, so no parent-column
  // assertion past this point.)
  expect(runs.listForTask(childId).length).toBe(2);
  const status = runs.events(runId).filter((e) => e.stream === "status");
  expect(status.some((e) => e.data.includes("retrying the spawn once"))).toBe(true);
  expect(tasks.get(parentId)!.pipelineFeedback ?? "").not.toContain("failed (pipeline-failed)");
});

test("real failure: a child hard-failure WITH agent output escalates immediately (build aborts, no retry)", async () => {
  const { settleChildRun } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const parentId = await seedTask({ pipelineStage: "building", column: "building" });
  const childId = await seedTask({ parentTaskId: parentId, planSubtaskId: "s1", childMergeStatus: "pending", column: "running" });
  const runId = await seedRun(childId, "pipeline-stage");
  runs.appendEvent(runId, "assistant", "I tried to build it but hit an unrecoverable error.");

  settleChildRun(childId, runId, { kind: "hard-failure", reason: "pipeline-failed" });
  await settle();

  expect(tasks.get(childId)!.column).toBe("blocked");
  expect(tasks.get(parentId)!.column).toBe("blocked");
  expect(runs.listForTask(childId).length).toBe(1); // no retry
});

// ─── F-4: DAG-aware bounce ───────────────────────────────────────────────────

test("bounce: a testing fail with an INCOMPLETE barrier re-enters the DAG (children spawn) instead of a fixup turn", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await seedTask({ pipelineStage: "testing", column: "testing", planApproved: true });
  const workdir = tasks.get(taskId)!.workdir;
  writeTasksPlan(workdir, {
    subtasks: [
      { id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: [] },
      { id: "b", title: "B", prompt: "do b", dependsOn: [], acceptanceCriteria: [] },
    ],
  });

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  runs.appendEvent(started.runId, "assistant", "PIPELINE_VERDICT: fail nothing was ever built");
  await settle(300);

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("building");
  expect(task.revisionCount).toBe(1); // the bounce still consumed a slot
  // The DAG took over: subtask children were created…
  const children = tasks.list().filter((t) => t.parentTaskId === taskId);
  expect(children.map((c) => c.planSubtaskId).sort()).toEqual(["a", "b"]);
  // …and NO parent fixup run spawned (only the testing run exists).
  expect(runs.listForTask(taskId).length).toBe(1);
});
