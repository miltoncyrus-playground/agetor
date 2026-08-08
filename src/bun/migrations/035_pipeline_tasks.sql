-- "Pipeline task" support: a task that walks planning -> plan-review ->
-- building -> testing automatically, no human click between stages, using
-- the same harness/CLI per stage with only the prompt template differing
-- (see src/bun/pipeline-prompts.ts).
--
-- `pipeline_stage` NULL means an ordinary (non-pipeline) task -- the
-- overwhelming majority of rows, including every legacy row. Set once at
-- creation (to 'planning'), never cleared once set; thereafter written
-- exclusively by the orchestrator's advancePipelineStage (never via
-- PATCH /tasks/:id -- these columns are deliberately absent from
-- ALLOWED_PATCH_FIELDS in server.ts).
--
-- `plan_approved` / `implementation_approved` are the two persisted
-- booleans an explicit AND-gate reads before letting a pipeline task reach
-- column 'ready' -- set true by a Critic "approve" / Tester "pass" verdict
-- respectively, reset false by a later revision on that side.
--
-- `revision_count` is the SHARED send-back counter across both loop edges
-- (plan-review->planning and testing->building), capped at
-- PIPELINE_REVISION_CAP (4, shared/types.ts) in application code -- routes
-- to 'blocked' instead of looping past the cap.
--
-- `pipeline_feedback` carries the most recent send-back's free-text reason
-- (a Critic "revise" reason or Tester "fail" reason) into the next
-- planning/building stage's prompt, then is cleared once consumed.
--
-- `paused_at` is set by POST /tasks/:id/pipeline-pause: while non-null,
-- advancePipelineStage still computes and persists the next stage but
-- skips spawning it, until POST /tasks/:id/pipeline-resume clears it.
--
-- All 6 columns are no-ops for every non-pipeline task (NULL/0/false
-- defaults), so this migration has zero behavioral effect until a task is
-- explicitly created with pipeline: true.
ALTER TABLE tasks ADD COLUMN pipeline_stage TEXT;
ALTER TABLE tasks ADD COLUMN plan_approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN implementation_approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN pipeline_feedback TEXT;
ALTER TABLE tasks ADD COLUMN paused_at INTEGER;
