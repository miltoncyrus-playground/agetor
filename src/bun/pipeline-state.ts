import { db } from "./db.ts";
import type { StageHandoff } from "./stage-handoff.ts";

/**
 * Between-stage scratch state for a pipeline task (migration 059). One row
 * per task, created lazily on first write, cascaded away with the task.
 * Everything here is server-managed and never surfaces through the task
 * PATCH allow-list — it exists so the NEXT stage's prompt can be assembled
 * from what earlier stages already learned instead of re-deriving it in
 * latent space (docs/plans/pipeline-token-efficiency.md O-5, O-6, O-11).
 *
 * Every read is fail-safe (a malformed JSON column reads as empty) and
 * every write is a single UPSERT, so a crash mid-write leaves the previous
 * row intact rather than a half-record.
 */

/** Newest-last cap on stored handoffs. Four covers specify → decompose plus
 *  one bounce; older stages' reads are superseded by later ones anyway and
 *  renderHandoff's char budget would drop them first. */
export const MAX_STORED_HANDOFFS = 4;

/** Result of agetor's own typecheck/lint/test run before the Tester stage
 *  (O-5). `tail` is the last bytes of combined output for FAILED commands
 *  only — passing output is noise the Tester never needs to read. */
export interface PrecheckResult {
  name: "typecheck" | "lint" | "test";
  cmd: string;
  ok: boolean;
  exitCode: number | null;
  tail: string;
}

export interface PrecheckSummary {
  results: PrecheckResult[];
  /** AC ids from SPEC.md that no test file mentions literally — the
   *  deterministic reason a green precheck still needs a Tester turn. */
  unreferencedAcs: string[];
  ranAt: number;
}

interface Row {
  task_id: string;
  handoffs: string;
  review_sha: string | null;
  precheck: string | null;
  updated_at: number;
}

const stmts = {
  get: db.prepare<Row, [string]>("SELECT task_id, handoffs, review_sha, precheck, updated_at FROM pipeline_stage_state WHERE task_id = ?"),
  upsertHandoffs: db.prepare(
    `INSERT INTO pipeline_stage_state (task_id, handoffs, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET handoffs = excluded.handoffs, updated_at = excluded.updated_at`,
  ),
  upsertReviewSha: db.prepare(
    `INSERT INTO pipeline_stage_state (task_id, review_sha, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET review_sha = excluded.review_sha, updated_at = excluded.updated_at`,
  ),
  upsertPrecheck: db.prepare(
    `INSERT INTO pipeline_stage_state (task_id, precheck, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET precheck = excluded.precheck, updated_at = excluded.updated_at`,
  ),
  clear: db.prepare("DELETE FROM pipeline_stage_state WHERE task_id = ?"),
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return (v as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export const pipelineState = {
  getHandoffs(taskId: string): StageHandoff[] {
    const row = stmts.get.get(taskId);
    const list = parseJson<unknown>(row?.handoffs ?? null, []);
    return Array.isArray(list) ? (list as StageHandoff[]) : [];
  },

  /** Append one settled stage's handoff, dropping the oldest past the cap.
   *  A handoff with nothing in it (no reads, no commands) is not stored —
   *  renderHandoff would omit it anyway and it would only push a useful
   *  older one out of the window. Returns the stored list. */
  appendHandoff(taskId: string, handoff: StageHandoff): StageHandoff[] {
    if (handoff.filesRead.length === 0 && handoff.commandsOk.length === 0) return this.getHandoffs(taskId);
    const next = [...this.getHandoffs(taskId).filter((h) => h.stage !== handoff.stage), handoff].slice(-MAX_STORED_HANDOFFS);
    stmts.upsertHandoffs.run(taskId, JSON.stringify(next), Date.now());
    return next;
  },

  getReviewSha(taskId: string): string | null {
    return stmts.get.get(taskId)?.review_sha ?? null;
  },

  setReviewSha(taskId: string, sha: string | null): void {
    stmts.upsertReviewSha.run(taskId, sha, Date.now());
  },

  getPrecheck(taskId: string): PrecheckSummary | null {
    const row = stmts.get.get(taskId);
    const v = parseJson<PrecheckSummary | null>(row?.precheck ?? null, null);
    return v && Array.isArray(v.results) ? v : null;
  },

  setPrecheck(taskId: string, summary: PrecheckSummary | null): void {
    stmts.upsertPrecheck.run(taskId, summary ? JSON.stringify(summary) : null, Date.now());
  },

  /** Drop every scrap of between-stage state (a fresh pipeline run from
   *  specify should not inherit a stale review sha or precheck). */
  clear(taskId: string): void {
    stmts.clear.run(taskId);
  },
};
