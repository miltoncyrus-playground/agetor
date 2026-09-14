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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "Looks good.\n\nPIPELINE_VERDICT: approve");
  // Assert the instant the next stage's run is spawned (deterministic —
  // `runId` flips synchronously in startTask's persist transaction, strictly
  // before that run's own fake-driver timer is armed), not after a fixed
  // settle() — otherwise the auto-spawned decompose run's own ~20ms fake
  // resolve (no TASKS.json yet) can race in first and block the task before
  // this assertion ever runs. See waitForNewRun's doc comment.
  await waitForNewRun(taskId, runId);

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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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

test("pipeline: plan-review approve goes straight to done when implementationApproved was already true", async () => {
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
    fast: false, maxMode: false, plans: [],
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: approve");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("done");
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
    fast: false, maxMode: false, plans: [],
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: revise the plan is missing error handling");
  // Deterministic — see waitForNewRun's doc comment: PLAN.md already exists
  // (makeWorkdir(true)), so the auto-spawned planning run's own fake resolve
  // would otherwise race ahead to plan-review again before this assertion runs.
  await waitForNewRun(taskId, runId);

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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "Looks correct.\n\nPIPELINE_VERDICT: approve");
  // Deterministic — see waitForNewRun's doc comment: the auto-spawned testing
  // run's own fake resolve carries no PIPELINE_VERDICT and would otherwise
  // race ahead and block the task before this assertion runs.
  await waitForNewRun(taskId, runId);

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
    fast: false, maxMode: false, plans: [],
  });
  await seedSatisfiedBarrier(taskId, workdir); // barrier met → the bounce is a fixup turn

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: revise the error handling swallows the exception silently");
  // Deterministic — see waitForNewRun's doc comment: the barrier is already
  // satisfied, so the auto-spawned building run's own fake resolve would
  // otherwise race ahead to code-review again before this assertion runs.
  await waitForNewRun(taskId, runId);

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

test("pipeline: testing pass reaches done (planApproved already true by construction)", async () => {
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
    fast: false, maxMode: false, plans: [],
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "All green.\nPIPELINE_VERDICT: pass");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("done");
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
    fast: false, maxMode: false, plans: [],
  });
  await seedSatisfiedBarrier(taskId, workdir); // barrier met → the bounce is a fixup turn

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: fail 2 type errors remain");
  // Deterministic — see waitForNewRun's doc comment: the barrier is already
  // satisfied, so the auto-spawned building run's own fake resolve would
  // otherwise race ahead to code-review again before this assertion runs.
  await waitForNewRun(taskId, runId);

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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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
    fast: false, maxMode: false, plans: [],
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

// ─── lean-context selection (O-1/O-2) ────────────────────────────────────────

test("pipelineLeanContext: pipeline stage on claude-code gets the stage toolset and the worktree CLAUDE.md when present", async () => {
  const { pipelineLeanContext } = await import("./orchestrator.ts");
  const base: Parameters<typeof pipelineLeanContext>[0] = {
    id: "t", title: "", prompt: "", column: "planning", agent: "claude-code",
    workdir: "/tmp", isolation: "worktree", taskType: "task", branch: null,
    branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "opus-5", effort: null,
    fast: false, maxMode: false, plans: [],
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: 0, updatedAt: 0, archivedAt: null,
    pipelineStage: "planning", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  };
  const withMd = await makeWorkdir(false);
  writeFileSync(path.join(withMd, "CLAUDE.md"), "# repo rules\n");
  const withoutMd = await makeWorkdir(false);

  const lean = pipelineLeanContext(base, "claude-code", withMd);
  expect(lean?.tools).toEqual(["Read", "Edit", "Write", "Bash", "Grep", "Glob"]);
  expect(lean?.appendSystemPromptFile).toBe(path.join(withMd, "CLAUDE.md"));
  expect(pipelineLeanContext(base, "claude-code", withoutMd)?.appendSystemPromptFile).toBeNull();
  // clarify is the one stage that talks to the human.
  expect(pipelineLeanContext({ ...base, pipelineStage: "clarify" }, "claude-code", withoutMd)?.tools).toContain("AskUserQuestion");
  // A build child (no stage, has a parent) is a pipeline turn too.
  expect(pipelineLeanContext({ ...base, pipelineStage: null, parentTaskId: "parent" }, "claude-code", withoutMd)?.tools).toEqual(["Read", "Edit", "Write", "Bash", "Grep", "Glob"]);
});

test("pipelineLeanContext: plain tasks, codex/gemini, and AGETOR_PIPELINE_LEAN_CONTEXT=0 all get null (full-context spawn)", async () => {
  const { pipelineLeanContext } = await import("./orchestrator.ts");
  const base: Parameters<typeof pipelineLeanContext>[0] = {
    id: "t", title: "", prompt: "", column: "planning", agent: "claude-code",
    workdir: "/tmp", isolation: "worktree", taskType: "task", branch: null,
    branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "opus-5", effort: null,
    fast: false, maxMode: false, plans: [],
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: 0, updatedAt: 0, archivedAt: null,
    pipelineStage: "planning", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  };
  expect(pipelineLeanContext({ ...base, pipelineStage: null }, "claude-code", "/tmp")).toBeNull();
  expect(pipelineLeanContext(base, "codex", "/tmp")).toBeNull();
  expect(pipelineLeanContext(base, "gemini", "/tmp")).toBeNull();
  const prior = process.env.AGETOR_PIPELINE_LEAN_CONTEXT;
  try {
    process.env.AGETOR_PIPELINE_LEAN_CONTEXT = "0";
    expect(pipelineLeanContext(base, "claude-code", "/tmp")).toBeNull();
  } finally {
    if (prior === undefined) delete process.env.AGETOR_PIPELINE_LEAN_CONTEXT; else process.env.AGETOR_PIPELINE_LEAN_CONTEXT = prior;
  }
});

// ─── trimmed CLAUDE.md for pipeline/child sessions (O-14) ────────────────────

const O14_FIXTURE = `# repo rules

### Agent command shape

Intro paragraph.

- **\`claude-code\`** → claude-code guidance line.
- **\`codex\`** → codex guidance line.
- **\`cursor\`** → cursor guidance line.
- **\`gemini\`** → gemini guidance line.
- **\`fx\`** → fx guidance line.

### Claude session lifecycle

Lifecycle prose that must survive.

## JubarteAI Agent Identity

This repository participates in the JubarteAI agent fleet.

### Never

Some never-do list, running to end of file.
`;

test("resolvePipelineSystemPromptFile: writes a filtered copy under <cwd>/.agetor containing only the requested kind's bullet, no JubarteAI heading", async () => {
  const { resolvePipelineSystemPromptFile } = await import("./orchestrator.ts");
  const cwd = await makeWorkdir(false);
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  writeFileSync(claudeMdPath, O14_FIXTURE);

  const out = resolvePipelineSystemPromptFile(claudeMdPath, "claude-code", cwd);
  expect(out).not.toBeNull();
  expect(out).not.toBe(claudeMdPath);
  expect(out!.startsWith(path.join(cwd, ".agetor"))).toBe(true);

  const { existsSync, readFileSync } = await import("node:fs");
  expect(existsSync(out!)).toBe(true);
  const content = readFileSync(out!, "utf8");
  expect(content).toContain("claude-code guidance line");
  expect(content).not.toContain("codex guidance line");
  expect(content).not.toContain("cursor guidance line");
  expect(content).not.toContain("gemini guidance line");
  expect(content).not.toContain("fx guidance line");
  expect(content).not.toContain("## JubarteAI Agent Identity");
  expect(content).toContain("Lifecycle prose that must survive.");
});

test("resolvePipelineSystemPromptFile: null claudeMdPath passes through as null", async () => {
  const { resolvePipelineSystemPromptFile } = await import("./orchestrator.ts");
  expect(resolvePipelineSystemPromptFile(null, "claude-code", "/tmp")).toBeNull();
});

test("resolvePipelineSystemPromptFile: AGETOR_PIPELINE_CLAUDE_MD_FILTER=0 restores the raw path unfiltered", async () => {
  const { resolvePipelineSystemPromptFile } = await import("./orchestrator.ts");
  const cwd = await makeWorkdir(false);
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  writeFileSync(claudeMdPath, O14_FIXTURE);

  const prior = process.env.AGETOR_PIPELINE_CLAUDE_MD_FILTER;
  try {
    process.env.AGETOR_PIPELINE_CLAUDE_MD_FILTER = "0";
    expect(resolvePipelineSystemPromptFile(claudeMdPath, "claude-code", cwd)).toBe(claudeMdPath);
  } finally {
    if (prior === undefined) delete process.env.AGETOR_PIPELINE_CLAUDE_MD_FILTER; else process.env.AGETOR_PIPELINE_CLAUDE_MD_FILTER = prior;
  }
});

test("pipeline: startTask on a pipeline claude-code task writes a filtered CLAUDE.md for spawn; a non-pipeline task does not", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { existsSync, readFileSync } = await import("node:fs");

  // Pipeline task: pipelineStage set via createTask(pipeline: true) + SPEC/PLAN
  // so `specify` succeeds and the task actually reaches a stage that spawns
  // a claude-code turn; pipelineLeanContext only kicks in once pipelineStage
  // is non-null, which is true from creation.
  const pipelineWorkdir = await makeWorkdir(true);
  writeFileSync(path.join(pipelineWorkdir, "CLAUDE.md"), O14_FIXTURE);
  const createdPipeline = await createTask({
    title: "o14-pipeline", prompt: "add dark mode", agent: "claude-code",
    workdir: pipelineWorkdir, isolation: "none", taskType: "task", pipeline: true,
  });
  if ("error" in createdPipeline) throw new Error(createdPipeline.error);
  await startAndGetRunId(startTask, createdPipeline.task.id);

  const pipelineFilteredPath = path.join(pipelineWorkdir, ".agetor", "CLAUDE.filtered.md");
  expect(existsSync(pipelineFilteredPath)).toBe(true);
  const pipelineFiltered = readFileSync(pipelineFilteredPath, "utf8");
  expect(pipelineFiltered).toContain("claude-code guidance line");
  expect(pipelineFiltered).not.toContain("codex guidance line");
  expect(pipelineFiltered).not.toContain("## JubarteAI Agent Identity");

  // Non-pipeline task: pipelineLeanContext returns null (no pipelineStage, no
  // parentTaskId), so resolvePipelineSystemPromptFile is never invoked and no
  // filtered file is written — ordinary tasks are unaffected.
  const plainWorkdir = await makeWorkdir(false);
  writeFileSync(path.join(plainWorkdir, "CLAUDE.md"), O14_FIXTURE);
  const createdPlain = await createTask({
    title: "o14-plain", prompt: "add dark mode", agent: "claude-code",
    workdir: plainWorkdir, isolation: "none", taskType: "task",
  });
  if ("error" in createdPlain) throw new Error(createdPlain.error);
  await startAndGetRunId(startTask, createdPlain.task.id);

  expect(existsSync(path.join(plainWorkdir, ".agetor", "CLAUDE.filtered.md"))).toBe(false);
});

// ─── stage/file-gated CLAUDE.md trimming (O-15) ──────────────────────────────

test("subtaskFilesForChild: returns the subtask's own files array when present", async () => {
  const { subtaskFilesForChild } = await import("./build-scheduler.ts");
  const dir = await makeWorkdir(false);
  writeTasksPlan(dir, {
    subtasks: [
      { id: "s1", title: "S1", prompt: "do s1", dependsOn: [], acceptanceCriteria: [], files: ["src/bun/foo.ts", "src/bun/bar.ts"] },
    ],
  });
  const parent = { worktreePath: dir, workdir: dir } as import("../shared/types.ts").Task;
  expect(subtaskFilesForChild(parent, "s1")).toEqual(["src/bun/foo.ts", "src/bun/bar.ts"]);
});

test("subtaskFilesForChild: null when files is empty or omitted", async () => {
  const { subtaskFilesForChild } = await import("./build-scheduler.ts");
  const dir = await makeWorkdir(false);
  writeTasksPlan(dir, {
    subtasks: [
      { id: "s1", title: "S1", prompt: "do s1", dependsOn: [], acceptanceCriteria: [], files: [] },
      { id: "s2", title: "S2", prompt: "do s2", dependsOn: [], acceptanceCriteria: [] },
    ],
  });
  const parent = { worktreePath: dir, workdir: dir } as import("../shared/types.ts").Task;
  expect(subtaskFilesForChild(parent, "s1")).toBeNull();
  expect(subtaskFilesForChild(parent, "s2")).toBeNull();
});

test("subtaskFilesForChild: null for an unknown subtaskId", async () => {
  const { subtaskFilesForChild } = await import("./build-scheduler.ts");
  const dir = await makeWorkdir(false);
  writeTasksPlan(dir, {
    subtasks: [{ id: "s1", title: "S1", prompt: "do s1", dependsOn: [], acceptanceCriteria: [], files: ["src/bun/foo.ts"] }],
  });
  const parent = { worktreePath: dir, workdir: dir } as import("../shared/types.ts").Task;
  expect(subtaskFilesForChild(parent, "nope")).toBeNull();
});

test("subtaskFilesForChild: null when TASKS.json is missing or invalid", async () => {
  const { subtaskFilesForChild } = await import("./build-scheduler.ts");
  const missingDir = await makeWorkdir(false);
  const parentMissing = { worktreePath: missingDir, workdir: missingDir } as import("../shared/types.ts").Task;
  expect(subtaskFilesForChild(parentMissing, "s1")).toBeNull();

  const invalidDir = await makeWorkdir(false);
  writeFileSync(path.join(invalidDir, "TASKS.json"), "{ not json");
  const parentInvalid = { worktreePath: invalidDir, workdir: invalidDir } as import("../shared/types.ts").Task;
  expect(subtaskFilesForChild(parentInvalid, "s1")).toBeNull();
});

test("parseReviewDiffStatPaths: parses a plain line, a rename, a brace-rename, and skips a malformed line", async () => {
  const { parseReviewDiffStatPaths } = await import("./orchestrator.ts");
  const stat = [
    " src/bun/foo.ts | 5 +++--",
    " src/bun/old.ts => src/bun/new.ts | 3 +--",
    " src/bun/{old => new}/thing.ts | 2 ++",
    "this line has no pipe at all",
  ].join("\n");
  const paths = parseReviewDiffStatPaths(stat);
  expect(paths).toContain("src/bun/foo.ts");
  expect(paths).toContain("src/bun/old.ts");
  expect(paths).toContain("src/bun/new.ts");
  expect(paths).toContain("src/bun/old/thing.ts");
  expect(paths).toContain("src/bun/new/thing.ts");
  expect(paths).not.toContain("this line has no pipe at all");
});

test("pipelineOverlapFiles: a build child resolves via subtaskFilesForChild", async () => {
  const { pipelineOverlapFiles, createTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(false);
  writeTasksPlan(workdir, {
    subtasks: [{ id: "s1", title: "S1", prompt: "do s1", dependsOn: [], acceptanceCriteria: [], files: ["src/bun/foo.ts"] }],
  });
  const createdParent = await createTask({
    title: "o15-parent", prompt: "x", agent: "claude-code", workdir, isolation: "none", taskType: "task", pipeline: true,
  });
  if ("error" in createdParent) throw new Error(createdParent.error);
  const parentId = createdParent.task.id;

  const now = Date.now();
  const child = {
    ...tasks.get(parentId)!,
    id: crypto.randomUUID(),
    parentTaskId: parentId,
    planSubtaskId: "s1",
    pipelineStage: null,
    worktreePath: workdir,
    workdir,
    createdAt: now,
    updatedAt: now,
  };
  expect(pipelineOverlapFiles(child, null)).toEqual(["src/bun/foo.ts"]);
});

test("pipelineOverlapFiles: a code-review task resolves via extras.reviewDiff.stat", async () => {
  const { pipelineOverlapFiles, createTask } = await import("./orchestrator.ts");
  const workdir = await makeWorkdir(false);
  const created = await createTask({
    title: "o15-review", prompt: "x", agent: "claude-code", workdir, isolation: "none", taskType: "task", pipeline: true,
  });
  if ("error" in created) throw new Error(created.error);
  const task = { ...created.task, pipelineStage: "code-review" as const };
  const extras = {
    reviewDiff: {
      file: "/tmp/x.diff", bytes: 10, sinceSha: "a", headSha: "b", empty: false,
      stat: " src/bun/foo.ts | 5 +++--\n src/mainview/App.tsx | 2 ++",
    },
  };
  expect(pipelineOverlapFiles(task, extras)).toEqual(["src/bun/foo.ts", "src/mainview/App.tsx"]);
});

test("pipelineOverlapFiles: testing/building (or any non-matching task) returns null without touching extras beyond the code-review check", async () => {
  const { pipelineOverlapFiles, createTask } = await import("./orchestrator.ts");
  const workdir = await makeWorkdir(false);
  const created = await createTask({
    title: "o15-testing", prompt: "x", agent: "claude-code", workdir, isolation: "none", taskType: "task", pipeline: true,
  });
  if ("error" in created) throw new Error(created.error);

  const testingTask = { ...created.task, pipelineStage: "testing" as const };
  // extras.reviewDiff is populated on purpose — if pipelineOverlapFiles read
  // it for a non-code-review stage it would wrongly return a non-null list.
  const extrasWithReviewDiff = {
    reviewDiff: { file: "/tmp/x.diff", bytes: 10, sinceSha: "a", headSha: "b", empty: false, stat: " src/bun/foo.ts | 1 +" },
  };
  expect(pipelineOverlapFiles(testingTask, extrasWithReviewDiff)).toBeNull();

  const buildingTask = { ...created.task, pipelineStage: "building" as const };
  expect(pipelineOverlapFiles(buildingTask, extrasWithReviewDiff)).toBeNull();
});

const O15_ORCHESTRATION_FLOW = `

### Orchestration flow

1. **Item one** intro prose.
2. **Item two** intro prose.
3. **Item three** intro prose.
4. **Item four** intro prose.
5. **Task context menu** — see \`src/mainview/lib/task-context-menu.ts\`.
6. **Filler six** prose.
7. **Filler seven** prose.
8. **Filler eight** prose.
9. **Tasks from issues** — see \`src/shared/issue-task.ts\`.
10. **Shared task-composition modules** — see \`src/mainview/components/kanban/PromptComposer.tsx\`.
11. **\`@\` file references** — see \`src/shared/at-refs.ts\`.
12. **Filler twelve** prose.
13. **Filler thirteen** prose, running to end of section.
`;

const O15_FIXTURE = `# repo rules

### Agent command shape

Intro paragraph.

- **\`claude-code\`** → claude-code guidance line.
- **\`codex\`** → codex guidance line.

### Claude session lifecycle

Lifecycle prose that must survive.
${O15_ORCHESTRATION_FLOW}
## JubarteAI Agent Identity

This repository participates in the JubarteAI agent fleet.

### Never

Some never-do list, running to end of file.
`;

test("resolvePipelineSystemPromptFile (4-arg): a specify-stage call drops items 5-13 of Orchestration flow entirely", async () => {
  const { resolvePipelineSystemPromptFile } = await import("./orchestrator.ts");
  const { readFileSync } = await import("node:fs");
  const cwd = await makeWorkdir(false);
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  writeFileSync(claudeMdPath, O15_FIXTURE);

  const out = resolvePipelineSystemPromptFile(claudeMdPath, "claude-code", cwd, { pipelineStage: "specify", isChild: false, files: null });
  expect(out).not.toBeNull();
  const content = readFileSync(out!, "utf8");
  expect(content).toContain("Item one");
  expect(content).toContain("Item four");
  expect(content).not.toContain("Task context menu");
  expect(content).not.toContain("Tasks from issues");
  expect(content).not.toContain("Shared task-composition modules");
  expect(content).not.toContain("`@` file references");
  expect(content).not.toContain("Filler six");
  expect(content).not.toContain("Filler thirteen");
});

test("resolvePipelineSystemPromptFile (4-arg): code-review with non-overlapping files drops only the four filterable items", async () => {
  const { resolvePipelineSystemPromptFile } = await import("./orchestrator.ts");
  const { readFileSync } = await import("node:fs");
  const cwd = await makeWorkdir(false);
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  writeFileSync(claudeMdPath, O15_FIXTURE);

  const out = resolvePipelineSystemPromptFile(claudeMdPath, "claude-code", cwd, {
    pipelineStage: "code-review",
    isChild: false,
    files: ["src/bun/unrelated.ts"],
  });
  expect(out).not.toBeNull();
  const content = readFileSync(out!, "utf8");
  expect(content).toContain("Item one");
  expect(content).toContain("Filler six");
  expect(content).toContain("Filler thirteen");
  expect(content).not.toContain("Task context menu");
  expect(content).not.toContain("Tasks from issues");
  expect(content).not.toContain("Shared task-composition modules");
  expect(content).not.toContain("`@` file references");
});

test("resolvePipelineSystemPromptFile (4-arg): testing/building with no files keeps everything", async () => {
  const { resolvePipelineSystemPromptFile } = await import("./orchestrator.ts");
  const { readFileSync } = await import("node:fs");

  for (const stage of ["testing", "building"] as const) {
    const cwd = await makeWorkdir(false);
    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    writeFileSync(claudeMdPath, O15_FIXTURE);
    const out = resolvePipelineSystemPromptFile(claudeMdPath, "claude-code", cwd, { pipelineStage: stage, isChild: false, files: null });
    expect(out).not.toBeNull();
    const content = readFileSync(out!, "utf8");
    expect(content).toContain("Task context menu");
    expect(content).toContain("Tasks from issues");
    expect(content).toContain("Shared task-composition modules");
    expect(content).toContain("`@` file references");
  }
});

test("resolvePipelineSystemPromptFile (4-arg): building+isChild with partially-overlapping files keeps only the overlapping item", async () => {
  const { resolvePipelineSystemPromptFile } = await import("./orchestrator.ts");
  const { readFileSync } = await import("node:fs");
  const cwd = await makeWorkdir(false);
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  writeFileSync(claudeMdPath, O15_FIXTURE);

  const out = resolvePipelineSystemPromptFile(claudeMdPath, "claude-code", cwd, {
    pipelineStage: null,
    isChild: true,
    files: ["src/shared/issue-task.ts"],
  });
  expect(out).not.toBeNull();
  const content = readFileSync(out!, "utf8");
  expect(content).not.toContain("Task context menu");
  expect(content).toContain("Tasks from issues");
  expect(content).not.toContain("Shared task-composition modules");
  expect(content).not.toContain("`@` file references");
});

test("pipeline: a build-child spawn writes a filtered CLAUDE.md dropping non-overlapping filterable items and keeping the overlapping one", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { existsSync, readFileSync } = await import("node:fs");

  const workdir = await makeWorkdir(false);
  writeFileSync(path.join(workdir, "CLAUDE.md"), O15_FIXTURE);
  writeTasksPlan(workdir, {
    subtasks: [{ id: "s1", title: "S1", prompt: "do s1", dependsOn: [], acceptanceCriteria: [], files: ["src/shared/issue-task.ts"] }],
  });

  const createdParent = await createTask({
    title: "o15-child-parent", prompt: "x", agent: "claude-code", workdir, isolation: "none", taskType: "task", pipeline: true,
  });
  if ("error" in createdParent) throw new Error(createdParent.error);

  const createdChild = await createTask({
    title: "o15-child", prompt: "implement s1", agent: "claude-code", workdir, isolation: "none", taskType: "task",
    column: "building", parentTaskId: createdParent.task.id, planSubtaskId: "s1",
  });
  if ("error" in createdChild) throw new Error(createdChild.error);

  await startAndGetRunId(startTask, createdChild.task.id);

  const filteredPath = path.join(workdir, ".agetor", "CLAUDE.filtered.md");
  expect(existsSync(filteredPath)).toBe(true);
  const content = readFileSync(filteredPath, "utf8");
  expect(content).not.toContain("Task context menu");
  expect(content).toContain("Tasks from issues");
  expect(content).not.toContain("Shared task-composition modules");
  expect(content).not.toContain("`@` file references");
});

test("pipeline: a testing-stage spawn keeps all four filterable Orchestration-flow items", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { existsSync, readFileSync } = await import("node:fs");

  const workdir = await makeWorkdir(true);
  writeFileSync(path.join(workdir, "CLAUDE.md"), O15_FIXTURE);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "o15-testing-spawn", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    fast: false, maxMode: false, plans: [],
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "testing", planApproved: true, implementationApproved: true,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  await startAndGetRunId(startTask, taskId);

  const filteredPath = path.join(workdir, ".agetor", "CLAUDE.filtered.md");
  expect(existsSync(filteredPath)).toBe(true);
  const content = readFileSync(filteredPath, "utf8");
  expect(content).toContain("Task context menu");
  expect(content).toContain("Tasks from issues");
  expect(content).toContain("Shared task-composition modules");
  expect(content).toContain("`@` file references");
});

// ─── stage session closed at settle (O-7) ────────────────────────────────────

test("pipeline: a settled stage's session is closed on advance and on done, recorded as a status event on the settled run", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "o7", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    fast: false, maxMode: false, plans: [],
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "code-review", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });

  // code-review approve → testing: the code-review session is closed.
  const reviewRunId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(reviewRunId, "assistant", "ok\nPIPELINE_VERDICT: approve");
  // The Tester run is auto-spawned; inject its verdict before the fake
  // driver's timer resolves it unverified (tight poll — see waitForNewRun).
  const testRunId = await waitForNewRun(taskId, reviewRunId);
  runs.appendEvent(testRunId, "assistant", "green\nPIPELINE_VERDICT: pass");
  expect(tasks.get(taskId)!.pipelineStage).toBe("testing");
  const reviewStatus = runs.events(reviewRunId).filter((e) => e.stream === "status").map((e) => e.data);
  expect(reviewStatus.some((d) => d.includes('stage "code-review" settled') && d.includes("session was closed"))).toBe(true);

  // testing pass → done: terminal, the tester session is closed too.
  await settle();
  expect(tasks.get(taskId)!.column).toBe("done");
  const testStatus = runs.events(testRunId).filter((e) => e.stream === "status").map((e) => e.data);
  expect(testStatus.some((d) => d.includes('stage "testing" settled') && d.includes("session was closed"))).toBe(true);
});

test("pipeline: a blocked stage keeps its session (no close status on a revise past the cap)", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { PIPELINE_REVISION_CAP } = await import("../shared/types.ts");

  const workdir = await makeWorkdir(true);
  const taskId = crypto.randomUUID();
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "o7-blocked", prompt: "x", column: "backlog", agent: "claude-code",
    workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    fast: false, maxMode: false, plans: [],
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "plan-review", planApproved: false, implementationApproved: false,
    revisionCount: PIPELINE_REVISION_CAP, pipelineFeedback: "old", pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });
  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: revise still wrong");
  await settle();
  expect(tasks.get(taskId)!.column).toBe("blocked");
  expect(runs.events(runId).some((e) => e.stream === "status" && e.data.includes("session was closed"))).toBe(false);
});
