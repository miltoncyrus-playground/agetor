-- Renumbered 042_satisfied_subtasks -> 057_satisfied_subtasks on merge with upstream/main (pipeline branch
-- originally numbered these against a 031-head trunk; upstream had already
-- claimed 032-050 by merge time). Same renumber-with-alias pattern
-- index.ts already uses elsewhere -- original id kept as an alias so a
-- dev DB that already applied it as 042_* is not re-migrated.

-- Pipeline parents: subtask ids a human explicitly marked as satisfied
-- without a merged child (JSON string array). Consulted by the build
-- barrier and the DAG scheduler so a subtask whose work landed some other
-- way (e.g. re-implemented on the parent branch after a failed merge)
-- stops re-tripping the barrier on every bounce back into building.
ALTER TABLE tasks ADD COLUMN satisfied_subtasks TEXT NOT NULL DEFAULT '[]';
