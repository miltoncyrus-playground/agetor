import { expect, test } from "bun:test";
import type { ColumnId } from "../../shared/types.ts";
import { COLUMNS, PIPELINE_STAGE_COLUMNS } from "../../shared/types.ts";
import { DISPLAY_COLUMNS, displayColumnMeta, toDisplayColumn, type DisplayColumnId } from "./display-columns.ts";

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
