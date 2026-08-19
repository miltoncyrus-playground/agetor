import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-orch-"));
// Drive claude through the in-process fake — no tmux, no real CLI. The fake
// emits a canned "stdout" chunk (never "assistant") and resolves after
// ~20ms, so a verdict-bearing stage's outcome is controlled directly by
// appending an "assistant" run_event ourselves right after startTask
// returns (synchronously, well within the fake's resolve window) — see
// startAndGetRunId() below. This exercises the real persistence/query path
// (runs.appendEvent -> runs.events -> parsePipelineVerdict), not a mock.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

async function makeWorkdir(withFiles: boolean): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-wd-"));
  if (withFiles) {
    writeFileSync(path.join(dir, "SPEC.md"), "# Spec\n\nAC-1: The thing works.\n");
    writeFileSync(path.join(dir, "PLAN.md"), "# Plan\n\nDo the thing.\n");
  }
  return dir;
}

/** Writes a TASKS.json into an existing worktree dir (renamed from BUILD_PLAN.json). */
function writeTasksPlan(dir: string, plan: unknown) {
  writeFileSync(path.join(dir, "TASKS.json"), JSON.stringify(plan));
}

/**
 * Satisfy a parent's build barrier: writes a one-subtask TASKS.json into its
 * workdir and inserts a matching `childMergeStatus: "merged"` child row.
 * Every exit from "building" (advance AND review/test bounce) now consults
 * the barrier, so tests seeding a task directly at building/code-review/
 * testing need this for the pre-barrier behaviors (advance to code-review,
 * fixup-turn bounce) to remain reachable.
 */
async function seedSatisfiedBarrier(parentTaskId: string, workdir: string): Promise<void> {
  const { tasks } = await import("./db.ts");
  writeTasksPlan(workdir, { subtasks: [{ id: "s1", title: "S1", prompt: "do s1", dependsOn: [], acceptanceCriteria: [] }] });
  const now = Date.now();
  tasks.insert({
    id: crypto.randomUUID(), title: "child s1", prompt: "do s1", column: "building", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: null, planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId, planSubtaskId: "s1", childMergeStatus: "merged",
  });
}

/** Start (or restart) a pipeline task's current stage and return the run id
 *  synchronously, before the fake's own resolve timers have had a chance to
 *  fire — matching the pattern orchestrator-gemini.test.ts already relies
 *  on (`const started = await startTask(...); const runId = started.runId`). */
async function startAndGetRunId(startTask: typeof import("./orchestrator.ts").startTask, taskId: string): Promise<string> {
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  return started.runId;
}

/** Poll for a task's `runId` to change away from `priorRunId` — used to
 *  capture an AUTO-spawned run's id (e.g. the next stage's run, fired by
 *  the previous stage's own success handler) early enough to inject a
 *  verdict before its fake-driver timer resolves it unverified. `runId` is
 *  set synchronously in startTask's persist transaction, strictly before
 *  the new run's timer is armed, so a tight poll interval reliably wins
 *  the race. */
async function waitForNewRun(taskId: string, priorRunId: string | null, timeoutMs = 500): Promise<string> {
  const { tasks } = await import("./db.ts");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runId = tasks.get(taskId)?.runId ?? null;
    if (runId && runId !== priorRunId) return runId;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for a new run on task ${taskId} (prior: ${priorRunId})`);
}

test("pipeline: created pipeline task starts at specify; with SPEC.md+PLAN.md the chain auto-advances to plan-review", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true); // writes SPEC.md + PLAN.md
  const created = await createTask({
    title: "p1", prompt: "add dark mode", agent: "claude-code",
    workdir, isolation: "none", taskType: "task", pipeline: true,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  expect(created.task.pipelineStage).toBe("specify"); // new first stage

  await startAndGetRunId(startTask, taskId);
  await settle(500); // specify→clarify→planning→plan-review, each ~20ms fake + agent-check overhead

  const task = tasks.get(taskId)!;
  // specify+clarify+planning are non-verdict-bearing; each auto-advances once
  // the file gates pass. plan-review is verdict-bearing — no verdict injected
  // so it blocks rather than advancing further, giving a stable assertion.
  expect(task.pipelineStage).toBe("plan-review");
  expect(task.column).toBe("blocked"); // plan-review blocks with no verdict injected
  expect(runs.listForTask(taskId).length).toBe(4); // specify+clarify+planning+plan-review
});

test("pipeline: specify success WITHOUT SPEC.md blocks instead of advancing", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(false); // nothing written
  const created = await createTask({
    title: "p2", prompt: "add dark mode", agent: "claude-code",
    workdir, isolation: "none", taskType: "task", pipeline: true,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("blocked");
  // pipelineStage stays put so a human sees exactly where it died.
  expect(task.pipelineStage).toBe("specify");
});

test("pipeline: plan-review approve advances to decompose and sets planApproved", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p3", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "plan-review", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "Looks good.\n\nPIPELINE_VERDICT: approve");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("decompose");
  expect(task.column).toBe("decompose");
  expect(task.planApproved).toBe(true);
  expect(runs.listForTask(taskId).length).toBe(2);
});

test("pipeline: tickBuild starts an independent subtask immediately and holds a dependent one until its dependency is merged", async () => {
  // Deterministic scheduling-logic test: calls tickBuild directly rather
  // than going through a decompose run, and never settle()s long enough
  // for the fake child runs it fires to actually resolve — so this checks
  // ONLY the DAG decision logic (who gets created when), independent of
  // real merge timing (covered end-to-end by the previous test). isolation
  // stays "none" — no real git needed here, tickBuild's own logic never
  // touches git; only the merge step (not reached in this test) does.
  const { tickBuild } = await import("./build-scheduler.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(false);
  writeTasksPlan(workdir, {
    subtasks: [
      { id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: [] },
      { id: "b", title: "B", prompt: "do b", dependsOn: ["a"], acceptanceCriteria: [] },
    ],
  });
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p3f", prompt: "x", column: "building", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  await tickBuild(taskId);

  // Checked immediately (no settle) — tickBuild's own child-creation loop
  // is fully awaited by the time it returns; only the fire-and-forget
  // startTask call for each child is still pending, well before the fake
  // driver's ~20ms timer. "b" depends on "a", which hasn't merged, so only
  // "a" should exist yet.
  let children = tasks.list().filter((t) => t.parentTaskId === taskId);
  expect(children.length).toBe(1);
  expect(children[0]!.planSubtaskId).toBe("a");
  expect(children[0]!.childMergeStatus).toBe("pending");
  expect(tasks.get(taskId)!.column).toBe("building"); // barrier not complete

  // Flip "a" to merged directly (bypassing a real run/merge — this test is
  // about the scheduler's dependency gating, not merge mechanics) and
  // re-tick.
  tasks.update(children[0]!.id, { childMergeStatus: "merged" });
  await tickBuild(taskId);

  children = tasks.list().filter((t) => t.parentTaskId === taskId);
  expect(children.length).toBe(2);
  const b = children.find((c) => c.planSubtaskId === "b")!;
  expect(b).toBeDefined();
  expect(b.childMergeStatus).toBe("pending");
  // The barrier still isn't complete ("b" hasn't merged), so the parent
  // stays in building, not code-review.
  expect(tasks.get(taskId)!.column).toBe("building");

  // Now merge "b" too and confirm the barrier completes and the parent
  // advances to code-review.
  tasks.update(b.id, { childMergeStatus: "merged" });
  await tickBuild(taskId);
  expect(tasks.get(taskId)!.pipelineStage).toBe("code-review");
  expect(tasks.get(taskId)!.column).toBe("code-review");
});

test("pipeline: DAG scheduler is a no-op once the parent is blocked (doesn't resurrect an aborted build)", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tickBuild } = await import("./build-scheduler.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  // subtask must claim AC-1 (written to SPEC.md by makeWorkdir(true)) so
  // the inline analyzeCoverage step passes and tickBuild fires.
  writeTasksPlan(workdir, { subtasks: [{ id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: ["AC-1"] }] });
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p3g", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "decompose", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  await startAndGetRunId(startTask, taskId);
  await settle(300);
  expect(tasks.list().filter((t) => t.parentTaskId === taskId).length).toBe(1);

  // The child (isolation:"none", so no real worktree/branch) already
  // organically blocked the parent via completeChildBuild's "nothing to
  // merge" failure path by now — this just makes the "blocked" precondition
  // explicit and deterministic regardless of that timing.
  tasks.update(taskId, { column: "blocked" });

  await tickBuild(taskId);
  await settle(150);

  // No new/second child should appear — doTick's guard bails out once
  // column !== "building", even though pipelineStage is still "building".
  expect(tasks.list().filter((t) => t.parentTaskId === taskId).length).toBe(1);
  expect(tasks.get(taskId)!.column).toBe("blocked");
});

test("pipeline: decompose success WITHOUT TASKS.json blocks instead of advancing", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p3d", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "decompose", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("blocked");
  // pipelineStage stays put so a human sees exactly where it died and can retry.
  expect(task.pipelineStage).toBe("decompose");
});

test("pipeline: decompose success with an INVALID TASKS.json (cycle) blocks with the reason in pipelineFeedback", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  writeTasksPlan(workdir, {
    subtasks: [
      { id: "a", title: "A", prompt: "1", dependsOn: ["b"], acceptanceCriteria: [] },
      { id: "b", title: "B", prompt: "2", dependsOn: ["a"], acceptanceCriteria: [] },
    ],
  });
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p3e", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "decompose", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("blocked");
  expect(task.pipelineStage).toBe("decompose");
  expect(task.pipelineFeedback).toContain("cycle");
  // A verdict-bearing/output-producing stage that fails to produce the
  // expected file blocks with "pipeline-failed" — this is what selects the
  // "Stage didn't produce the expected output" copy (and the Retry-stage /
  // Archive actions) in the RunPanel's blocked-task recovery banner.
  expect(task.blockReason).toBe("pipeline-failed");
});

test("pipeline: plan-review approve goes straight to ready when implementationApproved was already true", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p3b", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    // Simulates a re-planning pass after testing had already passed once.
    pipelineStage: "plan-review", planApproved: false, implementationApproved: true,
    revisionCount: 1, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: approve");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("ready");
  expect(task.planApproved).toBe(true);
  expect(task.implementationApproved).toBe(true);
});

test("pipeline: plan-review revise under the cap bounces to planning with feedback", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p4", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "plan-review", planApproved: true, implementationApproved: false,
    revisionCount: 1, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: revise the plan is missing error handling");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("planning");
  expect(task.column).toBe("planning");
  expect(task.planApproved).toBe(false); // reset — the approval no longer holds
  expect(task.revisionCount).toBe(2);
  expect(task.pipelineFeedback).toBe("the plan is missing error handling");
});

test("pipeline: revise past the revision cap blocks instead of looping again", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p5", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    // Already at the cap — one more revise must block, not loop a 7th time.
    pipelineStage: "plan-review", planApproved: true, implementationApproved: false,
    revisionCount: 6, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: revise still not right");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("blocked");
  expect(task.revisionCount).toBe(7);
  // Stays at plan-review — the cap block doesn't fabricate a stage change.
  expect(task.pipelineStage).toBe("plan-review");
  // Selects the "Revision limit reached" copy + Retry-stage/Archive actions
  // in the RunPanel's blocked-task recovery banner.
  expect(task.blockReason).toBe("revision-cap");
});

test("pipeline: building success with a satisfied barrier advances to code-review", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p6", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: "prior tester feedback", pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });
  await seedSatisfiedBarrier(taskId, workdir);

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  // code-review's OWN run also starts (its prompt is real now) and, since
  // no PIPELINE_VERDICT was injected for it, blocks — column reflects
  // that, but pipelineStage having landed on "code-review" at all is the
  // thing this test actually checks (building's completion target).
  expect(task.pipelineStage).toBe("code-review");
  expect(task.pipelineFeedback).toBeNull(); // consumed on the building->code-review hop
  expect(runs.listForTask(taskId).length).toBe(2); // building's run + the auto-spawned code-review run
});

test("pipeline: building success with UNMET barrier stays in building instead of advancing (the 2DOT2DOT regression)", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  // Two subtasks declared, ZERO children merged — the exact state the
  // 2DOT2DOT parent was in when a stray run success advanced it to
  // code-review over an empty branch.
  writeTasksPlan(workdir, {
    subtasks: [
      { id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: [] },
      { id: "b", title: "B", prompt: "do b", dependsOn: [], acceptanceCriteria: [] },
    ],
  });
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p6-unmet", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  await startAndGetRunId(startTask, taskId);
  await settle(300); // the run's success hands off to tickBuild, which spawns children

  const task = tasks.get(taskId)!;
  // NOT code-review — the barrier held. tickBuild took over and spawned the
  // two dep-free subtasks as real children instead.
  expect(task.pipelineStage).toBe("building");
  const children = tasks.list().filter((t) => t.parentTaskId === taskId);
  expect(children.map((c) => c.planSubtaskId).sort()).toEqual(["a", "b"]);
});

test("pipeline: building success with NO TASKS.json blocks instead of advancing", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(true); // SPEC+PLAN, no TASKS.json
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p6-nojson", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("blocked");
  expect(task.pipelineStage).toBe("building"); // stays put so a human sees where it died
  expect(task.pipelineFeedback).toContain("TASKS.json");
});

test("pipeline: code-review approve advances to testing", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p6b", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "code-review", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "Looks correct.\n\nPIPELINE_VERDICT: approve");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("testing");
  expect(task.column).toBe("testing");
  expect(runs.listForTask(taskId).length).toBe(2);
});

test("pipeline: code-review revise under the cap bounces to building with feedback, consuming the SHARED revision-cap slot", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p6c", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "code-review", planApproved: true, implementationApproved: false,
    // Already used 2 of the 6 shared slots via earlier plan-review/testing
    // bounces in this task's (simulated) history — code-review's revise
    // below must draw from the SAME counter, not a fresh one.
    revisionCount: 2, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });
  await seedSatisfiedBarrier(taskId, workdir); // barrier met → the bounce is a fixup turn

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: revise the error handling swallows the exception silently");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("building");
  expect(task.column).toBe("building");
  expect(task.revisionCount).toBe(3); // shared counter incremented, not a separate code-review counter
  // The originating gate is named in the feedback so the Builder knows
  // which review it is answering (buildingPrompt is stage-neutral now).
  expect(task.pipelineFeedback).toBe("code review: the error handling swallows the exception silently");
  // No NEW children spawned — this is the BOUNCE-entry (plain single-agent
  // fixup), not a fresh decompose-then-build kick-off. (The one merged
  // child is the barrier fixture seeded above.)
  expect(tasks.list().filter((t) => t.parentTaskId === taskId).length).toBe(1);
});

test("pipeline: specify through decompose chains correctly across real auto-advances (not directly-seeded stages)", async () => {
  // Every other test in this file seeds its task DIRECTLY at the stage
  // under test via tasks.insert (giving explicit control over exactly
  // which run gets the injected verdict). This test instead starts at
  // "specify" (as createTask does) and rides real auto-advances
  // (specify→clarify→planning→plan-review) to catch wiring bugs individual
  // per-stage tests can't — e.g. an outcome computed off the wrong run id,
  // or a stage transition that silently targets the wrong next stage.
  // Doesn't extend past decompose: crossing into "building" is a fresh DAG
  // entry (a child's run, not the parent's), so from there the existing
  // per-stage tests plus the real-git end-to-end coverage in
  // orchestrator-pipeline-merge.test.ts are the right tool.
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const created = await createTask({
    title: "full-loop", prompt: "add dark mode", agent: "claude-code",
    workdir, isolation: "none", taskType: "task", pipeline: true,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  // Start specify. specify→clarify→planning are non-verdict-bearing, so
  // each auto-advances once its file gates pass. We settle long enough for
  // all three to complete and for plan-review to start and block (verdict-
  // bearing, no verdict injected yet → column becomes "blocked").
  await startAndGetRunId(startTask, taskId);
  await settle(500); // specify→clarify→planning→plan-review, each ~20ms fake + agent-check overhead

  const afterSettle = tasks.get(taskId)!;
  expect(afterSettle.pipelineStage).toBe("plan-review");
  expect(afterSettle.column).toBe("blocked"); // no verdict yet

  // plan-review's run is the current task.runId — inject the verdict now.
  // The run already resolved (that's why it blocked), so we're past its
  // fake-driver timer; the verdict goes into the events table for the
  // advancePipelineStage call that fires when we re-start via spawnStage.
  // Actually plan-review already resolved — we need to re-start it or
  // recover it. Instead, start the stage directly via startTask (which
  // is exactly what the "Retry stage" recovery banner does):
  // the new run's fake driver resolves ~20ms later; inject verdict before then.
  const planReviewRunId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(planReviewRunId, "assistant", "PIPELINE_VERDICT: approve");

  const decomposeRunId = await waitForNewRun(taskId, planReviewRunId);
  expect(tasks.get(taskId)!.pipelineStage).toBe("decompose");
  expect(tasks.get(taskId)!.planApproved).toBe(true);
  void decomposeRunId; // decompose isn't verdict-bearing; reaching it is the assertion
});

test("pipeline: testing pass reaches ready (planApproved already true by construction)", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p7", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "testing", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "All green.\nPIPELINE_VERDICT: pass");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("ready");
  expect(task.implementationApproved).toBe(true);
});

test("pipeline: testing fail under the cap bounces to building (not planning)", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p8", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "testing", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });
  await seedSatisfiedBarrier(taskId, workdir); // barrier met → the bounce is a fixup turn

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: fail 2 type errors remain");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("building"); // NOT planning
  expect(task.column).toBe("building");
  expect(task.implementationApproved).toBe(false);
  expect(task.revisionCount).toBe(1);
  expect(task.pipelineFeedback).toBe("testing: 2 type errors remain");
});

test("pipeline: no PIPELINE_VERDICT in the response blocks rather than guessing", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p9", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "plan-review", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "This plan looks fine to me.");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("blocked");
  expect(task.planApproved).toBe(false);
});

test("pipeline: pause lands the column on the next stage but does not spawn a run", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p10", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null,
    pausedAt: Date.now(), blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null, // paused before this stage's run even started
  });
  await seedSatisfiedBarrier(taskId, workdir);

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  // Lands where code-review WOULD be, so the card reflects "next up:
  // code-review" —
  expect(task.pipelineStage).toBe("code-review");
  expect(task.column).toBe("code-review");
  // — but no second run was spawned; only building's own run exists, and
  // task.runId still points at it (nothing clears it — there's no new run
  // to point to instead).
  const buildingRuns = runs.listForTask(taskId);
  expect(buildingRuns.length).toBe(1);
  expect(task.runId).toBe(buildingRuns[0]!.id);
});

test("pipeline: an ordinary (non-pipeline) task is completely unaffected", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(false);
  const created = await createTask({
    title: "ordinary", prompt: "just a normal task", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  expect(created.task.pipelineStage).toBeNull();

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("review"); // plain success -> review, exactly as before
  expect(task.pipelineStage).toBeNull();
  expect(runs.listForTask(taskId).length).toBe(1); // no auto-chaining
});

test("pipeline: pausePipelineTask errors on a non-pipeline task", async () => {
  const { createTask, pausePipelineTask } = await import("./orchestrator.ts");

  const workdir = await makeWorkdir(false);
  const created = await createTask({
    title: "ordinary-pause", prompt: "x", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);

  const result = pausePipelineTask(created.task.id);
  expect("error" in result).toBe(true);
});

test("pipeline: pausePipelineTask sets pausedAt; resumePipelineTask clears it and spawns the current stage", async () => {
  const { startTask, pausePipelineTask, resumePipelineTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p11", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    // "testing" (verdict-bearing, no verdict appended below) rather than
    // "building" — building's fake run resolves and auto-cascades straight
    // to testing within the settle window (no verdict gate to stop it),
    // which would make "exactly 1 run after resume" a race. testing with
    // no verdict deterministically blocks instead of cascading further.
    pipelineStage: "testing", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  const pauseResult = pausePipelineTask(taskId);
  if ("error" in pauseResult) throw new Error(pauseResult.error);
  expect(pauseResult.task.pausedAt).not.toBeNull();
  expect(runs.listForTask(taskId).length).toBe(0); // pausing before any run started spawns nothing

  // Pausing an already-paused task is a no-op, not an error.
  const secondPause = pausePipelineTask(taskId);
  expect("error" in secondPause).toBe(false);

  const resumeResult = await resumePipelineTask(taskId);
  if ("error" in resumeResult) throw new Error(resumeResult.error);
  expect(resumeResult.task.pausedAt).toBeNull();
  await settle();
  // Resuming with no active run starts the current stage (testing) — no
  // verdict was appended, so it deterministically blocks rather than
  // cascading further, giving a stable single-run assertion point.
  expect(runs.listForTask(taskId).length).toBe(1);
  expect(tasks.get(taskId)!.column).toBe("blocked");
});

test("pipeline: pause skips the auto-spawn of the NEXT stage, resume continues it", async () => {
  const { startTask, pausePipelineTask, resumePipelineTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p12", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });
  await seedSatisfiedBarrier(taskId, workdir);

  // Start building's own run, then pause WHILE it's still in flight — the
  // pause must not affect this run (it's already spawned), only the
  // auto-advance decision once it resolves.
  await startAndGetRunId(startTask, taskId);
  const paused = pausePipelineTask(taskId);
  if ("error" in paused) throw new Error(paused.error);
  await settle(); // let building's fake run resolve

  let task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("code-review"); // still computed and landed
  expect(task.column).toBe("code-review");
  expect(runs.listForTask(taskId).length).toBe(1); // code-review's run did NOT spawn

  const resumed = await resumePipelineTask(taskId);
  if ("error" in resumed) throw new Error(resumed.error);
  await settle();
  task = tasks.get(taskId)!;
  expect(runs.listForTask(taskId).length).toBe(2); // code-review's run spawned on resume
  expect(task.pausedAt).toBeNull();
});

test("pipeline: resumeInFlightBuilds picks up a parent mid-build after a restart and continues the DAG", async () => {
  // Simulates the boot-time gap resumeInFlightBuilds closes: reconcileOrphans
  // only finds tasks with an active RUN, but a parent mid-build (fresh-entry)
  // has none of its own — its TASKS.json on disk plus its children's
  // rows are the only record of where the build was. Here: "a" already
  // succeeded+merged before the (simulated) crash, "b" was never created —
  // a fresh resumeInFlightBuilds() call should create it.
  const { resumeInFlightBuilds } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(false);
  writeTasksPlan(workdir, {
    subtasks: [
      { id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: [] },
      { id: "b", title: "B", prompt: "do b", dependsOn: [], acceptanceCriteria: [] },
    ],
  });
  const now = Date.now();
  const parentId = crypto.randomUUID();
  tasks.insert({
    id: parentId, title: "p6", prompt: "x", column: "building", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });
  const childAId = crypto.randomUUID();
  tasks.insert({
    id: childAId, title: "p6 — A", prompt: "do a", column: "building", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: null, planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: parentId, planSubtaskId: "a", childMergeStatus: "merged",
  });

  // Not asserting the exact return value here: this file shares one
  // AGETOR_DATA_DIR across every test, and resumeInFlightBuilds() counts
  // every pipelineStage:"building" row in the whole db (including
  // already-blocked ones from earlier tests — pipelineStage deliberately
  // stays "building" on those too, for retry-ability; doTick's own guard
  // is what makes resuming them a safe no-op). The real assertion is the
  // concrete effect below: "b" actually gets created.
  resumeInFlightBuilds();
  await settle(150);

  const children = tasks.list().filter((t) => t.parentTaskId === parentId);
  expect(children.length).toBe(2);
  const b = children.find((c) => c.planSubtaskId === "b");
  expect(b).toBeDefined();
  // "a" (pre-existing, already merged) is untouched.
  expect(tasks.get(childAId)!.childMergeStatus).toBe("merged");
});

test("pipeline: resumeInFlightBuilds ignores archived and non-building tasks", async () => {
  // NOTE: this file shares one AGETOR_DATA_DIR across every test, so
  // resumeInFlightBuilds()'s return value reflects the WHOLE db's matching
  // rows, not just this test's own fixtures (earlier tests may have left
  // "building"-stage rows behind) — assert on this test's OWN rows staying
  // untouched, not on a global count.
  const { resumeInFlightBuilds } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(false);
  const now = Date.now();
  // An archived parent (should be ignored even though pipelineStage is
  // still "building" — same "archived means don't touch it" convention
  // used elsewhere).
  const archivedParentId = crypto.randomUUID();
  tasks.insert({
    id: archivedParentId, title: "archived-build", prompt: "x", column: "building", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: now,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });
  // A child task (parentTaskId set) sitting in "building" — must not be
  // mistaken for a top-level parent mid-build.
  const someChildId = crypto.randomUUID();
  tasks.insert({
    id: someChildId, title: "some-child", prompt: "x", column: "building", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: null, planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: crypto.randomUUID(), planSubtaskId: "x", childMergeStatus: "pending",
  });

  resumeInFlightBuilds();
  await settle(150);

  // Neither fixture should have triggered any tickBuild side effect: the
  // archived parent gets no children, and the "child" row (which has no
  // TASKS.json / isn't a real building parent) is untouched.
  expect(tasks.list().filter((t) => t.parentTaskId === archivedParentId).length).toBe(0);
  expect(tasks.get(someChildId)!.column).toBe("building");
  expect(tasks.get(someChildId)!.childMergeStatus).toBe("pending");
});

// --- S2: resolveRunModel — model tiering for verdict-only pipeline stages ----

test("resolveRunModel: verdict stages on claude-code return sonnet-5", async () => {
  const { resolveRunModel } = await import("./orchestrator.ts");
  const base: Parameters<typeof resolveRunModel>[0] = {
    id: "t", title: "", prompt: "", column: "plan-review", agent: "claude-code",
    workdir: "/tmp", isolation: "worktree", taskType: "task", branch: null,
    branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "opus-5", effort: null,
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: 0, updatedAt: 0, archivedAt: null,
    pipelineStage: "plan-review", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  };
  expect(resolveRunModel({ ...base, pipelineStage: "plan-review" }, "claude-code")).toBe("sonnet-5");
  expect(resolveRunModel({ ...base, pipelineStage: "code-review" }, "claude-code")).toBe("sonnet-5");
  expect(resolveRunModel({ ...base, pipelineStage: "testing" }, "claude-code")).toBe("sonnet-5");
});

test("resolveRunModel: artifact stages on claude-code return task.model unchanged", async () => {
  const { resolveRunModel } = await import("./orchestrator.ts");
  const base: Parameters<typeof resolveRunModel>[0] = {
    id: "t", title: "", prompt: "", column: "specify", agent: "claude-code",
    workdir: "/tmp", isolation: "worktree", taskType: "task", branch: null,
    branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "opus-5", effort: null,
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: 0, updatedAt: 0, archivedAt: null,
    pipelineStage: "specify", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  };
  for (const stage of ["specify", "clarify", "planning", "decompose", "building"] as const) {
    expect(resolveRunModel({ ...base, pipelineStage: stage }, "claude-code")).toBe("opus-5");
  }
});

test("resolveRunModel: non-pipeline claude-code task returns task.model", async () => {
  const { resolveRunModel } = await import("./orchestrator.ts");
  const base: Parameters<typeof resolveRunModel>[0] = {
    id: "t", title: "", prompt: "", column: "running", agent: "claude-code",
    workdir: "/tmp", isolation: "worktree", taskType: "task", branch: null,
    branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "opus-5", effort: null,
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: 0, updatedAt: 0, archivedAt: null,
    pipelineStage: null, planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  };
  expect(resolveRunModel(base, "claude-code")).toBe("opus-5");
});

test("resolveRunModel: verdict stages on codex/gemini are NOT overridden", async () => {
  const { resolveRunModel } = await import("./orchestrator.ts");
  const base: Parameters<typeof resolveRunModel>[0] = {
    id: "t", title: "", prompt: "", column: "plan-review", agent: "codex",
    workdir: "/tmp", isolation: "worktree", taskType: "task", branch: null,
    branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "gpt-5.5", effort: null,
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: 0, updatedAt: 0, archivedAt: null,
    pipelineStage: "plan-review", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  };
  expect(resolveRunModel({ ...base, agent: "codex" }, "codex")).toBe("gpt-5.5");
  expect(resolveRunModel({ ...base, agent: "gemini", model: "gemini-3-pro-preview" }, "gemini")).toBe("gemini-3-pro-preview");
});

test("pipeline: restarting a revision-capped task blocks again WITHOUT growing the counter past cap+1", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { PIPELINE_REVISION_CAP } = await import("../shared/types.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "p-clamp", prompt: "x", column: "blocked", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "testing", planApproved: true, implementationApproved: false,
    // Already over the cap — the 2DOT2DOT task was restarted seventeen
    // times from this exact state and counted up to 23.
    revisionCount: PIPELINE_REVISION_CAP + 1, pipelineFeedback: null, pausedAt: null,
    blockReason: "revision-cap", parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });
  await seedSatisfiedBarrier(taskId, workdir);

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: fail still broken");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("blocked");
  expect(task.blockReason).toBe("revision-cap");
  expect(task.revisionCount).toBe(PIPELINE_REVISION_CAP + 1); // clamped, not 8, 9, …23
});
