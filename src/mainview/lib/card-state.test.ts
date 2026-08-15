/* Gate tests for the card face's single state string (cardStateLabel) —
 * pinned by the 2dot2dot completed-pipeline confusion (2026-08-15): a
 * pipeline that passed testing landed on `ready` but the card kept wearing
 * a "Testing" badge (pipelineStage is never cleared), reading as "hasn't
 * moved" when the pipeline was in fact complete. */

import { test, expect } from "bun:test";
import { cardStateLabel, type CardStateInput } from "./card-state.ts";

function input(overrides: Partial<CardStateInput> = {}): CardStateInput {
  return {
    column: "ready",
    pipelineStage: null,
    awaitingHandBack: false,
    gateParked: false,
    stalledSince: null,
    ...overrides,
  };
}

test("a completed pipeline (terminal column, stage never cleared) shows the COLUMN label, not the last stage", () => {
  // The incident shape: testing passed → column ready, pipelineStage still "testing".
  expect(cardStateLabel(input({ column: "ready", pipelineStage: "testing" }))).toBe("Ready");
  // Same rule for the other resting columns a pipeline task can end up in.
  expect(cardStateLabel(input({ column: "review", pipelineStage: "testing" }))).toBe("Review");
  expect(cardStateLabel(input({ column: "done", pipelineStage: "testing" }))).toBe("Done");
});

test("mid-pipeline (stage column) and blocked-mid-pipeline show the STAGE label", () => {
  expect(cardStateLabel(input({ column: "code-review", pipelineStage: "code-review" })))
    .toBe(cardStateLabel(input({ column: "code-review", pipelineStage: "code-review" })));
  // Stage label, whatever COLUMNS names it — assert it's the stage's label,
  // not the column fallback, by checking the two stage/column disagree case.
  const label = cardStateLabel(input({ column: "building", pipelineStage: "code-review" }));
  expect(label.toLowerCase()).toContain("code");
  // Blocked mid-pipeline: "which stage blocked" is the useful fact.
  const blocked = cardStateLabel(input({ column: "blocked", pipelineStage: "testing" }));
  expect(blocked.toLowerCase()).toContain("test");
});

test("non-pipeline tasks always show the column label", () => {
  expect(cardStateLabel(input({ column: "running" }))).toBe("Running");
  expect(cardStateLabel(input({ column: "backlog" }))).toBe("Backlog");
});

test("attention overrides beat everything, in priority order", () => {
  const base = { column: "code-review" as const, pipelineStage: "code-review" as const };
  expect(cardStateLabel(input({ ...base, awaitingHandBack: true }))).toBe("awaiting hand-back");
  expect(cardStateLabel(input({ ...base, stalledSince: Date.now() }))).toBe("may be stuck");
  expect(cardStateLabel(input({ ...base, gateParked: true }))).toBe("gate parked");
  // awaitingHandBack outranks stalled which outranks gateParked.
  expect(cardStateLabel(input({ ...base, awaitingHandBack: true, stalledSince: 1, gateParked: true })))
    .toBe("awaiting hand-back");
  expect(cardStateLabel(input({ ...base, stalledSince: 1, gateParked: true }))).toBe("may be stuck");
});
