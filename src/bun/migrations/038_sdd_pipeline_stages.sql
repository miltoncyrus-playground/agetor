-- Rename any in-flight `pre-builder` pipeline tasks to `decompose` so they
-- don't desync against the renamed TS union. No ALTER TABLE needed — the
-- pipeline_stage column is free-form TEXT; this is a data-only rename.
UPDATE tasks SET pipeline_stage = 'decompose' WHERE pipeline_stage = 'pre-builder';
