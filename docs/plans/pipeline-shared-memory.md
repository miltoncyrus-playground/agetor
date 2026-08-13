# Plan — Shared agent memory across the SDD pipeline (A-MEM adaptation)

| Field | Value |
| --- | --- |
| Date | 2026-08-13 |
| Source | User request: implement something like `jamesbower/agentic_shared_memory` (A-MEM) across the pipeline — planning only, this document is the deliverable |
| Reference design | A-MEM: shared associative memory for multi-agent systems — memory nodes (content + tags + versioning) in a central store, contextual retrieval injected into agent prompts, links between related nodes, periodic `optimize()` |
| Scope decision | Pipeline tasks only for v1 (`pipelineStage != null` and their build children). Plain tasks get nothing — zero behavior change outside the pipeline |
| Fidelity decision | Adopt A-MEM's *shape* (shared store, prompt injection, node links, versioning, maintenance), replace its *substrate* (LanceDB + OpenAI embeddings) with what this repo already has: `bun:sqlite` + FTS5 BM25. See §2 for why this is a first-principles deviation, not a shortcut |
| Status | **Design only. No code, no migration, no prompt file has been written yet.** |

## 1. Objective & success criteria

Today every pipeline stage starts from zero. The Planner in task N re-discovers the repo convention the Planner in task N-1 already learned; the Tester re-hits the "tests need `AGETOR_DATA_DIR` set" trap that already caused a `testing` bounce last week; a `code-review` revise reason that recurs across tasks is written to `pipelineFeedback`, consumed once, and discarded. The pipeline produces knowledge and throws it away.

This plan gives the pipeline a persistent, repo-scoped memory store that every stage reads from (relevant entries injected into the stage prompt, exactly the way the constitution already is) and writes to (two channels: a free deterministic harvest of every bounce reason, and an agent-authored sentinel block). Learnings compound across stages, across tasks, and across time — the A-MEM pitch ("instantiate multiple agents all referencing the same memory graph"), mapped onto agetor's stage agents.

Success criteria for the *design* (this document): every A-MEM capability has a stated adaptation or a stated, reasoned omission; every new mechanism names the exact existing code convention it reuses; every schema/route/prompt change is enumerated; retrieval and capture are placed in deterministic space per this project's own rule, with the latent-space surface limited to what genuinely needs judgment.

Success criteria for the *eventual implementation* (out of scope for this pass): `bun run typecheck` and `bun test` green including new unit tests for every pure function; a fake-driver pipeline walk where a memory captured in task A's `testing` bounce appears verbatim in task B's `testing` prompt when B runs in the same repo; the eval in §8 passes its threshold.

## 2. A-MEM → agetor mapping (and the one deliberate substitution)

| A-MEM concept | agetor adaptation | Why |
| --- | --- | --- |
| Central shared `MemoryGraph` | `memories` table in the existing `agetor.sqlite` | One store already shared by every stage agent via the orchestrator; no new process, no new file |
| LanceDB + OpenAI embeddings | FTS5 BM25 (verified compiled into `bun:sqlite` on this machine) + metadata filters | CLAUDE.md forbids external LLM/embedding APIs. Retrieval "which stored rows match this query text" is same-input-same-output — deterministic space. BM25 + repo/stage/tag filters is Layer-1 tried-and-true; embeddings are §11.1 |
| Node: content, embedding, links, tags, version | Row: body, tags, `memory_links` rows, `superseded_by` | Same shape minus the embedding column |
| Dynamic semantic linking | Deterministic links only in v1: explicit citation (`cites=MEM-n` in the sentinel), `supersedes`, same-source-task | LLM-scored linking is a paid latent pass with unproven value here; deferred (§11.2) |
| `retrieve(context=...)` injected into prompts | `recallMemories(...)` result injected into `stagePrompt` — the exact `constitutionRaw` pattern at `orchestrator.ts:1035-1043` | Precedent already exists and is proven |
| `update_node()` from agents | `PIPELINE_MEMORY:` sentinel lines in stage output, parsed by a pure parser | The `PIPELINE_VERDICT:` convention already proves rigid, example-driven sentinels are reliably followed by all three agent kinds — and it works identically for claude/codex/gemini, unlike an MCP tool (agetor's `ask_user` MCP server is already stripped by `hook-installer.ts`; native tools replaced it — there is no live agetor MCP surface to hang a `memory_save` tool on) |
| `optimize()` | Deterministic `pruneMemories()` — cap, evict by usage/age, drop superseded | No LLM needed for eviction policy |

## 3. Current state (as-built)

Confirmed by reading `src/bun/orchestrator.ts`, `src/bun/pipeline-prompts.ts`, `src/bun/db.ts`, `src/bun/migrations/`:

- 9-stage SDD pipeline is live: `specify → clarify → planning → plan-review → decompose (+inline analyze) → building → code-review → testing → ready`, driven by `advancePipelineStage` (`orchestrator.ts:1637`).
- **Constitution injection precedent**: `startTask` reads `.specify/memory/constitution.md` from the worktree and threads `constitutionRaw` into `stagePrompt` (`orchestrator.ts:1035-1043`). Memory injection is the same move with a DB read instead of a file read.
- **Sentinel-parsing precedent**: `PIPELINE_VERDICT:` lines parsed by pure `parsePipelineVerdict` from the run's assistant events (`lastPipelineVerdict` scans `runs.events(runId)` newest-first). Memory capture scans the same event stream.
- **Structured failure signals already exist and are discarded after one use**: every bounce edge writes a specific human-readable reason into `pipelineFeedback` (verdict revise reasons, `analyzeCoverage` gap lists, merge-conflict/child-failure reasons via `blockPipelineTask`, no-op-bounce fingerprint blocks from migration 039). These are free, pre-structured memory candidates — no agent turn needed to capture them.
- Latest migration is `039_pipeline_bounce_fingerprint.sql`; the new one is `040`.
- FTS5: verified available (`CREATE VIRTUAL TABLE … USING fts5` + `bm25()` ranking both work in `bun:sqlite` on this machine).
- Repo identity: tasks carry `workdir`; no normalized "repo key" helper exists yet. Git-host discovery code exists (`bitbucket.ts`, the consolidated host-discovery work) but nothing exposes "canonical remote URL for scoping" — small new pure helper needed (§5).

## 4. Target state — the memory loop

```
                        ┌──────────────────────────────────────────────┐
                        │  memories (sqlite + FTS5, repo-scoped)       │
                        └──────────────────────────────────────────────┘
                     recall ▲                                │ capture
                     (BM25, │                                ▼
                     filters,                 ┌── deterministic harvest ──┐
                     budget)│                 │  every bounce/block edge  │
                            │                 │  (zero agent turns)       │
   ┌────────────────────────┴───┐             └───────────────────────────┘
   │ startTask: stagePrompt +   │             ┌── agent-authored ─────────┐
   │ "## Relevant memories" +   │────────────▶│  PIPELINE_MEMORY: lines   │
   │ childBuildPrompt likewise  │  stage runs │  parsed at stage settle   │
   └────────────────────────────┘             └───────────────────────────┘
```

### 4.1 Recall — deterministic, injected at spawn

A pure-ish `recallMemories({ repoKey, stage, queryText, limit, charBudget })` in a new `src/bun/memory.ts`:

1. FTS5 `MATCH` over `title+body+tags` with the query built from the task's title + prompt (tokenized, stopwords dropped — pure helper, unit-tested).
2. Filter: same `repo_key`, not superseded. Rank: BM25 primary, then a small boost for same-stage rows and for rows with higher `retrieved_count` (proven useful), then recency.
3. Truncate to `limit` (default 6) AND `charBudget` (default 2,000 chars) — whichever bites first. The prompt must never balloon; this is the same "bounded injection" discipline the constitution section implicitly relies on.
4. Bump `retrieved_count`/`last_retrieved_at` on the returned rows (usage signal for pruning and for §10's metrics).

Injection points, both in `startTask`'s existing prompt-assembly block:
- Every stage prompt gains a `## Relevant memories` section: numbered entries rendered as `MEM-<id> [<kind>/<stage>]: <body>` so agents can cite ids. Explicit instruction: "these are prior observations from this repo, possibly stale — verify before relying on one."
- `childBuildPrompt` gets a subtask-scoped recall (query = subtask title + prompt) with a smaller budget (3 entries / 1,000 chars) — child agents are the ones that hit repo traps like test-env flags.

Empty recall → the section is omitted entirely (constitution behaves the same way).

### 4.2 Capture channel 1 — deterministic harvest (free, unmissable)

Every bounce/block already funnels through two choke points: the bounce arms inside `advancePipelineStage` (which set `pipelineFeedback` before `spawnStage`) and `blockPipelineTask` (`orchestrator.ts:1452`, also called by `build-scheduler.ts` on merge conflicts / child hard-failures). Both gain one call: `harvestBounceMemory({ taskId, runId, stage, targetStage, reason })` → inserts a `kind:"bounce"` row with the stage, the verbatim reason, tags derived deterministically (stage id, `revision-cap`/`pipeline-failed` when applicable), and source refs.

This is the structurally-cannot-be-skipped channel: even if an agent never emits a single sentinel line, the pipeline still accumulates "what goes wrong in this repo, at which stage, why." A bug in latent space (agent forgot to save a memory) becomes a feature in deterministic space — the harvest fires regardless.

Harvest is **fail-open**: a memory-write error is logged and swallowed; it must never derail run settlement (same "must never derail" treatment `pumpWatcherForHoldCheck` gets in `attachDoneHandler`).

### 4.3 Capture channel 2 — agent-authored sentinel

Every stage prompt (and `childBuildPrompt`) gains a fixed-format closing instruction, mirroring the `PIPELINE_VERDICT:` grammar with one example:

```
PIPELINE_MEMORY: kind=<knowledge|decision|convention> | tags=<comma,separated> | <one- to two-sentence finding>
```

Rules stated in the prompt: at most 3 lines per turn; only durable, repo-level findings (root causes, discovered conventions, config/flag traps, decisions between approaches) — never task-status narration; **never secrets, tokens, or key values** (names and purposes only — same rule the fleet-knowledge instructions already impose); optionally `supersedes=MEM-<id>` when correcting an earlier entry and `cites=MEM-<id>` when building on one.

Parsing: pure `parseMemoryLines(text): MemoryDraft[]` in `pipeline-prompts.ts` (zero IO, same convention as `parsePipelineVerdict`/`parseBuildPlan` — malformed lines are dropped, never fatal). Capture runs at stage settle inside `advancePipelineStage`, scanning the run's main-stream assistant events (the same `runs.events(runId)` walk `lastPipelineVerdict` does, but over all assistant messages, not just the last). Child runs are scanned by `completeChildBuild`'s settle path with the same parser.

`supersedes` sets `superseded_by` on the target row (the old row stays for audit, drops out of recall). `cites` writes a `memory_links` row. Both are ignored when the referenced id doesn't exist — never an error.

### 4.4 Dedup and pruning (A-MEM's `optimize()`)

- **Insert-time dedup** (deterministic): before insert, exact match on normalized body (lowercased, whitespace-collapsed) within the same `repo_key` → bump the existing row's `updated_at` and a `reinforced_count` instead of inserting. Near-duplicate semantic dedup is deferred with embeddings (§11.1).
- **`pruneMemories(repoKey)`** (deterministic): hard cap per repo (500 rows). Over cap → evict superseded rows first, then lowest `(retrieved_count, reinforced_count)` oldest-first. Runs opportunistically after each pipeline task reaches `ready` or `blocked` — no timer, no cron.

### 4.5 Scoping — `repoKey`

New pure helper `repoKeyFor(workdir)` in `memory.ts`: canonical form of `git remote get-url origin` (normalized: strip protocol/`.git`/credentials, lowercase host — reuse the host-normalization the git-host discovery code already does rather than re-inventing it), falling back to the resolved absolute `workdir` when there's no remote. Computed once at `createTask` time and **persisted on the task row** (`repo_key` column) so worktrees, re-runs, and children all share the parent's key without re-deriving it against a possibly-moved workdir. Cross-repo/global memory is deliberately out of scope (§11.3).

### 4.6 Human curation — API + minimal UI

Memories are only trustworthy if Milton can see and delete them:
- `GET /memories?repoKey=&q=&limit=` — list/search (recall's ranking, no usage-count bump).
- `DELETE /memories/:id` — hard delete.
- `PATCH /memories/:id` — body/tags edit.
- UI: one dialog ("Memory" entry point next to the existing repo-level affordances), a searchable list with kind/stage badges and a delete button per row. Deliberately thin — a browser, not an editor suite.

All routes behind the existing bearer-token gate like every other route.

## 5. Data model & migration

`src/bun/migrations/040_pipeline_memory.sql` (+ the usual `migrations/index.ts` append):

- `tasks` gains `repo_key TEXT` (nullable; backfill not needed — computed for new tasks, old tasks never recall).
- `memories`: `id INTEGER PK`, `repo_key TEXT NOT NULL`, `kind TEXT NOT NULL` (`bounce|knowledge|decision|convention`), `stage TEXT`, `body TEXT NOT NULL`, `tags TEXT NOT NULL DEFAULT '[]'` (JSON array, same convention as `tasks.backlog`/`refs`), `source_task_id TEXT`, `source_run_id TEXT`, `superseded_by INTEGER`, `retrieved_count INTEGER NOT NULL DEFAULT 0`, `reinforced_count INTEGER NOT NULL DEFAULT 0`, `last_retrieved_at TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`. Index on `(repo_key, kind)`.
- `memories_fts`: FTS5 external-content table over `body, tags` with the standard content-sync triggers (insert/update/delete) — the tried-and-true FTS5 pattern, not a hand-rolled sync.
- `memory_links`: `from_id`, `to_id`, `link_kind TEXT` (`cites`), PK `(from_id, to_id, link_kind)`.

No change to `runs`, no change to any pipeline column added by 034–039.

## 6. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| M1 | Migration 040 (tables above) + `db.ts` row mapping + a `memories` module in `db.ts` (insert/get/update/delete/search via FTS5, link writes) + `tasks.repo_key` plumbing | `src/bun/migrations/040_pipeline_memory.sql`, `migrations/index.ts`, `src/bun/db.ts`, `src/shared/types.ts` | — | Fresh DB migrates; FTS `MATCH` returns BM25-ranked rows; typecheck green |
| M2 | `src/bun/memory.ts`: `repoKeyFor`, query tokenizer, `recallMemories` (rank/limit/budget/usage-bump), `harvestBounceMemory`, insert-time dedup, `pruneMemories` | `src/bun/memory.ts` | M1 | Every function pure or single-choke-point IO; deterministic given fixed DB state |
| M3 | `parseMemoryLines` + `renderMemorySection` (pure) ; sentinel instruction appended to every stage prompt builder and `childBuildPrompt`; recall section slotted into `stagePrompt`'s assembly next to the constitution block | `src/bun/pipeline-prompts.ts` | M1 | Parsers zero-IO; prompts carry the instruction + example verbatim; empty recall renders nothing |
| M4 | Orchestrator wiring: `createTask` persists `repo_key`; `startTask` calls `recallMemories` alongside the `constitutionRaw` read; `advancePipelineStage` + child-settle scan assistant events with `parseMemoryLines`; bounce arms + `blockPipelineTask` call `harvestBounceMemory`; `ready`/`blocked` terminal calls `pruneMemories`. All memory IO fail-open | `src/bun/orchestrator.ts`, `src/bun/build-scheduler.ts` | M2, M3 | Fake-driver walk: sentinel from stage N recalled in stage N+1's prompt; injected bounce harvested; a thrown memory-write never blocks settlement |
| M5 | Routes `GET/PATCH/DELETE /memories` behind the token gate | `src/bun/server.ts` | M1, M2 | Route tests green; archived-task-style guards not needed (memories aren't task-owned) |
| M6 | Memory browser dialog (list, search box, kind/stage badges, delete) | `src/mainview/components/**`, `src/mainview/lib/api.ts` | M5 | Renders, searches, deletes against a live API; dark-mode pass |

## 7. Work breakdown — test tasks (gate lane)

| ID | Goal | Files owned | Covers |
| --- | --- | --- | --- |
| MT1 | `parseMemoryLines`: valid lines, all optional fields, >3 lines clipped, malformed dropped, secrets-looking lines still parsed (filtering is prompt-side, parser is dumb); `renderMemorySection` fixed-string checks | `src/bun/pipeline-prompts.test.ts` | M3 |
| MT2 | `memory.ts`: `repoKeyFor` (https/ssh/no-remote forms), tokenizer, recall ranking (BM25 + same-stage boost + budget clipping, deterministic on a seeded temp DB), dedup bump, supersede exclusion, prune eviction order | new `src/bun/memory.test.ts` | M2 |
| MT3 | Migration + FTS triggers: insert/update/delete stay in sync; `bm25()` usable | `src/bun/memory.test.ts` (temp `AGETOR_DATA_DIR`, same `mkdtemp` convention as every db-touching suite) | M1 |
| MT4 | Orchestrator integration (fake driver): cross-stage recall within a task; cross-task recall within a `repoKey`; bounce harvest on each edge incl. `blockPipelineTask` via a merge conflict; fail-open on injected memory-write error; non-pipeline task = zero memory calls | `src/bun/orchestrator-pipeline.test.ts` | M4 |
| MT5 | Route tests: auth-gated, search param honored, delete removes from FTS too | new `src/bun/memory-endpoint.test.ts` | M5 |

**Eval lane (periodic, paid, threshold-gated)** — one new eval, routed through local Claude Code per the LLM-access rule: seed a memory ("tests in this repo fail without `AGETOR_DATA_DIR` set to a temp dir") into a fixture repo's store, run a real single-stage `testing` turn with and without injection, and have an LLM judge score whether the with-memory transcript acts on the seeded fact. Pass threshold ≥ 4/5 runs. This is the proof injection changes behavior, which no gate test can show.

## 8. Execution waves

- **Wave 1**: M1 (schema + db module).
- **Wave 2**: M2 and M3 in parallel — disjoint files, both only need M1.
- **Wave 3**: M4 (orchestrator wiring) — needs both.
- **Wave 4**: M5 → M6 (API then UI); independent of M4, can overlap wave 3.
- **Wave 5**: MT1–MT5 gated on their implementation tasks; the eval last.

## 9. Blast radius & risks

- **Non-pipeline tasks**: zero change — every hook is inside `pipelineStage != null` paths.
- **Prompt growth**: bounded by the recall char budget; worst case +~2KB per stage prompt. Well under gemini's 4,096-byte argv ceiling concern? **No — it is not.** Gemini pipeline tasks deliver the prompt via argv (`GEMINI_PROMPT_ARGV_MAX_BYTES = 4096`), and stage prompts are already long. Mitigation: recall budget for gemini tasks shrinks to whatever headroom remains, down to zero (recall is an enhancement, never worth a spawn failure). This must be explicit in M4, not discovered in production.
- **Poisoned/stale memories**: an agent can save a wrong "fact" that then gets injected into future prompts — the classic shared-memory failure mode. Mitigations: the "possibly stale — verify" framing in the injected section, `supersedes` as the correction path, the curation UI, and pruning. Accepted residual risk for v1.
- **Secrets in memory rows**: prompt-side prohibition only (the parser stays dumb). Same trust model as `pipelineFeedback`, which already stores verbatim agent text. Rows never leave the local sqlite file.
- **Dev vs release stores**: `~/.agetor-dev` and `~/.agetor` have separate DBs, so memories don't cross — consistent with every other piece of state, worth remembering when dogfooding "why doesn't it recall."
- **Fail-open discipline**: every memory call sits on the run-settlement hot path; each one is wrapped. A memory bug degrades to "pipeline behaves like today," never to a stuck run.

## 10. Measurable outcomes

1. **Repeat-bounce rate**: share of harvested `bounce` memories whose normalized reason already existed for that `repo_key` (the dedup `reinforced_count` makes this a free query). Should trend down per-repo as recall starts pre-empting known traps — this is the single number that says the loop works.
2. **Recall usage**: fraction of stage spawns whose prompt carried ≥1 memory, and mean `retrieved_count` growth — proves injection actually fires outside tests.
3. **Eval score** (§7 eval lane): with-memory vs without-memory behavioral delta on the seeded-fact fixture, nightly.

## 11. Open questions / deferred

1. **Embeddings later**: if BM25 recall proves too literal, `sqlite-vec` (SQLite extension, local, no API) + a local embedding model is the upgrade path that stays inside the no-external-API rule. Not v1: it adds a native dependency to the packaged app for unproven benefit.
2. **LLM linking/summarization pass** (A-MEM's dynamic linking + note evolution): a periodic local-Claude pass that merges near-duplicates and writes richer links. Deferred until the store is big enough that pruning alone visibly loses signal.
3. **Cross-repo / global tier**: a `repo_key IS NULL` tier for machine-wide conventions. Cheap to add later (one filter change); scoping v1 to per-repo keeps poisoning blast radius small.
4. **Recall for plain (non-pipeline) tasks**: the same injection would work in `startTask`'s non-pipeline branch. Deliberately excluded so v1's behavior change is confined to the subsystem that asked for it — flag for a fast follow if pipeline recall proves out.
5. **Memory in `clarify`'s question budget**: recalled clarifications from prior tasks could auto-answer ambiguities before `ask_user` fires. Attractive, but it makes recall load-bearing for a human-facing flow — revisit after v1 data.
