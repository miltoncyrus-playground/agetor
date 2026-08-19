-- Pipeline parents: subtask ids a human explicitly marked as satisfied
-- without a merged child (JSON string array). Consulted by the build
-- barrier and the DAG scheduler so a subtask whose work landed some other
-- way (e.g. re-implemented on the parent branch after a failed merge)
-- stops re-tripping the barrier on every bounce back into building.
ALTER TABLE tasks ADD COLUMN satisfied_subtasks TEXT NOT NULL DEFAULT '[]';
