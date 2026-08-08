-- Parent/child task linking for the pre-builder pipeline stage: a "building"
-- stage's fresh entry (from pre-builder success) decomposes BUILD_PLAN.json
-- into real, independently-running CHILD tasks -- own worktree, branch, and
-- agent session each -- rather than one agent working through a list.
--
-- `parent_task_id` links a child back to the pipeline task that spawned it.
-- NULL for every ordinary/top-level task, including pipeline tasks
-- themselves. A child's OWN `pipeline_stage` stays NULL -- it is an
-- otherwise entirely ordinary task; these three columns are the only
-- markers that distinguish it.
--
-- `plan_subtask_id` is the local id from the parent's BUILD_PLAN.json
-- `subtasks[].id` this child corresponds to. Used by build-scheduler.ts's
-- tickBuild to detect "has this subtask already been created" and to
-- resolve `dependsOn` edges (plan-local ids) to real sibling Task rows.
--
-- `child_merge_status` tracks the post-run merge-back into the parent's
-- branch: 'pending' from child creation, 'merged' once
-- worktree.mergeBranch succeeds (the source of truth for the scheduler's
-- barrier check and dependency resolution -- NOT the child's `column`,
-- which stays 'building' for its whole successful life so it renders
-- grouped with its siblings), 'merge-failed' on a conflict (which also
-- moves the child to 'blocked' and aborts the whole build).
--
-- All 3 columns are NULL for every non-child task, so this migration has
-- zero behavioral effect until a "building" stage's fresh entry creates its
-- first child.
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
ALTER TABLE tasks ADD COLUMN plan_subtask_id TEXT;
ALTER TABLE tasks ADD COLUMN child_merge_status TEXT;
