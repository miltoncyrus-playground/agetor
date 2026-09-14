/**
 * O-14: pure string transforms that narrow a repo's CLAUDE.md for a
 * pipeline/child claude-code session's re-injected system prompt (see O-2
 * in orchestrator.ts). No filesystem or process access here — plain string
 * in, string out — so this module is trivially unit-testable and cannot
 * itself fail the spawn.
 */

import { inLane } from "./stage-handoff.ts";

export const AGENT_COMMAND_SHAPE_HEADING = "### Agent command shape";
export const JUBARTEAI_HEADING = "## JubarteAI Agent Identity";
export const ORCHESTRATION_FLOW_HEADING = "### Orchestration flow";

const HEADING_RE = /^(#{1,6})\s/;

interface HeadingSection {
  headingStart: number;
  headingLineEnd: number;
  sectionEnd: number;
}

/**
 * Locates the first line whose trimmed content exactly equals `headingText`
 * and returns the char-offset bounds of its section: the heading line
 * itself, plus the body that runs until the next heading of the same or
 * higher level (or end of string). Returns `null` if the heading isn't
 * found at all.
 */
function findHeadingSection(text: string, headingText: string): HeadingSection | null {
  let offset = 0;
  let headingLevel: number | null = null;
  let headingStart = -1;
  let headingLineEnd = -1;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineLength = line.length + 1; // account for the split-out "\n"
    if (headingLevel == null) {
      if (line.trim() === headingText) {
        const match = HEADING_RE.exec(line);
        if (match) {
          headingLevel = match[1]!.length;
          headingStart = offset;
          headingLineEnd = offset + lineLength;
        }
      }
    } else {
      const match = HEADING_RE.exec(line);
      if (match && match[1]!.length <= headingLevel) {
        return { headingStart, headingLineEnd, sectionEnd: offset };
      }
    }
    offset += lineLength;
  }
  if (headingLevel == null) return null;
  return { headingStart, headingLineEnd, sectionEnd: text.length };
}

const BULLET_START_RE = /^- \*\*`([\w.-]+)`\*\* →/gm;

function cutAgentCommandShapeSection(text: string, agentKind: string): string {
  try {
    const section = findHeadingSection(text, AGENT_COMMAND_SHAPE_HEADING);
    if (section == null) return text;
    const { headingLineEnd, sectionEnd } = section;
    const body = text.slice(headingLineEnd, sectionEnd);
    const matches = Array.from(body.matchAll(BULLET_START_RE));
    if (matches.length === 0) return text;
    const matchIndex = matches.findIndex((m) => m[1] === agentKind);
    if (matchIndex === -1) return text;
    const spanStart = matches[matchIndex]!.index!;
    const spanEnd = matches[matchIndex + 1]?.index ?? body.length;
    const newBody = body.slice(0, matches[0]!.index!) + body.slice(spanStart, spanEnd);
    return text.slice(0, headingLineEnd) + newBody + text.slice(sectionEnd);
  } catch {
    return text;
  }
}

function cutJubarteSection(text: string): string {
  try {
    const section = findHeadingSection(text, JUBARTEAI_HEADING);
    if (section == null) return text;
    return text.slice(0, section.headingStart) + text.slice(section.sectionEnd);
  } catch {
    return text;
  }
}

const ITEM_MARKER_RE = /^(\d+)\.\s+\*\*([^*]+)\*\*/gm;

interface OrchestrationItem {
  num: number;
  title: string;
  start: number;
  end: number;
}

function locateOrchestrationItems(body: string): OrchestrationItem[] {
  const matches = Array.from(body.matchAll(ITEM_MARKER_RE));
  return matches.map((m, i) => ({
    num: parseInt(m[1]!, 10),
    title: m[2]!.trim(),
    start: m.index!,
    end: matches[i + 1]?.index ?? body.length,
  }));
}

const ORCHESTRATION_DROP_FROM_ITEM = 5;

/** Layer 1: for a stage that never touches application source, cuts the
 *  orchestration-flow section body from item 5's marker to the end of the
 *  section, keeping items 1-4 (the intro lifecycle content) verbatim.
 *  Fail-open (returns `text` unchanged) if item 5 can't be located. */
function cutOrchestrationFlowStageGate(text: string): string {
  try {
    const section = findHeadingSection(text, ORCHESTRATION_FLOW_HEADING);
    if (section == null) return text;
    const { headingLineEnd, sectionEnd } = section;
    const body = text.slice(headingLineEnd, sectionEnd);
    const items = locateOrchestrationItems(body);
    const firstDrop = items.find((it) => it.num === ORCHESTRATION_DROP_FROM_ITEM);
    if (!firstDrop) return text;
    const newBody = body.slice(0, firstDrop.start);
    return text.slice(0, headingLineEnd) + newBody + text.slice(sectionEnd);
  } catch {
    return text;
  }
}

const FILTERABLE_ITEM_TITLES = new Set([
  "Task context menu",
  "Tasks from issues",
  "Shared task-composition modules",
  "`@` file references",
]);

const HINT_RE = /`([^`\n]+)`/g;

function extractPathHints(itemText: string): string[] {
  const hints = new Set<string>();
  for (const m of itemText.matchAll(HINT_RE)) {
    const v = m[1]!.trim();
    if (v.includes("/")) hints.add(v);
  }
  return [...hints];
}

function pathsOverlap(a: string, b: string): boolean {
  return inLane(a, b) || inLane(b, a);
}

/** Layer 2: for the four filterable items only, drops an item when it has
 *  at least one backtick-quoted `/`-containing hint and every hint fails to
 *  overlap every file in `files` (directory-prefix semantics, both
 *  directions). No signal (`files` missing/empty) keeps everything. */
function cutOrchestrationFlowOverlap(text: string, files: string[] | null | undefined): string {
  if (!files || files.length === 0) return text;
  try {
    const section = findHeadingSection(text, ORCHESTRATION_FLOW_HEADING);
    if (section == null) return text;
    const { headingLineEnd, sectionEnd } = section;
    const body = text.slice(headingLineEnd, sectionEnd);
    const items = locateOrchestrationItems(body);
    const drops: OrchestrationItem[] = [];
    for (const item of items) {
      if (!FILTERABLE_ITEM_TITLES.has(item.title)) continue;
      const hints = extractPathHints(body.slice(item.start, item.end));
      if (hints.length === 0) continue;
      const overlaps = hints.some((h) => files.some((f) => pathsOverlap(f, h)));
      if (!overlaps) drops.push(item);
    }
    if (drops.length === 0) return text;
    let newBody = "";
    let cursor = 0;
    for (const d of drops) {
      newBody += body.slice(cursor, d.start);
      cursor = d.end;
    }
    newBody += body.slice(cursor);
    return text.slice(0, headingLineEnd) + newBody + text.slice(sectionEnd);
  } catch {
    return text;
  }
}

export interface FilterPipelineContext {
  agentKind: string;
  /** Pipeline stage of this turn; null/undefined for a build child (whose
   *  own `Task.pipelineStage` is always null) or any non-pipeline call. */
  pipelineStage?: string | null;
  /** True for a build child (`task.parentTaskId != null`). Always keeps the
   *  section (Layer 1 never drops it) and goes straight to Layer 2. */
  isChild?: boolean;
  /** Stage-appropriate file list for Layer 2. Missing/empty = no signal,
   *  keep every filterable item (AC-7). */
  files?: string[] | null;
}

const ORCHESTRATION_DROP_STAGES = new Set(["specify", "clarify", "planning", "plan-review", "decompose"]);

function shouldDropOrchestrationFlowSection(opts: FilterPipelineContext): boolean {
  if (opts.isChild) return false;
  return opts.pipelineStage != null && ORCHESTRATION_DROP_STAGES.has(opts.pipelineStage);
}

export function filterClaudeMdForPipeline(text: string, opts: FilterPipelineContext): string {
  let out = text;
  out = cutAgentCommandShapeSection(out, opts.agentKind);
  out = cutJubarteSection(out);
  if (shouldDropOrchestrationFlowSection(opts)) {
    out = cutOrchestrationFlowStageGate(out);
  } else {
    out = cutOrchestrationFlowOverlap(out, opts.files);
  }
  return out;
}
