import { test, expect } from "bun:test";
import {
  extractHandoff,
  renderHandoff,
  stageRole,
  HANDOFF_HEADING,
  MAX_COMMANDS,
  MAX_COMMAND_CHARS,
  type HandoffEvent,
  type StageHandoff,
} from "./stage-handoff.ts";

const ROOT = "/home/u/.agetor/worktrees/t1";

/** Build events in the exact JSON shape the drivers persist (see
 *  `claude-tmux.ts` mapLine / `codex-tmux.ts` mapCodexEvent). */
function use(id: string, name: string, input: Record<string, unknown>, subagentId?: string | null): HandoffEvent {
  return { stream: "tool_use", data: JSON.stringify({ id, name, input, serverSide: false }), subagentId };
}
function result(toolUseId: string, content: unknown, isError = false, subagentId?: string | null): HandoffEvent {
  return { stream: "tool_result", data: JSON.stringify({ toolUseId, content, isError }), subagentId };
}
function read(id: string, file_path: string, extra: Record<string, unknown> = {}): HandoffEvent[] {
  return [use(id, "Read", { file_path, ...extra }), result(id, "     1→...")];
}
function bash(id: string, command: string, opts: { isError?: boolean; content?: unknown; noResult?: boolean } = {}): HandoffEvent[] {
  const evs = [use(id, "Bash", { command, description: "x" })];
  if (!opts.noResult) evs.push(result(id, opts.content ?? "ok", opts.isError ?? false));
  return evs;
}

const OPTS = { stage: "planning", worktreeRoot: ROOT };

// --- extractHandoff: Read ------------------------------------------------------

test("Read paths are made worktree-relative; whole-file read has no ranges", () => {
  const h = extractHandoff([...read("r1", `${ROOT}/src/a.ts`)], OPTS);
  expect(h).toEqual({ stage: "planning", filesRead: [{ path: "src/a.ts", ranges: [] }], commandsOk: [] });
});

test("Read with offset+limit records the half-open span offset-(offset+limit)", () => {
  const h = extractHandoff([...read("r1", `${ROOT}/src/a.ts`, { offset: 1, limit: 120 })], OPTS);
  expect(h.filesRead).toEqual([{ path: "src/a.ts", ranges: ["1-121"] }]);
});

test("Read with only limit starts at 1; only offset is open-ended", () => {
  const h = extractHandoff(
    [...read("r1", `${ROOT}/a.ts`, { limit: 50 }), ...read("r2", `${ROOT}/b.ts`, { offset: 300 })],
    OPTS,
  );
  expect(h.filesRead).toEqual([
    { path: "a.ts", ranges: ["1-51"] },
    { path: "b.ts", ranges: ["300-"] },
  ]);
});

test("same file read twice: paths dedupe, disjoint ranges sorted, overlapping merged", () => {
  const h = extractHandoff(
    [
      ...read("r1", `${ROOT}/a.ts`, { offset: 200, limit: 50 }),
      ...read("r2", `${ROOT}/a.ts`, { offset: 1, limit: 100 }),
      ...read("r3", `${ROOT}/a.ts`, { offset: 80, limit: 40 }),
    ],
    OPTS,
  );
  expect(h.filesRead).toEqual([{ path: "a.ts", ranges: ["1-120", "200-250"] }]);
});

test("a whole-file read subsumes partial ranges of the same file", () => {
  const h = extractHandoff(
    [...read("r1", `${ROOT}/a.ts`, { offset: 1, limit: 10 }), ...read("r2", `${ROOT}/a.ts`)],
    OPTS,
  );
  expect(h.filesRead).toEqual([{ path: "a.ts", ranges: [] }]);
});

test("open-ended span absorbs later spans", () => {
  const h = extractHandoff(
    [...read("r1", `${ROOT}/a.ts`, { offset: 10 }), ...read("r2", `${ROOT}/a.ts`, { offset: 500, limit: 5 })],
    OPTS,
  );
  expect(h.filesRead).toEqual([{ path: "a.ts", ranges: ["10-"] }]);
});

test("paths outside the worktree stay absolute; null root leaves everything absolute", () => {
  const h = extractHandoff([...read("r1", "/etc/hosts"), ...read("r2", `${ROOT}/x.ts`)], OPTS);
  expect(h.filesRead.map((f) => f.path)).toEqual(["/etc/hosts", "x.ts"]);
  const h2 = extractHandoff([...read("r1", `${ROOT}/x.ts`)], { stage: "planning", worktreeRoot: null });
  expect(h2.filesRead[0]!.path).toBe(`${ROOT}/x.ts`);
});

test("a sibling dir sharing the root prefix is not relativised", () => {
  const h = extractHandoff([...read("r1", `${ROOT}-other/x.ts`)], OPTS);
  expect(h.filesRead[0]!.path).toBe(`${ROOT}-other/x.ts`);
});

test("gemini read_file with absolute_path is recognised", () => {
  const h = extractHandoff([use("g1", "read_file", { absolute_path: `${ROOT}/g.ts` })], OPTS);
  expect(h.filesRead).toEqual([{ path: "g.ts", ranges: [] }]);
});

test("first-seen order is preserved", () => {
  const h = extractHandoff(
    [...read("r1", `${ROOT}/z.ts`), ...read("r2", `${ROOT}/a.ts`), ...read("r3", `${ROOT}/z.ts`)],
    OPTS,
  );
  expect(h.filesRead.map((f) => f.path)).toEqual(["z.ts", "a.ts"]);
});

// --- extractHandoff: Bash --------------------------------------------------------

test("Bash commands with a non-error result are kept; isError results excluded", () => {
  const h = extractHandoff(
    [...bash("b1", "npm run typecheck"), ...bash("b2", "npm test", { isError: true, content: "Exit code 1\nFAIL" })],
    OPTS,
  );
  expect(h.commandsOk).toEqual(["npm run typecheck"]);
});

test("`Exit code N` text backstop excludes a failure even when isError is false", () => {
  const h = extractHandoff([...bash("b1", "npm test", { content: "Exit code 2\n..." })], OPTS);
  expect(h.commandsOk).toEqual([]);
  // Exit code 0 in text is fine.
  const ok = extractHandoff([...bash("b1", "npm test", { content: "Exit code 0\nall green" })], OPTS);
  expect(ok.commandsOk).toEqual(["npm test"]);
});

test("a Bash tool_use with no tool_result at all is not counted", () => {
  const h = extractHandoff([...bash("b1", "sleep 999", { noResult: true })], OPTS);
  expect(h.commandsOk).toEqual([]);
});

test("claude array-form tool_result content is read for the backstop", () => {
  const h = extractHandoff(
    [...bash("b1", "git status", { content: [{ type: "text", text: "Exit code 128\nfatal" }] })],
    OPTS,
  );
  expect(h.commandsOk).toEqual([]);
  const ok = extractHandoff([...bash("b1", "git status", { content: [{ type: "text", text: "clean" }] })], OPTS);
  expect(ok.commandsOk).toEqual(["git status"]);
});

test("commands are trimmed to the first non-empty line and capped at 120 chars", () => {
  const long = "x".repeat(300);
  const h = extractHandoff([...bash("b1", "\n\n   npm run build   \n&& echo done"), ...bash("b2", long)], OPTS);
  expect(h.commandsOk[0]).toBe("npm run build");
  expect(h.commandsOk[1]!.length).toBe(MAX_COMMAND_CHARS);
  expect(h.commandsOk[1]!.endsWith("…")).toBe(true);
});

test("commands dedupe and stop at MAX_COMMANDS", () => {
  const evs: HandoffEvent[] = [];
  for (let i = 0; i < 30; i++) evs.push(...bash(`b${i}`, `echo ${i % 20}`));
  const h = extractHandoff(evs, OPTS);
  expect(h.commandsOk.length).toBe(MAX_COMMANDS);
  expect(new Set(h.commandsOk).size).toBe(MAX_COMMANDS);
  expect(h.commandsOk[0]).toBe("echo 0");
});

test("codex `shell` and gemini `run_shell_command` names count as shell tools", () => {
  const h = extractHandoff(
    [
      use("c1", "shell", { command: "ls" }), result("c1", "a b", false),
      use("g1", "run_shell_command", { command: "pwd" }), result("g1", "/x", false),
      use("c2", "shell", { command: ["git", "log", "-1"] }), result("c2", "abc", false),
    ],
    OPTS,
  );
  expect(h.commandsOk).toEqual(["ls", "pwd", "git log -1"]);
});

test("subagent-stream events are ignored entirely", () => {
  const h = extractHandoff(
    [
      use("s1", "Read", { file_path: `${ROOT}/sub.ts` }, "agent-1"),
      use("s2", "Bash", { command: "echo sub" }, "agent-1"), result("s2", "sub", false, "agent-1"),
      ...read("m1", `${ROOT}/main.ts`),
    ],
    OPTS,
  );
  expect(h.filesRead.map((f) => f.path)).toEqual(["main.ts"]);
  expect(h.commandsOk).toEqual([]);
});

test("a subagent-stream tool_result cannot vouch for a main-stream tool_use", () => {
  const h = extractHandoff([use("b1", "Bash", { command: "ls" }), result("b1", "ok", false, "agent-1")], OPTS);
  expect(h.commandsOk).toEqual([]);
});

test("unparseable or foreign events are skipped without aborting", () => {
  const h = extractHandoff(
    [
      { stream: "tool_use", data: "{ not json" },
      { stream: "tool_use", data: "42" },
      { stream: "tool_result", data: "nope" },
      { stream: "assistant", data: "hello" },
      { stream: "tool_use", data: JSON.stringify({ id: "w", name: "Write", input: { file_path: `${ROOT}/w.ts` } }) },
      { stream: "tool_use", data: JSON.stringify({ id: "r", name: "Read", input: {} }) },
      ...read("ok", `${ROOT}/ok.ts`),
    ],
    OPTS,
  );
  expect(h.filesRead).toEqual([{ path: "ok.ts", ranges: [] }]);
});

test("empty input → empty handoff carrying the stage", () => {
  expect(extractHandoff([], { stage: "decompose", worktreeRoot: ROOT })).toEqual({
    stage: "decompose", filesRead: [], commandsOk: [],
  });
});

// --- stageRole -----------------------------------------------------------------

test("stageRole maps known stages to prompt role names and title-cases unknown ids", () => {
  expect(stageRole("planning")).toBe("Planner");
  expect(stageRole("plan-review")).toBe("Critic");
  expect(stageRole("code-review")).toBe("Code Reviewer");
  expect(stageRole("some-new_stage")).toBe("Some New Stage");
});

// --- renderHandoff ---------------------------------------------------------------

const PLANNER: StageHandoff = {
  stage: "planning",
  filesRead: [{ path: "src/a.ts", ranges: ["1-120"] }, { path: "src/b.ts", ranges: [] }],
  commandsOk: ["npm run typecheck", "git log -5"],
};
const DECOMPOSER: StageHandoff = {
  stage: "decompose",
  filesRead: [{ path: "src/c/d.ts", ranges: [] }, { path: "docs/x.md", ranges: ["10-30", "50-60"] }],
  commandsOk: [],
};

test("renders one line per stage plus commands, oldest stage first", () => {
  const out = renderHandoff([PLANNER, DECOMPOSER], { charBudget: 10_000 });
  expect(out.split("\n")).toEqual([
    HANDOFF_HEADING,
    "The Planner consulted: src/a.ts (1-120), src/b.ts",
    "Commands that worked: `npm run typecheck`, `git log -5`",
    "The Decomposer consulted: src/c/d.ts, docs/x.md (10-30, 50-60)",
  ]);
});

test("empty handoffs render nothing", () => {
  expect(renderHandoff([], { charBudget: 1000 })).toBe("");
  expect(renderHandoff([{ stage: "planning", filesRead: [], commandsOk: [] }], { charBudget: 1000 })).toBe("");
});

test("commands-only stage names the role in the commands line", () => {
  const out = renderHandoff([{ stage: "testing", filesRead: [], commandsOk: ["bun test"] }], { charBudget: 1000 });
  expect(out).toBe(`${HANDOFF_HEADING}\nCommands that worked for the Tester: \`bun test\``);
});

test("onlyPaths filters files to the child's lane (files and directory prefixes); commands kept", () => {
  const out = renderHandoff([PLANNER, DECOMPOSER], { charBudget: 10_000, onlyPaths: ["src/c", "src/a.ts"] });
  expect(out.split("\n")).toEqual([
    HANDOFF_HEADING,
    "The Planner consulted: src/a.ts (1-120)",
    "Commands that worked: `npm run typecheck`, `git log -5`",
    "The Decomposer consulted: src/c/d.ts",
  ]);
});

test("onlyPaths: a prefix match must be on a path boundary", () => {
  const out = renderHandoff(
    [{ stage: "planning", filesRead: [{ path: "src/cat.ts", ranges: [] }, { path: "src/c/x.ts", ranges: [] }], commandsOk: [] }],
    { charBudget: 1000, onlyPaths: ["src/c/"] },
  );
  expect(out).toBe(`${HANDOFF_HEADING}\nThe Planner consulted: src/c/x.ts`);
});

test("onlyPaths that matches nothing (and no commands) renders nothing", () => {
  expect(renderHandoff([DECOMPOSER], { charBudget: 1000, onlyPaths: ["lib/"] })).toBe("");
});

test("budget: whole stage entries are dropped oldest-first", () => {
  const full = renderHandoff([PLANNER, DECOMPOSER], { charBudget: 10_000 });
  const decomposerOnly = renderHandoff([DECOMPOSER], { charBudget: 10_000 });
  const out = renderHandoff([PLANNER, DECOMPOSER], { charBudget: full.length - 1 });
  expect(out).toBe(decomposerOnly);
  expect(out.length).toBeLessThanOrEqual(full.length - 1);
});

test("budget: then whole paths are dropped (last-read first), never a half entry", () => {
  const two = renderHandoff([DECOMPOSER], { charBudget: 10_000 });
  const out = renderHandoff([DECOMPOSER], { charBudget: two.length - 1 });
  expect(out).toBe(`${HANDOFF_HEADING}\nThe Decomposer consulted: src/c/d.ts`);
  // Every emitted line is a complete, well-formed line.
  for (const line of out.split("\n")) expect(line.endsWith(",")).toBe(false);
});

test("budget too small for any whole entry → empty string", () => {
  expect(renderHandoff([PLANNER, DECOMPOSER], { charBudget: 10 })).toBe("");
});

test("budget: files go before commands, then the stage as a unit", () => {
  const h: StageHandoff = { stage: "planning", filesRead: [{ path: "a.ts", ranges: [] }], commandsOk: ["ls"] };
  const full = renderHandoff([h], { charBudget: 10_000 });
  const cmdOnly = `${HANDOFF_HEADING}\nCommands that worked for the Planner: \`ls\``;
  expect(renderHandoff([h], { charBudget: full.length - 1 })).toBe(cmdOnly);
  expect(renderHandoff([h], { charBudget: cmdOnly.length - 1 })).toBe("");
});

test("render output is exactly within budget and deterministic across calls", () => {
  const a = renderHandoff([PLANNER, DECOMPOSER], { charBudget: 120 });
  const b = renderHandoff([PLANNER, DECOMPOSER], { charBudget: 120 });
  expect(a).toBe(b);
  expect(a.length).toBeLessThanOrEqual(120);
  expect(a.startsWith(HANDOFF_HEADING)).toBe(true);
});

test("renderHandoff does not mutate its input", () => {
  const copy = JSON.parse(JSON.stringify([PLANNER, DECOMPOSER]));
  renderHandoff([PLANNER, DECOMPOSER], { charBudget: 40, onlyPaths: ["src"] });
  expect([PLANNER, DECOMPOSER]).toEqual(copy);
});

// --- end-to-end over a realistic stream --------------------------------------------

test("extract → render over a claude-shaped stream", () => {
  const events: HandoffEvent[] = [
    { stream: "user", data: "Plan the feature" },
    { stream: "thinking", data: "..." },
    ...bash("b1", "git log --oneline -5"),
    ...read("r1", `${ROOT}/src/bun/orchestrator.ts`, { offset: 1, limit: 200 }),
    ...read("r2", `${ROOT}/src/shared/types.ts`),
    ...bash("b2", "bun run typecheck"),
    ...bash("b3", "bun test src/bun/nope.test.ts", { isError: true, content: "Exit code 1\nerror: no tests" }),
    { stream: "tool_use", data: JSON.stringify({ id: "w1", name: "Write", input: { file_path: `${ROOT}/PLAN.md`, content: "#" } }) },
    result("w1", "ok"),
    { stream: "assistant", data: "Done. PIPELINE_VERDICT: approve" },
  ];
  const h = extractHandoff(events, { stage: "planning", worktreeRoot: ROOT });
  const out = renderHandoff([h], { charBudget: 600 });
  expect(out).toBe([
    HANDOFF_HEADING,
    "The Planner consulted: src/bun/orchestrator.ts (1-201), src/shared/types.ts",
    "Commands that worked: `git log --oneline -5`, `bun run typecheck`",
  ].join("\n"));
});
