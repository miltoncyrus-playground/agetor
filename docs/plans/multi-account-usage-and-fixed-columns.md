# Plan — Multi-account Claude harnesses: discovery, identity, usage/quota, plus always-visible board columns

| Field | Value |
| --- | --- |
| Date | 2026-08-14 |
| Source | User request: switch between two Claude accounts (`~/.claude` and `~/.claude-adevinta`) inside agetor; per-account usage/quota display; stop auto-hiding the Backlog / Ready / In Progress / Blocked columns. Design only — this document is the deliverable |
| Scope decision | Three workstreams: W1 account discovery + identity (claude-code only), W2 per-account usage/quota, W3 board column visibility. Codex/gemini account identity is explicitly out of scope (same pattern, separate plan) |
| Key finding | Multi-account support already exists end-to-end via harness aliases (`home` → `CLAUDE_CONFIG_DIR`). W1/W2 close the discoverability and observability gaps; nothing in the spawn/tail path changes |
| Status | **Design only. No code, no migration written yet.** |

## 1. Objective & success criteria

A user with two logged-in Claude accounts can, from inside agetor: (a) see both accounts offered as ready-made harnesses without knowing config-dir paths, (b) see which account each harness is logged in as, (c) see each account's token burn and (opt-in) live quota utilization at the point where they pick an agent for a task, and (d) always see the four working columns (Backlog, Ready, In Progress, Blocked) on every project lane, empty or not.

Measurable outcomes:
- W1: adding the second account goes from "hand-type a path you have to already know" to one click on a discovered entry. Trace: the discovered-accounts section in the Add-harness picker.
- W2: the account-throttled failure mode ("claude reports limit reached mid-run") becomes visible *before* spawn. Trace: quota badge in the New Task picker, `usage_daily` rows queryable in SQLite.
- W3: dragging a card to an empty Ready/Backlog/Blocked column becomes possible (today the column doesn't render when empty, so there is no drop target). Trace: the four columns render on every lane in the packaged app.

Implementation success (out of scope for this pass): `bun run typecheck` and `bun test` green including every new gate test in §8; no eval suite — none of the three workstreams has a latent-space component, stated explicitly rather than skipped silently.

## 2. Current state (as-built, verified by reading the code and the user's machine)

What already works and must not be touched:

| Concern | Where | Status |
| --- | --- | --- |
| Harness model with `home` → `CLAUDE_CONFIG_DIR` | `src/shared/types.ts:158`, `src/bun/agents.ts:191-204` | done |
| Harness CRUD API + Settings UI + templates | `src/bun/server.ts:2755-2941`, `SettingsDialog.tsx`, `HARNESS_TEMPLATES` at `types.ts:243` | done |
| Per-task harness selection, patchable `agent` field | `NewTaskForm.tsx:84`, task PATCH allow-list | done |
| JSONL tail / reattach / subagent streams resolve against harness home | `claude-tmux.ts:258`, `server.ts:4117-4121` | done |
| `.claude.json` location split (in-home vs `~/.claude.json`) | `commands.ts:525-529` | done |
| `/harnesses/:id/shell-env` for running `claude /login` in an alias env | `server.ts:2941` | done |
| Stat-keyed JSON cache for large `.claude.json` reads | `commands.ts:270` | done, reuse |

Verified on the target machine (Linux):
- `~/.claude` + `~/.claude.json` (default account) and `~/.claude-adevinta/.claude.json` (CLAUDE_CONFIG_DIR account) both exist; both blobs have `oauthAccount` with `emailAddress`, `displayName`, `billingType` (plus `accountUuid`, which must never be surfaced).
- Both dirs have `.credentials.json` (no macOS-keychain complication on this platform; the keychain caveat at `types.ts:166-169` still applies on macOS and is why `HOME` is never overridden).
- Every assistant line in `<configDir>/projects/**/*.jsonl` carries `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, nested `cache_creation`), `message.model`, `message.id`, top-level `requestId` and `timestamp`.

The zero-code workaround exists today: Settings → Add harness → "Additional Claude Code" → set Home to `~/.claude-adevinta`. This plan removes the need to know that.

## 3. W1 — Discover existing Claude config dirs + account identity

### 3.1 Discovery module (`src/bun/harness-discovery.ts`, new, pure)

Deterministic space, no LLM, no network.

- Candidates: glob `~/.claude*` directories, plus `process.env.CLAUDE_CONFIG_DIR` when set (covers agetor itself being launched under a non-default profile, which makes the *built-in* harness effectively that account).
- A candidate qualifies if its config blob parses and contains `oauthAccount.emailAddress`. Blob location rule is the same as `commands.ts:528`: `<dir>/.claude.json` for an override dir, sibling `~/.claude.json` for `~/.claude`. This distinguishes real account dirs from caches/plugin dirs matching the glob.
- Exclusions: the built-in's effective config dir (`process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`) and every registered harness's resolved `home`. Dedupe by realpath (symlink safety); display the user-visible path.
- Output type (new, in `src/shared/types.ts`): `DiscoveredAccount = { configDir, email, displayName, billingType, suggestedHarnessId }`. Suggested id derived from the dir suffix (`.claude-adevinta` → `claude-adevinta`), run through the existing `uniqueHarnessId` collision bump in `SettingsDialog.tsx`. Never include tokens or `accountUuid`.
- Exposure: new route `GET /harness-discovery` (dedicated, so the Settings dialog can refresh on open without dragging in `/defaults`).

### 3.2 Account identity on `HarnessStatus`

- Extend `HarnessStatus` (`types.ts:207`) with `account: { email, displayName, billingType } | null`. Additive; UI treats absence as null.
- `checkHarness` (`src/bun/agent-status.ts`) reads it via the same blob-location rule, through the stat-keyed cache at `commands.ts:270` (blob is large, `/harnesses` is polled). `null` = not logged in; Settings row shows a "run /login" hint next to the existing shell-env affordance.
- Codex/gemini return `account: null` (per-kind nullable, no parity blocker).

### 3.3 UI

- Add-harness picker (`SettingsDialog.tsx`): discovered accounts render as dynamic entries *above* the static `HARNESS_TEMPLATES`: "Existing Claude account · \<email\> · \<path\>", pre-filling `home` + suggested id. One click, then the normal editor.
- Retitle the "Additional Claude Code" template description to say "new login, separate from any existing account" so it stops reading as the only multi-account path.
- New Task picker (`NewTaskForm.tsx`): show the account email as a sublabel/tooltip per claude harness so two claude harnesses are distinguishable by account, not just label.

## 4. W2 — Per-account usage/quota

Two data planes with different trust levels. Keyed by **config dir** (the account), not harness id — two harnesses sharing a `home` share one account, and the JSONL tree also counts the user's direct CLI sessions outside agetor. That is correct: the budget displayed is the account's.

### 4.1 Plane A — historical token usage (local, deterministic, ships first)

New module `src/bun/account-usage.ts`:

- Parse `<configDir>/projects/**/*.jsonl` assistant lines for `message.usage` + `message.model` + `timestamp`.
- Dedupe key `message.id + requestId` — resumed/reattached sessions repeat lines; this is the account-level analog of the `run_events.line_uuid` idempotency pattern. (Same two decisions **ccusage** proved out. Search-before-building verdict: ccusage rejected as a dependency — CLI-first, full-tree re-parse per invocation, no incremental cursor or SQLite rollup, which is exactly what a polled endpoint needs. Its parsing decisions are borrowed; the ~200-line parser is in-repo next to the existing JSONL idioms.)
- Incremental scan, never full re-parse: per-file cursor (`path`, `mtime`, `size`, `offset`) folded into a daily rollup. Migration `040_account_usage.sql` (or next free number at implementation time): tables `usage_files` (cursors) and `usage_daily(config_dir, day, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, message_count)`, unique on `(config_dir, day, model)`. Rollups survive JSONL retention (`cleanupPeriodDays`, default 30d) deleting raw files, so history accumulates beyond the transcripts.
- Scan triggers: on `/harnesses` fetch and on a slow interval while Settings is open. Cursors make each pass cheap (stat, compare, seek).
- Cost: tokens always; "API-equivalent cost" only when the model id is in a small in-repo price map, `null` otherwise. Never guess prices for unknown ids; tokens are the honest unit for subscription accounts.

### 4.2 Plane B — live quota utilization (networked, undocumented, opt-in, phase 2)

The REPL `/usage` panel's 5-hour/weekly percentages come from an OAuth-authenticated Anthropic endpoint, not disk. Headless access means reading `<configDir>/.credentials.json` (`claudeAiOauth.accessToken`) and calling that endpoint per account. Constraints if built:

- **Explicit opt-in toggle per harness, default off.** Reading a credentials file to make network calls the user didn't run themselves crosses a line agetor never crosses today; toggle copy must say so.
- Token read at request time, memory only, never persisted, never logged, sent only to `api.anthropic.com`. Response cached in memory, ~60s TTL, so picker polling can't hammer the endpoint.
- Endpoint is unofficial: strict schema-validated parse; any mismatch or non-200 degrades to `quota: null` + reason ("re-login needed" on 401, "unavailable" otherwise). Must never block or fail `/harnesses`.
- First implementation step is an empirical spike confirming endpoint path + response shape against a real token (the gemini-driver verification precedent in CLAUDE.md). Not inferred from community docs.
- Rejected alternatives: scraping the tmux `/usage` screen (fragile, races the user's REPL input); OTel telemetry export (official but needs a collector, only sees future usage); parsing in-band limit warnings from JSONL (kept only as free garnish — if a rate-limit notice appears in a stream we already tail, surface it on the harness row).
- **Gate: Milton's explicit go.** The open decision is whether agetor may read `.credentials.json` and call an unofficial endpoint behind the off-by-default toggle. If no, the feature ships tokens-only and quota stays in the REPL.

### 4.3 Contract and API

- `HarnessStatus` gains `usage: AccountUsageSummary | null` where `AccountUsageSummary = { configDir, today: TokenTotals, last7d: TokenTotals, quota: { fiveHourPct, weeklyPct, resetsAt } | null }`. `quota` stays null until plane B ships and is enabled.
- New route `GET /harnesses/:id/account-usage` returning the daily rollup series for drill-down. Named `account-usage` because `/harnesses/:id/usage` (`server.ts:2928`) is already taken by task-count usage — do not overload it.
- No changes to `Harness`, spawn, or tail code.

### 4.4 UI

- Settings harness row: today/7d token totals next to the existing `HOME=` line; quota badge when plane B is on.
- New Task picker: quota percentage as sublabel per claude harness when available (the decision point for "which account has headroom"); tokens-only fallback otherwise.
- Drill-down: per-day per-model table in Settings fed by the new route. Table for v1; if it becomes a chart, follow the dataviz skill.

## 5. W3 — Always-visible board columns (no more auto-hide for Backlog / Ready / In Progress / Blocked)

### 5.1 Current behavior

`App.tsx:581-583` computes each lane's `laneVisibleColumns` by filtering `visibleDisplayColumns` down to buckets with ≥1 task in that lane — the documented "auto-hide, per lane" behavior (`SwimLane.tsx:14-16`). Consequence: an empty column doesn't render, so it also isn't a drop target.

### 5.2 Change

- `src/mainview/lib/display-columns.ts`: add `ALWAYS_VISIBLE_DISPLAY_COLUMNS: ReadonlySet<DisplayColumnId> = new Set(["backlog", "ready", "in-progress", "blocked"])`. `review` and `done` keep auto-hide (they are outcome buckets; the four working columns are the ones whose absence disorients).
- Extract the lane filter into a pure helper in `display-columns.ts` — `filterLaneColumns(visible, hasTasksById)` — keeping a column when it is in the always-visible set OR has tasks. `App.tsx:581` calls it.
- Precedence with the status filter is automatic: `visibleDisplayColumns` (`App.tsx:519`) already excludes explicitly filtered-out statuses *before* the lane filter, so a user who filters Backlog out still sees it disappear. Filter wins over always-visible.
- Lane-level behavior unchanged: lanes with zero visible tasks are still skipped entirely (`App.tsx:549`); only column visibility *within* a rendered lane changes.
- `Column.tsx` needs no logic change — it already renders an empty task list (count badge shows 0) and `useDroppable` registers regardless. Verify the empty column body has enough min-height to be a comfortable drop target; add one if the card list container collapses to zero.
- Side benefit, name it in the commit: dragging a card into an empty Ready/Backlog/Blocked column becomes possible for the first time.
- Note: "In Progress" is the display bucket that collapses plain `running` plus all 6 pipeline-stage columns (`toDisplayColumn`); no change to that mapping.

## 6. Migrations

- W1, W3: none. Discovery and identity are computed at request time; column visibility is pure UI.
- W2: one migration (`usage_files` + `usage_daily`, §4.1). Follows the numbered-file + `migrations/index.ts` append rule; never edits an applied migration.

## 7. Failure modes

- Malformed/unreadable `.claude.json`: candidate skipped (discovery) / `account: null` (status). Never throws into a route.
- Two harnesses, one config dir: legal; discovery dedupes so it can't happen by accident; both rows show the same account numbers, which is the truth.
- Account logged out after harness creation: visible at the picker (§3.2) instead of failing with claude's login prompt stuck in tmux.
- JSONL deleted/truncated mid-scan: cursor detects `size < offset`, resets that file's cursor; rollup rows stand (dedupe makes re-reads idempotent).
- Malformed JSONL lines: skipped, counted, surfaced as `parseErrors`, never thrown.
- Unknown model id: tokens aggregate, cost null.
- Missing/expired credentials (plane B): `quota: null` + reason; run flow unaffected.
- W3: a lane whose only tasks are review/done still renders the four working columns empty — intended, per the request.

## 8. Test plan

Gate tests only; no latent-space component in any workstream, so no eval suite applies (stated, not skipped).

- `harness-discovery.test.ts`: mkdtemp fake HOME with `.claude` + sibling `~/.claude.json`, `.claude-adevinta` with in-dir blob, a `.claude-cache` decoy without `oauthAccount`, registered-harness exclusion, `CLAUDE_CONFIG_DIR` env case, symlinked-dir dedupe, malformed JSON.
- `agent-status.test.ts` additions: `account` from harness home, from default path when `home` null, null on missing/logged-out blob.
- `account-usage.test.ts`: fixture JSONL with real-shape lines (incl. nested `cache_creation`), dedupe on repeated `message.id + requestId`, cursor incrementality (append / truncate / replace), retention survival (delete fixture, rollup persists).
- Migration apply/reapply no-op.
- Route tests: `/harness-discovery` payload shape with token/`accountUuid` absence asserted; `account-usage` vs `usage` route non-collision.
- Plane B client (if approved): recorded-fixture schema tests, 401/timeout/shape-drift degrade paths; live-endpoint check behind an integration flag only.
- `display-columns.test.ts`: `filterLaneColumns` pure-function cases — empty lane keeps the 4, review/done hidden when empty, status filter excludes an always-visible column, populated review/done render.

## 9. Phasing

1. **Phase 1** (no open questions): W3, W1, W2 plane A + UI. Independent surfaces (`mainview` lib/App vs new bun modules) — parallel-session safe per the services rule.
2. **Phase 2** (gated on Milton's credentials decision, §4.2): plane B quota client + opt-in toggle + picker badge.
3. **Later, separate plans**: codex (`~/.codex/auth.json`) and gemini account identity; usage charts.
