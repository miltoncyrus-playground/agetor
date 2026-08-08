import { isActiveColumn, type ColumnId } from "../../shared/types.ts";

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
  { id: "backlog", label: "Backlog", dotClass: "bg-zinc-500" },
  { id: "ready", label: "Ready", dotClass: "bg-sky-500" },
  // Matches the existing pulsing "actively working" dot's color (TaskCard.tsx)
  // so an in-progress task's dot is emerald whether pulsing or resting.
  { id: "in-progress", label: "In Progress", dotClass: "bg-emerald-500" },
  // Deliberately not amber — the card's outer ring already uses amber for
  // "waiting on a human" (pendingInteractionCount > 0); a blocked dot in the
  // same color would collide with that unrelated signal.
  { id: "blocked", label: "Blocked", dotClass: "bg-red-500" },
  { id: "review", label: "Review", dotClass: "bg-violet-500" },
  { id: "done", label: "Done", dotClass: "bg-slate-400" },
];

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
