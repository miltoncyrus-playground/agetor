-- Persists WHY a task landed in the "blocked" column, so the UI can render
-- a durable, reason-specific recovery banner instead of relying on the
-- one-shot GlobalEvent/toast fired at the moment of transition (which is
-- lost if missed, or after an app restart). Set by orchestrator.ts's
-- updateColumn whenever it transitions a task to "blocked", cleared when
-- the task leaves "blocked". NULL for every task that has never been
-- blocked, and for pre-migration rows.
ALTER TABLE tasks ADD COLUMN block_reason TEXT;
