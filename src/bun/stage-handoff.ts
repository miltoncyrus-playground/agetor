/**
 * Deterministic stage handoff pack (plan O-11).
 *
 * At stage settle, the orchestrator has every event the settled run
 * produced (`runs.events(runId)`). This module walks the main-stream
 * `tool_use` / `tool_result` events and extracts two things the next stage
 * would otherwise spend tokens rediscovering: the files the agent Read
 * (paths + line ranges) and the shell commands that exited cleanly. It then
 * renders them into a compact block for the next prompt, under a hard
 * character budget. Zero LLM calls, no staleness: same branch, same commit.
 *
 * Both functions are pure; the orchestrator owns the IO.
 *
 * Event data shapes this parses (the drivers all agree, see
 * `claude-tmux.ts` `mapLine`, `codex-tmux.ts` `mapCodexEvent`,
 * `gemini-tmux.ts` `mapGeminiEvent`):
 *
 *   stream "tool_use"    data = JSON { id, name, input, serverSide }
 *   stream "tool_result" data = JSON { toolUseId, content, isError }
 *
 * `content` is a string or an array of `{ type: "text", text }` blocks
 * (claude), a string (codex, gemini). `isError` is set from claude's
 * `is_error`, codex's `exit_code !== 0`, gemini's `status !== "success"`, so
 * it is the exit-status signal for every agent kind and the rule for "this
 * command worked" is: a tool_result for that id exists AND `isError` is
 * false AND the result text does not start with `Exit code <non-zero>` (a
 * belt-and-braces backstop for claude builds that reported a failed Bash
 * as plain text). A tool_use with no result at all (interrupted turn) is
 * never counted.
 */
export interface StageHandoff {
  /** Pipeline stage id the run belonged to (`planning`, `decompose`, …). */
  stage: string;
  /** Files read, first-seen order. `ranges` empty = whole file (or ranges
   *  unknown); otherwise half-open `"<offset>-<offset+limit>"` spans,
   *  merged and sorted. */
  filesRead: Array<{ path: string; ranges: string[] }>;
  /** Shell commands (first line, trimmed, ≤ 120 chars) whose result was not
   *  an error. Deduped, first-seen order, at most `MAX_COMMANDS`. */
  commandsOk: string[];
}

export type HandoffEvent = { stream: string; data: string; subagentId?: string | null };

/** Cap on `commandsOk` per stage. Twelve covers a typical
 *  install/typecheck/test/git set; beyond that it's exploratory noise. */
export const MAX_COMMANDS = 12;

/** Max chars kept of a single command line. */
export const MAX_COMMAND_CHARS = 120;

/** Tool names that mean "read a file", across the agent kinds we drive.
 *  claude: `Read`; gemini: `read_file`; codex reads via shell (not counted). */
const READ_TOOL_NAMES = new Set(["Read", "read_file"]);

/** Tool names that mean "run a shell command". claude: `Bash`; codex:
 *  `shell` (our own mapping of `command_execution`); gemini:
 *  `run_shell_command`. */
const SHELL_TOOL_NAMES = new Set(["Bash", "shell", "run_shell_command"]);

/** Human role per stage id, matching the "You are the <Role>" openers in
 *  `pipeline-prompts.ts`, so the next agent reads "The Planner consulted"
 *  not "The planning consulted". Unknown ids fall back to a capitalised
 *  stage id so a new stage still renders something sensible. */
const STAGE_ROLES: Record<string, string> = {
  specify: "Specifier",
  clarify: "Clarifier",
  planning: "Planner",
  "plan-review": "Critic",
  decompose: "Decomposer",
  analyze: "Analyzer",
  building: "Builder",
  "code-review": "Code Reviewer",
  testing: "Tester",
};

export function stageRole(stage: string): string {
  const known = STAGE_ROLES[stage];
  if (known) return known;
  return stage
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ") || "Previous stage";
}

type ToolUse = { id: string; name: string; input: Record<string, unknown> };
type ToolResult = { toolUseId: string; text: string; isError: boolean };

function parseToolUse(data: string): ToolUse | null {
  try {
    const raw: unknown = JSON.parse(data);
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const input = r.input && typeof r.input === "object" && !Array.isArray(r.input)
      ? (r.input as Record<string, unknown>)
      : {};
    return {
      id: typeof r.id === "string" ? r.id : "",
      name: typeof r.name === "string" ? r.name : "",
      input,
    };
  } catch {
    return null;
  }
}

/** Plain text of a tool_result `content`: a string, or the concatenated
 *  `text` of an array of text blocks (claude's shape). Anything else → "". */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : ""))
      .join("\n");
  }
  return "";
}

function parseToolResult(data: string): ToolResult | null {
  try {
    const raw: unknown = JSON.parse(data);
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    return {
      toolUseId: typeof r.toolUseId === "string" ? r.toolUseId : "",
      text: toolResultText(r.content),
      isError: r.isError === true,
    };
  } catch {
    return null;
  }
}

/** Failed-command backstop on the result text: claude's Bash tool reports a
 *  non-zero exit as `Exit code N` at the top of the result. `isError` is the
 *  primary signal; this only catches builds that omitted the flag. */
const FAILED_RESULT_RE = /^\s*Exit code [1-9]\d*\b/;

function resultLooksOk(r: ToolResult | undefined): boolean {
  if (!r) return false;
  if (r.isError) return false;
  return !FAILED_RESULT_RE.test(r.text);
}

/** First non-empty line, trimmed, hard-capped at `MAX_COMMAND_CHARS`
 *  (with a trailing ellipsis when cut). Multi-line heredocs and `&&` chains
 *  still leave a recognisable head. */
function normalizeCommand(raw: unknown): string | null {
  let s: string;
  if (typeof raw === "string") s = raw;
  else if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) s = (raw as string[]).join(" ");
  else return null;
  const first = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  if (first.length <= MAX_COMMAND_CHARS) return first;
  return first.slice(0, MAX_COMMAND_CHARS - 1) + "…";
}

function readPath(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "absolute_path", "path"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function toWorktreeRelative(p: string, root: string | null): string {
  if (!root) return p;
  const prefix = root.endsWith("/") ? root : root + "/";
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  if (p === root) return ".";
  return p;
}

function asPositiveInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

/** Half-open span for a partial Read: `[offset, offset+limit)`. A Read with
 *  neither offset nor limit is the whole file (null). Only-offset reads
 *  `offset-` (to end); only-limit reads from line 1. */
function readRange(input: Record<string, unknown>): [number, number | null] | null {
  const offset = asPositiveInt(input.offset);
  const limit = asPositiveInt(input.limit);
  if (offset === null && limit === null) return null;
  const start = offset ?? 1;
  if (limit === null) return [start, null];
  return [start, start + limit];
}

/** Merge overlapping/adjacent numeric spans, sort by start. An open-ended
 *  span `[s, null)` absorbs everything at or after `s`. */
function mergeRanges(spans: Array<[number, number | null]>): Array<[number, number | null]> {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number | null]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && (last[1] === null || s <= last[1])) {
      if (last[1] !== null) last[1] = e === null ? null : Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

function formatRange([s, e]: [number, number | null]): string {
  return e === null ? `${s}-` : `${s}-${e}`;
}

/**
 * Extract a handoff from one run's events. Pure. Skips every event with a
 * `subagentId` (background agents' reads aren't the stage's own context)
 * and every event it can't parse, per event, so one malformed row never
 * drops the whole pack.
 */
export function extractHandoff(
  events: HandoffEvent[],
  opts: { stage: string; worktreeRoot: string | null },
): StageHandoff {
  const main = events.filter((e) => e.subagentId === null || e.subagentId === undefined);

  // Results first so each tool_use can be judged in one pass regardless of
  // whether its result came later in the stream (it always does, but the
  // order of persistence isn't a contract worth depending on).
  const results = new Map<string, ToolResult>();
  for (const e of main) {
    if (e.stream !== "tool_result") continue;
    const r = parseToolResult(e.data);
    if (r && r.toolUseId && !results.has(r.toolUseId)) results.set(r.toolUseId, r);
  }

  const files = new Map<string, { whole: boolean; spans: Array<[number, number | null]> }>();
  const commands: string[] = [];
  const seenCommands = new Set<string>();

  for (const e of main) {
    if (e.stream !== "tool_use") continue;
    const use = parseToolUse(e.data);
    if (!use) continue;

    if (READ_TOOL_NAMES.has(use.name)) {
      const raw = readPath(use.input);
      if (!raw) continue;
      const p = toWorktreeRelative(raw, opts.worktreeRoot);
      const entry = files.get(p) ?? { whole: false, spans: [] };
      const range = readRange(use.input);
      if (range === null) entry.whole = true;
      else entry.spans.push(range);
      files.set(p, entry);
      continue;
    }

    if (SHELL_TOOL_NAMES.has(use.name)) {
      if (commands.length >= MAX_COMMANDS) continue;
      const cmd = normalizeCommand(use.input.command);
      if (!cmd || seenCommands.has(cmd)) continue;
      if (!resultLooksOk(results.get(use.id))) continue;
      seenCommands.add(cmd);
      commands.push(cmd);
    }
  }

  const filesRead = [...files.entries()].map(([p, entry]) => ({
    path: p,
    // A whole-file read subsumes any partial spans of the same file.
    ranges: entry.whole ? [] : mergeRanges(entry.spans).map(formatRange),
  }));

  return { stage: opts.stage, filesRead, commandsOk: commands };
}

/** Heading of the rendered block. Exported so the injection site and tests
 *  agree on the exact sentinel. */
export const HANDOFF_HEADING = "## From earlier stages";

/** True when `p` is `lane` itself or lives under `lane/` (directory prefix).
 *  Exported: also used by `claude-md-filter.ts` (O-15) for its
 *  orchestration-flow path-overlap check, so the two call sites can never
 *  drift apart. */
export function inLane(p: string, lane: string): boolean {
  const l = lane.replace(/\/+$/, "");
  if (!l) return true;
  return p === l || p.startsWith(l + "/");
}

function formatFile(f: { path: string; ranges: string[] }): string {
  return f.ranges.length ? `${f.path} (${f.ranges.join(", ")})` : f.path;
}

function renderStage(h: StageHandoff, files: Array<{ path: string; ranges: string[] }>): string[] {
  const lines: string[] = [];
  if (files.length) lines.push(`The ${stageRole(h.stage)} consulted: ${files.map(formatFile).join(", ")}`);
  if (h.commandsOk.length) {
    const who = files.length ? "Commands that worked" : `Commands that worked for the ${stageRole(h.stage)}`;
    lines.push(`${who}: ${h.commandsOk.map((c) => `\`${c}\``).join(", ")}`);
  }
  return lines;
}

/**
 * Render handoffs (oldest stage first, as given) into one block under
 * `charBudget`. Pure. "" when there is nothing to say (no files, no commands
 * after filtering) or the budget can't fit even one whole entry.
 *
 * `onlyPaths` is a child's `files` ownership list: worktree-relative file
 * paths or directory prefixes. When set, `filesRead` is filtered to paths
 * inside the lane (commands are kept: they're lane-independent).
 *
 * Truncation drops whole units, never half a line: first whole stage
 * entries oldest-first, then whole paths from the oldest remaining stage
 * (last-read first), so the most recent stage's most-read-first paths are
 * the last thing to go.
 */
export function renderHandoff(
  handoffs: StageHandoff[],
  opts: { charBudget: number; onlyPaths?: string[] },
): string {
  // Working copy: per-stage filtered file lists we're allowed to shrink.
  let work = handoffs
    .map((h) => ({
      h,
      files: opts.onlyPaths
        ? h.filesRead.filter((f) => opts.onlyPaths!.some((lane) => inLane(f.path, lane)))
        : [...h.filesRead],
    }))
    .filter((w) => w.files.length > 0 || w.h.commandsOk.length > 0);

  const render = (): string => {
    const body = work.flatMap((w) => renderStage(w.h, w.files));
    return body.length ? [HANDOFF_HEADING, ...body].join("\n") : "";
  };

  let out = render();
  // Phase 1: drop whole stage entries, oldest first, while more than one
  // remains. Keeping the newest stage matters most: its reads are the ones
  // the very next stage would repeat.
  while (out.length > opts.charBudget && work.length > 1) {
    work = work.slice(1);
    out = render();
  }
  // Phase 2: drop whole paths from what's left (last-read first), then the
  // stage itself when it's down to nothing.
  while (out.length > opts.charBudget && work.length > 0) {
    const w = work[0]!;
    if (w.files.length > 0) {
      w.files = w.files.slice(0, -1);
    } else if (w.h.commandsOk.length > 0) {
      // Only commands left and still over budget: drop the whole stage.
      work = work.slice(1);
    } else {
      work = work.slice(1);
    }
    work = work.filter((x) => x.files.length > 0 || x.h.commandsOk.length > 0);
    out = render();
  }
  return out.length <= opts.charBudget ? out : "";
}
