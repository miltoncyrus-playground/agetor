-- Per-run token accounting (O-10, docs/plans/pipeline-token-efficiency.md).
-- Fed from the claude JSONL tail the driver already reads: every assistant
-- line carries `message.usage`; one row per run sums them. `run_usage_seen`
-- is the idempotence key — claude writes one JSONL line per content block
-- (same message.id, same usage block repeated) and a boot reattach replays
-- the file from offset 0, so the same message reaches the recorder many
-- times. Counting each (run_id, message_id) once is what makes the totals
-- honest. `bootstrap_tokens` is the context of the run's FIRST message: the
-- fixed per-session cost (system prompt + tool schemas + CLAUDE.md + prompt).
CREATE TABLE run_usage (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  messages INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  bootstrap_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE run_usage_seen (
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (run_id, message_id)
);
