-- Per-harness opt-in for live quota (5-hour / weekly limit utilization).
-- Off by default on purpose: enabling it means agetor reads the account's
-- .credentials.json access token at request time and queries Anthropic's
-- (unofficial) OAuth usage endpoint on the user's behalf — a line agetor
-- never crosses without this explicit flag. Mirrors the `enabled` column's
-- built-in carve-out: toggleable on built-ins too, since the default
-- account is exactly the one most users want to watch.
ALTER TABLE harnesses ADD COLUMN quota_enabled INTEGER NOT NULL DEFAULT 0;
