import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tasks } from "./db.ts";
import { createTask, startTask, spawnPipelineStage, blockPipelineTask, cancelSiblingChildren, archiveTask } from "./orchestrator.ts";
import { parseBuildPlan, childBuildPrompt, PIPELINE_BUILD_PLAN_FILE } from "./pipeline-prompts.ts";
import { mergeBranch, abortMerge } from "./worktree.ts";

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

  const children = tasks.list().filter((t) => t.parentTaskId === parentTaskId);
  const childBySubtaskId = new Map(children.map((c) => [c.planSubtaskId, c]));

  const allMerged = subtasks.every((s) => childBySubtaskId.get(s.id)?.childMergeStatus === "merged");
  if (allMerged) {
    spawnPipelineStage(parentTaskId, null, "code-review");
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
  // Build already aborted or moved on (e.g. two children settling around
  // the same time, the first already triggered an abort) — nothing to do,
  // same guard doTick uses.
  if (parent.pipelineStage !== "building" || parent.column !== "building") return;

  if (!child.worktreePath || !child.branch) {
    // Isolation was off, or the worktree never materialized — nothing to
    // merge. Treated identically to a merge conflict: the build can't
    // proceed without this subtask's work landing in the parent branch.
    tasks.update(childTaskId, { childMergeStatus: "merge-failed", column: "blocked" });
    blockPipelineTask(
      parentTaskId, null, "pipeline-failed",
      `subtask "${child.planSubtaskId}" has no worktree/branch to merge`,
    );
    cancelSiblingChildren(parentTaskId);
    return;
  }

  const parentWorktreePath = parent.worktreePath ?? parent.workdir;
  const result = await mergeBranch(parentWorktreePath, child.branch);
  if (!result.ok) {
    if (result.conflict) await abortMerge(parentWorktreePath);
    tasks.update(childTaskId, { childMergeStatus: "merge-failed", column: "blocked" });
    blockPipelineTask(
      parentTaskId, null, "pipeline-failed",
      `merge conflict on subtask "${child.planSubtaskId}": ${result.detail}`,
    );
    cancelSiblingChildren(parentTaskId);
    return;
  }

  tasks.update(childTaskId, { childMergeStatus: "merged" });
  // Same serialized slot — call the inner function directly rather than
  // the exported `tickBuild` (which would enqueue a second, redundant slot
  // for this parent).
  await doTick(parentTaskId);
}
