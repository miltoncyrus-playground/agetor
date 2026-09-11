import { test, expect } from "bun:test";
import { classifyStage, summarizeTranscript, aggregateByStage, duplicateReads, type RunRow } from "./token-report.ts";

// ─── classifyStage ───────────────────────────────────────────────────────────

test("classifyStage maps every stage prompt opener to its label", () => {
  const cases: Array<[string, string]> = [
    ["You are the Spec Author in an automated spec-driven pipeline", "specify"],
    ["You are the Clarifier in an automated", "clarify"],
    ["You are the Planner in an automated", "planning"],
    ["You are the Critic in an automated", "plan-review"],
    ["You are the Decomposer in an automated", "decompose"],
    ["You are the Builder in an automated", "building(fixup)"],
    ["You are the Code Reviewer in an automated", "code-review"],
    ["You are the Tester in an automated", "testing"],
    ["A git merge is IN PROGRESS in this worktree", "merge-resolution"],
  ];
  for (const [text, want] of cases) {
    expect(classifyStage(text, { isChild: false, origin: "pipeline-stage" })).toBe(want);
  }
});

test("classifyStage: children win over prompt text; origin decides the rest", () => {
  expect(classifyStage("You are the Planner", { isChild: true, origin: "pipeline-stage" })).toBe("child-build");
  expect(classifyStage("continue", { isChild: false, origin: "pipeline-merge" })).toBe("merge-resolution");
  expect(classifyStage("continue", { isChild: false, origin: "continuation" })).toBe("continuation");
  expect(classifyStage("what's the status?", { isChild: false, origin: null })).toBe("conversation");
});

// ─── summarizeTranscript ─────────────────────────────────────────────────────

function assistant(id: string, usage: Record<string, number>, content: unknown[] = [{ type: "text", text: "ok" }], model = "claude-sonnet-5") {
  return JSON.stringify({ type: "assistant", message: { id, model, usage, content } });
}
function userResult(toolUseId: string, content: string) {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content }] } });
}

test("summarizeTranscript sums usage once per message.id and records bootstrap", () => {
  const lines = [
    // claude writes one line per content block — same message id twice.
    assistant("m1", { input_tokens: 2, cache_creation_input_tokens: 12_000, cache_read_input_tokens: 40_000, output_tokens: 100 }, [{ type: "text", text: "a" }]),
    assistant("m1", { input_tokens: 2, cache_creation_input_tokens: 12_000, cache_read_input_tokens: 40_000, output_tokens: 100 }, [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/worktrees/abc/src/a.ts" } }]),
    userResult("t1", "x".repeat(1000)),
    assistant("m2", { input_tokens: 5, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 52_000, output_tokens: 50 }, [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }]),
    userResult("t2", "y".repeat(200)),
    "not json at all",
    "",
  ].join("\n");
  const s = summarizeTranscript(lines);
  expect(s.messages).toBe(2);
  expect(s.input).toBe(7);
  expect(s.cacheWrite).toBe(13_000);
  expect(s.cacheRead).toBe(92_000);
  expect(s.output).toBe(150);
  expect(s.context).toBe(7 + 13_000 + 92_000);
  expect(s.bootstrap).toBe(52_002);
  expect(s.tools).toEqual({ Read: 1, Bash: 1 });
  expect(s.readPaths).toEqual(["/w/worktrees/abc/src/a.ts"]);
  expect(s.resultBytes).toEqual({ Read: 1000, Bash: 200 });
  expect(s.models).toEqual(["claude-sonnet-5"]);
});

test("summarizeTranscript on an empty or usage-less transcript is all zeros", () => {
  const s = summarizeTranscript("");
  expect(s.messages).toBe(0);
  expect(s.context).toBe(0);
  expect(s.bootstrap).toBe(0);
  // A message with no id can't be deduped and is skipped, same rule as account-usage.ts.
  const noId = JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 9 } } });
  expect(summarizeTranscript(noId).messages).toBe(0);
});

// ─── aggregateByStage / duplicateReads ───────────────────────────────────────

function row(stage: RunRow["stage"], taskId: string, context: number, readPaths: string[] = []): RunRow {
  return {
    runId: `r-${taskId}`, taskId, parentId: "p", title: "t", stage, status: "succeeded", promptBytes: 100,
    summary: { messages: 1, input: 0, cacheWrite: 0, cacheRead: context, output: 1, context, bootstrap: context, tools: {}, readPaths, resultBytes: {}, models: [] },
  };
}

test("aggregateByStage sorts by context and computes shares that sum to 1", () => {
  const agg = aggregateByStage([row("specify", "a", 100), row("child-build", "b", 700), row("child-build", "c", 200)]);
  expect(agg.map((a) => a.stage)).toEqual(["child-build", "specify"]);
  expect(agg[0]!.runs).toBe(2);
  expect(agg[0]!.share).toBeCloseTo(0.9);
  expect(agg.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1);
});

test("duplicateReads finds files read by 2+ agents, worktree-relative, children distinct", () => {
  const dups = duplicateReads([
    row("planning", "p", 1, ["/h/.agetor-dev/worktrees/p/SPEC.md", "/h/.agetor-dev/worktrees/p/src/only-planner.ts"]),
    row("child-build", "c1ab", 1, ["/h/.agetor-dev/worktrees/c1ab/SPEC.md"]),
    row("child-build", "c2cd", 1, ["/h/.agetor-dev/worktrees/c2cd/SPEC.md"]),
  ]);
  expect(dups).toHaveLength(1);
  expect(dups[0]!.path).toBe("SPEC.md");
  expect(dups[0]!.readers.sort()).toEqual(["child:c1ab", "child:c2cd", "planning"]);
});
