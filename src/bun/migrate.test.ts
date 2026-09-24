import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, splitSqlStatements, type Migration } from "./migrate.ts";
import reseedBuiltins from "./migrations/024_reseed_harness_builtins.sql" with { type: "text" };
import retireGemini3ProPreview from "./migrations/049_retire_gemini_3_pro_preview.sql" with { type: "text" };
import normalizeCursorGrok47 from "./migrations/069_normalize_cursor_grok_4_7.sql" with { type: "text" };
import normalizeCursorOpus55 from "./migrations/070_normalize_cursor_opus_5_5.sql" with { type: "text" };
import { migrations } from "./migrations/index.ts";

// Minimal harnesses table matching the shape after 013 + 014 (adds `enabled`).
const HARNESSES_DDL = `
  CREATE TABLE harnesses (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex')),
    label TEXT NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    home TEXT, bin TEXT, env_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  );`;

test("applies pending migrations in order, skips already-applied ones", () => {
  const db = new Database(":memory:");
  const m: Migration[] = [
    { id: "001_init", sql: "CREATE TABLE foo (id INTEGER);" },
    { id: "002_add",  sql: "CREATE TABLE bar (id INTEGER);" },
  ];

  expect(migrate(db, m)).toEqual(["001_init", "002_add"]);
  expect(migrate(db, m)).toEqual([]); // idempotent

  const extra: Migration = { id: "003_extra", sql: "CREATE TABLE baz (id INTEGER);" };
  expect(migrate(db, [...m, extra])).toEqual(["003_extra"]);

  const tables = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
  ).all().map((r) => r.name);
  expect(tables).toEqual(["_migrations", "bar", "baz", "foo"]);
});

test("skips a renamed migration when a legacy alias is already applied", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, cursor_session_id TEXT);
    CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO _migrations (id, applied_at) VALUES ('025_cursor_session_id', 1);
  `);

  const renamed: Migration = {
    id: "033_cursor_session_id",
    aliases: ["025_cursor_session_id"],
    sql: "ALTER TABLE runs ADD COLUMN cursor_session_id TEXT;",
  };

  expect(migrate(db, [renamed])).toEqual([]);
  expect(migrate(db, [renamed])).toEqual([]);

  const applied = db
    .query<{ id: string }, []>(`SELECT id FROM _migrations ORDER BY id`)
    .all()
    .map((r) => r.id);
  expect(applied).toEqual(["025_cursor_session_id", "033_cursor_session_id"]);
});

test("rolls back a failing migration so it can be retried", () => {
  const db = new Database(":memory:");
  const bad: Migration = {
    id: "001_bad",
    sql: "CREATE TABLE ok (id INTEGER); INSERT INTO missing VALUES (1);",
  };
  expect(() => migrate(db, [bad])).toThrow();

  const applied = db.query<{ id: string }, []>(`SELECT id FROM _migrations`).all();
  expect(applied).toEqual([]);

  const hasOk = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE name='ok'`,
  ).all();
  expect(hasOk).toEqual([]);
});

test("a CHECK-constraint failure mid-migration rolls back statements that ran before AND after it", () => {
  // Regression: `Database.exec()`/`.run()` given a multi-statement string
  // does NOT stop at a failing statement the way the "rolls back a failing
  // migration" test above might suggest — that test's failure ("no such
  // table") is a different SQLite error class than a CHECK-constraint
  // violation, and only the former aborts the batch. Verified directly
  // against bun:sqlite: a 3-statement string where statement 2 violates a
  // CHECK constraint throws no error at all, and statement 3 (which would
  // succeed on its own) still runs. For the table-rebuild recipe several
  // migrations use (CREATE new / INSERT...SELECT / DROP old / RENAME), that
  // silently no-ops the row copy on a CHECK violation while the DROP and
  // RENAME after it still execute — permanently replacing the old table
  // with an empty one, with no thrown error to catch. This is why
  // `migrate()` runs each statement through its own `db.run()` call
  // (`splitSqlStatements`) instead of one `db.exec()` per file.
  const db = new Database(":memory:");
  const bad: Migration = {
    id: "001_bad_check",
    sql: `
      CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL CHECK (v IN ('a', 'b')));
      INSERT INTO t (id, v) VALUES (1, 'z');
      INSERT INTO t (id, v) VALUES (2, 'b');
    `,
  };
  expect(() => migrate(db, [bad])).toThrow(/CHECK constraint failed/);

  // Whole migration rolled back — not just the table create, but also the
  // second INSERT that would have succeeded on its own.
  const tables = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='t'`,
  ).all();
  expect(tables).toEqual([]);
  const applied = db.query<{ id: string }, []>(`SELECT id FROM _migrations`).all();
  expect(applied).toEqual([]);
});

test("splitSqlStatements respects semicolons inside string literals and comments", () => {
  const sql = `
    -- a comment; with a semicolon
    INSERT INTO t (v) VALUES ('has; a semicolon'' and '' quotes');
    /* block; comment */
    INSERT INTO t (v) VALUES ('second');
  `;
  const statements = splitSqlStatements(sql);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("has; a semicolon");
  expect(statements[1]).toContain("second");
});

test("024_reseed_harness_builtins restores wiped builtins, is idempotent, and preserves enabled", () => {
  const db = new Database(":memory:");
  db.exec(HARNESSES_DDL);

  // Simulate the damaged prod state: builtins wiped out by a bad table rebuild.
  expect(db.query(`SELECT COUNT(*) n FROM harnesses`).get() as { n: number }).toEqual({ n: 0 });

  db.exec(reseedBuiltins);
  const afterFirst = db
    .query<{ id: string; kind: string; enabled: number; is_builtin: number }, []>(
      `SELECT id, kind, enabled, is_builtin FROM harnesses ORDER BY id`,
    )
    .all();
  expect(afterFirst).toEqual([
    { id: "claude-code", kind: "claude-code", enabled: 1, is_builtin: 1 },
    { id: "codex", kind: "codex", enabled: 0, is_builtin: 1 },
  ]);

  // Idempotent: re-running does not duplicate or overwrite. Flip claude-code
  // off first to prove OR IGNORE leaves an existing row's enabled untouched.
  db.run(`UPDATE harnesses SET enabled = 0 WHERE id = 'claude-code'`);
  db.exec(reseedBuiltins);
  const afterSecond = db
    .query<{ id: string; enabled: number }, []>(`SELECT id, enabled FROM harnesses ORDER BY id`)
    .all();
  expect(afterSecond).toEqual([
    { id: "claude-code", enabled: 0 }, // preserved, not reset to 1
    { id: "codex", enabled: 0 },
  ]);
});

test("049_retire_gemini_3_pro_preview rewrites only tasks pinned to the shut-down id (any harness), clears the stale lastModel:gemini preference, normalizes suffixed Cursor Gemini Flash variants to base id + effort, idempotently", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE harnesses (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      model TEXT,
      effort TEXT
    );
    CREATE TABLE preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    INSERT INTO harnesses (id, kind) VALUES
      ('gemini', 'gemini'), ('gemini-2', 'gemini'),
      ('cursor', 'cursor'), ('cursor-2', 'cursor'),
      ('fx', 'fx'), ('codex', 'codex');
  `);

  db.exec(`
    INSERT INTO tasks (id, agent, model, effort) VALUES
      ('t01', 'gemini', 'gemini-3-pro-preview', NULL),
      ('t02', 'gemini-2', 'gemini-3-pro-preview', NULL),
      ('t03', 'gemini', 'gemini-3.7-flash', NULL),
      ('t04', 'cursor', 'gemini-3.1-pro', 'high'),
      ('t05', 'fx', 'google/gemini-3.1-pro-preview', NULL),
      ('t06', 'codex', 'gpt-5.6-sol', 'high'),
      ('t07', 'gemini', NULL, NULL),
      ('t08', 'cursor', 'gemini-3.8-flash-high', NULL),
      ('t09', 'cursor-2', 'gemini-3.7-flash-low', 'high'),
      ('t10', 'cursor', 'gemini-3.8-flash-medium', 'medium'),
      ('t11', 'gemini', 'gemini-3.8-flash-medium', NULL),
      ('t12', 'cursor', 'gemini-3.6-flash', 'minimal');
  `);

  db.exec(`
    INSERT INTO preferences (key, value, updated_at) VALUES
      ('lastModel:gemini', 'gemini-3-pro-preview', 1),
      ('lastModel:codex', 'gpt-5.6-sol', 1),
      ('lastMode:gemini', 'auto', 1),
      ('lastModel:cursor', 'gemini-3.1-pro', 1);
  `);

  const readAll = () =>
    db
      .query<{ id: string; agent: string; model: string | null; effort: string | null }, []>(
        `SELECT id, agent, model, effort FROM tasks ORDER BY id`,
      )
      .all();

  const readPrefs = () =>
    db
      .query<{ key: string; value: string }, []>(
        `SELECT key, value FROM preferences ORDER BY key`,
      )
      .all();

  db.exec(retireGemini3ProPreview);
  expect(readAll()).toEqual([
    { id: "t01", agent: "gemini", model: "gemini-3.1-pro-preview", effort: null }, // rewritten
    { id: "t02", agent: "gemini-2", model: "gemini-3.1-pro-preview", effort: null }, // rewritten — additional-account harness, no join needed
    { id: "t03", agent: "gemini", model: "gemini-3.7-flash", effort: null }, // untouched
    { id: "t04", agent: "cursor", model: "gemini-3.1-pro", effort: "high" }, // untouched — different literal
    { id: "t05", agent: "fx", model: "google/gemini-3.1-pro-preview", effort: null }, // untouched — different literal
    { id: "t06", agent: "codex", model: "gpt-5.6-sol", effort: "high" }, // untouched — unrelated kind
    { id: "t07", agent: "gemini", model: null, effort: null }, // untouched — still NULL
    { id: "t08", agent: "cursor", model: "gemini-3.8-flash", effort: "high" }, // variant → base + effort
    { id: "t09", agent: "cursor-2", model: "gemini-3.7-flash", effort: "low" }, // variant wins over a stale effort; additional cursor harness via the kind join
    { id: "t10", agent: "cursor", model: "gemini-3.8-flash", effort: "medium" }, // variant → base, effort already matched
    { id: "t11", agent: "gemini", model: "gemini-3.8-flash-medium", effort: null }, // untouched — not a cursor-kind harness
    { id: "t12", agent: "cursor", model: "gemini-3.6-flash", effort: "minimal" }, // untouched — already base + effort
  ]);
  expect(readPrefs()).toEqual([
    { key: "lastMode:gemini", value: "auto" }, // untouched — not a lastModel key
    { key: "lastModel:codex", value: "gpt-5.6-sol" }, // untouched — other kind
    { key: "lastModel:cursor", value: "gemini-3.1-pro" }, // untouched — other kind
    // lastModel:gemini (the dead id) is gone
  ]);

  // Idempotent: re-applying against the already-rewritten rows is a no-op
  // for both tables.
  const tasksBeforeSecond = readAll();
  const prefsBeforeSecond = readPrefs();
  db.exec(retireGemini3ProPreview);
  expect(readAll()).toEqual(tasksBeforeSecond);
  expect(readPrefs()).toEqual(prefsBeforeSecond);
});

test("049 leaves a lastModel:gemini pref that already points at a live model alone", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE harnesses (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      model TEXT,
      effort TEXT
    );
    CREATE TABLE preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    INSERT INTO preferences (key, value, updated_at) VALUES
      ('lastModel:gemini', 'gemini-3.7-flash', 1);
  `);

  db.exec(retireGemini3ProPreview);

  const prefs = db
    .query<{ key: string; value: string }, []>(
      `SELECT key, value FROM preferences ORDER BY key`,
    )
    .all();
  expect(prefs).toEqual([{ key: "lastModel:gemini", value: "gemini-3.7-flash" }]);
});

test("050 is registered right after 049", () => {
  const idx050 = migrations.findIndex((m) => m.id === "050_sent_files");
  expect(idx050).toBeGreaterThan(0);
  expect(migrations[idx050]?.sql).toContain("ADD COLUMN sent_files TEXT");
  const prev = migrations[idx050 - 1];
  expect(prev?.id).toBe("049_retire_gemini_3_pro_preview");
  expect(prev?.sql).toContain("gemini-3.1-pro-preview");
});

test("051-053 (upstream's fx_recovery/agent_profiles/task_agent_profile) are registered right after 050", () => {
  const idx051 = migrations.findIndex((m) => m.id === "051_fx_recovery");
  expect(idx051).toBeGreaterThan(0);
  expect(migrations[idx051 - 1]?.id).toBe("050_sent_files");
  const idx052 = migrations.findIndex((m) => m.id === "052_agent_profiles");
  expect(idx052).toBe(idx051 + 1);
  expect(migrations[idx052]?.sql).toContain("CREATE TABLE agent_profiles");
  const idx053 = migrations.findIndex((m) => m.id === "053_task_agent_profile");
  expect(idx053).toBe(idx052 + 1);
  expect(migrations[idx053]?.sql).toContain("ADD COLUMN agent_profile_id TEXT");
  expect(migrations[idx053]?.sql).toContain("ADD COLUMN agent_profile TEXT");
});

test("the fork's 060-068 block sits right after upstream's 053, and the renumbered incoming 069-073 are the last five", () => {
  const ids = migrations.map((m) => m.id);
  const idx060 = migrations.findIndex((m) => m.id === "060_pipeline_tasks");
  expect(migrations[idx060 - 1]?.id).toBe("053_task_agent_profile");
  expect(ids.slice(idx060, idx060 + 9)).toEqual([
    "060_pipeline_tasks",
    "061_prebuilder_children",
    "062_block_reason",
    "063_sdd_pipeline_stages",
    "064_pipeline_bounce_fingerprint",
    "065_account_usage",
    "066_satisfied_subtasks",
    "067_run_usage",
    "068_pipeline_stage_state",
  ]);
  const m066 = migrations.find((m) => m.id === "066_satisfied_subtasks");
  expect(m066?.sql).toContain("ADD COLUMN satisfied_subtasks TEXT");
  // 060-066 were authored as 035-040/042 on the pre-upstream-sync pipeline
  // lineage, renumbered to 051-057 on the original port, then renumbered
  // again to 060-066 on this sync (upstream had independently claimed
  // 051-053 in the meantime) — both prior ids stay as aliases so a DB that
  // applied them under either older numbering is not re-migrated.
  expect(m066?.aliases).toEqual(["042_satisfied_subtasks", "057_satisfied_subtasks"]);
  const m067 = migrations.find((m) => m.id === "067_run_usage");
  expect(m067?.aliases).toEqual(["043_run_usage", "058_run_usage"]);
  expect(m067?.sql).toContain("CREATE TABLE run_usage (");
  const m068 = migrations.find((m) => m.id === "068_pipeline_stage_state");
  expect(m068?.aliases).toEqual(["044_pipeline_stage_state", "059_pipeline_stage_state"]);
  expect(m068?.sql).toContain("CREATE TABLE IF NOT EXISTS pipeline_stage_state");

  // The five migrations that arrived with upstream/feature/agetor-pipelines
  // (alamops/agetor#244) as 055-059. Renumbered to 069-073 on merge: this
  // fork's 060-068 block above had already claimed every id through 068.
  // Every id each has ever borne is kept as an alias (append-only), so a dev
  // DB that already applied one under an older id is not re-migrated — 071
  // and 072 each carry TWO, since upstream itself had already renumbered
  // them once. Upstream's own 054_account_usage is deliberately NOT
  // registered: it is the same migration as this fork's 065_account_usage.
  expect(ids).not.toContain("054_account_usage");
  expect(ids.slice(-5)).toEqual([
    "069_normalize_cursor_grok_4_7",
    "070_normalize_cursor_opus_5_5",
    "071_pipelines",
    "072_task_pipeline",
    "073_task_pipeline_id_index",
  ]);
  const at = migrations.length - 5;
  expect(migrations[at - 1]?.id).toBe("068_pipeline_stage_state");
  expect(migrations[at]?.aliases).toEqual(["055_normalize_cursor_grok_4_7"]);
  expect(migrations[at]?.sql).toContain("grok-4.7");
  expect(migrations[at + 1]?.aliases).toEqual(["056_normalize_cursor_opus_5_5"]);
  expect(migrations[at + 1]?.sql).toContain("claude-opus-5-5");
  expect(migrations[at + 2]?.aliases).toEqual(["056_pipelines", "057_pipelines"]);
  expect(migrations[at + 2]?.sql).toContain("CREATE TABLE pipelines");
  expect(migrations[at + 3]?.aliases).toEqual(["057_task_pipeline", "058_task_pipeline"]);
  expect(migrations[at + 3]?.sql).toContain("ADD COLUMN pipeline_id TEXT");
  expect(migrations[at + 4]?.aliases).toEqual(["059_task_pipeline_id_index"]);
  expect(migrations[at + 4]?.sql).toContain("CREATE INDEX IF NOT EXISTS idx_tasks_pipeline_id ON tasks(pipeline_id) WHERE pipeline_id IS NOT NULL");
});

test("069_normalize_cursor_grok_4_7 (upstream 055) folds suffixed grok-4.7 variants into base id + effort + fast on cursor-kind tasks, agent profiles and the lastModel:cursor pref, idempotently", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE harnesses (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      fast INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      harness_id TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT,
      fast INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    INSERT INTO harnesses (id, kind) VALUES
      ('cursor', 'cursor'), ('cursor-2', 'cursor'), ('fx', 'fx'), ('codex', 'codex');
  `);

  db.exec(`
    INSERT INTO tasks (id, agent, model, effort, fast) VALUES
      ('t01', 'cursor', 'grok-4.7-high', NULL, 0),
      ('t02', 'cursor-2', 'grok-4.7-xhigh-fast', 'low', 0),
      ('t03', 'cursor', 'grok-4.7-medium', 'medium', 1),
      ('t04', 'cursor', 'grok-4.7-low-fast', NULL, 1),
      ('t05', 'cursor', 'grok-4.7', 'high', 1),
      ('t06', 'cursor', 'cursor-grok-4.6', 'xhigh', 0),
      ('t07', 'cursor', 'cursor-grok-4.6-high', NULL, 0),
      ('t08', 'fx', 'spacexai/grok-4.7', NULL, 0),
      ('t09', 'codex', 'grok-4.7-high', 'high', 0),
      ('t10', 'cursor', NULL, NULL, 0),
      ('t11', 'cursor', 'grok-4.7-max', NULL, 0);
  `);

  db.exec(`
    INSERT INTO agent_profiles (id, harness_id, model, effort, fast) VALUES
      ('p01', 'cursor', 'grok-4.7-xhigh', NULL, 0),
      ('p02', 'cursor-2', 'grok-4.7-high-fast', 'high', 0),
      ('p03', 'cursor', 'grok-4.7', 'medium', 0),
      ('p04', 'codex', 'grok-4.7-low', NULL, 0);
  `);

  db.exec(`
    INSERT INTO preferences (key, value, updated_at) VALUES
      ('lastModel:cursor', 'grok-4.7-high-fast', 1),
      ('lastModel:codex', 'grok-4.7-high', 1),
      ('lastMode:cursor', 'auto', 1);
  `);

  const readTasks = () =>
    db
      .query<{ id: string; model: string | null; effort: string | null; fast: number }, []>(
        `SELECT id, model, effort, fast FROM tasks ORDER BY id`,
      )
      .all();
  const readProfiles = () =>
    db
      .query<{ id: string; model: string; effort: string | null; fast: number }, []>(
        `SELECT id, model, effort, fast FROM agent_profiles ORDER BY id`,
      )
      .all();
  const readPrefs = () =>
    db
      .query<{ key: string; value: string; updated_at: number }, []>(
        `SELECT key, value, updated_at FROM preferences ORDER BY key`,
      )
      .all();

  db.exec(normalizeCursorGrok47);
  expect(readTasks()).toEqual([
    { id: "t01", model: "grok-4.7", effort: "high", fast: 0 }, // variant → base + effort
    { id: "t02", model: "grok-4.7", effort: "xhigh", fast: 1 }, // variant wins over a stale effort; -fast sets fast; additional cursor harness via the kind join
    { id: "t03", model: "grok-4.7", effort: "medium", fast: 0 }, // stale fast=1 cleared — the verbatim id ran the regular tier
    { id: "t04", model: "grok-4.7", effort: "low", fast: 1 },
    { id: "t05", model: "grok-4.7", effort: "high", fast: 1 }, // untouched — already base + effort + fast
    { id: "t06", model: "cursor-grok-4.6", effort: "xhigh", fast: 0 }, // untouched — other model
    { id: "t07", model: "cursor-grok-4.6-high", effort: null, fast: 0 }, // untouched — 4.6 variants are out of scope
    { id: "t08", model: "spacexai/grok-4.7", effort: null, fast: 0 }, // untouched — fx id
    { id: "t09", model: "grok-4.7-high", effort: "high", fast: 0 }, // untouched — not a cursor-kind harness
    { id: "t10", model: null, effort: null, fast: 0 }, // untouched — still NULL
    { id: "t11", model: "grok-4.7-max", effort: null, fast: 0 }, // untouched — not a real variant id
  ]);
  expect(readProfiles()).toEqual([
    { id: "p01", model: "grok-4.7", effort: "xhigh", fast: 0 },
    { id: "p02", model: "grok-4.7", effort: "high", fast: 1 },
    { id: "p03", model: "grok-4.7", effort: "medium", fast: 0 }, // untouched
    { id: "p04", model: "grok-4.7-low", effort: null, fast: 0 }, // untouched — not a cursor-kind harness
  ]);
  expect(readPrefs()).toEqual([
    { key: "lastMode:cursor", value: "auto", updated_at: 1 }, // untouched — not a lastModel key
    { key: "lastModel:codex", value: "grok-4.7-high", updated_at: 1 }, // untouched — other kind
    { key: "lastModel:cursor", value: "grok-4.7", updated_at: 1 }, // variant → base
  ]);

  // Idempotent: re-applying against the already-normalized rows is a no-op.
  const tasksBefore = readTasks();
  const profilesBefore = readProfiles();
  const prefsBefore = readPrefs();
  db.exec(normalizeCursorGrok47);
  expect(readTasks()).toEqual(tasksBefore);
  expect(readProfiles()).toEqual(profilesBefore);
  expect(readPrefs()).toEqual(prefsBefore);
});

test("070_normalize_cursor_opus_5_5 (upstream 056) folds suffixed claude-opus-5-5 variants into base id + effort + fast on cursor-kind tasks, agent profiles and the lastModel:cursor pref, idempotently", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE harnesses (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      fast INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      harness_id TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT,
      fast INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    INSERT INTO harnesses (id, kind) VALUES
      ('cursor', 'cursor'), ('cursor-2', 'cursor'), ('fx', 'fx'), ('codex', 'codex');
  `);

  db.exec(`
    INSERT INTO tasks (id, agent, model, effort, fast) VALUES
      ('t01', 'cursor', 'claude-opus-5-5-high', NULL, 0),
      ('t02', 'cursor-2', 'claude-opus-5-5-xhigh-fast', 'low', 0),
      ('t03', 'cursor', 'claude-opus-5-5-medium', 'medium', 1),
      ('t04', 'cursor', 'claude-opus-5-5-low-fast', NULL, 1),
      ('t05', 'cursor', 'claude-opus-5-5-max', NULL, 0),
      ('t06', 'cursor', 'claude-opus-5-5', 'high', 1),
      ('t07', 'cursor', 'claude-opus-5-thinking-high', NULL, 0),
      ('t08', 'cursor', 'claude-opus-5', NULL, 0),
      ('t09', 'fx', 'anthropic/claude-opus-5.5', NULL, 0),
      ('t10', 'codex', 'claude-opus-5-5-high', 'high', 0),
      ('t11', 'cursor', NULL, NULL, 0),
      ('t12', 'cursor', 'claude-opus-5-5-minimal', NULL, 0);
  `);

  db.exec(`
    INSERT INTO agent_profiles (id, harness_id, model, effort, fast) VALUES
      ('p01', 'cursor', 'claude-opus-5-5-xhigh', NULL, 0),
      ('p02', 'cursor-2', 'claude-opus-5-5-high-fast', 'high', 0),
      ('p03', 'cursor', 'claude-opus-5-5', 'medium', 0),
      ('p04', 'codex', 'claude-opus-5-5-low', NULL, 0);
  `);

  db.exec(`
    INSERT INTO preferences (key, value, updated_at) VALUES
      ('lastModel:cursor', 'claude-opus-5-5-high-fast', 1),
      ('lastModel:codex', 'claude-opus-5-5-high', 1),
      ('lastMode:cursor', 'auto', 1);
  `);

  const readTasks = () =>
    db
      .query<{ id: string; model: string | null; effort: string | null; fast: number }, []>(
        `SELECT id, model, effort, fast FROM tasks ORDER BY id`,
      )
      .all();
  const readProfiles = () =>
    db
      .query<{ id: string; model: string; effort: string | null; fast: number }, []>(
        `SELECT id, model, effort, fast FROM agent_profiles ORDER BY id`,
      )
      .all();
  const readPrefs = () =>
    db
      .query<{ key: string; value: string; updated_at: number }, []>(
        `SELECT key, value, updated_at FROM preferences ORDER BY key`,
      )
      .all();

  db.exec(normalizeCursorOpus55);
  expect(readTasks()).toEqual([
    { id: "t01", model: "claude-opus-5-5", effort: "high", fast: 0 }, // variant → base + effort
    { id: "t02", model: "claude-opus-5-5", effort: "xhigh", fast: 1 }, // variant wins over a stale effort; -fast sets fast; additional cursor harness via the kind join
    { id: "t03", model: "claude-opus-5-5", effort: "medium", fast: 0 }, // stale fast=1 cleared — the verbatim id ran the regular tier
    { id: "t04", model: "claude-opus-5-5", effort: "low", fast: 1 },
    { id: "t05", model: "claude-opus-5-5", effort: "max", fast: 0 }, // variant → base + effort (max IS a real Opus 5.5 tier, unlike grok-4.7's)
    { id: "t06", model: "claude-opus-5-5", effort: "high", fast: 1 }, // untouched — already base + effort + fast
    { id: "t07", model: "claude-opus-5-thinking-high", effort: null, fast: 0 }, // untouched — Opus 5 variant, no `-5-5-`
    { id: "t08", model: "claude-opus-5", effort: null, fast: 0 }, // untouched — other model (Opus 5, not 5.5)
    { id: "t09", model: "anthropic/claude-opus-5.5", effort: null, fast: 0 }, // untouched — fx id
    { id: "t10", model: "claude-opus-5-5-high", effort: "high", fast: 0 }, // untouched — not a cursor-kind harness
    { id: "t11", model: null, effort: null, fast: 0 }, // untouched — still NULL
    { id: "t12", model: "claude-opus-5-5-minimal", effort: null, fast: 0 }, // untouched — not a real variant id
  ]);
  expect(readProfiles()).toEqual([
    { id: "p01", model: "claude-opus-5-5", effort: "xhigh", fast: 0 },
    { id: "p02", model: "claude-opus-5-5", effort: "high", fast: 1 },
    { id: "p03", model: "claude-opus-5-5", effort: "medium", fast: 0 }, // untouched
    { id: "p04", model: "claude-opus-5-5-low", effort: null, fast: 0 }, // untouched — not a cursor-kind harness
  ]);
  expect(readPrefs()).toEqual([
    { key: "lastMode:cursor", value: "auto", updated_at: 1 }, // untouched — not a lastModel key
    { key: "lastModel:codex", value: "claude-opus-5-5-high", updated_at: 1 }, // untouched — other kind
    { key: "lastModel:cursor", value: "claude-opus-5-5", updated_at: 1 }, // variant → base
  ]);

  // Idempotent: re-applying against the already-normalized rows is a no-op.
  const tasksBefore = readTasks();
  const profilesBefore = readProfiles();
  const prefsBefore = readPrefs();
  db.exec(normalizeCursorOpus55);
  expect(readTasks()).toEqual(tasksBefore);
  expect(readProfiles()).toEqual(profilesBefore);
  expect(readPrefs()).toEqual(prefsBefore);
});

test("073 (upstream 059) creates the partial tasks(pipeline_id) index, is idempotent, and only indexes non-NULL pipeline_id rows", () => {
  const db = new Database(":memory:");
  migrate(db, migrations);
  const idx = db
    .query<{ name: string; sql: string }, []>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_pipeline_id'`,
    )
    .get();
  expect(idx?.sql).toContain("WHERE pipeline_id IS NOT NULL");
  // Re-running the migration set is a no-op (recorded in `_migrations`), and
  // the statement itself is `IF NOT EXISTS`, so applying it a second time
  // by hand doesn't throw either.
  migrate(db, migrations);
  db.exec(migrations.find((m) => m.id === "073_task_pipeline_id_index")!.sql);
  // The query planner actually uses the partial index for the parent lookup
  // `pipelines.taskCounts()` runs.
  const plan = db
    .query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN SELECT pipeline_id, COUNT(*) FROM tasks WHERE pipeline_id IS NOT NULL GROUP BY pipeline_id`,
    )
    .all();
  expect(plan.some((row) => row.detail.includes("idx_tasks_pipeline_id"))).toBe(true);
  db.close();
});
