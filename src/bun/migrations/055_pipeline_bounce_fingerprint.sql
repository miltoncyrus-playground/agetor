-- Renumbered 039_pipeline_bounce_fingerprint -> 055_pipeline_bounce_fingerprint on merge with upstream/main (pipeline branch
-- originally numbered these against a 031-head trunk; upstream had already
-- claimed 032-050 by merge time). Same renumber-with-alias pattern
-- index.ts already uses elsewhere -- original id kept as an alias so a
-- dev DB that already applied it as 039_* is not re-migrated.

-- Progress marker for the pipeline bounce loop-breaker: the tree fingerprint
-- ("<targetStage>:<sha256>") captured when a review/test bounce spawns. The
-- next bounce to the same target compares against it — an identical
-- fingerprint means the bounce cycle changed nothing on disk, so the task
-- blocks immediately instead of burning the revision budget on no-op loops.
ALTER TABLE tasks ADD COLUMN pipeline_bounce_fingerprint TEXT;
