import { COLUMNS, isActiveColumn, type ColumnId } from "../../shared/types.ts";

/**
 * The reduced 6-bucket taxonomy the swimlane board renders against, distinct
 * from `task.column`'s real 12-value `ColumnId`. `task.column` stays exactly
 * as-is for orchestration/DnD-target purposes — this is a display-only
 * mapping so a project's row doesn't have to spread one task's progress
 * across up to 6 near-empty pipeline-stage columns. All 6 pipeline stages
 * (see `PIPELINE_STAGE_COLUMNS`) plus plain `running` collapse into
 * `"in-progress"`; the specific stage still reads from the card's state text
 * and dot color, not from column position.
 */
export type DisplayColumnId = "backlog" | "ready" | "in-progress" | "blocked" | "review" | "done";

export const DISPLAY_COLUMNS: { id: DisplayColumnId; label: string; dotClass: string }[] = [
  // Semantic tokens only — literal palette classes (bg-emerald-500 and
  // friends) are tuned to one background and silently break in the other
  // theme (CLAUDE.md, UI conventions). The two states with no semantic
  // token of their own (backlog, done) use the neutral muted-foreground.
  { id: "backlog", label: "Backlog", dotClass: "bg-muted-foreground/50" },
  { id: "ready", label: "Ready", dotClass: "bg-info" },
  // Matches the existing pulsing "actively working" dot (TaskCard.tsx) so an
  // in-progress task's dot reads the same whether pulsing or resting.
  { id: "in-progress", label: "In Progress", dotClass: "bg-success-solid" },
  // Deliberately not the warning token — the card's outer ring already uses
  // it for "waiting on a human" (pendingInteractionCount > 0); a blocked dot
  // in the same color would collide with that unrelated signal.
  { id: "blocked", label: "Blocked", dotClass: "bg-danger-solid" },
  { id: "review", label: "Review", dotClass: "bg-primary" },
  { id: "done", label: "Done", dotClass: "bg-muted-foreground/40" },
];

/**
 * All six display columns render on every lane, empty or not — an empty
 * column shrinks to a slim stub (Column.tsx) instead of disappearing, so
 * the board geometry is stable and every column is always a drop target.
 * Kept as a set (rather than deleting the auto-hide seam entirely) so a
 * future column can opt back into auto-hide by omission.
 */
export const ALWAYS_VISIBLE_DISPLAY_COLUMNS: ReadonlySet<DisplayColumnId> =
  new Set(["backlog", "ready", "in-progress", "blocked", "review", "done"]);

/**
 * Per-lane column visibility: keep a column when it's always-visible OR it
 * has at least one task in this lane. With every column currently in the
 * always-visible set this passes its input through — the seam stays because
 * `visible` must already have the user's explicit status filter applied
 * (App.tsx's `visibleDisplayColumns`), which is what makes the filter win:
 * a status the user filtered out never reaches here.
 */
export function filterLaneColumns<T extends { id: DisplayColumnId }>(
  visible: T[],
  hasTasks: (id: DisplayColumnId) => boolean,
): T[] {
  return visible.filter((c) => ALWAYS_VISIBLE_DISPLAY_COLUMNS.has(c.id) || hasTasks(c.id));
}

const DISPLAY_COLUMN_BY_ID = new Map(DISPLAY_COLUMNS.map((c) => [c.id, c]));

export function displayColumnMeta(id: DisplayColumnId) {
  const meta = DISPLAY_COLUMN_BY_ID.get(id);
  if (!meta) throw new Error(`unknown display column: ${id}`);
  return meta;
}

/** Maps a real `ColumnId` down to its display bucket. `isActiveColumn`
 *  already means "running or any pipeline-stage column" — exactly the
 *  "in-progress" bucket, so it's reused rather than re-listing the 6
 *  pipeline stages here. */
export function toDisplayColumn(column: ColumnId): DisplayColumnId {
  if (isActiveColumn(column)) return "in-progress";
  if (column === "backlog" || column === "ready" || column === "blocked"
      || column === "review" || column === "done") {
    return column;
  }
  // Unreachable given ColumnId's full union (isActiveColumn already covers
  // every pipeline-stage id), kept for exhaustiveness safety against a
  // future ColumnId addition.
  return "in-progress";
}

/**
 * The real `ColumnId`s a display bucket stands for — the inverse of
 * `toDisplayColumn`. The attention strip's chips drive App's existing
 * `statusFilter: ColumnId[]`, and "in-progress" covers plain `running` plus
 * all six pipeline stages, so a chip click has to expand to that whole set
 * rather than a single id. Derived from `toDisplayColumn` over `COLUMNS`
 * instead of re-listing the stages, so the two can't drift.
 */
export function columnIdsFor(display: DisplayColumnId): ColumnId[] {
  return COLUMNS.filter((c) => toDisplayColumn(c.id) === display).map((c) => c.id);
}

/** True when `filter` is exactly the set `display` expands to — i.e. the
 *  board is currently focused on that one bucket and clicking its chip
 *  again should clear the filter. Order-insensitive. */
export function isDisplayColumnFilter(filter: ColumnId[], display: DisplayColumnId): boolean {
  const ids = columnIdsFor(display);
  if (filter.length !== ids.length) return false;
  const set = new Set(filter);
  return ids.every((id) => set.has(id));
}
