import { branchCommitType, type Task } from "../shared/types.ts";

/**
 * Fixed filename the Planner writes its plan to, at the worktree root. New
 * convention introduced by pipeline tasks — nothing like it exists
 * elsewhere in agetor. Plain markdown, overwritten on every planning pass
 * (including a revision), no fixed internal schema — just "a human/agent
 * can read what to build and why."
 */
export const PIPELINE_PLAN_FILE = "PLAN.md";

/**
 * Single line prefix both verdict-bearing stages (plan-review, testing) are
 * instructed to end their final message with, followed by a keyword and
 * (on a send-back) a free-text reason:
 *   PIPELINE_VERDICT: approve
 *   PIPELINE_VERDICT: revise <reason...>
 *   PIPELINE_VERDICT: pass
 *   PIPELINE_VERDICT: fail <reason...>
 * One shared prefix rather than stage-specific sentinels — the caller
 * already knows which stage it's parsing for (task.pipelineStage), so the
 * stage disambiguates approve/revise from pass/fail. Line-anchored,
 * fixed-keyword format so parsing is a simple regex, not prose matching.
 */
export const PIPELINE_VERDICT_PREFIX = "PIPELINE_VERDICT:";

/** Result of parsing a verdict-bearing stage's last assistant message. */
export type PipelineVerdict =
  | { ok: true; kind: "approve" | "pass" }
  | { ok: true; kind: "revise" | "fail"; reason: string }
  | { ok: false };

const APPROVE_KEYWORDS: Record<"plan-review" | "testing", { ok: string; bounce: string }> = {
  "plan-review": { ok: "approve", bounce: "revise" },
  "testing": { ok: "pass", bounce: "fail" },
};

/**
 * Parse a verdict-bearing stage's final assistant message for the
 * PIPELINE_VERDICT sentinel. Pure — no DB/IO — so it's directly
 * unit-testable. Scans all lines (not just the very last one) so a trailing
 * blank line or closing remark after the sentinel doesn't break the match;
 * if the sentinel appears more than once, the LAST occurrence wins (an
 * agent correcting itself mid-message should have the final word).
 */
export function parsePipelineVerdict(
  stage: "plan-review" | "testing",
  text: string,
): PipelineVerdict {
  const { ok, bounce } = APPROVE_KEYWORDS[stage];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith(PIPELINE_VERDICT_PREFIX)) continue;
    const rest = line.slice(PIPELINE_VERDICT_PREFIX.length).trim();
    const lower = rest.toLowerCase();
    if (lower === ok) return { ok: true, kind: ok as "approve" | "pass" };
    if (lower === bounce || lower.startsWith(`${bounce} `)) {
      const reason = rest.slice(bounce.length).trim();
      return {
        ok: true,
        kind: bounce as "revise" | "fail",
        reason: reason || "(no reason given)",
      };
    }
    // Prefix matched but the keyword didn't — malformed sentinel, not a
    // silent miss. Treat as unparseable rather than guessing which way.
    return { ok: false };
  }
  return { ok: false };
}

const TICKET_HEADER = "## Original ticket";

function ticketBlock(task: Task): string {
  return `${TICKET_HEADER}\n\n${task.prompt}`;
}

/** Planner stage — not verdict-bearing. Success is just "the run finished". */
function planningPrompt(task: Task): string {
  const feedback = task.pipelineFeedback
    ? `\n\nThe previous plan was sent back for revision. Reviewer feedback to address:\n\n${task.pipelineFeedback}`
    : "";
  return (
    `You are the Planner in an automated pipeline: Planner → Critic → Builder → Tester. ` +
    `Investigate this codebase enough to design a concrete implementation plan for the ` +
    `ticket below, then write that plan to ${PIPELINE_PLAN_FILE} at the repository root ` +
    `(overwrite it if it already exists). The plan should name the files/areas that need ` +
    `to change and the approach — a Critic agent will review it next, and a Builder agent ` +
    `will implement it from the file alone, so it needs to be concrete enough to act on ` +
    `without further clarification from you. Do not write or change any other files, and ` +
    `do not run any commands beyond what's needed to investigate the codebase. When ` +
    `${PIPELINE_PLAN_FILE} is written, stop — do not ask a question, do not wait for ` +
    `confirmation.${feedback}\n\n${ticketBlock(task)}`
  );
}

/** Critic stage — must end with PIPELINE_VERDICT: approve|revise <reason>. */
function planReviewPrompt(task: Task): string {
  return (
    `You are the Critic in an automated pipeline: Planner → Critic → Builder → Tester. ` +
    `Read ${PIPELINE_PLAN_FILE} at the repository root (written by the Planner) and check ` +
    `it against the actual codebase — does it name real files/patterns, is the approach ` +
    `sound, does it fully address the ticket below, is anything it proposes likely to break ` +
    `something else? Do not write or change any files yourself; this is a review, not an ` +
    `implementation pass.\n\n` +
    `End your final message with exactly one line, in exactly this form:\n` +
    `${PIPELINE_VERDICT_PREFIX} approve\n` +
    `— if the plan is ready to build — or:\n` +
    `${PIPELINE_VERDICT_PREFIX} revise <one-paragraph reason>\n` +
    `— if it needs another pass, explaining concretely what's wrong or missing so the ` +
    `Planner can fix it. Nothing else you write is parsed — only this line decides what ` +
    `happens next, so make sure it's the literal last line of your message.\n\n${ticketBlock(task)}`
  );
}

/** Builder stage — not verdict-bearing. Success is just "the run finished". */
function buildingPrompt(task: Task): string {
  const feedback = task.pipelineFeedback
    ? `\n\nThe previous implementation was sent back by the Tester. What it found:\n\n${task.pipelineFeedback}`
    : "";
  return (
    `You are the Builder in an automated pipeline: Planner → Critic → Builder → Tester. ` +
    `${PIPELINE_PLAN_FILE} at the repository root (already reviewed and approved) describes ` +
    `what to build. Implement it. Follow the plan; if you need to deviate in a small way to ` +
    `make it actually work, that's fine, but stay within its intent — don't redesign the ` +
    `approach. A Tester agent will run linters/typecheck/tests against your changes next. ` +
    `When you're done, stop — do not ask a question, do not wait for confirmation, do not ` +
    `commit anything (a later stage handles that).${feedback}\n\n${ticketBlock(task)}`
  );
}

/** Tester stage — must end with PIPELINE_VERDICT: pass|fail <reason>. Local
 *  commit only, reusing commitPushPrompt's commit-type derivation — every
 *  push/PR-drafting instruction is deliberately absent; this must never
 *  leave the local branch. */
function testingPrompt(task: Task): string {
  const ccType = branchCommitType(task.branch, task.taskType);
  return (
    `You are the Tester in an automated pipeline: Planner → Critic → Builder → Tester. ` +
    `Run this project's linters, type-checker, and test suite. If something fails and the ` +
    `fix is small and obviously correct, fix it directly; for anything larger, leave it and ` +
    `report it in your verdict instead of guessing at a bigger change.\n\n` +
    `If you changed anything, commit it locally with a clear commit message (prefix the ` +
    `subject with "${ccType}:", e.g. "${ccType}: ..."). Do NOT push, do not open a pull ` +
    `request, do not run any git command that touches a remote — this commit stays local, ` +
    `a human reviews and pushes it later. Do not include any AI attribution in the commit ` +
    `message.\n\n` +
    `End your final message with exactly one line, in exactly this form:\n` +
    `${PIPELINE_VERDICT_PREFIX} pass\n` +
    `— if everything is clean — or:\n` +
    `${PIPELINE_VERDICT_PREFIX} fail <one-paragraph reason>\n` +
    `— if something is still broken, explaining concretely what so the Builder can fix it. ` +
    `Nothing else you write is parsed — only this line decides what happens next, so make ` +
    `sure it's the literal last line of your message.\n\n${ticketBlock(task)}`
  );
}

/** Dispatch to the right stage's prompt builder. The returned string
 *  *replaces* the raw ticket prompt as the turn's text in startTask —
 *  nothing is lost, since every builder above folds task.prompt back in
 *  via ticketBlock(). */
export function stagePrompt(
  task: Task,
  stage: NonNullable<Task["pipelineStage"]>,
): string {
  switch (stage) {
    case "planning": return planningPrompt(task);
    case "plan-review": return planReviewPrompt(task);
    case "building": return buildingPrompt(task);
    case "testing": return testingPrompt(task);
  }
}
