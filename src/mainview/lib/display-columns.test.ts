import { expect, test } from "bun:test";
import type { ColumnId } from "../../shared/types.ts";
import { COLUMNS, PIPELINE_STAGE_COLUMNS } from "../../shared/types.ts";
import {
  ALWAYS_VISIBLE_DISPLAY_COLUMNS,
  DISPLAY_COLUMNS,
  columnIdsFor,
  displayColumnMeta,
  filterLaneColumns,
  isDisplayColumnFilter,
  toDisplayColumn,
  type DisplayColumnId,
} from "./display-columns.ts";

// --- toDisplayColumn -------------------------------------------------------

test("toDisplayColumn passes the 5 non-pipeline columns straight through", () => {
  const passthrough: ColumnId[] = ["backlog", "ready", "blocked", "review", "done"];
  for (const c of passthrough) {
    expect(toDisplayColumn(c)).toBe(c as DisplayColumnId);
  }
});

test("toDisplayColumn collapses plain running into in-progress", () => {
  expect(toDisplayColumn("running")).toBe("in-progress");
});

test("toDisplayColumn collapses every pipeline-stage column into in-progress", () => {
  for (const c of PIPELINE_STAGE_COLUMNS) {
    expect(toDisplayColumn(c)).toBe("in-progress");
  }
});

test("every real ColumnId maps to exactly one display column with no throw", () => {
  for (const c of COLUMNS) {
    expect(() => toDisplayColumn(c.id)).not.toThrow();
  }
});

// --- DISPLAY_COLUMNS / displayColumnMeta ------------------------------------

test("DISPLAY_COLUMNS has exactly the 6 expected buckets, in board order", () => {
  expect(DISPLAY_COLUMNS.map((c) => c.id)).toEqual([
    "backlog", "ready", "in-progress", "blocked", "review", "done",
  ]);
});

test("no two display columns share a dot color", () => {
  const colors = DISPLAY_COLUMNS.map((c) => c.dotClass);
  expect(new Set(colors).size).toBe(colors.length);
});

test("no display column uses the amber family reserved for the awaiting ring", () => {
  for (const c of DISPLAY_COLUMNS) {
    expect(c.dotClass).not.toContain("amber");
  }
});

test("displayColumnMeta resolves each id to its own entry", () => {
  for (const c of DISPLAY_COLUMNS) {
    expect(displayColumnMeta(c.id)).toBe(c);
  }
});

// --- filterLaneColumns -------------------------------------------------------

const NONE = () => false;
const has = (...ids: DisplayColumnId[]) => {
  const s = new Set(ids);
  return (id: DisplayColumnId) => s.has(id);
};

test("every display column is in the always-visible set — nothing auto-hides anymore", () => {
  expect([...ALWAYS_VISIBLE_DISPLAY_COLUMNS].sort()).toEqual(
    ["backlog", "blocked", "done", "in-progress", "ready", "review"],
  );
});

test("an empty lane still renders all six columns, in board order", () => {
  expect(filterLaneColumns(DISPLAY_COLUMNS, NONE).map((c) => c.id)).toEqual([
    "backlog", "ready", "in-progress", "blocked", "review", "done",
  ]);
});

test("the user's status filter wins over always-visible (pre-filtered input is respected)", () => {
  // Simulates App.tsx's `visibleDisplayColumns` with "backlog" filtered out:
  // the helper never re-adds a column that isn't in its input.
  const withoutBacklog = DISPLAY_COLUMNS.filter((c) => c.id !== "backlog");
  const ids = filterLaneColumns(withoutBacklog, has("backlog", "done")).map((c) => c.id);
  expect(ids).toEqual(["ready", "in-progress", "blocked", "review", "done"]);
});

test("a populated column is kept exactly once (not duplicated) by both rules", () => {
  const ids = filterLaneColumns(DISPLAY_COLUMNS, has("ready")).map((c) => c.id);
  expect(ids).toEqual(["backlog", "ready", "in-progress", "blocked", "review", "done"]);
});

/* ── columnIdsFor / isDisplayColumnFilter ──────────────────────────────────
 * The inverse mapping the attention strip's chips drive App's real
 * `statusFilter: ColumnId[]` through. */

test("columnIdsFor is the exact inverse of toDisplayColumn for every column", () => {
  for (const c of COLUMNS) {
    expect(columnIdsFor(toDisplayColumn(c.id))).toContain(c.id);
  }
  // Every ColumnId is claimed by exactly one bucket — no column is dropped
  // or double-counted across the six buckets.
  const claimed = DISPLAY_COLUMNS.flatMap((d) => columnIdsFor(d.id));
  expect(claimed.length).toBe(COLUMNS.length);
  expect(new Set(claimed).size).toBe(COLUMNS.length);
});

test("in-progress expands to plain running plus every pipeline stage", () => {
  const ids = columnIdsFor("in-progress");
  expect(ids).toContain("running");
  for (const stage of PIPELINE_STAGE_COLUMNS) expect(ids).toContain(stage);
  expect(ids.length).toBe(PIPELINE_STAGE_COLUMNS.length + 1);
});

test("the non-pipeline buckets map one-to-one", () => {
  for (const id of ["backlog", "ready", "blocked", "review", "done"] as const) {
    expect(columnIdsFor(id)).toEqual([id]);
  }
});

test("isDisplayColumnFilter is true only for that bucket's exact set", () => {
  expect(isDisplayColumnFilter(columnIdsFor("in-progress"), "in-progress")).toBe(true);
  expect(isDisplayColumnFilter(["blocked"], "blocked")).toBe(true);
  // Order must not matter — the filter array's order is the menu's, not ours.
  expect(isDisplayColumnFilter([...columnIdsFor("in-progress")].reverse(), "in-progress")).toBe(true);
  // A strict subset is NOT the bucket: a hand-built filter of just `running`
  // must not light the in-progress chip as "already focused", or clicking it
  // would clear instead of expanding to the full set.
  expect(isDisplayColumnFilter(["running"], "in-progress")).toBe(false);
  // Same length, wrong members.
  expect(isDisplayColumnFilter(["review"], "blocked")).toBe(false);
  // The empty filter (no filtering at all) is never "focused".
  expect(isDisplayColumnFilter([], "in-progress")).toBe(false);
  expect(isDisplayColumnFilter([], "done")).toBe(false);
});

test("a same-LENGTH filter padded with duplicates is not mistaken for the bucket", () => {
  // The length check alone would pass here, so this is what makes the
  // every()-over-a-Set half of the implementation load-bearing: same count
  // as in-progress' 7 ids, but one real member repeated instead of the rest.
  const padded = Array<ColumnId>(columnIdsFor("in-progress").length).fill("running");
  expect(padded.length).toBe(columnIdsFor("in-progress").length);
  expect(isDisplayColumnFilter(padded, "in-progress")).toBe(false);
  // And the trivial shorter-with-duplicates case still fails on length.
  expect(isDisplayColumnFilter(["blocked", "blocked"] as ColumnId[], "blocked")).toBe(false);
});
