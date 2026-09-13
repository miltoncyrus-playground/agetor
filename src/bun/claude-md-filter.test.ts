import { describe, expect, test } from "bun:test";
import { AGENT_COMMAND_SHAPE_HEADING, JUBARTEAI_HEADING, filterClaudeMdForPipeline } from "./claude-md-filter.ts";

const AGENT_KINDS = ["claude-code", "codex", "cursor", "gemini", "fx"] as const;

// Bullets deliberately NOT in file order (fx, claude-code, gemini, cursor, codex)
// to prove the parser doesn't assume the real file's ordering.
const FIXTURE = `# CLAUDE.md fixture

## Stack and architecture

Some architecture prose here.

${AGENT_COMMAND_SHAPE_HEADING}

Intro paragraph describing the command shapes.

- **\`fx\`** → driven through fx-acp.ts, no tmux at all.
  Extra fx filler prose on its own line.
- **\`claude-code\`** → driven through claude-tmux.ts, one tmux session per task.
  Extra claude-code filler prose on its own line.
- **\`gemini\`** → driven through gemini-tmux.ts, one-shot per turn.
  Extra gemini filler prose on its own line.
- **\`cursor\`** → driven through cursor-tmux.ts, structural clone of codex.
  Extra cursor filler prose on its own line.
- **\`codex\`** → driven through codex-tmux.ts, one-shot per turn.
  Extra codex filler prose on its own line.

Trailing paragraph after the bullets, belongs to whichever bullet is last.

### Claude session lifecycle

Some lifecycle prose that must survive every cut.

## Persistence

Persistence section prose.

${JUBARTEAI_HEADING}

This repository participates in the JubarteAI agent fleet.

### Never

Some never-do list.

More JubarteAI prose running to the end of the file.
`;

function fixtureWithout(heading: string, replacement: string): string {
  return FIXTURE.replace(heading, replacement);
}

describe("filterClaudeMdForPipeline", () => {
  for (const kind of AGENT_KINDS) {
    test(`keeps only the ${kind} bullet and always drops JubarteAI`, () => {
      const out = filterClaudeMdForPipeline(FIXTURE, { agentKind: kind });
      for (const other of AGENT_KINDS) {
        if (other === kind) continue;
        expect(out).not.toContain(`**\`${other}\`** →`);
      }
      expect(out).toContain(`**\`${kind}\`** →`);
      expect(out).not.toContain(JUBARTEAI_HEADING);
      // surrounding sections must survive untouched
      expect(out).toContain("### Claude session lifecycle");
      expect(out).toContain("## Persistence");
      expect(out).toContain("## Stack and architecture");
    });
  }

  test("Agent command shape heading renamed/missing: that section passes through untouched, JubarteAI still removed", () => {
    const fixture = fixtureWithout(AGENT_COMMAND_SHAPE_HEADING, "### Agent invocation shape");
    const out = filterClaudeMdForPipeline(fixture, { agentKind: "claude-code" });
    for (const kind of AGENT_KINDS) {
      expect(out).toContain(`**\`${kind}\`** →`);
    }
    expect(out).not.toContain(JUBARTEAI_HEADING);
  });

  test("JubarteAI heading renamed/missing: that section passes through untouched, Agent command shape narrowing still happens", () => {
    const fixture = fixtureWithout(JUBARTEAI_HEADING, "## JubarteAI Fleet Identity");
    const out = filterClaudeMdForPipeline(fixture, { agentKind: "claude-code" });
    expect(out).toContain("## JubarteAI Fleet Identity");
    expect(out).toContain("This repository participates in the JubarteAI agent fleet.");
    expect(out).toContain(`**\`claude-code\`** →`);
    expect(out).not.toContain(`**\`codex\`** →`);
    expect(out).not.toContain(`**\`cursor\`** →`);
    expect(out).not.toContain(`**\`gemini\`** →`);
    expect(out).not.toContain(`**\`fx\`** →`);
  });

  test("neither section present: output is byte-identical to input", () => {
    const fixture = fixtureWithout(JUBARTEAI_HEADING, "## Not JubarteAI At All").replace(
      AGENT_COMMAND_SHAPE_HEADING,
      "### Not Agent Shape At All",
    );
    const out = filterClaudeMdForPipeline(fixture, { agentKind: "claude-code" });
    expect(out).toBe(fixture);
  });

  test("unrecognized agentKind: Agent command shape untouched, JubarteAI still removed", () => {
    const out = filterClaudeMdForPipeline(FIXTURE, { agentKind: "made-up-kind" });
    for (const kind of AGENT_KINDS) {
      expect(out).toContain(`**\`${kind}\`** →`);
    }
    expect(out).not.toContain(JUBARTEAI_HEADING);
  });
});
