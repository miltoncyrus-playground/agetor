import { test, expect } from "bun:test";
import {
  parsePipelineVerdict,
  stagePrompt,
  PIPELINE_PLAN_FILE,
  PIPELINE_VERDICT_PREFIX,
} from "./pipeline-prompts.ts";
import type { Task } from "../shared/types.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1", title: "Add dark mode", prompt: "Add a dark mode toggle to settings.",
    column: "planning", agent: "claude-code", workdir: "/tmp/wd", isolation: "worktree",
    taskType: "task", branch: "agetor/t1-add-dark-mode", branchSource: "created",
    worktreePath: "/tmp/wt", baseRef: "abc123", prUrl: null,
    mode: null, model: null, effort: null,
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: 0, updatedAt: 0, archivedAt: null,
    pipelineStage: "planning", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null,
    ...overrides,
  };
}

// --- parsePipelineVerdict: plan-review -------------------------------------

test("plan-review: approve, as the sole final line", () => {
  const v = parsePipelineVerdict("plan-review", "Looks solid.\n\nPIPELINE_VERDICT: approve");
  expect(v).toEqual({ ok: true, kind: "approve" });
});

test("plan-review: revise with a multi-word reason", () => {
  const v = parsePipelineVerdict(
    "plan-review",
    "Missing test coverage.\n\nPIPELINE_VERDICT: revise the plan omits how theme state persists across restarts",
  );
  expect(v).toEqual({
    ok: true,
    kind: "revise",
    reason: "the plan omits how theme state persists across restarts",
  });
});

test("plan-review: revise with no reason text still parses, placeholder reason", () => {
  const v = parsePipelineVerdict("plan-review", "PIPELINE_VERDICT: revise");
  expect(v).toEqual({ ok: true, kind: "revise", reason: "(no reason given)" });
});

test("plan-review: trailing blank lines after the sentinel don't break the match", () => {
  const v = parsePipelineVerdict("plan-review", "PIPELINE_VERDICT: approve\n\n\n");
  expect(v).toEqual({ ok: true, kind: "approve" });
});

test("plan-review: no sentinel at all -> unparseable", () => {
  const v = parsePipelineVerdict("plan-review", "This plan looks good to me!");
  expect(v).toEqual({ ok: false });
});

test("plan-review: sentinel prefix present but wrong keyword for this stage -> unparseable, not misread as pass/fail", () => {
  const v = parsePipelineVerdict("plan-review", "PIPELINE_VERDICT: pass");
  expect(v).toEqual({ ok: false });
});

test("plan-review: sentinel mentioned mid-message (not the true final line) is still honored if it's the LAST occurrence", () => {
  const v = parsePipelineVerdict(
    "plan-review",
    "I was going to write PIPELINE_VERDICT: revise but changed my mind.\nPIPELINE_VERDICT: approve",
  );
  expect(v).toEqual({ ok: true, kind: "approve" });
});

test("plan-review: earlier sentinel is superseded by a later one in the same message", () => {
  const v = parsePipelineVerdict(
    "plan-review",
    "PIPELINE_VERDICT: approve\nWait, actually on reflection:\nPIPELINE_VERDICT: revise reconsidered after re-reading the plan",
  );
  expect(v.ok && v.kind).toBe("revise");
});

// --- parsePipelineVerdict: testing ------------------------------------------

test("testing: pass", () => {
  expect(parsePipelineVerdict("testing", "All green.\nPIPELINE_VERDICT: pass"))
    .toEqual({ ok: true, kind: "pass" });
});

test("testing: fail with reason", () => {
  const v = parsePipelineVerdict("testing", "PIPELINE_VERDICT: fail 3 type errors in settings.ts");
  expect(v).toEqual({ ok: true, kind: "fail", reason: "3 type errors in settings.ts" });
});

test("testing: 'approve'/'revise' keywords (the other stage's) don't parse for testing", () => {
  expect(parsePipelineVerdict("testing", "PIPELINE_VERDICT: approve")).toEqual({ ok: false });
  expect(parsePipelineVerdict("testing", "PIPELINE_VERDICT: revise something")).toEqual({ ok: false });
});

test("testing: case-insensitive keyword match", () => {
  expect(parsePipelineVerdict("testing", "PIPELINE_VERDICT: PASS")).toEqual({ ok: true, kind: "pass" });
});

// --- stagePrompt -------------------------------------------------------------

test("stagePrompt: planning embeds the ticket and PLAN.md filename, no verdict instruction", () => {
  const p = stagePrompt(task({ pipelineStage: "planning" }), "planning");
  expect(p).toContain("Add a dark mode toggle to settings.");
  expect(p).toContain(PIPELINE_PLAN_FILE);
  expect(p).not.toContain(PIPELINE_VERDICT_PREFIX);
});

test("stagePrompt: planning folds in prior feedback when present", () => {
  const p = stagePrompt(
    task({ pipelineStage: "planning", pipelineFeedback: "needs a rollback plan" }),
    "planning",
  );
  expect(p).toContain("needs a rollback plan");
});

test("stagePrompt: plan-review instructs the verdict sentinel format for both outcomes", () => {
  const p = stagePrompt(task({ pipelineStage: "plan-review" }), "plan-review");
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} approve`);
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} revise`);
});

test("stagePrompt: building references PLAN.md and folds in tester feedback", () => {
  const p = stagePrompt(
    task({ pipelineStage: "building", pipelineFeedback: "off-by-one in the pagination" }),
    "building",
  );
  expect(p).toContain(PIPELINE_PLAN_FILE);
  expect(p).toContain("off-by-one in the pagination");
});

test("stagePrompt: testing explicitly forbids push/PR (never silently omits it), and derives the commit-type prefix from the branch", () => {
  const p = stagePrompt(task({ pipelineStage: "testing", branch: "feature/dark-mode" }), "testing");
  expect(p.toLowerCase()).toContain("do not push");
  expect(p.toLowerCase()).toContain("do not open a pull request");
  expect(p.toLowerCase()).not.toContain("push it"); // no instruction to actually push
  expect(p).toContain('"feature:');
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} pass`);
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} fail`);
});

test("stagePrompt: testing falls back to task-type commit prefix when the branch has no slash", () => {
  const p = stagePrompt(
    task({ pipelineStage: "testing", branch: null, taskType: "bug" }),
    "testing",
  );
  expect(p).toContain('"fix:');
});
