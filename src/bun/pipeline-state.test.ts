import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-state-"));
const { pipelineState, MAX_STORED_HANDOFFS } = await import("./pipeline-state.ts");
const { tasks, db } = await import("./db.ts");

function insertTask(id: string) {
  const now = Date.now();
  tasks.insert({
    id, title: "t", prompt: "x", column: "backlog", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: "opus-4.7", effort: "high",
    references: [], backlog: [], satisfiedSubtasks: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
    pipelineStage: "specify", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
    parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
  });
}

const h = (stage: string, files: string[] = ["a.ts"], cmds: string[] = []) =>
  ({ stage, filesRead: files.map((p) => ({ path: p, ranges: [] })), commandsOk: cmds });

test("handoffs: empty by default, append keeps newest-last, same stage replaces, cap enforced", () => {
  const id = crypto.randomUUID(); insertTask(id);
  expect(pipelineState.getHandoffs(id)).toEqual([]);
  pipelineState.appendHandoff(id, h("specify"));
  pipelineState.appendHandoff(id, h("planning", ["b.ts"]));
  expect(pipelineState.getHandoffs(id).map((x) => x.stage)).toEqual(["specify", "planning"]);
  // A re-run of the same stage replaces its earlier handoff instead of duplicating it.
  pipelineState.appendHandoff(id, h("planning", ["c.ts"]));
  expect(pipelineState.getHandoffs(id).map((x) => x.filesRead[0]!.path)).toEqual(["a.ts", "c.ts"]);
  for (const s of ["plan-review", "decompose", "building", "code-review"]) pipelineState.appendHandoff(id, h(s));
  const stored = pipelineState.getHandoffs(id);
  expect(stored.length).toBe(MAX_STORED_HANDOFFS);
  expect(stored[stored.length - 1]!.stage).toBe("code-review");
  expect(stored[0]!.stage).not.toBe("specify");
});

test("handoffs: an empty handoff is not stored", () => {
  const id = crypto.randomUUID(); insertTask(id);
  pipelineState.appendHandoff(id, h("specify", [], []));
  expect(pipelineState.getHandoffs(id)).toEqual([]);
});

test("review sha and precheck round-trip independently; clear drops the row; malformed JSON reads as empty", () => {
  const id = crypto.randomUUID(); insertTask(id);
  expect(pipelineState.getReviewSha(id)).toBeNull();
  pipelineState.setReviewSha(id, "abc123");
  expect(pipelineState.getReviewSha(id)).toBe("abc123");
  // Setting the sha did not disturb handoffs (separate columns, one row).
  pipelineState.appendHandoff(id, h("planning"));
  expect(pipelineState.getReviewSha(id)).toBe("abc123");
  expect(pipelineState.getPrecheck(id)).toBeNull();
  const summary = { results: [{ name: "test" as const, cmd: "npm test", ok: false, exitCode: 1, tail: "1 failing" }], unreferencedAcs: ["AC-2"], ranAt: 1 };
  pipelineState.setPrecheck(id, summary);
  expect(pipelineState.getPrecheck(id)).toEqual(summary);
  pipelineState.setPrecheck(id, null);
  expect(pipelineState.getPrecheck(id)).toBeNull();
  db.run("UPDATE pipeline_stage_state SET handoffs = 'not json', precheck = '{' WHERE task_id = ?", [id]);
  expect(pipelineState.getHandoffs(id)).toEqual([]);
  expect(pipelineState.getPrecheck(id)).toBeNull();
  pipelineState.clear(id);
  expect(pipelineState.getReviewSha(id)).toBeNull();
});

test("row is cascaded away with its task", () => {
  const id = crypto.randomUUID(); insertTask(id);
  pipelineState.setReviewSha(id, "deadbeef");
  db.run("DELETE FROM tasks WHERE id = ?", [id]);
  expect(db.query("SELECT count(*) AS n FROM pipeline_stage_state WHERE task_id = ?").get(id)).toEqual({ n: 0 });
});
