-- Renumbered 038_sdd_pipeline_stages -> 054_sdd_pipeline_stages on merge with upstream/main (pipeline branch
-- originally numbered these against a 031-head trunk; upstream had already
-- claimed 032-050 by merge time). Same renumber-with-alias pattern
-- index.ts already uses elsewhere -- original id kept as an alias so a
-- dev DB that already applied it as 038_* is not re-migrated.

-- Rename any in-flight `pre-builder` pipeline tasks to `decompose` so they
-- don't desync against the renamed TS union. No ALTER TABLE needed — the
-- pipeline_stage column is free-form TEXT; this is a data-only rename.
UPDATE tasks SET pipeline_stage = 'decompose' WHERE pipeline_stage = 'pre-builder';
