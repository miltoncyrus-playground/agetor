# Pipeline merge-loop prevention

Post-incident hardening from the 2dot2dot-redesign build-stage loop
(2026-08-16 → 2026-08-19). The incident, compressed: the `canvas` subtask's
merge-back conflicted → the build aborted → a recovery turn on the parent,
unaware the work existed on a branch, **re-implemented the feature in the
parent worktree** → bookkeeping (`childMergeStatus: merge-failed`) and
reality (work in tree) could never reconcile → every barrier check retried
the doomed merge and re-blocked, forever, with the recovery work sitting as
41 uncommitted files.

Five fixes, each mapped to a contributing cause:

## 1. Conflicts are work, not dead ends (merge-resolution turns)

`mergeChildIntoParent` (build-scheduler.ts) no longer aborts + blocks on a
conflict. It leaves the merge **in progress** (conflict markers + MERGE_HEAD
intact), parks the child in the new `childMergeStatus: "merge-conflict"`
state, and spawns an agent turn on the parent (`spawnMergeResolution`,
orchestrator.ts) whose prompt (`mergeResolutionPrompt`) says: resolve the
conflicts preserving both sides, conclude with `git commit`, **do NOT
re-implement**. The run is stamped `origin: "pipeline-merge"` (via
`runs.setOrigin` — the run row is created by the ordinary per-kind turn
senders, stamped in the same synchronous continuation).

Settle-side (`settleMergeResolution`), the agent's outcome is never trusted:
`isBranchMerged` (worktree.ts) re-derives from git alone — MERGE_HEAD gone
AND the child branch's tip an ancestor of the parent's HEAD. Landed → child
`merged`/done, `tickBuild` resumes. Not landed → the pre-resolution behavior
(abort, `merge-failed`, parent blocked, siblings cancelled) — so it's exactly
one automatic attempt, no resolution loops.

While a `merge-conflict` child exists, `doTick` no-ops and `doCompleteChild`
parks other finishing children as `merge-deferred` — one merge in flight per
parent, and no git operation can touch the parked merge state.

## 2. Merge-failed recovery is merge-scoped

When a conflict does end in a block, the `pipelineFeedback` names the branch
carrying the finished work and says "resolve that merge / mark the subtask
satisfied; do NOT re-implement the feature". `buildingPrompt` folds
`pipelineFeedback` into any later "Retry stage" fixup turn, so the recovery
agent can no longer innocently rebuild the feature.

## 3. Durable "subtask satisfied" override

`Task.satisfiedSubtasks` (migration 042, pipeline parents only): subtask ids
a human declared satisfied without a merged child. Written by
`satisfyPipelineSubtask` (`POST /tasks/:id/satisfy-subtask`, per-subtask
"Mark satisfied" buttons in the RunPanel blocked banner — driven by the
`unmetSubtasks` server decoration) and by `overridePipelineGate`'s building
case, which now marks every currently-unmet subtask satisfied so the
override survives a later bounce back into building (previously it was
amnesiac — the exact residual loop). Consumed by `buildBarrierState`
(counts as met) and `tickBuild` (never spawns a child for it; counts it as a
met dependency). Marking a subtask satisfied archives its leftover un-merged
child so no tick can retry the doomed merge.

## 4. Stage-end commit discipline

`buildingPrompt` now requires a local commit (mirroring the child/testing
prompts) instead of forbidding one. Deterministic backstop regardless of
prompt compliance: `commitAll` (worktree.ts) — add -A + commit iff dirty,
refuses when MERGE_HEAD is parked — runs at the top of `doTick` (parent
worktree; dirty trees make every merge refuse) and in `doCompleteChild`
before the merge (a child that forgot to commit would otherwise merge
"Already up to date" and be wrongly marked merged with zero work landed).

## 5. File ownership at decompose time

`BuildSubtask.files` in TASKS.json (optional, back-compat): the paths a
subtask will create/modify. `parseBuildPlan` rejects a plan where the same
path appears in two subtasks. `decomposePrompt` instructs single-owner
shared files (README, package.json, global config → owned by one slice,
usually a final integration subtask); `childBuildPrompt` tells the child to
stay inside its list and report needed out-of-lane changes in its final
message instead of editing.

## Tests

- `orchestrator-pipeline-merge.test.ts`: conflict → resolution spawn →
  failure path (end-to-end, real git + fake driver); resolution success path
  (concluded merge → merged → barrier completes → code-review).
- `orchestrator-pipeline-guards.test.ts`: satisfy semantics + guards,
  override-marks-satisfied, tickBuild skip/dependency handling.
- `worktree.test.ts`: `isBranchMerged` (unmerged / parked / concluded),
  `commitAll` (clean / dirty / merge-in-progress / non-git).
- `pipeline-prompts.test.ts`: `files` validation + overlap rejection, the
  ownership and commit-discipline prompt clauses, `mergeResolutionPrompt`.
