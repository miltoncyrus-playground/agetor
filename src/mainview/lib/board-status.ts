import { COLUMNS, isActiveColumn, type ColumnId, type Task } from "../../shared/types.ts";

/**
 * Pure helpers behind the board's "pipeline status at a glance" affordances:
 * the attention strip above the lanes, the per-lane pipeline-stage breakdown,
 * the Done column's recent-only window, waiting-first card ordering, and the
 * time-in-column age badge. All deterministic — every function takes its
 * inputs (including `nowMs`) explicitly so the gate tests never touch the
 * clock.
 */

/** One predicate for "this card is waiting on the human", shared by the
 *  attention strip's waiting count, the waiting-first column sort, and the
 *  card's amber ring: a pending interaction (question/approval) or a build
 *  child whose finished work awaits an explicit hand-back to the pipeline. */
export function isWaitingOnHuman(t: Pick<Task, "pendingInteractionCount" | "awaitingHandBack">): boolean {
  return t.pendingInteractionCount > 0 || t.awaitingHandBack === true;
}

export interface AttentionSummary {
  /** Agent actively working: plain `running` or any pipeline-stage column. */
  running: number;
  blocked: number;
  review: number;
  /** Tasks waiting on the human (see `isWaitingOnHuman`) — orthogonal to
   *  column, so counted independently of the three above. */
  waiting: number;
}

/** Board-level triage counts. Archived tasks never need attention. */
export function attentionSummary(tasks: Task[]): AttentionSummary {
  const s: AttentionSummary = { running: 0, blocked: 0, review: 0, waiting: 0 };
  for (const t of tasks) {
    if (t.archivedAt != null) continue;
    if (isActiveColumn(t.column)) s.running++;
    else if (t.column === "blocked") s.blocked++;
    else if (t.column === "review") s.review++;
    if (isWaitingOnHuman(t)) s.waiting++;
  }
  return s;
}

/**
 * Which actual columns the merged "In Progress" bucket is hiding, in COLUMNS
 * (pipeline) order — "2 Building · 1 Testing" for a lane header. Only tasks
 * in an active column count; anything else in the input is ignored so the
 * caller can pass the bucket's array verbatim.
 */
export function stageBreakdown(tasks: Task[]): { id: ColumnId; label: string; count: number }[] {
  const counts = new Map<ColumnId, number>();
  for (const t of tasks) {
    if (!isActiveColumn(t.column)) continue;
    counts.set(t.column, (counts.get(t.column) ?? 0) + 1);
  }
  return COLUMNS.filter((c) => counts.has(c.id)).map((c) => ({
    id: c.id,
    label: c.label,
    count: counts.get(c.id)!,
  }));
}

export const DONE_RECENCY_DAYS = 7;

/**
 * The Done column's recent-only window: tasks finished within the cutoff
 * stay visible, the rest collapse into a "+N older" footer. Uses
 * `updatedAt` — a done task's last update IS reaching done (or being
 * archived, which removes it from the active view anyway). Returns the
 * INPUT array reference when nothing is older, so Column's element-wise
 * memo bailout keeps working on the common case.
 */
export function partitionRecentDone(
  tasks: Task[],
  nowMs: number,
  cutoffDays = DONE_RECENCY_DAYS,
): { recent: Task[]; olderCount: number } {
  const cutoff = nowMs - cutoffDays * 86_400_000;
  const recent = tasks.filter((t) => t.updatedAt >= cutoff);
  if (recent.length === tasks.length) return { recent: tasks, olderCount: 0 };
  return { recent, olderCount: tasks.length - recent.length };
}

/**
 * Float cards waiting on a human (pending interaction) to the top of their
 * column, keeping relative order stable within both groups. Returns the
 * INPUT array reference when the order is already correct (including "no
 * waiting cards at all") — same memo-bailout contract as above.
 */
export function sortWaitingFirst(tasks: Task[]): Task[] {
  let seenNonWaiting = false;
  let needsSort = false;
  for (const t of tasks) {
    if (isWaitingOnHuman(t)) {
      if (seenNonWaiting) { needsSort = true; break; }
    } else {
      seenNonWaiting = true;
    }
  }
  if (!needsSort) return tasks;
  const waiting = tasks.filter((t) => isWaitingOnHuman(t));
  const rest = tasks.filter((t) => !isWaitingOnHuman(t));
  return [...waiting, ...rest];
}

/** How long the age badge stays hidden — sub-hour dwell in Review/Blocked
 *  is normal flow, not rot. */
export const AGE_BADGE_MIN_MS = 60 * 60_000;

/** "45m" / "3h" / "2d" — coarse on purpose; the badge flags rot, not SLAs. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
