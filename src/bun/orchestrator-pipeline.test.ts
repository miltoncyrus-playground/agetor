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

async function makeWorkdir(withPlan: boolean): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-wd-"));
  if (withPlan) writeFileSync(path.join(dir, "PLAN.md"), "# Plan\n\nDo the thing.\n");
  return dir;
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

test("pipeline: planning success with PLAN.md present auto-advances to plan-review and spawns a new run", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const workdir = await makeWorkdir(true);
  const created = await createTask({
    title: "p1", prompt: "add dark mode", agent: "claude-code",
    workdir, isolation: "none", taskType: "task", pipeline: true,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  expect(created.task.pipelineStage).toBe("planning");

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("plan-review");
  expect(task.column).toBe("plan-review");
  expect(runs.listForTask(taskId).length).toBe(2); // planning's run + the auto-spawned plan-review run
});

test("pipeline: planning success WITHOUT PLAN.md blocks instead of advancing", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const workdir = await makeWorkdir(false);
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
  expect(task.pipelineStage).toBe("planning");
});

test("pipeline: plan-review approve advances to building and sets planApproved", async () => {
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "plan-review", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "Looks good.\n\nPIPELINE_VERDICT: approve");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("building");
  expect(task.column).toBe("building");
  expect(task.planApproved).toBe(true);
  expect(runs.listForTask(taskId).length).toBe(2);
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    // Simulates a re-planning pass after testing had already passed once.
    pipelineStage: "plan-review", planApproved: false, implementationApproved: true,
    revisionCount: 1, pipelineFeedback: null, pausedAt: null,
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "plan-review", planApproved: true, implementationApproved: false,
    revisionCount: 1, pipelineFeedback: null, pausedAt: null,
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    // Already at the cap — one more revise must block, not loop a 5th time.
    pipelineStage: "plan-review", planApproved: true, implementationApproved: false,
    revisionCount: 4, pipelineFeedback: null, pausedAt: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: revise still not right");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.column).toBe("blocked");
  expect(task.revisionCount).toBe(5);
  // Stays at plan-review — the cap block doesn't fabricate a stage change.
  expect(task.pipelineStage).toBe("plan-review");
});

test("pipeline: building success (not verdict-bearing) advances straight to testing", async () => {
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: "prior tester feedback", pausedAt: null,
  });

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("testing");
  expect(task.column).toBe("testing");
  expect(task.pipelineFeedback).toBeNull(); // consumed
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "testing", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null,
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "testing", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null,
  });

  const runId = await startAndGetRunId(startTask, taskId);
  runs.appendEvent(runId, "assistant", "PIPELINE_VERDICT: fail 2 type errors remain");
  await settle();

  const task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("building"); // NOT planning
  expect(task.column).toBe("building");
  expect(task.implementationApproved).toBe(false);
  expect(task.revisionCount).toBe(1);
  expect(task.pipelineFeedback).toBe("2 type errors remain");
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "plan-review", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null,
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null,
    pausedAt: Date.now(), // paused before this stage's run even started
  });

  await startAndGetRunId(startTask, taskId);
  await settle();

  const task = tasks.get(taskId)!;
  // Lands where testing WOULD be, so the card reflects "next up: testing" —
  expect(task.pipelineStage).toBe("testing");
  expect(task.column).toBe("testing");
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    // "testing" (verdict-bearing, no verdict appended below) rather than
    // "building" — building's fake run resolves and auto-cascades straight
    // to testing within the settle window (no verdict gate to stop it),
    // which would make "exactly 1 run after resume" a race. testing with
    // no verdict deterministically blocks instead of cascading further.
    pipelineStage: "testing", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null,
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
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "building", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null,
  });

  // Start building's own run, then pause WHILE it's still in flight — the
  // pause must not affect this run (it's already spawned), only the
  // auto-advance decision once it resolves.
  await startAndGetRunId(startTask, taskId);
  const paused = pausePipelineTask(taskId);
  if ("error" in paused) throw new Error(paused.error);
  await settle(); // let building's fake run resolve

  let task = tasks.get(taskId)!;
  expect(task.pipelineStage).toBe("testing"); // still computed and landed
  expect(task.column).toBe("testing");
  expect(runs.listForTask(taskId).length).toBe(1); // testing's run did NOT spawn

  const resumed = await resumePipelineTask(taskId);
  if ("error" in resumed) throw new Error(resumed.error);
  await settle();
  task = tasks.get(taskId)!;
  expect(runs.listForTask(taskId).length).toBe(2); // testing's run spawned on resume
  expect(task.pausedAt).toBeNull();
});
