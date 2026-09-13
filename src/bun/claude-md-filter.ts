/**
 * O-14: pure string transforms that narrow a repo's CLAUDE.md for a
 * pipeline/child claude-code session's re-injected system prompt (see O-2
 * in orchestrator.ts). No filesystem or process access here — plain string
 * in, string out — so this module is trivially unit-testable and cannot
 * itself fail the spawn.
 */

export const AGENT_COMMAND_SHAPE_HEADING = "### Agent command shape";
export const JUBARTEAI_HEADING = "## JubarteAI Agent Identity";

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

export function filterClaudeMdForPipeline(text: string, opts: { agentKind: string }): string {
  let out = text;
  out = cutAgentCommandShapeSection(out, opts.agentKind);
  out = cutJubarteSection(out);
  return out;
}
