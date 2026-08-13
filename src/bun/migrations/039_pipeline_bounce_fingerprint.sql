-- Progress marker for the pipeline bounce loop-breaker: the tree fingerprint
-- ("<targetStage>:<sha256>") captured when a review/test bounce spawns. The
-- next bounce to the same target compares against it — an identical
-- fingerprint means the bounce cycle changed nothing on disk, so the task
-- blocks immediately instead of burning the revision budget on no-op loops.
ALTER TABLE tasks ADD COLUMN pipeline_bounce_fingerprint TEXT;
