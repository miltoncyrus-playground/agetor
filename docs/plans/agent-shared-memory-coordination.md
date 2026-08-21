# Plan — Shared agent state and coordination across concurrent agetor tasks

| Field | Value |
| --- | --- |
| Date | 2026-08-21 |
| Source | Ticket "Shared agent state and coordination design document" (SPEC.md / PLAN.md on `feature/agent-shared-memory`) |
| Reference project | `/home/mcyrus/agentic_shared_memory` (`jamesbower/agentic_shared_memory`), an A-MEM implementation. Evaluated, not adopted as a runtime |
| Prior design reconciled | `docs/plans/pipeline-shared-memory.md` (design only, unimplemented as of this date) |
| Scope decision | Every concurrently running agetor task on one machine and one `AGETOR_DATA_DIR`: plain tasks, pipeline stage tasks, and pipeline build children alike |
| Status | **Design only. No code, no migration, no prompt file, no UI has been written for this document.** |

## 0. How to read this document

Sections 1 through 4 establish the boundary, audit the reference project, name what agetor already does, and reconcile with the prior pipeline design. Sections 5 through 7 are the three capability areas the ticket asks for, one section each. Sections 8 through 12 are the cross-cutting rules every mechanism in 5 through 7 obeys. Sections 13 through 16 are the delivery argument. Section 17 is an edge-case register, and the last table maps each acceptance criterion to the section that discharges it.

Two reading conventions:

- Anything marked `EXISTING` is already shipped in agetor. It is named with its file and symbol and is never re-proposed. Redesigning shipped behavior is out of scope.
- **Every fenced block in this document is illustrative.** Each one is preceded by the line `*Illustrative only. Shapes the discussion; not an implementation to merge.*` The blocks exist to pin down a shape so the discussion has something concrete to argue about. Column names, field names, and grammars in them are sketches, not a schema anyone should apply.

---

## 1. Problem and boundary

Agetor can run several coding agents at once. Each gets its own branch and its own worktree (`prepareWorkdir`, `worktree.ts:872`), which is what makes parallel work safe. The same isolation is what makes the agents blind: an agent cannot see that a peer is rewriting the file it is about to rewrite, cannot tell a peer that their two branches will not merge, and loses everything it worked out the moment its turn stalls, its task is paused, or the app restarts.

This document decides what to build about that, across three capability areas: cross-agent awareness (§5), conflict communication (§6), and agent state persistence and resumption (§7).

### 1.1 Boundary decisions

| Decision | Value | Source |
| --- | --- | --- |
| Scope | Every concurrently running task: plain, pipeline stage, pipeline build child | SPEC A-3 |
| Coordination identity | The **task** (`Task.id`), because it is stable across the many run rows one conversation produces and it is what owns the branch and the worktree | SPEC A-4 |
| Liveness | **Derived** from the current run and existing signals, never stored as an independent field that could disagree with reality | SPEC A-4 |
| Participating agent kinds | `claude-code`, `codex`, `gemini` | SPEC A-8 |
| Excluded participants | Background subagents and tracked background shells (`claude-subagents.ts`). Their streams are read-only and they own no branch and no worktree, so they have nothing to claim and no way to act on a notice | SPEC A-8 |
| Machine boundary | Single machine, single `AGETOR_DATA_DIR`. The agents that see each other are the ones recorded in one `agetor.sqlite` | SPEC A-6 |
| Repository boundary | `repoKey` (canonical `origin` remote URL, falling back to the resolved absolute `workdir`), as already specified in `pipeline-shared-memory.md` §4.5. Detail in §10 | SPEC A-6 |
| Agent-facing channel | Prompt injection in, output sentinels out. Not an MCP tool | SPEC A-9 |

### 1.2 The single-agent rule

This is normative and every later section inherits it by reference rather than restating it.

> **When exactly one task is running for a `repoKey`, every coordination surface in this document renders nothing.** Not an empty state, not a "no peers" line, not a zero-row table. No peer block is injected into any prompt, no conflict scan runs, no notice is queued, and no notification fires.

The gating predicate is concrete: **the peer count for the task's `repoKey`, after excluding the task itself, is zero.** When it is zero, the awareness block is omitted from the prompt entirely, the conflict detector returns before touching the database, and the operator surface hides rather than renders empty.

Omitting an injected section when it has no content is not a new behavior. `startTask` already does exactly this with the constitution: `constitutionRaw` stays `null` when `.specify/memory/constitution.md` is absent (`orchestrator.ts:1041-1049`), and `stagePrompt` renders nothing for it. The peer block copies that behavior.

The consequence worth stating plainly: a solo agent's prompt is byte-identical to today's, its run path is identical to today's, and the operator sees no new chrome. The features in this document are invisible until a second agent exists.

---

## 2. Reference project capability audit

The reference project at `/home/mcyrus/agentic_shared_memory` is an A-MEM (associative memory) implementation: a `MemoryGraph` of atomic memory nodes carrying content, a 1536-float embedding, bidirectional links with similarity scores, tags, and a version counter, stored in LanceDB, embedded with OpenAI, and orchestrated with the Agno framework.

**Provenance matters more than usual here, so it is a column in the table.** `README.md` advertises `memory_graph.retrieve(context=...)`, `memory_graph.update_node()` and `memory_graph.optimize()` as the system's API. None of the three exists in `main.py`. The class implements exactly ten methods: `__init__`, `_initialize_table`, `add_node`, `_update_links`, `get_node`, `query`, `search`, `get_connected_nodes`, `create_index`, and `create_agent_memory`. The four files under `documentation/` go considerably further, describing versioned-node restore, five configurable conflict-resolution strategies, sharding, tiered storage, query caching, batch APIs, cross-agent learning, and dynamic team formation, none of which is backed by code. Two of the implemented methods are weaker than they read: `query` parses a `WHERE` clause and then returns every row regardless (`main.py:384-395`), and `create_agent_memory` returns a three-key dictionary (`main.py:520-532`), not a memory system.

So each row below carries **implemented** (present in `main.py`) or **documented-only** (present in `README.md` or `documentation/` with no implementation). A capability cannot honestly be classified `adopt` on the strength of code that does not exist, and an idea is not worthless because it is only prose. The provenance column keeps both facts visible.

### 2.1 The audit

Rules this table obeys: every capability gets exactly one verdict, never blank and never "partial"; **Possible and Useful are two independent judgements** and never collapse into one column; every `Possible: yes` / `Useful: no` row is marked `POSSIBLE-BUT-NOT-USEFUL` and repeated in the excluded list at §2.2.

#### (a) Storage and node model

| Capability | Provenance | Possible in agetor? | Useful in agetor? | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| Memory node schema: `id`, `content`, `embedding`, `links`, `link_scores`, `tags`, `created_at`, `last_updated`, `version` (`main.py:36-46`) | implemented | yes | yes | adapt | The shape maps onto a sqlite row minus the embedding column. `pipeline-shared-memory.md` §5 already specifies that row; this design reuses it and does not restate it. |
| `add_node`: create a node, generate its embedding, link it (`main.py:78`) | implemented | yes | yes | adapt | Becomes the insert side of the durable store, fed by the two capture channels already designed (deterministic bounce harvest, agent sentinel). The embedding call is dropped. |
| Embeddings: 1536-float OpenAI vectors (`main.py:39`, `requirements.txt` `openai>=1.5.0`) | implemented | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Possible only through a local model, since the hosted call is barred (§2.3). Not useful at the size this store reaches (hundreds of rows), where FTS5 BM25 already returns the right rows. Upgrade path kept as an open question in §16. |
| LanceDB as the substrate (`requirements.txt` `lancedb>=0.3.0`, `main.py:51-76`) | implemented | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. LanceDB is embedded and local, so hosting is not the objection. It would be a second datastore beside `agetor.sqlite` for a table holding hundreds of rows. |
| Tags for categorization (`main.py:42`) | implemented | yes | yes | adopt | Kept as a JSON-array column, the convention `tasks.backlog` and `tasks.refs` already use. |
| `version` counter per node (`main.py:45`) | implemented | yes | yes | adapt | Kept as a monotonic per-row counter, and reused in §11 as the concurrent-write ordering rule so agreement between agents on wall-clock time is never required. |

#### (b) Retrieval

| Capability | Provenance | Possible in agetor? | Useful in agetor? | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `get_node` by id (`main.py:308`) | implemented | yes | yes | adopt | A direct row read. §12's curation surface needs exactly this. |
| `query`: SQL-like filtered read (`main.py:342`) | implemented | yes | yes | adapt | The implementation parses a `WHERE` clause and then returns every row anyway (`main.py:384-395`). Real filtering is a plain sqlite `WHERE`. |
| `search`: vector similarity over content (`main.py:397`) | implemented | yes | yes | adapt | Substituted with FTS5 `MATCH` plus BM25 ranking, the substitution `pipeline-shared-memory.md` §2 already made. |
| `retrieve(context=...)`: inject relevant memories into the prompt | documented-only (`README.md` A-MEM table; absent from `main.py`) | yes | yes | adopt | The most valuable idea in the reference. agetor already has the injection precedent at `orchestrator.ts:1041-1049`. Both §5's peer block and §7's checkpoint block are instances of it. |
| Hybrid query: vector search plus a tag filter (`documentation/lancedb_implementation.md`, "Hybrid Query for Link Discovery") | documented-only | yes | yes | adapt | Becomes `MATCH` plus a metadata `WHERE` on `repo_key` and kind. The vector half is dropped with embeddings. |
| Retrieval-strategy tiers: `vector_only` / `hybrid` / `two_stage` with a cross-encoder reranker (`memory_graph_optimization.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Three tunable strategies over a few hundred rows is configuration with no reachable payoff. |
| `create_index`: IVF_PQ, cosine metric (`main.py:497`) | implemented | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. An approximate-nearest-neighbour index exists to make million-row scans fast. A sqlite index on `(repo_key, kind)` is the entire requirement here. |
| Multimodal query: images stored and queried alongside text (`lancedb_implementation.md` core-capabilities table) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Every fact in §5, §6 and §7 is text. Nothing in the three capability areas has an image to store. |

#### (c) Linking and graph traversal

| Capability | Provenance | Possible in agetor? | Useful in agetor? | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| Bidirectional dynamic links with `link_scores`, written on both endpoints (`_update_links`, `main.py:171-306`) | implemented | yes | yes | adapt | Kept as deterministic links only: explicit `cites`, `supersedes`, and same-source-task. Similarity-scored links need the embedding pass this design rejects. |
| Similarity-threshold linking: `max_links=5`, `threshold=0.7` (`main.py:171`) | implemented | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. These are tuning knobs on top of the rejected embedding path, and the reference's own conversion from distance to similarity (`main.py:215`) assumes a cosine metric it never sets. |
| `get_connected_nodes`: breadth-first traversal to a depth (`main.py:438`) | implemented | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Depth-2 traversal pays off when links are dense and machine-generated. With deterministic links only, the graph is shallow and one join answers what a traversal would. |
| Explicit relationship creation with typed edges: `create_relationship(source, target, relationship_type)` (`multi_agent_collaboration.md`) | documented-only | yes | yes | adapt | Reduced to the two edge kinds that carry meaning here: `cites` and `supersedes`. A general typed-edge vocabulary is weight with no reader. |
| Link versioning: keep a history of how links changed (`lancedb_implementation.md`, "Link Versioning") | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Auditing link churn matters when links mutate automatically. Deterministic links do not mutate. |
| Link consistency management: ACID updates plus a background consistency checker (`lancedb_implementation.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. A foreign key plus "ignore a dangling id" covers it, which is what `pipeline-shared-memory.md` §4.3 already specified. |

#### (d) Evolution, versioning, and conflict resolution

| Capability | Provenance | Possible in agetor? | Useful in agetor? | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `update_node()`: continuous evolution of a stored fact | documented-only (`README.md` A-MEM table; absent from `main.py`) | yes | yes | adapt | Becomes `supersedes`: the old row stays for audit and drops out of recall. In-place mutation of a shared fact is what makes a wrong entry impossible to trace afterwards (§12). |
| Versioned-node history and restore: `versioned_nodes` table, `get_node_versions`, `restore_node_version` (`multi_agent_collaboration.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. The supersede chain is the history. A restore button on a knowledge row has no reader, and §12's correction path is delete or supersede. |
| Configurable conflict-resolution strategies: `latest_update`, `highest_confidence`, `confidence_weighted`, `agent_priority`, `consensus` (`multi_agent_collaboration.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Four of the five need a confidence score no agent here produces honestly, and auto-picking a winner between two contradictory findings is exactly what SPEC non-goal 8 forbids. §6's C3 surfaces the contradiction to a human instead. |

#### (e) Multi-agent collaboration

| Capability | Provenance | Possible in agetor? | Useful in agetor? | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| Shared graph across agents: "instantiate multiple agents all referencing the same memory_graph" (`README.md`) | implemented by construction (one `MemoryGraph` instance passed to several agents) | yes | yes | adopt | This is the ticket. One `agetor.sqlite` is already shared by every task through the orchestrator, so the substrate exists. |
| `create_agent_memory(user_memory=True, session_summary=True)` (`main.py:520`) | implemented (returns a three-key dict) | yes | yes | adapt | The reference's only answer to "an agent resumes without starting over" is its session-summary concept. That concept becomes §7's checkpoint. Agno's memory object itself is not adopted. Forward reference: §7. |
| Per-agent memory allocation and partitioning by `agent_id` and `namespace` (`multi_agent_collaboration.md`, best practice 2) | documented-only (`create_agent_memory` in `main.py:520` accepts no `agent_id`) | yes | yes | adapt | Partitioning is real and needed, but the axis here is `repoKey` plus task, not agent id. See §10. |
| Specialized agent teams: research / synthesis / reporting agents with assigned instructions (`multi_agent_collaboration.md`) | documented-only | no | no | reject | agetor's agents are operator-authored tasks running real CLIs. There is no meta-agent to assign roles, and adding one redesigns the product rather than coordinating it. |
| Sequential and parallel collaborative workflows: `collaborative_research`, `parallel_collaborative_research` (`multi_agent_collaboration.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. agetor already has both: the SDD pipeline is the sequential workflow and the build barrier (`build-scheduler.ts:68`) is the parallel one. A second orchestrator would duplicate `advancePipelineStage`. |
| Automatic synchronization: knowledge written by one agent is visible to the next with no explicit transfer (`multi_agent_collaboration.md`) | implemented by construction | yes | yes | adopt | Falls out of a single shared sqlite file. There is no mechanism to build, only a property to preserve. |
| Manual synchronization: `sync()` and `schedule_sync(interval_seconds=300)` (`multi_agent_collaboration.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. A single local file has nothing to synchronize against. |
| Cross-agent learning: `enable_cross_agent_learning(source_agents, target_agents, learning_rate=0.3)` | documented-only | no | no | reject | No definition exists of what a learning rate does to a text store, and no code backs it. It cannot be built from what the reference provides. |
| Dynamic team formation: `form_agent_team(task_description)` spawning specialists | documented-only | no | no | reject | Requires a meta-agent that creates tasks. Task creation is the operator's in agetor, and changing that is outside this design's boundary. |

#### (f) Maintenance and optimization

| Capability | Provenance | Possible in agetor? | Useful in agetor? | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `optimize()`: periodic maintenance of the store | documented-only (`README.md`; absent from `main.py`) | yes | yes | adapt | Becomes the deterministic `pruneMemories()` already designed in `pipeline-shared-memory.md` §4.4. An eviction policy is same-input-same-output work and needs no model. |
| Scheduled optimization: `schedule_optimization(interval_hours=24)`, cron-style maintenance windows (`memory_graph_optimization.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Pruning opportunistically at task settle needs no timer and no background process inside a desktop app. |
| Node pruning by age, by relevance, by access frequency (`memory_graph_optimization.md`) | documented-only | yes | yes | adapt | Age and access-frequency pruning are kept and are deterministic. Pruning "by relevance to current project goals" needs a model judgement per row and is dropped. |
| Node consolidation: merge, summarize or link near-duplicates with `gpt-4o` (`memory_graph_optimization.md`) | documented-only | yes | yes | adapt | Exact-body dedup at insert time is kept and is deterministic. The model-driven merge pass stays deferred exactly where `pipeline-shared-memory.md` §11.2 left it. |
| Memory hierarchies: `create_hierarchy` plus `hierarchical_retrieve` (`memory_graph_optimization.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Two flat scopes (task and repo) are the whole hierarchy this domain has, and §8 states the rule for choosing between them. |
| Batch operations: `batch_create_nodes`, `batch_generate_embeddings`, `batch_create_relationships` (`memory_graph_optimization.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Writes arrive one finding at a time on a run-settle path. There is no bulk load to batch. |
| Performance monitoring and reports: `enable_monitoring`, `generate_collaboration_report`, `generate_performance_report` (`multi_agent_collaboration.md`, `memory_graph_optimization.md`) | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL as specified. §13 defines the three outcome signals this design needs, each readable with one sqlite query and none needing a monitoring subsystem. |

#### (g) Scale and operations

Every row in this group is mechanically buildable and pointless for a store that will hold hundreds of rows on one developer machine. They are grouped so the exclusion is visible as a set rather than scattered.

| Capability | Provenance | Possible in agetor? | Useful in agetor? | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| Horizontal scaling by sharding: `ShardedMemoryGraph` with `content_based` / `round_robin` / `timestamp` strategies | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Sharding answers a row count three orders of magnitude above this one. |
| Vertical scaling: `configure_resources(max_memory_percent, max_cpu_percent, io_priority)` | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. The store's working set is smaller than one page cache. |
| Distributed processing across worker nodes and a coordinator | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL, and cross-machine coordination is outside the boundary set in §1.1 and repeated in §16. |
| Benchmarking: `run_benchmark`, `compare_configurations` | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL, and SPEC non-goal 6 excludes benchmarks from this ticket regardless. |
| Vector quantization: product quantization with subvector counts and bit widths | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. No vectors are stored, so there is nothing to quantize. |
| Adaptive indexing: reindex when query patterns shift past a threshold | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. One index on `(repo_key, kind)` has no pattern to adapt to. |
| Tiered storage: hot in memory, warm on SSD, cold on HDD, by access frequency | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. The entire store fits in the hot tier. |
| Query caching: `enable_caching(cache_size, ttl_seconds)`, `cached_retrieve` | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. Recall runs once per spawn, so there is no repeated query to cache. |
| Parallel query processing: `configure_parallel_processing`, `parallel_retrieve` | documented-only | yes | no | reject | POSSIBLE-BUT-NOT-USEFUL. A single BM25 query over hundreds of rows finishes well inside one spawn's slack. |

#### (h) Framework and orchestration

| Capability | Provenance | Possible in agetor? | Useful in agetor? | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| Agno as the agent-orchestration framework (`requirements.txt` `agno>=1.0.0`; `main.py:13-18` imports `agno.agent.Agent`, `agno.models.openai.OpenAIChat`, `agno.vectordb.lancedb.LanceDb`, `agno.embedder.openai.OpenAIEmbedder`) | implemented | no | no | reject | agetor is Bun and TypeScript, and its agents are CLI subprocesses it spawns and drives through tmux, not in-process Python agents. There is no seam to host Agno, and CLAUDE.md's "no framework-of-the-month" rule closes the question independently. |
| Agno `monitoring=True` telemetry for memory-graph metrics (`README.md`) | documented-only | no | no | reject | Depends on Agno, which is rejected, and points run telemetry at a hosted service, which the local-first rule bars. §13's signals are read locally instead. |

### 2.2 The excluded set: POSSIBLE-BUT-NOT-USEFUL

These 26 capabilities could be built inside agetor and are not worth building. They are excluded from the recommendation in §15 by construction.

Embeddings; LanceDB as the substrate; retrieval-strategy tiers; `create_index` (IVF_PQ); multimodal query; similarity-threshold linking (`max_links=5`, `threshold=0.7`); `get_connected_nodes` depth traversal; link versioning; link consistency management; versioned-node history and restore; configurable conflict-resolution strategies; sequential and parallel collaborative workflows; manual synchronization (`sync`, `schedule_sync`); scheduled optimization; memory hierarchies; batch operations; performance monitoring and reports; horizontal scaling by sharding; vertical scaling; distributed processing; benchmarking; vector quantization; adaptive indexing; tiered storage; query caching; parallel query processing.

Five further capabilities are rejected as **not possible** in agetor rather than not useful, and are likewise absent from §15: specialized agent teams, cross-agent learning, dynamic team formation, Agno orchestration, and Agno `monitoring=True`.

The audit's totals: 50 capabilities classified, 5 `adopt`, 14 `adapt`, 31 `reject`. No capability is unclassified and no verdict is conditional.

### 2.3 External dependencies of the reference, retained or substituted (AC-13)

| Dependency | Retained or substituted | Substitute | Forcing constraint |
| --- | --- | --- | --- |
| OpenAI embeddings (`requirements.txt` `openai>=1.5.0`; 1536-dim vectors at `main.py:39`; `OpenAIEmbedder(id="text-embedding-3-small")` throughout `documentation/`) | substituted | FTS5 `MATCH` with BM25 ranking over title, body and tags, plus metadata filters, as `pipeline-shared-memory.md` §2 specifies | CLAUDE.md's rule that software we build must not call a hosted inference endpoint. "Which stored rows match this text" is also same-input-same-output work, so the latent-versus-deterministic rule puts it in code, not in a model. |
| OpenAI chat model for link analysis (`MemoryGraph.__init__(vector_db, llm)` at `main.py:22`; the "LLM Link Analysis" step in `documentation/memory_workflow.md` and the dynamic-linking diagram in `lancedb_implementation.md`; `OpenAIChat(id="gpt-4o")` in every documentation example) | substituted | Deterministic links only: explicit `cites`, `supersedes`, and same-source-task | The same no-external-LLM-API rule, plus the latent-versus-deterministic rule. Where a model genuinely is needed later, CLAUDE.md requires routing through local Claude Code, not an API. |
| Agno framework (`requirements.txt` `agno>=1.0.0`) | substituted | agetor's own orchestrator: `startTask` (`orchestrator.ts:927`), `advancePipelineStage` (`:1844`), and the build barrier (`build-scheduler.ts:68`) | "No framework-of-the-month", and the structural mismatch that agetor drives CLI subprocesses rather than hosting in-process agents. |
| Agno `monitoring=True` telemetry (`README.md`) | substituted | Local signals read from `agetor.sqlite`, defined in §13 | Local-first. Nothing about a coordination store should require an outbound connection to be observable. |
| LanceDB (`requirements.txt` `lancedb>=0.3.0`, `pyarrow>=12.0.0`) | substituted | The existing `bun:sqlite` database at `$AGETOR_DATA_DIR/agetor.sqlite`, with FTS5 | Not a hosting constraint: LanceDB is embedded and runs locally. The forcing constraint is "do not add a second datastore" for a table that will hold hundreds of rows, when a migrated, backed-up, already-open sqlite file is right there. |
| JubarteAI fleet platform (`connect`, `echo_current_task`, `list_agents`, `message_agents`, `search_knowledge`, `create_knowledge`; documented in CLAUDE.md) | retained as an **optional outbound adapter only**, never as the mechanism | The local stores in §8, with an off-by-default adapter that mirrors awareness rows outward when a fleet is connected | AC-15's rule that a shared-state failure must never block a run, plus the local-first rule. A hosted service cannot sit on the spawn path. **Confirm** (SPEC A-5): if the operator intends the fleet platform to be the mechanism rather than an adapter, that reverses this row and most of §5 and §6, so it should be settled before Phase 1 rather than after. |

One note on the fleet platform, since it is easy to miscount as existing coverage: it is an instruction layer for coding-agent sessions a human drives, not an agetor runtime capability. Nothing in `src/` calls it. It is therefore absent from §3's `EXISTING` list, present here as an external dependency, and present in §16 as a considered-and-rejected substrate for the default path.

---

## 3. What agetor already does (EXISTING)

Every row here is shipped. This design builds on them and does not re-specify them (SPEC non-goal 2). The last column is the point of the table: it names the gap each existing mechanism leaves, and those gaps are what §5 through §7 fill.

| Capability | Status | Where | What it does NOT cover |
| --- | --- | --- | --- |
| Agent session resumption after an app restart | EXISTING | `reconcileOrphans` (`orchestrator.ts:606`) reattaches a live tmux session for each `status='running'` run, keyed on `runs.claude_session_id` / `codex_session_id` / `gemini_session_id` (`db.ts:789-791`), re-tails the transcript from offset 0, and deduplicates on `run_events.line_uuid` under the partial unique index from migration `018_run_events_dedup.sql`. `resumeInFlightBuilds` (`:881`) does the same for in-flight pipeline builds | **Reasoning state.** The CLI's own conversation is recovered. Nothing tells the agent what it had already finished versus what remained, what it decided, or what it was in the middle of testing. Where the session is gone rather than reattachable, even the conversation is lost. |
| Stall detection ("may be stuck") | EXISTING | `checkTurnStall` (`claude-tmux.ts:1422`) fires when an in-flight turn's transcript has been silent past `AGETOR_TURN_STALL_MS` (read per call at `:1363-1366`) and no subagent transcript is fresh (`subagentActivityWithin`); it emits `TURN_STALLED_STATUS_PREFIX` (`shared/types.ts:34`), the orchestrator marks `stall-registry.ts`, and `server.ts` decorates `Task.stalledSince` (`shared/types.ts:1081`) | **Recovery.** It is a soft signal with no column flip and no checkpoint. It tells the operator something is wrong and hands the agent nothing to resume from. |
| Session-death detection mid-run | EXISTING | `startDeathWatch` (`claude-tmux.ts:4260`) polls `tmux has-session` while a turn is in flight and requires `DEATH_MISS_THRESHOLD` (`:3991`, currently 4) consecutive misses before emitting `SESSION_DIED_STATUS_PREFIX` (`shared/types.ts:20`); the orchestrator moves the card to `blocked` with `reason: "session-died"`. `codex-tmux.ts` carries the same watch | Same gap as stalls: the run is correctly declared dead, and the work in the operator's head is the only record of what it had achieved. |
| Per-task branch and working-copy isolation | EXISTING | `prepareWorkdir` (`worktree.ts:872`) creates `~/.agetor/worktrees/<task-id>/` on branch `agetor/<short-id>-<slug>`, off a `baseRef` resolved to a sha at create time so re-runs are reproducible | **Visibility between the copies.** Isolation is why two agents can work at once and also why neither can see the other. Divergence is discovered at merge, not before. |
| Declared ownership of code areas between parallel subtasks | EXISTING | `BuildSubtask.files` (`pipeline-prompts.ts:203-212`), `parseBuildPlan`'s exact-match cross-subtask overlap rejection (`:288-308`), and `childBuildPrompt`'s instruction to the child to stay inside its list | **Everything outside one build plan.** Ownership is declared inside a single TASKS.json and is invisible to plain tasks, to a second pipeline running at the same time, and to any task that did not come from that plan. |
| Mid-run message delivery to a running agent | EXISTING | `sendInput` (`orchestrator.ts:2460`). For `claude-code`, a follow-up sent while a turn is in flight folds into the active run via `pasteFollowUp` with `holdUntilIdle` so the run does not settle on the intermediate `end_turn`. For `codex` and `gemini`, the message enters a per-task queue drained when the current turn resolves (`drainCodexQueue` / `drainGeminiQueue`, called at `:1331-1332` and `:1391-1392`) | Nothing generates such a message today except the operator typing it. §6 reuses this transport rather than inventing one. |
| Parking a message that cannot be delivered now | EXISTING | `Task.backlog` (`BacklogMessage[]`, migration 025) with add, reorder, patch and delete routes, plus the RunPanel tray that can send, edit or drop each draft | Operator-authored only. Nothing system-generated parks here yet. §6 names it as the precedent for an undeliverable conflict notice. |
| Pause and resume of a pipeline task | EXISTING | `Task.pausedAt` (`shared/types.ts:956`), `pausePipelineTask` (`orchestrator.ts:3550`), `resumePipelineTask` (`:3567`) which spawns the next stage on resume | The resumed stage starts from its stage prompt. Whatever the paused agent had worked out is not carried across the pause. |
| Merge divergence handling | EXISTING | `mergeBranch` (`worktree.ts:682`), `isBranchMerged` (`:718`) as the git-verified settle, `spawnMergeResolution` (`orchestrator.ts:1623`) with run `origin: "pipeline-merge"`, `Task.childMergeStatus: "merge-conflict"` as the one-merge-in-flight latch, `Task.satisfiedSubtasks` (migration 042) for a human marking a subtask done without a merge, and `blockPipelineTask` (`orchestrator.ts:1479`) | **Detection timing.** Everything here starts at merge time. Two branches that will not merge are indistinguishable from two that will until one is attempted. |
| Derived attention flags | EXISTING | `isAwaitingHandBack` (`shared/types.ts:1091`), `isGateParked` (`:1118`), `Task.pendingInteractionCount` (`:852`) backed by the pending-interaction registry in `interactions.ts` | Per-task. Nothing relates one task's state to another's. |
| Cross-task operator surfaces | EXISTING | `AttentionStrip.tsx` (tasks needing the operator) and `WorktreesDialog.tsx` backed by `listWorktrees` (`orchestrator.ts:4019`) | Neither shows what an agent is working on or where two agents overlap. §5's operator surface hangs beside these rather than duplicating them. |
| Agent self-reported plan state | EXISTING | `src/mainview/lib/todo-progress.ts` derives the current to-do list from the last `TodoWrite` snapshot in a run's events | **claude-only and webview-side.** It reads a tool call only claude emits, and it lives in the renderer with no server-side persistence. §7 therefore cannot use it as the checkpoint source, though it is a useful corroborating signal for claude tasks. |
| Push and poll transports for cross-task state | EXISTING | The `GlobalEvent` union (`shared/types.ts:2434`) published by `publishGlobalEvent` (`orchestrator.ts:348`) over the app-level `/app/events` SSE channel (`server.ts:4439`); the webview's 2-second `/tasks` poll (`App.tsx:263`); native notifications via `notifier.ts` | The events carry run status, column moves, updates and interaction changes. None of them carries what a task is working on. |
| Durable repo-scoped knowledge across tasks | **Designed, not built** | `docs/plans/pipeline-shared-memory.md` | See §4. There is no `src/bun/memory.ts`, no `memories` table, and no `PIPELINE_MEMORY` handling in `src/` today. |

---

## 4. Reconciliation with `pipeline-shared-memory.md`

**Implementation status, verified.** That document is a design, not code. There is no `src/bun/memory.ts`, no `memories` table, and zero occurrences of `PIPELINE_MEMORY` under `src/`. Its §5 reserves migration `040_pipeline_memory.sql`, but `040` on disk is `040_account_usage.sql`; the numbers through `042_satisfied_subtasks.sql` are taken and **the next free migration number is `043`**. Nothing below supersedes shipped behavior, because none of it shipped.

| Area of `pipeline-shared-memory.md` | This design | Why |
| --- | --- | --- |
| §2 A-MEM mapping table (shape adopted, substrate substituted) | leaves unchanged | §2.1 here reaches the same verdicts from a larger inventory. The mapping stands; this document widens it rather than revising it. |
| §4.1 Recall and prompt injection (`recallMemories`, `## Relevant memories`, budget, empty section omitted) | leaves unchanged for durable knowledge; **extends** the injection pattern to two new blocks | §5's peer block and §7's checkpoint block are new instances of the same pattern at the same injection point (`orchestrator.ts:1041-1049`). The recall mechanism itself is untouched. |
| §4.2 Deterministic bounce harvest at the bounce arms and `blockPipelineTask` | leaves unchanged | It is the structurally unmissable capture channel and it is pipeline-shaped by nature: a bounce is a pipeline event. Plain tasks have no bounce edge to harvest. |
| §4.3 `PIPELINE_MEMORY:` sentinel grammar and its pure parser | leaves unchanged; **extends** the convention with one further sentinel | §7 adds an `AGENT_STATE:` sentinel for checkpoints. Same grammar discipline, same dumb parser, same drop-malformed-lines rule. The memory grammar itself is not restated here. |
| §4.4 Dedup and pruning (`pruneMemories`, 500-row cap, eviction order) | leaves unchanged | Deterministic eviction was already the right call. §11 adds the ephemeral stores' own retention, which is separate. |
| §4.5 `repoKey` (canonical `origin`, fallback to absolute `workdir`, persisted on the task row) | **extends** to all tasks | The prior design computes `repoKey` at `createTask` for pipeline use. Awareness and conflict scoping need it on every task, including plain ones, so it becomes universal rather than pipeline-only. This is the one schema consequence of SPEC A-3. |
| §4.6 Curation API and UI (`GET/PATCH/DELETE /memories`, a thin browser dialog) | **extends** to the ephemeral stores | §12's shared-state browser covers checkpoints and conflict records as well as memories, because a wrong checkpoint is as damaging as a wrong memory and needs the same delete. |
| §5 Schema and migration | **extends** | Its `memories`, `memories_fts` and `memory_links` tables stand as written. The ephemeral tables sketched in §8 are additional, in the same database, in a migration numbered from `043` upward. |
| §9 Blast radius, specifically the gemini argv finding | **extends** | That document already establishes `GEMINI_PROMPT_ARGV_MAX_BYTES = 4096` (`agents.ts:67`) as a hard ceiling and shrinks recall to fit. It only had one injected block to fit. This design adds two more, so the ceiling becomes a **shared budget with a stated split order**, which is a constraint that document did not have to solve. See §9. |
| §10 Metrics (repeat-bounce rate, recall usage, eval score) | leaves unchanged; **extends** with three more | §13 adds one measurable outcome per capability area. The existing three keep their definitions. |
| §11.1 Embeddings deferred | leaves unchanged | §2.1 independently rejects embeddings as POSSIBLE-BUT-NOT-USEFUL at this corpus size, with the same local-model upgrade path noted in §16. |
| §11.2 LLM linking and summarization pass deferred | leaves unchanged | Same verdict from the audit's evolution group. |
| §11.3 Cross-repo global tier deferred | leaves unchanged | §10 keeps `repoKey` as the hard boundary. A machine-wide tier stays a one-filter change for later. |
| §11.4 Recall for plain (non-pipeline) tasks, flagged for a fast follow | **extends**, and closes it | SPEC A-3 makes the whole design task-scoped rather than pipeline-scoped, so plain tasks get awareness, conflict notices, and checkpoints. Durable-knowledge recall for plain tasks follows the same widening in Phase 4. |
| §11.5 Memory in `clarify`'s question budget | leaves unchanged | Still deferred, still for the same reason: it would make recall load-bearing for a human-facing flow. |

Nothing in that document is superseded. Two mechanical facts must travel with any implementation of it: **the next free migration number is `043`, not `040`**, and **the gemini argv ceiling is now a shared budget** across three injected blocks rather than one.

---

## 5. Capability area A: cross-agent awareness

An agent should be able to learn what its live peers are doing, and the operator should be able to see all of it in one place. "Peer" means another task with the same `repoKey` that is not this task. Single-agent behavior is §1.2's rule: zero peers renders nothing anywhere.

*Illustrative only. Shapes the discussion; not an implementation to merge.*

```
   task A run settles / column moves / diff changes
                 │
                 ▼
        ┌──────────────────────────┐        derived per read, never stored
        │ agent_claims (task-scoped)│◀──────  liveness: runId, run status,
        │  repo_key, task_id,       │        tmux session present,
        │  intent, declared_paths,  │        stalledSince, pausedAt,
        │  touched_paths, base_sha  │        gateParked, awaitingHandBack
        └──────────────────────────┘
             │                    │
   peer read │                    │ overlap test (§6 C1)
             ▼                    ▼
  "## Other agents in this repo"   conflict_records
   injected at spawn beside the    (pair-scoped, §6)
   constitution block
```

### 5.1 The fact set

One row per fact an agent or the operator can learn about a peer task. `Visible to peers?` is the trust boundary from §10 applied per fact.

| Fact | Source | Refresh trigger | Considered stale when | Visible to peers? |
| --- | --- | --- | --- | --- |
| **Identity** | | | | |
| Task id | `Task.id` | Immutable | Never | yes |
| Title | `Task.title` | On `PATCH /tasks/:id`, carried on the 2s `/tasks` poll | Never (it is what the operator called it) | yes |
| Agent kind and harness id | `Task.agent` resolved against the `harnesses` table | On task edit or agent switch | Never | yes |
| Model, mode, effort | `Task.model` (`shared/types.ts:796`), `Task.mode` (`:790`), `Task.effort` (`:803`) | On task edit | Never | yes |
| Project | The task's project association | On task edit | Never | yes |
| `parentTaskId`, `planSubtaskId` | `Task.parentTaskId` (`:980`), `Task.planSubtaskId` (`:990`) | Set once, at child creation | Never | yes |
| **Current task** | | | | |
| Intent summary | A bounded summary of `Task.prompt` (first N characters, or the subtask title and prompt for a build child). Never the full prompt | On task create, and on any `PATCH` that changes `prompt` | When the task has had no active run for the claim window (see §5.3) | yes |
| `pipelineStage` | `Task.pipelineStage` (`:899`) | On every `advancePipelineStage` transition, pushed as a `GlobalEvent` `kind: "column"` with `reason: "stage-advance"` | Never (it is authoritative) | yes |
| `column` | `Task.column` | On every column move, pushed as a `GlobalEvent` `kind: "column"` | Never | yes |
| `revisionCount` | `Task.revisionCount` (`:923`) | On each bounce | Never | yes |
| Latest `blockReason` | `Task.blockReason` (`:967`) | On `blockPipelineTask` and the blocked transitions | Cleared when the task leaves `blocked` | yes |
| **Working scope** | | | | |
| `repoKey` | Derived at `createTask` from the canonical `origin` remote, falling back to the resolved absolute `workdir`, then persisted on the task row (`pipeline-shared-memory.md` §4.5, extended to all tasks by §4 above) | Computed once at create | Never | yes (it is the partition key, not content) |
| `workdir` | `Task.workdir` | On task edit, which the UI locks once `worktreePath` is set | Never | yes |
| `worktreePath` | `Task.worktreePath` (`:767`) | Set once by `prepareWorkdir` (`worktree.ts:872`) | Never | yes |
| `branch` | `Task.branch` | Set once by `prepareWorkdir` | Never | yes |
| `baseRef` and its resolved sha | `Task.baseRef` (`:774`), pinned at create time | Set once at create | When the source repo's own HEAD has moved past it (surfaced, not corrected) | yes |
| Declared paths | `BuildSubtask.files` (`pipeline-prompts.ts:203-212`) when the task is a build child with a declared list; otherwise empty | On build-plan parse (`parseBuildPlan`, `:230`) | With the task | yes |
| Observed touched paths | Derived on demand from `getTaskDiff` (`worktree.ts:1035`) or a `git status` in the worktree, and cached with `treeFingerprintSync` (`:357`) as the invalidation key | Computed on demand, because it costs a git call. Recomputed when the fingerprint changes, at turn settle, and before any overlap test | When the cached fingerprint no longer matches the worktree | yes (paths only, never diff content) |
| Ahead count against base | `getAheadCount` (`worktree.ts:91`) | On demand, same cache key | Same as touched paths | yes |
| **Liveness and activity** | | | | |
| `runId` and its run status | `Task.runId` (`:829`) joined to the `runs` row | Pushed on `GlobalEvent` `kind: "run-status"` | Never (derived per read) | yes |
| Run `origin` | `runs.origin` (`shared/types.ts:1688`): `continuation`, `pipeline-stage`, `pipeline-merge`, or null | Set at run creation | Never | yes |
| tmux session present | `tmux has-session` for the task's session, the same probe `reconcileOrphans` (`orchestrator.ts:606`) and `startDeathWatch` (`claude-tmux.ts:4260`) already use | On demand, and on the death-watch tick while a turn is in flight | Never (derived per read) | yes |
| Last run-event timestamp | Newest `run_events` row for the task | On every appended event | It is itself the staleness clock for everything else | yes |
| `stalledSince` | `stall-registry.ts` via `Task.stalledSince` (`shared/types.ts:1081`) | Set on `TURN_STALLED_STATUS_PREFIX`, cleared on `TURN_STALL_RESUMED_STATUS_PREFIX` or turn end | Never (in-memory, re-derived after restart) | yes |
| `pausedAt` | `Task.pausedAt` (`:956`) | On `pausePipelineTask` / `resumePipelineTask` | Never | yes |
| `gateParked` | `isGateParked` (`shared/types.ts:1118`), derived from the latest run's status and origin | Derived per read in the task list | Never | yes |
| `awaitingHandBack` | `isAwaitingHandBack` (`:1091`) | Derived per read | Never | yes |
| `pendingInteractionCount` | `Task.pendingInteractionCount` (`:852`), backed by `interactions.ts` | On interaction register and resolve, pushed on the app-level SSE channel | Never | yes |

**Liveness is derived, never stored.** Every row in the liveness group is computed at read time from a source that is already authoritative: the run row, the tmux probe, the in-memory stall registry, the derived flags. Nothing writes a `is_alive` column. The reason is the failure mode a stored copy invites: a crashed writer leaves a stale `true` behind, and a peer then coordinates against an agent that no longer exists. A derived value cannot disagree with reality because there is no second copy to disagree with. This also means liveness has no entry in §8's store table: it is owned by nothing.

*Illustrative only. Shapes the discussion; not an implementation to merge.*

```ts
// Shape of one peer as seen by another. Assembled per read; only the
// claim half is persisted (see §8).
interface PeerView {
  taskId: string;
  title: string;
  agent: string;                 // claude-code | codex | gemini
  pipelineStage: string | null;
  column: string;
  intent: string;                // bounded summary, not the full prompt
  branch: string | null;
  baseSha: string | null;
  declaredPaths: string[];       // from BuildSubtask.files when present
  touchedPaths: string[];        // derived from getTaskDiff, fingerprint-cached
  live: {                        // every field derived at read time
    running: boolean;
    sessionPresent: boolean;
    stalledSince: number | null;
    pausedAt: number | null;
    gateParked: boolean;
    awaitingHandBack: boolean;
    pendingInteractions: number;
    lastEventAt: number | null;
  };
  claimStale: boolean;           // §5.3
}
```

### 5.2 Refresh mechanics, by transport

Each fact above resolves to exactly one of four existing transports. Nothing new is invented.

| Transport | EXISTING mechanism | Facts carried |
| --- | --- | --- |
| Pushed | `publishGlobalEvent` (`orchestrator.ts:348`) over `/app/events` (`server.ts:4439`) | Run status, column and stage transitions, interaction register and resolve |
| Polled | The webview's 2-second `/tasks` refresh (`App.tsx:263`) | Every persisted `Task` field: title, agent, model, stage, column, `revisionCount`, `blockReason`, `pausedAt`, branch, base |
| Derived per read | The task-list assembly in `db.ts` and `server.ts` | `isAwaitingHandBack`, `isGateParked`, `stalledSince`, `pendingInteractionCount` |
| Computed on demand | A git call, guarded by a `treeFingerprintSync` cache | Touched paths, ahead count, base-moved comparison |

The split matters for cost. Anything that costs a subprocess (the git-derived facts) is never on the poll path. It is computed when a turn settles, when the overlap test in §6 needs it, or when the operator opens the awareness view, and it is skipped entirely when the fingerprint has not moved.

### 5.3 The staleness rule

A fact whose refresh window has passed is **rendered as stale, not dropped**. The peer stays visible with its age shown, because "an agent was working on this an hour ago and has gone quiet" is information the reader needs, while silently removing the row makes the repo look emptier than it is.

The claim window has one further consequence, and it is the answer to the SPEC edge case where an agent records what it intends to work on and then changes course:

> **A declared intent whose task has had no active run for longer than the claim window stops counting as a claim for §6's overlap test.** It still renders in the awareness view, marked stale. It no longer triggers a conflict record, and any open record that rests on it moves to the stale-claim class (§6, C4).

Two forces set the window. Too short and a legitimately long tool call looks abandoned; `AGETOR_TURN_STALL_MS` already defaults to 10 minutes for exactly that reason, because long tool calls write no transcript between `tool_use` and `tool_result` (`claude-tmux.ts:1363-1366`). Too long and peers coordinate against ghosts. A window at a small multiple of the stall threshold, configurable by the same kind of env read, is the shape; the exact multiple is an open question in §16 with a stated way to settle it.

Touched paths have their own, shorter, invalidation: the `treeFingerprintSync` value. When the worktree's fingerprint changes, the cached path set is wrong by definition and is recomputed before use.

### 5.4 Delivery surface 1: agent-facing

A bounded `## Other agents in this repo` block injected at spawn, at the same point in `startTask` where the constitution is assembled (`orchestrator.ts:1041-1049`), listing **peers only** and never the task itself.

*Illustrative only. Shapes the discussion; not an implementation to merge.*

```
## Other agents in this repo

These tasks are running now against the same repository. Their work is in
separate branches and worktrees, so you will not see their changes in your
files. Treat this as context, not instruction.

- [T-4f2a] "Rewrite the diff viewer" (claude-code, running)
  branch agetor/4f2a-rewrite-diff-viewer, base 6de003c
  declared: src/mainview/components/kanban/DiffDialog.tsx
  touched:  src/mainview/components/kanban/DiffDialog.tsx, src/mainview/lib/diff-selection.ts

- [T-91cc] "Add gemini effort mapping" (gemini, paused 12m)
  branch agetor/91cc-gemini-effort, base 6de003c
  declared: (none)
  touched:  src/bun/agents.ts
```

Rules on the block:

- **Char budget.** The block is truncated to a stated budget before it reaches the prompt, on the same discipline `pipeline-shared-memory.md` §4.1 applies to recall. Truncation drops whole peers from the tail, ordered by relevance: peers whose paths overlap this task's declared or touched paths first, then live peers, then stale ones. A half-rendered peer is never emitted.
- **Omit when empty.** Zero peers means no heading, no blank section, nothing (§1.2).
- **Never the full prompt.** A peer's intent is a bounded summary. Full prompts routinely carry pasted context that belongs to that task alone (§10).
- **Argv budget split.** For a `gemini` task the whole prompt rides in argv under `GEMINI_PROMPT_ARGV_MAX_BYTES = 4096` (`agents.ts:67`). The peer block, the checkpoint block from §7, and durable-knowledge recall share the leftover headroom in that fixed order of sacrifice: recall is dropped first, then the peer block, then the checkpoint, and the base prompt is never touched. When headroom reaches zero the blocks are simply absent. Injection is an enhancement and is never worth a spawn failure. See §9.

### 5.5 Delivery surface 2: operator-facing

An awareness view over the active tasks for a `repoKey`, described functionally per SPEC A-7. No mockups, no component names, no styling.

It must show: every live task for the repo, with its title, agent kind, stage or column, branch, intent summary, declared paths, touched paths, and its liveness state rendered as one of running, stalled since, paused, gate-parked, awaiting hand-back, or waiting on the operator. Overlapping path sets between two rows must be visually distinguishable from non-overlapping ones, because spotting the pair heading for the same file is the whole reason the view exists. Open conflict records (§6) appear against the pair they concern. Stale claims are shown with their age rather than hidden.

It must offer: opening any listed task, opening its diff, and closing a conflict record as handled. It offers no merge action and no way to edit another task's claim, since ownership of a task stays with that task.

Where it hangs: beside the two existing cross-task surfaces, `AttentionStrip.tsx` (which answers "who needs me") and `WorktreesDialog.tsx` backed by `listWorktrees` (`orchestrator.ts:4019`) (which answers "what working copies exist"). This view answers "who is doing what, and where do they collide", which neither covers. It should reuse the worktree dialog's data path rather than opening a second one.

---

## 6. Capability area B: conflict communication

Detection is deterministic and runs in the orchestrator. Communication reuses the transport that already delivers operator messages to a running agent. Nothing here decides a merge outcome; that stays with the existing flow and the operator (SPEC non-goal 8). Single-agent behavior is §1.2's rule: with zero peers no scan runs at all.

### 6.1 Conflict classes

| Class | Signal | Detection point in the workflow | Who is notified | Severity |
| --- | --- | --- | --- | --- |
| **C1** Overlapping intent to change the same code area | Path-set intersection between two live tasks on one `repoKey`, over declared paths (`BuildSubtask.files`) and observed touched paths (from `getTaskDiff`) | **Both up front and at integration.** Up front at every claim point: task start (after `prepareWorkdir` when the branch and base exist), build-plan parse (`parseBuildPlan`, `pipeline-prompts.ts:230`), and the first observed write to a path. Re-tested whenever either side's touched-path set changes, keyed on `treeFingerprintSync` | Both tasks, and the operator surface | high when both sides are live and the overlap includes a file both have already modified; medium when it rests on declared intent alone |
| **C2** Divergent lines of work that will not merge cleanly | Branch divergence against the shared base | Cheaply and continuously from the existing git primitives (`getAheadCount`, `worktree.ts:91`; `treeFingerprintSync`, `:357`) whenever a C1 overlap already exists; definitively at merge time through `mergeBranch` (`:682`) and the git-verified `isBranchMerged` (`:718`) | The task attempting the merge, and the operator | high at merge time (it is already blocking); medium as an early warning |
| **C3** Contradictory decisions recorded about the same subject | Two durable knowledge entries with the same normalized subject and incompatible conclusions | At capture time, against the set just recalled for that task. The candidate entry is compared with the entries already returned by recall for the same subject | The operator only. Neither agent is asked to arbitrate | medium |
| **C4** Stale claim | A declared intent whose owning task has had no active run past the claim window (§5.3), or whose task is finished, archived, or deleted | On the same tick that re-tests C1, and when a task settles or is archived | The operator, and the peer holding an open record that rests on the stale claim | low |
| **C5** Duplicate work | Two live tasks with materially the same intent and no path overlap yet: normalized-token overlap between the two intent summaries above a stated threshold | At task start, and when a task's prompt is edited | Both tasks, and the operator | low. It is advisory. A false positive here costs a sentence in a prompt, so the threshold is set to prefer silence |

C3 deserves one clarification, because it reaches into the durable store: the comparison is deterministic (same normalized subject, differing conclusion text) and it does **not** try to judge which entry is right. Deciding truth is a model judgement with no ground truth available at capture time. The record is opened, both entries stay in the store, and §12's curation surface is where a human resolves it by superseding one.

### 6.2 Notification volume bound

N live tasks can produce N-squared candidate pairs. The bound is structural, not a rate limit bolted on afterwards:

- **One open record per unordered task pair per class.** The record's identity is `(repoKey, min(taskA,taskB), max(taskA,taskB), class)`. A re-detection updates the existing record's evidence and counter; it does not open a second one and does not re-notify.
- **Notify once per record.** The first transition of a record to open sends the notice. Later evidence changes update the record silently and are visible on the operator surface. A second notice fires only if the record was closed and genuinely reopens.
- **Coalesce per recipient per delivery.** When a task has several open records at once, one notice carries all of them rather than one notice each.
- **Per-repo ceiling on open records**, above which new detections still record but stop notifying and the operator surface shows a "many overlaps" state. Past a certain density the right response is a human looking at the plan, not more messages into prompts.

The property this buys: notice volume is bounded by the number of *distinct* conflicting pairs, and each pair costs at most one interruption per agent.

### 6.3 AC-7 trace: C1 end to end

Task A (claude-code, `agetor/4f2a-rewrite-diff-viewer`) has touched `src/mainview/components/kanban/DiffDialog.tsx`. Task B (gemini, `agetor/91cc-gemini-effort`) declares the same file in its `BuildSubtask.files`. Both are live on the same `repoKey`.

**1. Who sends.**
The detector runs in the orchestrator, on behalf of the claiming task. It is not an agent judgement and no agent is asked to decide whether an overlap exists. Two reasons. First, the question "do these two path sets intersect" is same-input-same-output work, so it belongs in deterministic space; asking a model costs tokens, varies between runs, and cannot be inspected afterwards. Second, a detector that lives in an agent only fires when that agent happens to be running and happens to think of it, which is exactly when a conflict is least likely to be noticed. The orchestrator sees every task, so the scan is complete by construction. The notice is therefore attributed to agetor, quoting the peer's declared facts, not to Task A speaking as an author.

**2. What the message contains.**
The peer's task id and title; the overlapping paths, and for each one whether it is declared or already touched on each side; each side's branch; each side's base sha; what each side declared versus what it has actually touched, so the recipient can tell an intention from a fact; the timestamp of detection; and a stated expectation drawn from the bounded set in step 4.

*Illustrative only. Shapes the discussion; not an implementation to merge.*

```
## Overlap with another agent in this repo

Task T-4f2a "Rewrite the diff viewer" (claude-code, running) is working on
files you also declared. Its changes are on branch
agetor/4f2a-rewrite-diff-viewer (base 6de003c); yours are on
agetor/91cc-gemini-effort (base 6de003c). You will not see its edits in
your worktree.

Overlapping paths:
  src/mainview/components/kanban/DiffDialog.tsx
    T-4f2a: touched (modified)      you: declared (not yet touched)

Detected 2026-08-21T14:52:03Z.

What to do: continue if your change to this file is small and additive; or
narrow your scope and say so; or stop and hand back to the operator. Do not
attempt to merge or reconcile the other branch yourself.
```

**3. How a running recipient receives it without losing in-progress work.**
It rides the existing follow-up transport named in §3 (`sendInput`, `orchestrator.ts:2460`). No new delivery path is built.

- For `claude-code`, the notice folds into the live turn via `pasteFollowUp`, with `holdUntilIdle` set so the run does not settle on the intermediate `end_turn` between the current response and the reply. The turn stays `running` and resolves when claude goes quiet. This is the same mechanism an operator's mid-turn message already uses, and the reason it does not clobber in-progress work is that claude's REPL accepts a queued message rather than overwriting the current one.
- For `codex` and `gemini`, there is no live process between turns: each turn is a one-shot `codex exec` or `gemini -p` invocation. The notice enters the existing per-task queue (`drainCodexQueue` / `drainGeminiQueue`, called at `orchestrator.ts:1331-1332` and `:1391-1392`) and is delivered as the next resumed turn, carried by the thread id or session id. The stated consequence is a delivery latency of up to one turn. This is a property of the substrate, not a gap to close (SPEC A-8).

**The guard that must never be skipped:** a notice is never delivered while a native prompt or modal is pending for that task. The RunPanel's own `modalPending` rule exists for this reason (see `DiffDialog.tsx:548-571`, where `canSend` is gated on `!modalPending` and `send()` re-checks before firing): a keystroke reaching a live tmux modal lands in the modal's prompt rather than in the agent's conversation. A notice delivered into an open permission dialog would answer the dialog. The registry in `interactions.ts` is the authority on whether an interaction is pending, and the notice waits, or parks per step 5, until it clears.

**4. What the recipient is expected to do.**
A bounded, stated set, spelled out in the message so it is not left to invention:

- **Acknowledge and continue**, when the overlap is small or additive.
- **Narrow its own scope** and say so, so the claim shrinks and the record can close.
- **Stop and hand back to the operator**, when the overlap makes the task's plan wrong.

It is explicitly **not** asked to merge, rebase, pull the peer's branch, edit the peer's files, or decide whose approach wins. Automatic conflict resolution is out of scope (SPEC non-goal 8), and the existing merge flow (`mergeBranch`, `isBranchMerged`, `spawnMergeResolution`) stays the only path that touches integration.

**5. Non-response and not-running.**
Each case has its own outcome, and they are different.

| Case | Outcome |
| --- | --- |
| Recipient is not running now | The notice **parks durably** on the record and is delivered at the task's next spawn as a prompt block rather than as a mid-turn message. The precedent is `Task.backlog` (migration 025), which already parks an undeliverable message until it can be sent. |
| Recipient is mid-turn | Delivered by fold (claude-code) or queue (codex, gemini) per step 3. It is never dropped and never overwrites in-progress input. |
| Recipient has a pending interaction or modal | Held until the interaction resolves, then delivered. If the task settles first, it parks per the not-running case. |
| Recipient has finished or is archived | **No delivery.** The record resolves as `moot` and is surfaced only on the operator surface. Injecting a notice into an archived task's history would be noise nobody reads, and the archived freeze already rejects mutations. |
| Recipient was deleted | The record is **dropped with the task**, on the same teardown path that kills the session and removes the worktree (`deleteTask` → `removeWorktree`, `worktree.ts:1117`). A record referencing a task id that no longer exists is garbage, not evidence. |
| Nobody ever reads it | The record **ages out on a stated timer** and closes as `unacknowledged`. The operator surface is the backstop reader: an unacknowledged record stays listed with its age until a human closes it or it ages out. |

State it plainly: **`unacknowledged` is a normal terminal state, not an error.** An agent that finished its work without ever reading a low-severity overlap notice did nothing wrong, and nothing about that outcome should block a run, mark a task, or raise an alert. The measurable question is not "were notices acknowledged" but "did detected overlaps precede the merge conflicts that happened", which is §13's C1 signal.

---

## 7. Capability area C: agent state persistence and resumption

The gap §3 names: agetor recovers an agent's *conversation* and recovers nothing about its *reasoning*. `reconcileOrphans` (`orchestrator.ts:606`) reattaches a live session and replays the transcript, which is the right mechanism and is already built. What no mechanism carries is what the agent had finished, what it had decided, and what it was about to do next. This section defines a checkpoint that carries exactly that, and nothing else.

Single-agent behavior: checkpoints are per-task and involve no peers, so they function identically with one agent running. §1.2's rule applies to the awareness and conflict surfaces, not to this one; a solo agent still gets its own state back. That is the one place in this document where the single-agent case is not a no-op, and it is deliberate, because the SPEC user story ("as an agent resuming after a stall, a pause, or an app restart") does not mention peers.

### 7.1 What resumable working state consists of

*Illustrative only. Shapes the discussion; not an implementation to merge.*

```ts
interface Checkpoint {
  taskId: string;
  runId: string;              // the run that produced it
  capturedAt: number;
  baseSha: string;            // the base the work assumes (see §7.4)
  completedSteps: Array<{     // ordered, survives truncation first
    what: string;             // one line
    evidence: string;         // a file path, a test name, a command that passed
  }>;
  decisions: Array<{
    what: string;
    why: string;              // one line of rationale, not an essay
  }>;
  openItems: string[];
  nextAction: string | null;  // the single next intended step
  filesTouched: string[];     // created or modified so far
  hypothesis: string | null;  // the active theory, when debugging
  version: number;            // monotonic; §11's concurrent-write rule
}
```

Deliberately excluded, and each exclusion has a reason:

| Excluded | Why |
| --- | --- |
| Raw transcripts | Already persisted in `run_events` and already replayed by the reattach path. Duplicating them doubles the store and adds nothing on resume. |
| Tool output and command stdout | Volume with a poor ratio of signal to bytes, and it is what pushes a checkpoint past any injection budget. Evidence is a *reference* to the passing test, not its output. |
| Anything recoverable from the CLI's own session | When `reconcileOrphans` reattaches, the conversation is intact. The checkpoint's job is to cover the case where it is not. |
| Diff content | Path names are the coordination unit (§5, §10). The diff is available on demand from `getTaskDiff` (`worktree.ts:1035`). |
| Secrets, tokens, credentials, personal data | §10's prohibition, absolutely. |

### 7.2 Capture points

Every capture point is an existing choke point named in §3. No new lifecycle hook is introduced.

| Capture point | EXISTING hook | Why here |
| --- | --- | --- |
| Turn settle | The done handler that settles a run and moves the column | The most common boundary. What the agent just finished is freshest here. |
| Pipeline stage settle | `advancePipelineStage` (`orchestrator.ts:1844`) | The stage is about to hand off, and the next stage is a different prompt entirely. |
| Child build settle | `completeChildBuild` (`build-scheduler.ts:325`) | A child's work is about to be merged; what it did and did not finish matters to the parent. |
| Stall detected | The orchestrator's handler for `TURN_STALLED_STATUS_PREFIX`, which already marks `stall-registry.ts` | A stall is the case where nothing else will fire. Capturing here is what makes the "may be stuck" signal recoverable rather than merely informative. |
| Explicit pause | `pausePipelineTask` (`orchestrator.ts:3550`) | The operator is deliberately stopping. This is the cheapest, most reliable capture there is. |
| Quit path | The `before-quit` hook in `index.ts` that already broadcasts `quit_request` and waits for the QuitConfirmDialog | The app is going away with sessions still alive. Capturing before the window closes costs nothing and covers the restart case. |

**Writes are transactional or write-then-swap.** A checkpoint row is written in a single sqlite transaction, or staged and swapped atomically, so a crash mid-write leaves either the previous complete checkpoint or no checkpoint, never a half-record that reads as complete. This is the SPEC edge case about an agent crashing while writing its state, and it is answered by the write discipline rather than by a validator on the read side. A reader additionally treats a row whose `version` was never committed as absent.

**Capture is agent-authored through a sentinel, harvested deterministically.** The content is a judgement (what counts as a completed step, what the next action is), so it comes from the agent; the parsing, storage and truncation are deterministic. The channel is the existing sentinel convention (SPEC A-9), extending the `PIPELINE_VERDICT:` and `PIPELINE_MEMORY:` grammar with one more line kind:

*Illustrative only. Shapes the discussion; not an implementation to merge.*

```
AGENT_STATE: done=<one line> | evidence=<file, test, or command>
AGENT_STATE: decided=<one line> | because=<one line>
AGENT_STATE: open=<one line>
AGENT_STATE: next=<one line>
AGENT_STATE: hypothesis=<one line>
```

The parser is pure and dumb: malformed lines are dropped and never fatal, exactly as `parsePipelineVerdict` (`pipeline-prompts.ts:86`) and `parseBuildPlan` (`:230`) already behave. Where an agent emits nothing, the checkpoint still records the deterministic half (`filesTouched` from `getTaskDiff`, `baseSha`, `capturedAt`, `runId`), which is the same "a bug in latent space becomes a feature in deterministic space" split the bounce harvest uses.

### 7.3 Feed-back on resume

A bounded `## Your earlier state on this task` block, rendered into the resume prompt at the same injection point as everything else (`orchestrator.ts:1041-1049`).

**Truncation order is normative, because getting it wrong defeats the purpose:**

1. `completedSteps` with their evidence. **Never truncated before anything else.** This is the list that prevents repeated work, which is the entire measurable outcome in §13.
2. `nextAction`.
3. `openItems`.
4. `decisions` with rationale.
5. `hypothesis`.
6. `filesTouched`.

When the budget still does not fit after dropping 6 through 2, `completedSteps` is truncated **oldest-first with a stated count of what was dropped** ("14 earlier completed steps omitted"), so the agent knows the list is partial rather than believing it started at step 15. Narration is sacrificed before completed work, in every case. That is the SPEC edge case about state outgrowing what can be handed back.

### 7.4 The base-moved case

A checkpoint records the `baseSha` the work assumed. On resume, that value is compared against the task's current `baseRef` and the repo's HEAD (both already available: `baseRef` is pinned on the task row at create time, and `resolveRef`/`treeFingerprintSync` in `worktree.ts` read the rest).

When they differ, the injected block **says so, in the block**, rather than presenting stale conclusions as current:

> This state was written against base `6de003c`. The task's base is now `a0ab0d5`. Conclusions about code you did not change may be out of date. Re-check before relying on one.

The checkpoint is not discarded and not silently rewritten. Most of what it holds (what was completed, what was decided, what remains) survives a base move intact; what does not survive is any conclusion about code the agent did not touch. Marking it is honest and cheap. Deleting it would throw away the completed-steps list, which is the part that was worth keeping.

### 7.5 The three resume triggers are not the same

AC-8 names three, and they differ in what has survived. Blurring them is how a design ends up injecting a checkpoint into a conversation that already contains it.

| Trigger | What survived | Role of the checkpoint |
| --- | --- | --- |
| **After a stall** (`checkTurnStall`, `claude-tmux.ts:1422`) | The tmux session is usually still alive and the conversation is intact; the turn is wedged, not gone | Context for the *same* conversation. The block is delivered as a follow-up into the live session, not as a fresh spawn prompt. It reminds the agent what it had established before the wedge, and pairs with the scraped pane lines the stall sentinel already carries. |
| **After a pause** (`resumePipelineTask`, `orchestrator.ts:3567`) | The task's DB state; the session may or may not still exist | `resumePipelineTask` already spawns the next stage, so the checkpoint rides that spawn as a prompt block. This is the cheapest of the three: the pause was deliberate, so the checkpoint was captured cleanly at `pausePipelineTask`. |
| **After an app restart** (`reconcileOrphans`, `orchestrator.ts:606`) | Two sub-cases, and they are genuinely different. **Reattached**: the tmux session survived, the JSONL replays from offset 0, and the conversation is intact, so the checkpoint is **redundant but harmless** and is not injected. **Orphaned**: the session is gone, the run flipped to `orphaned` and the task went back to `ready` with `run_id=NULL`, so the conversation is unrecoverable and the checkpoint is **the only surviving context**. It is injected on the next spawn. | The reattach-versus-orphan split is the whole value of the distinction: injecting a checkpoint into a reattached conversation duplicates what the agent can already see, and *not* injecting one into an orphaned task loses everything. |

---

## 8. Store split and the placement rule

Two stores, both tables in the existing `agetor.sqlite`. No second datastore (§2.3).

| Store | Owns | Lifetime | Scope | Curated by | Deleted when |
| --- | --- | --- | --- | --- | --- |
| **Ephemeral working state** | Checkpoints (§7), awareness claims (§5), open conflict records (§6) | High churn. Overwritten or closed continuously | Task-scoped (claims, checkpoints) or pair-scoped (conflict records) | Nobody by default. The operator can delete any row from §12's browser | The task is deleted or archived; the record ages out; the checkpoint is superseded by a newer one for the same task |
| **Durable shared knowledge** | `memories`, exactly as specified in `pipeline-shared-memory.md` §5 | Low churn. Survives every task | Repo-scoped by `repoKey` | The operator, plus deterministic pruning and the agent `supersedes` path | Superseded and then pruned; evicted at the 500-row cap; hard-deleted by the operator |
| **Derived liveness** | Nothing. It is computed at read time from the run row, the tmux probe, and the existing derived flags | None | None | Not applicable | Not applicable. **This is the point**: a derived value cannot go stale independently of its source, so there is nothing to clean up and nothing to disagree with (§5.1) |

*Illustrative only. Shapes the discussion; not an implementation to merge.*

```sql
-- Ephemeral half. Three tables, one migration, numbered from 043 upward
-- (042_satisfied_subtasks.sql is the latest on disk).
CREATE TABLE agent_claims (
  task_id        TEXT PRIMARY KEY,
  repo_key       TEXT NOT NULL,
  intent         TEXT NOT NULL,      -- bounded summary, never the full prompt
  declared_paths TEXT NOT NULL,      -- JSON array
  touched_paths  TEXT NOT NULL,      -- JSON array, refreshed on fingerprint change
  base_sha       TEXT,
  fingerprint    TEXT,               -- treeFingerprintSync value the paths came from
  updated_at     TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE agent_checkpoints (
  task_id     TEXT PRIMARY KEY,      -- latest wins; write-then-swap (§7.2)
  run_id      TEXT,
  base_sha    TEXT,
  body        TEXT NOT NULL,         -- the parsed Checkpoint, JSON
  captured_at TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE conflict_records (
  repo_key    TEXT NOT NULL,
  task_a      TEXT NOT NULL,         -- min(taskA, taskB)
  task_b      TEXT NOT NULL,         -- max(taskA, taskB)
  class       TEXT NOT NULL,         -- C1 | C2 | C3 | C4 | C5
  state       TEXT NOT NULL,         -- open | acknowledged | moot | unacknowledged | closed
  evidence    TEXT NOT NULL,         -- JSON: overlapping paths, branches, bases
  opened_at   TEXT NOT NULL,
  notified_at TEXT,
  closed_at   TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (repo_key, task_a, task_b, class)
);
```

### 8.1 The placement rule

One sentence a builder can apply without judgement:

> **Would this fact still be true and useful to a *different* task in this repo a month from now?** Yes goes to durable knowledge. No goes to ephemeral working state.

The two clauses both matter. "Still true" excludes anything about a task's current position. "Useful to a different task" excludes anything whose only reader is the task that wrote it.

Worked examples, including the two that read the wrong way at first glance:

| Fact | Placement | Why |
| --- | --- | --- |
| "Tests in this repo fail unless `AGETOR_DATA_DIR` points at a temp dir" | Durable | True next month, and every future task that runs `bun test` needs it. |
| "`electrobun/bun` transitively imports `three`, so `src/types/three.d.ts` must stay" | Durable | A repo trap that outlives every task that hits it. |
| "Decided to reuse `sendInput` rather than add a delivery path" | Durable | A decision with rationale that a later task would otherwise re-litigate. |
| "Completed steps 1 to 6 of the diff-viewer rewrite" | Ephemeral | Only its own task can use it, and it is meaningless once the task lands. |
| "Task T-4f2a and T-91cc both touch `DiffDialog.tsx`" | Ephemeral | Both tasks will be gone next month and the statement will be false. |
| **"A peer's current branch is `agetor/4f2a-rewrite-diff-viewer`"** | **Ephemeral**, despite looking durable | It is a stable-looking string, so it reads like a fact about the repo. It is a fact about a task that will be deleted, and its worktree torn down, and the branch itself removed by `removeWorktree` (`worktree.ts:1117`). Storing it durably guarantees a store full of dead branch names. |
| **"The stall watchdog needs two threshold windows to clear after a long tool call, so a quick re-run looks stalled"** | **Durable**, despite looking ephemeral | It was learned while debugging one task's stall, in the middle of ephemeral work, which is why it reads as ephemeral. The statement is about the repo's behavior, is true next month, and is exactly the trap the next agent would otherwise burn a turn rediscovering. |

The second pair is the practical test of the rule. Ask what the sentence is *about*, not what the agent was doing when it learned it.

---

## 9. Agent-kind coverage matrix

Every mechanism proposed anywhere in this document gets a row. The three kinds are `claude-code`, `codex` and `gemini` (SPEC A-8). The fallback column is what happens for a kind that cannot do the thing in the main column, and it is never blank.

| Mechanism | `claude-code` | `codex` | `gemini` | Fallback for kinds that cannot |
| --- | --- | --- | --- | --- |
| Awareness prompt injection (§5.4) | Full block at spawn, prompt delivered as keystrokes into the tmux REPL, so budget is generous | Full block at spawn, prompt delivered via a stdin file redirect, so no argv cap applies | **Budgeted.** The whole prompt rides in argv under `GEMINI_PROMPT_ARGV_MAX_BYTES = 4096` (`agents.ts:67`), and `buildCommand` throws above it rather than guessing at a stdin path | Gemini: shrink to the remaining headroom, then omit. Sacrifice order across the three injected blocks is fixed: durable-knowledge recall first, then the peer block, then the checkpoint. The base prompt is never truncated. Injection is an enhancement and never worth a spawn failure |
| Awareness operator view (§5.5) | Identical | Identical | Identical | None needed. It reads task rows and derived liveness, none of which is kind-specific |
| C1 notice delivery, mid-turn (§6.3 step 3) | **Folds into the live turn** via `pasteFollowUp` with `holdUntilIdle`, so the run does not settle on the intermediate `end_turn` | **Not possible mid-turn.** Each turn is a one-shot `codex exec`; there is no live process between turns | **Not possible mid-turn.** Each turn is a one-shot `gemini -p`; same structure | Codex and gemini: the existing per-task queue (`drainCodexQueue` / `drainGeminiQueue`, `orchestrator.ts:1331-1332`), delivered as the next resumed turn via the thread id or session id. **Stated consequence: delivery latency of up to one turn.** This asymmetry is a known property of the substrate, not an open question (SPEC A-8) |
| C1 notice delivery, not running (§6.3 step 5) | Parks on the record, injected at next spawn | Identical | Identical, subject to the argv budget above | Gemini past budget: the notice stays parked and stays visible on the operator surface rather than being injected |
| Pending-modal guard on delivery | `interactions.ts` registry; a notice never reaches a live tmux modal | Same registry | Same registry | None needed. The guard is orchestrator-side and kind-independent |
| C2 detection (§6.1) | Identical | Identical | Identical | None needed. `getAheadCount`, `treeFingerprintSync`, `mergeBranch` and `isBranchMerged` are git calls on a worktree, with no agent involvement |
| C3 detection (§6.1) | Identical | Identical | Identical | None needed. It compares stored knowledge rows at capture time |
| C4 stale-claim expiry, C5 duplicate-work detection | Identical | Identical | Identical | None needed. Both are deterministic scans over `agent_claims` |
| Checkpoint capture, deterministic half (§7.2) | Identical | Identical | Identical | None needed. `filesTouched`, `baseSha`, `capturedAt`, `runId` come from git and the run row |
| Checkpoint capture, agent-authored half (`AGENT_STATE:` sentinel) | Parsed from assistant events in the main stream | Parsed from the mapped `assistant` events out of codex's `--json` NDJSON log | Parsed from the mapped `assistant` events out of gemini's `stream-json` NDJSON log | None needed for the sentinel itself: it is plain text in an assistant message, and all three kinds emit an `assistant` stream. Where an agent emits no sentinel, the deterministic half stands alone |
| Checkpoint feed-back on resume (§7.3) | Injected at spawn, or delivered as a follow-up into the live session after a stall | Injected at spawn of the next turn | Injected at spawn, subject to the argv budget | Gemini past budget: the block truncates by §7.3's order and, at zero headroom, is omitted. Codex and gemini after a stall: there is no live session to deliver into, so the block waits for the next spawn |
| Any mechanism reading the agent's reasoning traces | Available: claude emits a `thinking` stream | Available: codex emits a `thinking` stream | **Not available.** Gemini emits no `thinking` stream. Reasoning traces exist in its on-disk checkpoint transcript but never appear in `stream-json` stdout | Gemini: fall back to the `assistant` stream plus the deterministic half. **No mechanism in this document depends on reasoning traces**, precisely so that this gap costs nothing. The row exists to prove the dependency was checked, per SPEC non-goal 7 |
| Agent self-reported plan state (`todo-progress.ts`) | Available (claude's `TodoWrite` snapshots), but webview-side only | Not emitted | Not emitted | All kinds: the `AGENT_STATE:` sentinel is the checkpoint source. `todo-progress.ts` is a corroborating signal for claude tasks and is never the source of truth. This is why §3 marks it claude-only and UI-side |
| Agent-facing reads and writes, generally | Sentinel and prompt injection | Sentinel and prompt injection | Sentinel and prompt injection | None. **No MCP tool is proposed**, per SPEC A-9: sentinels work identically for all three kinds, agetor's `ask_user` MCP server is stripped by the hook installer, and this ticket's own Clarify run confirmed empirically that `ask_user` was not callable. An MCP surface would work for none of the three today |
| Background subagents and tracked background shells | **Excluded** | **Excluded** (not applicable) | **Excluded** (not applicable) | Not participants. Their streams are read-only, they own no branch and no worktree, so they have nothing to claim, nothing to overlap, and no way to act on a notice. Stated here rather than left implied (SPEC A-8) |

---

## 10. Trust boundary, scoping, and prohibited content

### 10.1 Three lists

**Visible to peers** (an agent may see this about another task, and the operator sees all of it):

Task id, title, agent kind, harness id, model, mode, effort, project, `parentTaskId`, `planSubtaskId`, a bounded intent summary, `pipelineStage`, `column`, `revisionCount`, `blockReason`, `repoKey`, `workdir`, `worktreePath`, `branch`, `baseRef` and its sha, declared paths, observed touched **path names**, ahead count, run status, run `origin`, tmux session presence, last-event timestamp, `stalledSince`, `pausedAt`, `gateParked`, `awaitingHandBack`, `pendingInteractionCount`, and open conflict records naming the pair.

**Private to a single run** (never leaves the task, never enters a peer's prompt):

The full `Task.prompt` and any context pasted into it; the run's transcript and `run_events`; tool inputs and outputs; diff *content* (as opposed to path names); the agent's `thinking` stream where one exists; `Task.backlog` drafts; pending interaction payloads; and the checkpoint body, which belongs to its own task and is fed back only to that task.

The line between the two is drawn at **names, not contents**. A peer learning that `DiffDialog.tsx` is being edited is the point of §5. A peer receiving the contents of that edit is a leak with no coordination value and an unbounded budget cost.

**Never recorded anywhere shared:**

Secrets, API keys, tokens, passwords, credentials, private keys, connection strings with embedded credentials, and personal data. The rule is the one this repo already applies to fleet knowledge entries and that `pipeline-shared-memory.md` §4.3 already imposes on `PIPELINE_MEMORY:` lines: **names and purposes only, never values.** "Set `ANTHROPIC_API_KEY` in `.env`; the search pipeline reads it" is fine. The key itself is not.

**The parser stays dumb, so the prohibition is prompt-side and curation-side.** No regex tries to detect a secret before storing it. That is the same trust model `pipelineFeedback` already operates under, storing verbatim agent text, and it is a deliberate choice: a detector that catches most secrets encourages treating the store as sanitized, which is worse than knowing it is not. The three real controls are the instruction in the prompt, the operator's ability to inspect and delete any entry (§12), and the fact that every row stays in a local sqlite file that never leaves the machine. This is the SPEC edge case about secrets appearing in an agent's output, answered honestly rather than optimistically.

### 10.2 Scoping (AC-17)

**Same repository is decided by `repoKey`**: the canonical `origin` remote URL (protocol, credentials and `.git` suffix stripped, host lowercased, reusing the host normalization the git-host discovery code already performs), falling back to the resolved absolute `workdir` when there is no remote. It is computed once at `createTask` and persisted on the task row, which is what makes worktrees, re-runs and build children of one repo share a key without re-deriving it against a `workdir` that may have moved. This is `pipeline-shared-memory.md` §4.5's rule, extended to every task per §4.

**Different repositories never coordinate.** No awareness row, no conflict record, and no knowledge entry crosses a `repoKey`. The blast radius of a wrong entry is therefore one repository (§12).

**Coordination is confined to one machine.** The agents that see each other are the ones recorded in one `$AGETOR_DATA_DIR/agetor.sqlite`. Cross-machine coordination is outside the design boundary and is repeated as a rejected alternative in §16.

**The dev-versus-release store split is a known limitation, not a bug to fix.** `bun run dev` sets `AGETOR_DATA_DIR=$HOME/.agetor-dev` while the packaged app defaults to `~/.agetor`, deliberately, so an in-progress migration cannot poison the release build's state. The consequence, stated so it is not rediscovered: **two agetor instances working on the same repository through the two data dirs cannot see each other.** Operator-visible symptom: the awareness view in one instance shows no peers while the other instance is plainly running tasks on the same files, and no overlap is ever detected between them. Per SPEC A-6 the split is not unified.

**One repository reached through different working directories** is the case `repoKey` normalization exists to solve, and it solves most of it: two worktrees, a re-run, and a build child all resolve to the same canonical `origin` URL. Where it fails, and what the operator sees:

| Failure | What happens | What the operator sees |
| --- | --- | --- |
| No `origin` remote at all (a purely local repo) | The key falls back to the resolved absolute `workdir` | Two clones of the same local repo at different paths get different keys and never coordinate. The awareness view shows no peers in either. |
| Two clones of the same remote at different paths | Both resolve to the same canonical remote URL, so they **do** share a key | Correct coordination, with one caveat: path-based overlap (C1) compares repo-relative paths, so it works, while any absolute-path display shows two different roots. |
| `origin` renamed or repointed after `createTask` | The persisted key is not recomputed, by design | An existing task keeps coordinating under its original key. A task created afterwards gets the new key and does not see it. The symptom is a peer that "should" be visible and is not. |
| Different remotes for the same logical project (a fork) | Different keys | No coordination between fork and upstream working copies. This is the intended behavior, not a defect. |

---

## 11. Failure modes and degraded behavior

> **A failure of the shared-state layer never blocks, stalls, or corrupts an agent run.** Every read is best-effort and yields nothing on failure. Every write is fail-open: logged and swallowed. The observable result of a total outage of everything in this document is that agetor behaves exactly as it does today.

That is the section's normative sentence and it governs every row below. It is a pattern already used in this repo rather than one invented here: `pipeline-shared-memory.md` §4.2 makes the bounce harvest fail-open for the same reason, `startTask` proceeds without a constitution when the file read throws (`orchestrator.ts:1045`), `prepareWorkdir` falls back to running in `workdir` when isolation cannot be established, `removeWorktree` is explicitly best-effort and never blocks a delete, and `hasUncommittedChanges` returns `null` rather than throwing when git cannot answer. Coordination joins that list.

Every store proposed anywhere in this document appears here.

| Store or mechanism | Failure mode | Detection | Degraded behavior |
| --- | --- | --- | --- |
| `agent_claims` (§8) | Unavailable (DB open fails, table missing before migration) | The query throws | Peer list is empty, so §1.2's zero-peer path runs: no block injected, no scan. Identical to today |
| `agent_claims` | Slow | Query exceeds a read deadline on the spawn path | Abandon the read and spawn without the block. A spawn never waits on coordination |
| `agent_claims` | Corrupt row (unparseable JSON in a path array) | Parse failure on read | Drop that peer from the list, keep the rest. One bad row never empties the view |
| `agent_claims` | Locked (sqlite busy under WAL) | Busy timeout | Skip the write, keep the previous claim, which is stale but valid and marked stale by §5.3's rule |
| `agent_claims` | Over quota (unbounded touched-path arrays on a large refactor) | Row size past a cap | Truncate the path list with a recorded "truncated" flag. Overlap tests treat a truncated set as evidence, never as a complete set, so C1 stays advisory for that pair |
| `agent_claims` | Concurrently written | Two tasks updating their own rows | Not a conflict: the primary key is `task_id` and each task writes only its own row |
| `agent_checkpoints` (§8) | Unavailable | Read or write throws | Resume proceeds with no checkpoint block, exactly as agetor behaves today. `reconcileOrphans` is unaffected because it does not consult this table |
| `agent_checkpoints` | Slow | Deadline on the settle path | Skip the capture. A missed checkpoint costs context on a resume that may never happen; a blocked settle costs a stuck run. The trade is not close |
| `agent_checkpoints` | Corrupt or half-written | The write-then-swap discipline in §7.2 means a half-record is never visible; a body that fails to parse is caught on read | Treat as absent. **A partially written checkpoint must never read as complete**, which is why the write is transactional rather than validated afterwards |
| `agent_checkpoints` | Locked | Busy timeout | Skip the capture; the previous checkpoint stands and is older, which §7.4's base comparison already surfaces |
| `agent_checkpoints` | Over quota (checkpoint grows past a row cap) | Size check before write | Truncate by §7.3's order, completed steps last, and record the dropped count |
| `agent_checkpoints` | Concurrently written | Two writers for one `task_id`, for example a stall capture racing a turn settle | Last writer wins on the monotonic `version` counter (see below) |
| `conflict_records` (§8) | Unavailable | Query throws | No detection, no notices. Merges behave exactly as they do today, which is where conflicts surface without this layer |
| `conflict_records` | Slow | Deadline on the detection tick | Skip the tick. Detection is periodic and idempotent, so the next tick re-derives the same state from claims |
| `conflict_records` | Corrupt evidence blob | Parse failure | Close the record as `moot` and let the next tick re-open it from live claims. Records are derived, so they are cheap to rebuild |
| `conflict_records` | Locked | Busy timeout | Skip; next tick |
| `conflict_records` | Over quota (many pairs) | Per-repo open-record ceiling from §6.2 | Stop notifying, keep recording, show the "many overlaps" state on the operator surface |
| `conflict_records` | Concurrently written | Two detectors racing the same pair | The unordered-pair primary key makes the second insert a no-op update. Version counter resolves the evidence |
| `memories` (durable, from `pipeline-shared-memory.md`) | Unavailable, slow, corrupt, locked | Query throws or exceeds the deadline | Recall returns nothing and the `## Relevant memories` section is omitted, which is already that design's specified behavior. Capture is already fail-open there |
| `memories` | Over quota | The 500-row per-repo cap | `pruneMemories` evicts superseded rows first, then lowest usage, oldest first. Already specified |
| `memories` | Concurrently written | Two tasks capturing at once | Same rule as below |
| Derived liveness (§5.1) | tmux probe fails or hangs | Non-zero exit or a probe deadline | Treat presence as unknown and render it as unknown, never as dead. Falsely reporting a live agent as dead is the one error that would make peers act wrongly. Note this store has no persistence to fail: there is nothing to corrupt |
| Prompt injection (§5.4, §7.3) | The assembled block exceeds the budget, or gemini's argv ceiling | Byte count before spawn | Truncate by the stated order, then omit. **A spawn never fails because of an injected block** |
| Notice delivery (§6.3) | The target session died between queueing and delivery | The existing death watch (`startDeathWatch`, `claude-tmux.ts:4260`) | Park the notice on the record; it is delivered at the next spawn. The record stays open |
| Sentinel parsing (`AGENT_STATE:`) | Malformed or absent lines | Pure parser | Drop the line, keep the rest, never fatal. Same discipline as `parsePipelineVerdict` and `parseBuildPlan` |
| Optional fleet adapter (§2.3) | Hosted service unreachable, slow, or rate-limited | Request failure or timeout | Mirror outward is skipped and logged. **It is never read on any path that a run depends on**, which is the whole reason it is an adapter and not the mechanism |

### 11.1 Concurrent writes, ordering, and clocks

The SPEC edge case: two agents write the same shared entry at the same time, with no guarantee about ordering or agreement on clock time between them.

**Rule: last-writer-wins on a monotonic per-row `version` counter, incremented inside the same transaction as the write. Wall-clock time is never used to order two writes from different agents.**

Three reasons the counter beats timestamps here. First, all writers are processes on one machine writing to one sqlite file, so a compare-and-set on an integer is exact and cheap, while timestamps from different agent processes carry no ordering guarantee worth relying on. Second, sqlite's own transaction serialization under WAL already gives a total order for the writes that matter; the counter simply makes that order readable. Third, a version counter is what the reference project already carries on its node schema (`version`, `main.py:45`), so this reuses its shape rather than inventing one.

Timestamps are still recorded, because "how old is this" is what §5.3 and §12 need to render. They are used for **display and expiry**, never for **conflict ordering**. The distinction is the point: an entry can be shown as "12 minutes old" without any claim that it was written before or after another agent's entry.

For `memories`, the durable case, a genuine same-subject collision is not silently resolved at all: it opens a C3 record (§6.1) and both entries stay in the store until a human supersedes one. Auto-picking a winner between two contradictory findings is exactly what §2.1 rejects the reference's five conflict-resolution strategies for.

---

## 12. Correction, staleness, and human curation

Wrong shared state is worse than no shared state, because a false entry gets injected into later prompts with the same authority as a true one. Correction is therefore a first-class path, not an afterthought.

| State is | Durable knowledge (`memories`) | Ephemeral working state |
| --- | --- | --- |
| **Wrong** | An agent writes a `supersedes` entry (the correction path already specified in `pipeline-shared-memory.md` §4.3): the old row stays for audit and drops out of recall. The operator can also hard-delete it | The operator deletes the row. A wrong checkpoint is deleted, not corrected, because its author is gone and nobody else can restate it faithfully |
| **Stale** | Handled by usage-based pruning: low `retrieved_count` and `reinforced_count`, oldest first, at the 500-row cap | Claims expire by the §5.3 window and stop counting for overlap. Conflict records age out and close as `unacknowledged`. Checkpoints are superseded by the next capture for the same task, and a checkpoint written against a moved base is marked, not deleted (§7.4) |
| **Superseded** | The supersede chain is the history. The superseding entry is the one recall returns | Not applicable in the same sense: the latest row *is* the state. There is one claim and one checkpoint per task |
| **Deleted** | Hard delete through the curation surface, which also removes it from the FTS index | Hard delete, and automatic teardown with the task: `deleteTask` removes claims, checkpoints, and every conflict record naming the task, on the same path that kills the session and tears down the worktree |

### 12.1 Blast radius of a wrong entry

Stated concretely, because "we have a correction path" is not an answer on its own:

- **Which prompts could carry it.** A wrong durable entry can reach any task in the same `repoKey` whose recall query matches it, at any spawn, from the moment it is written until it is superseded, deleted, or pruned. Never a task in another repository (§10.2), and never another machine (§1.1). A wrong ephemeral entry reaches strictly less: a wrong claim reaches only peers of that one repo while the task is live, and a wrong checkpoint reaches only its own task.
- **Over what window.** Until corrected. There is no automatic expiry for a durable entry that keeps getting retrieved; being retrieved is what protects it from pruning, so a wrong entry that reads plausibly is the one most likely to survive. That is the honest risk, and it is the reason the curation surface exists rather than a "confidence score" that would just launder the same problem.
- **How the operator finds it after the fact.** Every entry carries its source task id and source run id. Given a task that behaved oddly, the operator can list what was injected into it; given a suspect entry, the operator can list which tasks retrieved it, because recall already bumps `retrieved_count` and `last_retrieved_at` per row. Both directions are one sqlite query.

### 12.2 The human-facing surface

Described functionally per SPEC A-7. No mockups, no component names, no styling.

A **shared-state browser** covering both stores in one place, since the operator's question is "what does agetor believe about this repo", not "which table is it in".

It must show, per entry: the body, the kind (durable knowledge, claim, checkpoint, conflict record), the source task and run, the age, and for durable entries the usage counts and any supersede relationship. It must be searchable and filterable by repo and by kind. Conflict records must show the pair they concern, their class, and their state.

It must offer, per entry: inspect, edit, and delete. Plus one action specific to conflict records: **close the record as handled**, which is the operator acting as the backstop reader §6.3 step 5 relies on.

Where it hangs: it extends the memory browser dialog already sketched in `pipeline-shared-memory.md` §4.6 rather than adding a second dialog beside it. That document's version covered `memories` only; this one adds the ephemeral kinds and the conflict-record close action.

Deliberately thin. A browser, not an editor suite. The operator's job here is to delete what is wrong, not to author shared state by hand.
