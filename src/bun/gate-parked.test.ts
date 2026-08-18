/* ────────────────────────────────────────────────────────────────────────── *
 * Gate tests for the `Task.gateParked` derived flag (2dot2dot code-review
 * incident 2026-08-15): a parent pipeline task parked on its gate column by
 * a conversation turn — the RC-6 provenance gate correctly refuses to
 * advance, but its "use Retry stage or the gate override" breadcrumb pointed
 * at buttons that only render for a `blocked` task. `gateParked` is the
 * parent-side twin of `awaitingHandBack` and drives the GateParkedBanner.
 *
 * Two layers: the pure `isGateParked` predicate, and the db.ts derivation
 * (correlated `current_run_origin` subquery through tasks.get/list) —
 * including the race-freedom property: a settled STAGE run never flags, so
 * the async gap before the next stage's run row appears can't flicker the
 * banner on during a normal auto-advance.
 * ────────────────────────────────────────────────────────────────────────── */

import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isGateParked, type Task } from "../shared/types.ts";

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-gate-parked-"));
const { tasks, runs } = await import("./db.ts");

/* ── 1. isGateParked predicate ───────────────────────────────────────────── */

const PARKED: Parameters<typeof isGateParked>[0] = {
  parentTaskId: null,
  pipelineStage: "code-review",
  archivedAt: null,
  pausedAt: null,
  column: "code-review",
};

test("isGateParked: the incident shape — conversation turn settled on the gate column", () => {
  expect(isGateParked(PARKED, "succeeded", null)).toBe(true);
  expect(isGateParked(PARKED, "succeeded", "continuation")).toBe(true);
});

test("isGateParked: a settled stage run never flags (race-freedom during auto-advance)", () => {
  expect(isGateParked(PARKED, "succeeded", "pipeline-stage")).toBe(false);
});

test("isGateParked: in-flight, failed, or never-ran turns don't flag", () => {
  expect(isGateParked(PARKED, "running", null)).toBe(false);
  expect(isGateParked(PARKED, "failed", null)).toBe(false);
  expect(isGateParked(PARKED, "cancelled", null)).toBe(false);
  expect(isGateParked(PARKED, null, null)).toBe(false);
});

test("isGateParked: children, non-pipeline, paused, archived, and off-column tasks are excluded", () => {
  expect(isGateParked({ ...PARKED, parentTaskId: randomUUID() }, "succeeded", null)).toBe(false);
  expect(isGateParked({ ...PARKED, pipelineStage: null }, "succeeded", null)).toBe(false);
  expect(isGateParked({ ...PARKED, pausedAt: Date.now() }, "succeeded", null)).toBe(false);
  expect(isGateParked({ ...PARKED, archivedAt: Date.now() }, "succeeded", null)).toBe(false);
  // Conversation turn pulled the card to "running" and it hasn't been
  // re-affirmed to the stage column yet — not parked.
  expect(isGateParked({ ...PARKED, column: "running" }, "succeeded", null)).toBe(false);
  // Card in blocked — BlockedBanner owns that state, not the parked banner.
  expect(isGateParked({ ...PARKED, column: "blocked" }, "succeeded", null)).toBe(false);
});

/* ── 2. db.ts derivation through current_run_origin ──────────────────────── */

function seedPipelineTask(overrides: Partial<Task> = {}): string {
  const id = randomUUID();
  const now = Date.now();
  tasks.insert({
    id, title: "t", prompt: "x", column: "code-review", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: null, effort: null,
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "code-review", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pipelineBounceFingerprint: null,
    pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null,
    childMergeStatus: null,
    ...overrides,
  });
  return id;
}

function seedRun(taskId: string, origin: string | null, status = "succeeded"): string {
  const id = randomUUID();
  runs.insert({
    id, taskId, agent: "claude-code", status: status as never,
    startedAt: Date.now() - 1_000, endedAt: Date.now(), exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, geminiSessionId: null,
    origin: origin as never,
  });
  tasks.update(taskId, { runId: id });
  return id;
}

test("db derivation: conversation-turn run on the gate column → gateParked true (get and list agree)", () => {
  const id = seedPipelineTask();
  seedRun(id, null);
  expect(tasks.get(id)?.gateParked).toBe(true);
  expect(tasks.list().find((t) => t.id === id)?.gateParked).toBe(true);
});

test("db derivation: stage run / running run / paused task → gateParked false", () => {
  const stage = seedPipelineTask();
  seedRun(stage, "pipeline-stage");
  expect(tasks.get(stage)?.gateParked).toBe(false);

  const inflight = seedPipelineTask();
  seedRun(inflight, null, "running");
  expect(tasks.get(inflight)?.gateParked).toBe(false);

  const paused = seedPipelineTask({ pausedAt: Date.now() });
  seedRun(paused, "continuation");
  expect(tasks.get(paused)?.gateParked).toBe(false);
});

test("db derivation: a task that never ran carries no flag", () => {
  const id = seedPipelineTask();
  expect(tasks.get(id)?.gateParked).toBe(false);
});
