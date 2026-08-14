-- Per-account (config-dir-keyed) local token-usage rollups, fed by an
-- incremental scan of each Claude account's `<configDir>/projects/**/*.jsonl`.
-- Rollups survive claude's own transcript retention (cleanupPeriodDays)
-- deleting the raw files, so history accumulates beyond the transcripts.

-- Per-file scan cursor: where the last scan stopped. `offset` only ever
-- advances past complete lines; a shrunken file (size < offset) resets to 0.
CREATE TABLE usage_files (
  path TEXT PRIMARY KEY,
  config_dir TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  offset INTEGER NOT NULL
);

-- Daily per-model rollup. Additive; correctness under re-reads comes from
-- usage_seen below, not from the cursor alone.
CREATE TABLE usage_daily (
  config_dir TEXT NOT NULL,
  day TEXT NOT NULL,            -- UTC date, YYYY-MM-DD
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (config_dir, day, model)
);

-- Idempotency keys: one row per counted API response (`message.id:requestId`).
-- Claude rewrites an assistant message's JSONL line as it streams (each
-- rewrite carrying usage) and reattach/resume re-reads files from offset 0,
-- so the same response can be seen many times — only the first insert
-- aggregates into usage_daily.
CREATE TABLE usage_seen (
  config_dir TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (config_dir, key)
) WITHOUT ROWID;
