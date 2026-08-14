import { expect, test } from "bun:test";
import type { ColumnId, Task } from "../../shared/types.ts";
import {
  AGE_BADGE_MIN_MS,
  attentionSummary,
  formatAge,
  partitionRecentDone,
  sortWaitingFirst,
  stageBreakdown,
} from "./board-status.ts";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function task(over: Partial<Task>): Task {
  return {
    id: Math.random().toString(36).slice(2),
    column: "ready",
    pendingInteractionCount: 0,
    archivedAt: null,
    updatedAt: NOW,
    ...over,
  } as Task;
}

// --- attentionSummary --------------------------------------------------------

test("attentionSummary buckets running/blocked/review and counts waiting orthogonally", () => {
  const s = attentionSummary([
    task({ column: "running" }),
    task({ column: "building" as ColumnId }), // pipeline stage → running
    task({ column: "blocked", pendingInteractionCount: 1 }), // blocked AND waiting
    task({ column: "review" }),
    task({ column: "ready", pendingInteractionCount: 2 }), // waiting only
    task({ column: "backlog" }),
    task({ column: "done" }),
  ]);
  expect(s).toEqual({ running: 2, blocked: 1, review: 1, waiting: 2 });
});

test("attentionSummary ignores archived tasks entirely", () => {
  const s = attentionSummary([
    task({ column: "blocked", archivedAt: NOW, pendingInteractionCount: 1 }),
  ]);
  expect(s).toEqual({ running: 0, blocked: 0, review: 0, waiting: 0 });
});

// --- stageBreakdown ----------------------------------------------------------

test("stageBreakdown counts active columns in pipeline order and skips the rest", () => {
  const rows = stageBreakdown([
    task({ column: "testing" as ColumnId }),
    task({ column: "building" as ColumnId }),
    task({ column: "building" as ColumnId }),
    task({ column: "running" }),
    task({ column: "review" }), // not active — ignored
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.count]));
  expect(byId["building"]).toBe(2);
  expect(byId["testing"]).toBe(1);
  expect(byId["running"]).toBe(1);
  // Order follows COLUMNS, so building precedes testing.
  expect(rows.findIndex((r) => r.id === "building")).toBeLessThan(rows.findIndex((r) => r.id === "testing"));
  expect(rows.every((r) => r.label.length > 0)).toBe(true);
});

test("stageBreakdown of an empty or inactive list is empty", () => {
  expect(stageBreakdown([])).toEqual([]);
  expect(stageBreakdown([task({ column: "done" })])).toEqual([]);
});

// --- partitionRecentDone -----------------------------------------------------

test("partitionRecentDone splits at the cutoff and preserves order", () => {
  const fresh = task({ column: "done", updatedAt: NOW - DAY });
  const stale = task({ column: "done", updatedAt: NOW - 8 * DAY });
  const edge = task({ column: "done", updatedAt: NOW - 7 * DAY }); // exactly at cutoff → recent
  const { recent, olderCount } = partitionRecentDone([fresh, stale, edge], NOW);
  expect(recent).toEqual([fresh, edge]);
  expect(olderCount).toBe(1);
});

test("partitionRecentDone returns the input array reference when nothing is older", () => {
  const tasks = [task({ column: "done" }), task({ column: "done" })];
  const { recent, olderCount } = partitionRecentDone(tasks, NOW);
  expect(recent).toBe(tasks);
  expect(olderCount).toBe(0);
});

// --- sortWaitingFirst --------------------------------------------------------

test("sortWaitingFirst floats waiting cards up, stable within both groups", () => {
  const a = task({}); const b = task({ pendingInteractionCount: 1 });
  const c = task({}); const d = task({ pendingInteractionCount: 3 });
  expect(sortWaitingFirst([a, b, c, d])).toEqual([b, d, a, c]);
});

test("sortWaitingFirst returns the input reference when already ordered (memo contract)", () => {
  const none = [task({}), task({})];
  expect(sortWaitingFirst(none)).toBe(none);
  const prefix = [task({ pendingInteractionCount: 1 }), task({})];
  expect(sortWaitingFirst(prefix)).toBe(prefix);
  const empty: Task[] = [];
  expect(sortWaitingFirst(empty)).toBe(empty);
});

// --- formatAge ---------------------------------------------------------------

test("formatAge renders minutes, hours, then days at the documented breakpoints", () => {
  expect(formatAge(5 * 60_000)).toBe("5m");
  expect(formatAge(59 * 60_000)).toBe("59m");
  expect(formatAge(60 * 60_000)).toBe("1h");
  expect(formatAge(47 * 3_600_000)).toBe("47h");
  expect(formatAge(48 * 3_600_000)).toBe("2d");
  expect(formatAge(-5)).toBe("0m");
});

test("the age badge threshold is one hour", () => {
  expect(AGE_BADGE_MIN_MS).toBe(3_600_000);
});
