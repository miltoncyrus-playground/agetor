import { expect, test } from "bun:test";
import type { ColumnId } from "../../shared/types.ts";
import { COLUMNS, PIPELINE_STAGE_COLUMNS } from "../../shared/types.ts";
import {
  ALWAYS_VISIBLE_DISPLAY_COLUMNS,
  DISPLAY_COLUMNS,
  displayColumnMeta,
  filterLaneColumns,
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

test("the four working columns are exactly the always-visible set", () => {
  expect([...ALWAYS_VISIBLE_DISPLAY_COLUMNS].sort()).toEqual(
    ["backlog", "blocked", "in-progress", "ready"],
  );
});

test("an empty lane still renders the four working columns, in board order", () => {
  expect(filterLaneColumns(DISPLAY_COLUMNS, NONE).map((c) => c.id)).toEqual([
    "backlog", "ready", "in-progress", "blocked",
  ]);
});

test("review and done stay auto-hidden when empty", () => {
  const ids = filterLaneColumns(DISPLAY_COLUMNS, NONE).map((c) => c.id);
  expect(ids).not.toContain("review");
  expect(ids).not.toContain("done");
});

test("review and done render once the lane has a task in them", () => {
  expect(filterLaneColumns(DISPLAY_COLUMNS, has("done")).map((c) => c.id)).toEqual([
    "backlog", "ready", "in-progress", "blocked", "done",
  ]);
  expect(filterLaneColumns(DISPLAY_COLUMNS, has("review", "done")).map((c) => c.id)).toEqual([
    "backlog", "ready", "in-progress", "blocked", "review", "done",
  ]);
});

test("the user's status filter wins over always-visible (pre-filtered input is respected)", () => {
  // Simulates App.tsx's `visibleDisplayColumns` with "backlog" filtered out:
  // the helper never re-adds a column that isn't in its input.
  const withoutBacklog = DISPLAY_COLUMNS.filter((c) => c.id !== "backlog");
  const ids = filterLaneColumns(withoutBacklog, has("backlog", "done")).map((c) => c.id);
  expect(ids).toEqual(["ready", "in-progress", "blocked", "done"]);
});

test("a populated working column is kept (not duplicated) by both rules", () => {
  const ids = filterLaneColumns(DISPLAY_COLUMNS, has("ready")).map((c) => c.id);
  expect(ids).toEqual(["backlog", "ready", "in-progress", "blocked"]);
});
