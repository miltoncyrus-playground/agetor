import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tasks, runs } from "./db.ts";
import { createTask, startTask, spawnPipelineStage, blockPipelineTask, cancelSiblingChildren, archiveTask } from "./orchestrator.ts";
import { parseBuildPlan, childBuildPrompt, PIPELINE_BUILD_PLAN_FILE } from "./pipeline-prompts.ts";
import { mergeBranch, abortMerge } from "./worktree.ts";
import type { Task } from "../shared/types.ts";

/**
 * DAG scheduler for a "building" stage's FRESH entry (from pre-builder
 * success — see orchestrator.ts's advancePipelineStage, case "pre-builder").
 * Kept as its own file rather than folded into orchestrator.ts, mirroring
 * the existing one-concern-per-file split with pipeline-prompts.ts/
 * worktree.ts: this is DAG-walking + child-task orchestration, a distinct
 * concern from the run-lifecycle bookkeeping orchestrator.ts already owns.
 *
 * The DAG itself has no dedicated DB table — BUILD_PLAN.json on disk (parsed
 * fresh on every tick) is the static graph; the child Task rows already
 * created (`parentTaskId`/`planSubtaskId`/`childMergeStatus`) are the
 * dynamic execution state. This avoids inventing new persistence for
 * something the existing Task table plus a JSON worktree file already
 * cover — see the "search before building" note in the approved plan.
 *
 * Mutual import with orchestrator.ts (this file imports createTask/
 * startTask/spawnPipelineStage/blockPipelineTask from there; orchestrator.ts
 * calls tickBuild from here for the pre-builder->building fresh-entry
 * transition) is safe: every cross-call happens inside a function body at
 * request/event time, never at module top-level evaluation — a standard
 * ESM pattern, not a real cycle hazard.
 */

// Serializes tickBuild/completeChildBuild calls PER PARENT so two children
// finishing at once (or a merge racing a tick) can never double-create a
// child for the same subtask or interleave two merges into the same
// worktree. The stored promise never rejects (errors are swallowed into the
// chain, not propagated to the next enqueuer) so one failed tick doesn't
// wedge every later call for the same parent; the promise RETURNED to the
// caller still reflects the real outcome.
const parentQueues = new Map<string, Promise<void>>();

function runSerialized(parentTaskId: string, fn: () => Promise<void>): Promise<void> {
  const prior = parentQueues.get(parentTaskId) ?? Promise.resolve();
  const chained = prior.catch(() => {}).then(fn);
  parentQueues.set(parentTaskId, chained.catch(() => {}));
  return chained;
}

/**
 * Snapshot of a parent's build barrier: is every subtask declared in
 * TASKS.json backed by a `merged` child? This is THE gate every exit from
 * the "building" stage must consult (advancePipelineStage's `case
 * "building"` and `bounceOrBlock`'s building target) — the 2DOT2DOT
 * postmortem's root cause RC-2 was precisely that the building exit trusted
 * the caller's context ("a run ended, so building must be done") instead of
 * this state. Pure read: TASKS.json parsed fresh + child rows, no mutation.
 *
 * `"invalid"` (missing/unparseable TASKS.json) is a real anomaly, not a
 * soft case: building is only reachable through decompose, which committed
 * a validated TASKS.json — callers block on it rather than guessing.
 * `merge-deferred` children count as unmet: their work exists but hasn't
 * landed on the parent branch yet (the next `tickBuild` merges them first).
 */
export type BuildBarrierState =
  | { kind: "complete" }
  | { kind: "incomplete"; unmet: string[] }
  | { kind: "invalid"; reason: string };

export function buildBarrierState(parent: Task): BuildBarrierState {
  const planPath = join(parent.worktreePath ?? parent.workdir, PIPELINE_BUILD_PLAN_FILE);
  if (!existsSync(planPath)) {
    return { kind: "invalid", reason: `${PIPELINE_BUILD_PLAN_FILE} is missing` };
  }
  const parsed = parseBuildPlan(readFileSync(planPath, "utf8"));
  if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };
  const childBySubtaskId = new Map(
    tasks.list().filter((t) => t.parentTaskId === parent.id).map((c) => [c.planSubtaskId, c]),
  );
  const unmet = parsed.plan.subtasks
    .filter((s) => childBySubtaskId.get(s.id)?.childMergeStatus !== "merged")
    .map((s) => s.id);
  return unmet.length === 0 ? { kind: "complete" } : { kind: "incomplete", unmet };
}

/**
 * Merge one child's branch into the parent's worktree and record the
 * outcome. The single merge core `doCompleteChild` (live settle) and
 * `doTick` (deferred-child pickup) share, so the two paths can't drift.
 * Returns true when the merge landed (`childMergeStatus: "merged"`); false
 * means the build was aborted (conflict, or nothing to merge) — the parent
 * is already blocked and siblings cancelled by the time this returns.
 */
async function mergeChildIntoParent(child: Task, parent: Task): Promise<boolean> {
  if (!child.worktreePath || !child.branch) {
    // Isolation was off, or the worktree never materialized — nothing to
    // merge. Treated identically to a merge conflict: the build can't
    // proceed without this subtask's work landing in the parent branch.
    tasks.update(child.id, { childMergeStatus: "merge-failed", column: "blocked" });
    blockPipelineTask(
      parent.id, null, "pipeline-failed",
      `subtask "${child.planSubtaskId}" has no worktree/branch to merge`,
    );
    cancelSiblingChildren(parent.id);
    return false;
  }
  const parentWorktreePath = parent.worktreePath ?? parent.workdir;
  const result = await mergeBranch(parentWorktreePath, child.branch);
  if (!result.ok) {
    if (result.conflict) await abortMerge(parentWorktreePath);
    tasks.update(child.id, { childMergeStatus: "merge-failed", column: "blocked" });
    blockPipelineTask(
      parent.id, null, "pipeline-failed",
      `merge conflict on subtask "${child.planSubtaskId}": ${result.detail}`,
    );
    cancelSiblingChildren(parent.id);
    return false;
  }
  tasks.update(child.id, { childMergeStatus: "merged" });
  return true;
}

/**
 * Continue (or start) a parent's build: reads+parses BUILD_PLAN.json fresh
 * from its worktree, creates+starts any subtask whose dependencies are all
 * merged and that has no child row yet, and — once every declared subtask
 * has a merged child — advances the parent to "code-review". No-ops if the
 * parent isn't in an active "building" state (covers: task deleted, build
 * already aborted to `blocked`, or the barrier already completed and moved
 * on — a stale/duplicate trigger calling this again must not resurrect or
 * re-advance a build that's already settled).
 *
 * Fire-and-forget from every caller (orchestrator.ts's fresh-entry helper,
 * this file's own completeChildBuild below, and the M5 boot-resume pass) —
 * callers that need to know it's done can still await the returned promise;
 * nothing here throws past its own logging.
 */
export async function tickBuild(parentTaskId: string): Promise<void> {
  return runSerialized(parentTaskId, () => doTick(parentTaskId));
}

async function doTick(parentTaskId: string): Promise<void> {
  const parent = tasks.get(parentTaskId);
  // pipelineStage stays "building" even once blocked (so a human sees
  // where the build died) — column is the real "is this still active"
  // signal here, same distinction the rest of the pipeline draws.
  if (!parent || parent.pipelineStage !== "building" || parent.column !== "building") return;

  const planPath = join(parent.worktreePath ?? parent.workdir, PIPELINE_BUILD_PLAN_FILE);
  if (!existsSync(planPath)) {
    blockPipelineTask(parentTaskId, null, "pipeline-failed", `${PIPELINE_BUILD_PLAN_FILE} is missing`);
    return;
  }
  const parsed = parseBuildPlan(readFileSync(planPath, "utf8"));
  if (!parsed.ok) {
    blockPipelineTask(parentTaskId, null, "pipeline-failed", parsed.reason);
    return;
  }
  const { subtasks } = parsed.plan;

  // Pick up merge-deferred children FIRST — work that completed while the
  // parent was outside its active building state (see settleChildRun /
  // doCompleteChild). Their commits must land before the barrier below is
  // evaluated, so a bounce back into building resumes from everything that
  // actually got built rather than re-spawning subtasks whose work already
  // exists on a dangling branch. A conflict aborts the build exactly like a
  // live-settle merge would (mergeChildIntoParent blocks + cancels).
  for (const child of tasks.list().filter((t) => t.parentTaskId === parentTaskId)) {
    if (child.childMergeStatus !== "merge-deferred") continue;
    const parentNow = tasks.get(parentTaskId);
    if (!parentNow || parentNow.column !== "building") return;
    if (!(await mergeChildIntoParent(child, parentNow))) return;
  }

  const children = tasks.list().filter((t) => t.parentTaskId === parentTaskId);
  const childBySubtaskId = new Map(children.map((c) => [c.planSubtaskId, c]));

  const allMerged = subtasks.every((s) => childBySubtaskId.get(s.id)?.childMergeStatus === "merged");
  if (allMerged) {
    // `pipelineFeedback: null` — consumed on the building→code-review hop,
    // matching what the old advancePipelineStage `case "building"` did
    // before the barrier check moved that exit's decision here.
    spawnPipelineStage(parentTaskId, null, "code-review", { pipelineFeedback: null });
    // Every child's commits are already merged into the parent branch at
    // this point, so archiving them (which tears down their now-redundant
    // worktree/branch — archiveTask, not just a hide-from-board flag) loses
    // nothing: the merge commits carry the work forward regardless of
    // whether the source branch/worktree survives. `force` is required
    // since children are archived out of "building", not "done", which
    // archiveTask normally requires. Fire-and-forget — cleanup shouldn't
    // block or be blocked by the parent's own advance, which already
    // happened above.
    for (const child of children) {
      void archiveTask(child.id, { force: true, stopRun: true }).then((result) => {
        if ("error" in result) {
          console.error(`[agetor] failed to archive completed child ${child.id}:`, result.error);
        }
      });
    }
    return;
  }

  for (const subtask of subtasks) {
    if (childBySubtaskId.has(subtask.id)) continue; // already created (any state)
    const depsSatisfied = subtask.dependsOn.every(
      (depId) => childBySubtaskId.get(depId)?.childMergeStatus === "merged",
    );
    if (!depsSatisfied) continue;

    const created = await createTask({
      title: `${parent.title} — ${subtask.title}`,
      prompt: childBuildPrompt(parent, subtask),
      agent: parent.agent,
      workdir: parent.workdir,
      // Mirrors the parent's own isolation mode rather than hardcoding
      // "worktree" — in real usage a pipeline task is always
      // isolation:"worktree" (NewTaskForm force-couples the two), but
      // matching the parent keeps this correct rather than assumed, and
      // lets isolation:"none" orchestrator tests exercise the scheduler
      // without needing a real git repo.
      isolation: parent.isolation,
      taskType: parent.taskType,
      baseRef: parent.branch ?? undefined,
      mode: parent.mode,
      model: parent.model,
      effort: parent.effort,
      column: "building",
      parentTaskId,
      planSubtaskId: subtask.id,
    });
    if ("error" in created) {
      blockPipelineTask(
        parentTaskId, null, "pipeline-failed",
        `failed to create child for subtask "${subtask.id}": ${created.error}`,
      );
      return;
    }
    childBySubtaskId.set(subtask.id, created.task);
    // startTask signals failure by RESOLVING with { error }, not just by
    // rejecting — handle both (harness unavailable, bad workdir, etc. all
    // resolve this way; an unexpected internal throw would reject).
    void startTask(created.task.id).then(
      (result) => {
        if ("error" in result) {
          blockPipelineTask(
            parentTaskId, null, "pipeline-failed",
            `failed to start subtask "${subtask.id}": ${result.error}`,
          );
        }
      },
      (err) => {
        console.error(`[agetor] failed to start child task ${created.task.id} (subtask "${subtask.id}"):`, err);
        blockPipelineTask(
          parentTaskId, null, "pipeline-failed",
          `failed to start subtask "${subtask.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  }
}

/**
 * Called (from orchestrator.ts's `settleChildRun`) only when a CHILD's own
 * agent run succeeded — merges its branch back into the parent's branch
 * (a real, deterministic `git merge`, not an agent turn — see
 * worktree.ts's `mergeBranch`), then either continues the build (another
 * subtask may now be unblocked, or the barrier may now be complete) or, on
 * a conflict, aborts the whole build. Runs in the SAME per-parent
 * serialized slot `tickBuild` uses, so a merge and a tick for the same
 * parent can never interleave.
 */
export async function completeChildBuild(childTaskId: string): Promise<void> {
  const child = tasks.get(childTaskId);
  if (!child || !child.parentTaskId) return;
  const parentTaskId = child.parentTaskId;
  return runSerialized(parentTaskId, () => doCompleteChild(childTaskId, parentTaskId));
}

async function doCompleteChild(childTaskId: string, parentTaskId: string): Promise<void> {
  const child = tasks.get(childTaskId);
  const parent = tasks.get(parentTaskId);
  if (!child || !parent) return;
  // Parent no longer actively building — the build was aborted, blocked, or
  // has moved to a later stage. This used to be a silent `return`, which is
  // the 2DOT2DOT postmortem's RC-3: the child's completed work froze
  // invisibly on `column: "running"` / `childMergeStatus: "pending"` forever.
  // Now the work is explicitly parked: `merge-deferred` + `review` makes it
  // visible, a status event on the parent names it, and the next tickBuild
  // for this parent (a bounce back into building, or the building-exit
  // barrier check) merges it before deciding anything else.
  if (parent.pipelineStage !== "building" || parent.column !== "building") {
    tasks.update(childTaskId, { childMergeStatus: "merge-deferred", column: "review" });
    if (parent.runId) {
      const data =
        `subtask "${child.planSubtaskId}" completed after the build phase ended — ` +
        `merge deferred until the build resumes`;
      runs.appendEvent(parent.runId, "status", data);
    }
    return;
  }

  if (!(await mergeChildIntoParent(child, parent))) return;
  // Same serialized slot — call the inner function directly rather than
  // the exported `tickBuild` (which would enqueue a second, redundant slot
  // for this parent).
  await doTick(parentTaskId);
}
