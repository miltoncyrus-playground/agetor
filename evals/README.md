# Evals — the paid, LLM-calling quality lane

Gate tests (`bun test`) are deterministic, free, and run on every commit.
This directory is the OTHER lane: evals that spawn a real claude run against
the pipeline's real prompts and score the resulting artifacts. Slower, costs
model usage, allowed to be non-deterministic — but every run has a hard pass
threshold and a non-zero exit on failure.

## Design rule

Generation is latent space; **every score is deterministic code** over the
files/git state the run produced (parseBuildPlan, `isBranchMerged`,
`git status`, exact file content). No LLM-as-judge — a judge call would just
add a second non-determinism on top of the first. If a property can't be
scored deterministically, it doesn't get an eval here.

## Running

```bash
bun run eval:pipeline                                  # all evals, 1 run each
bun evals/pipeline/run-evals.ts --only merge --runs 3  # subset, repeated
bun evals/pipeline/run-evals.ts --model claude-sonnet-5
```

Defaults: `claude-opus-5`, effort high (agetor's own claude-code defaults).
Each eval is one headless `claude -p` call in a throwaway fixture repo under
`/tmp`. `claude -p` draws Agent SDK credit (not the interactive subscription
quota). A JSON report lands at `evals/pipeline/last-report.json` (gitignored).

## When to run

- Before shipping a change to `src/bun/pipeline-prompts.ts`.
- Nightly, if wired into a scheduler.

## Current evals (see run-evals.ts for the full check lists)

| Eval | Prompt under test | Scores |
|---|---|---|
| decompose-files | `decomposePrompt` | TASKS.json parses, per-subtask `files` with no overlap, AC coverage, shared files owned, committed |
| merge-resolution | `mergeResolutionPrompt` | merge concluded (`isBranchMerged`), both sides' intent preserved, no markers, branch files landed, clean tree |
| builder-commit | `buildingPrompt` | plan implemented exactly, work committed, `feature:` subject, no AI attribution |
