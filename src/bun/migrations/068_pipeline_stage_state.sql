-- Per-pipeline-task scratch state that lives BETWEEN stage turns (O-5/O-6/
-- O-11 in docs/plans/pipeline-token-efficiency.md). Kept off the tasks
-- table on purpose: none of it is user-facing, none is patchable, and a
-- separate row spares every Task fixture in the test suite a new field.
--   handoffs   JSON StageHandoff[] — files each settled stage Read and the
--              commands that worked, injected into the next stage's prompt
--              so it doesn't rediscover them (capped, newest last).
--   review_sha HEAD the Code Reviewer last reviewed; a revision pass gets a
--              diff since THIS sha instead of the whole branch.
--   precheck   JSON PrecheckSummary of the deterministic typecheck/lint/test
--              run agetor did before spawning the Tester (null = none).
CREATE TABLE IF NOT EXISTS pipeline_stage_state (
  task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  handoffs   TEXT NOT NULL DEFAULT '[]',
  review_sha TEXT,
  precheck   TEXT,
  updated_at INTEGER NOT NULL
);
