import { describe, expect, test } from "bun:test";
import {
  AGENT_COMMAND_SHAPE_HEADING,
  JUBARTEAI_HEADING,
  ORCHESTRATION_FLOW_HEADING,
  filterClaudeMdForPipeline,
} from "./claude-md-filter.ts";
import { inLane } from "./stage-handoff.ts";

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

// ─── O-15: Orchestration flow Layer 1 (stage gate) + Layer 2 (files overlap) ───

const ORCH_ITEM_1 = "ORCH_ITEM_ONE_INTRO_TEXT";
const ORCH_ITEM_2 = "ORCH_ITEM_TWO_INTRO_TEXT";
const ORCH_ITEM_3 = "ORCH_ITEM_THREE_INTRO_TEXT";
const ORCH_ITEM_4 = "ORCH_ITEM_FOUR_INTRO_TEXT";
const ORCH_ITEM_5 = "ORCH_ITEM_FIVE_FILLER_TEXT";
const ORCH_ITEM_6 = "ORCH_ITEM_SIX_FILLER_TEXT";
const ORCH_ITEM_7 = "ORCH_ITEM_SEVEN_FILLER_TEXT";
const ORCH_ITEM_8 = "ORCH_ITEM_EIGHT_FILLER_TEXT";
const ORCH_ITEM_13 = "ORCH_ITEM_THIRTEEN_FILLER_TEXT";

const ORCH_HINT_9 = "src/mainview/lib/context-menu.ts";
const ORCH_HINT_10 = "src/bun/issue-task.ts";
const ORCH_HINT_11 = "src/mainview/components/kanban/PromptComposer.tsx";
const ORCH_HINT_12 = "src/shared/at-refs.ts";

// A coincidental textual match embedded in filler item 6, so a `files` value
// naming this exact string can be shown to have no effect on items 1-8/13
// (AC-9) even though the text literally matches.
const ORCH_COINCIDENTAL_HINT = "src/mainview/lib/context-menu.ts";

const ORCH_FIXTURE = `# CLAUDE.md fixture

${ORCHESTRATION_FLOW_HEADING}

1. **Intro lifecycle step one**: ${ORCH_ITEM_1}.
2. **Intro lifecycle step two**: ${ORCH_ITEM_2}.
3. **Intro lifecycle step three**: ${ORCH_ITEM_3}.
4. **Intro lifecycle step four**: ${ORCH_ITEM_4}.
5. **Some runtime detail**: ${ORCH_ITEM_5}.
6. **Another runtime detail mentioning ${ORCH_COINCIDENTAL_HINT} in passing**: ${ORCH_ITEM_6}.
7. **Yet another runtime detail**: ${ORCH_ITEM_7}.
8. **One more runtime detail**: ${ORCH_ITEM_8}.
9. **Task context menu**: right-click quick actions, see \`${ORCH_HINT_9}\`.
10. **Tasks from issues**: seeding a task from an issue thread, see \`${ORCH_HINT_10}\`.
11. **Shared task-composition modules**: shared composer bits, see \`${ORCH_HINT_11}\`.
12. **\`@\` file references**: inline file mentions, see \`${ORCH_HINT_12}\`.
13. **Trailing runtime detail**: ${ORCH_ITEM_13}.

${AGENT_COMMAND_SHAPE_HEADING}

Sibling section prose that must survive every orchestration-flow cut.

- **\`claude-code\`** → driven through claude-tmux.ts.
`;

const ORCH_DROP_STAGES = ["specify", "clarify", "planning", "plan-review", "decompose"] as const;
const ORCH_KEEP_STAGES = ["code-review", "testing", "building"] as const;

const ORCH_ALWAYS_KEPT_MARKERS = [ORCH_ITEM_1, ORCH_ITEM_2, ORCH_ITEM_3, ORCH_ITEM_4];
const ORCH_FILLER_MARKERS = [ORCH_ITEM_5, ORCH_ITEM_6, ORCH_ITEM_7, ORCH_ITEM_8, ORCH_ITEM_13];
const ORCH_FILTERABLE_TITLES = [
  "**Task context menu**",
  "**Tasks from issues**",
  "**Shared task-composition modules**",
  "**`@` file references**",
];

describe("filterClaudeMdForPipeline: Orchestration flow Layer 1 (stage gate)", () => {
  for (const stage of ORCH_DROP_STAGES) {
    test(`drop-stage ${stage}: drops items 5-13, keeps items 1-4 and the sibling section`, () => {
      const out = filterClaudeMdForPipeline(ORCH_FIXTURE, { agentKind: "claude-code", pipelineStage: stage });
      for (const marker of ORCH_ALWAYS_KEPT_MARKERS) {
        expect(out).toContain(marker);
      }
      for (const marker of ORCH_FILLER_MARKERS) {
        expect(out).not.toContain(marker);
      }
      for (const title of ORCH_FILTERABLE_TITLES) {
        expect(out).not.toContain(title);
      }
      expect(out).toContain(AGENT_COMMAND_SHAPE_HEADING);
      expect(out).toContain("Sibling section prose that must survive every orchestration-flow cut.");
    });
  }

  for (const stage of ORCH_KEEP_STAGES) {
    test(`keep-stage ${stage}: keeps items 5-13 when no files are given`, () => {
      const out = filterClaudeMdForPipeline(ORCH_FIXTURE, { agentKind: "claude-code", pipelineStage: stage });
      for (const marker of [...ORCH_ALWAYS_KEPT_MARKERS, ...ORCH_FILLER_MARKERS]) {
        expect(out).toContain(marker);
      }
      for (const title of ORCH_FILTERABLE_TITLES) {
        expect(out).toContain(title);
      }
    });
  }

  test("build child (isChild: true, pipelineStage: null): keeps items 5-13 when no files are given", () => {
    const out = filterClaudeMdForPipeline(ORCH_FIXTURE, {
      agentKind: "claude-code",
      pipelineStage: null,
      isChild: true,
    });
    for (const marker of [...ORCH_ALWAYS_KEPT_MARKERS, ...ORCH_FILLER_MARKERS]) {
      expect(out).toContain(marker);
    }
    for (const title of ORCH_FILTERABLE_TITLES) {
      expect(out).toContain(title);
    }
  });
});

describe("filterClaudeMdForPipeline: Orchestration flow Layer 2 (files overlap)", () => {
  test("non-overlapping files: drops all four filterable items, keeps 1-8/13", () => {
    const out = filterClaudeMdForPipeline(ORCH_FIXTURE, {
      agentKind: "claude-code",
      pipelineStage: "code-review",
      files: ["src/completely/unrelated/path.ts"],
    });
    for (const marker of [...ORCH_ALWAYS_KEPT_MARKERS, ...ORCH_FILLER_MARKERS]) {
      expect(out).toContain(marker);
    }
    for (const title of ORCH_FILTERABLE_TITLES) {
      expect(out).not.toContain(title);
    }
  });

  test("files undefined: keeps every item (AC-7)", () => {
    const out = filterClaudeMdForPipeline(ORCH_FIXTURE, {
      agentKind: "claude-code",
      pipelineStage: "code-review",
    });
    for (const title of ORCH_FILTERABLE_TITLES) {
      expect(out).toContain(title);
    }
  });

  test("files = []: keeps every item (AC-7)", () => {
    const out = filterClaudeMdForPipeline(ORCH_FIXTURE, {
      agentKind: "claude-code",
      pipelineStage: "code-review",
      files: [],
    });
    for (const title of ORCH_FILTERABLE_TITLES) {
      expect(out).toContain(title);
    }
  });

  test("discriminates: an overlapping file keeps that item while non-overlapping items are still dropped (AC-6)", () => {
    const out = filterClaudeMdForPipeline(ORCH_FIXTURE, {
      agentKind: "claude-code",
      pipelineStage: "building",
      isChild: true,
      // Exact match on item 11's hint; unrelated to items 9/10/12.
      files: [ORCH_HINT_11],
    });
    expect(out).toContain("**Shared task-composition modules**");
    expect(out).not.toContain("**Task context menu**");
    expect(out).not.toContain("**Tasks from issues**");
    expect(out).not.toContain("**`@` file references**");
    // Nested-under-hint also counts as overlap (directory-prefix semantics).
    const outNested = filterClaudeMdForPipeline(ORCH_FIXTURE, {
      agentKind: "claude-code",
      pipelineStage: "building",
      isChild: true,
      files: [`${ORCH_HINT_9}/deeper/child.ts`],
    });
    expect(outNested).toContain("**Task context menu**");
    // Parent-directory-of-hint also counts as overlap (other direction).
    const outParent = filterClaudeMdForPipeline(ORCH_FIXTURE, {
      agentKind: "claude-code",
      pipelineStage: "building",
      isChild: true,
      files: ["src/bun"],
    });
    expect(outParent).toContain("**Tasks from issues**");
  });

  test("filterable-titled item with no backtick `/` hints is always kept", () => {
    const fixture = ORCH_FIXTURE.replace(
      `11. **Shared task-composition modules**: shared composer bits, see \`${ORCH_HINT_11}\`.`,
      "11. **Shared task-composition modules**: shared composer bits, no path mentioned here at all.",
    );
    const out = filterClaudeMdForPipeline(fixture, {
      agentKind: "claude-code",
      pipelineStage: "code-review",
      files: ["src/completely/unrelated/path.ts"],
    });
    expect(out).toContain("**Shared task-composition modules**");
  });

  test("items 1-8/13 are never affected by any files value, including a coincidental textual match (AC-9)", () => {
    const out = filterClaudeMdForPipeline(ORCH_FIXTURE, {
      agentKind: "claude-code",
      pipelineStage: "code-review",
      files: [ORCH_COINCIDENTAL_HINT],
    });
    for (const marker of [...ORCH_ALWAYS_KEPT_MARKERS, ...ORCH_FILLER_MARKERS]) {
      expect(out).toContain(marker);
    }
    // The coincidental match is only in item 6's title, not one of the four
    // filterable titles, so it must not rescue item 9 (whose own hint is the
    // exact same path but which is itself unrelated to `files` here beyond
    // that coincidence) — item 9 is retained anyway since its hint equals a
    // `files` entry, proving the overlap decision, not blanket retention.
    expect(out).toContain("**Task context menu**");
  });
});

describe("inLane parity (claude-md-filter.ts imports this exact function from stage-handoff.ts,", () => {
  // so asserting its documented cases here is sufficient to guarantee
  // identical directory-prefix semantics in both call sites without
  // re-deriving the same assertions against a second, private copy.
  test("documented cases", () => {
    expect(inLane("a/b.ts", "a")).toBe(true);
    expect(inLane("a.ts", "b")).toBe(false);
    expect(inLane("a", "a")).toBe(true);
  });
});
