import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";import { db, tasks, runs, harnesses, projects, subagents, backlog, dataDir } from "./db.ts";
import { spawnAgent, toClaudeModelArg, claudeModelPickerFamily, pipelineToolset, leanContextEnabled, type LeanContext, type SpawnAgentArgs, type SpawnedAgent } from "./agents.ts";
import { checkHarness } from "./agent-status.ts";
import { getDiscoveredEfforts } from "./agent-discovery.ts";
import { resolveClaudePlan, upsertClaudePlanFromExitPlanMode, upsertDetectedPlan } from "./task-plans.ts";
import { deriveTodoProgress, summarizeTodoProgress } from "../shared/todo-progress.ts";
import { ISSUE_SNAPSHOT_FILENAME, normalizeIssueUrl, parseIssueUrl } from "../shared/issue-task.ts";
import { providerRepoForDir } from "./git-provider.ts";
import {
  AGENT_OPTIONS,
  DEFAULT_BRANCH_CONFIG,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TASK_TYPE,
  IDLE_SESSION_REAP_MS,
  SESSION_DIED_STATUS_PREFIX,
  TASK_TYPES,
  branchPattern,
  renderBranchTemplate,
  retainableEfforts,
  supportedEfforts,
  validateBranchName,
  type AgentKind,
  type Harness,
  type TaskType,
} from "../shared/types.ts";

/**
 * Resolve a task's harness id to its full row (falling back to a synthetic
 * built-in via `getByIdOrKind` so legacy `"claude-code"` / `"codex"` rows
 * still work even before the migration seed lands). Returns null for
 * dangling alias references — callers must surface a clear error rather
 * than silently picking a kind.
 */
function resolveHarness(harnessId: string): Harness | null {
  return harnesses.getByIdOrKind(harnessId);
}
import {
  cancelPendingForTask,
  countPendingForTask,
  setBroadcaster,
  setResolvedBroadcaster,
  type AnyRequest,
  type InteractionResolved,
} from "./interactions.ts";
import {
  CLAUDE_API_ERROR_STATUS_PREFIX,
  CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX,
  cycleToMode,
  type CycleResult,
  type ContinuationHooks,
  dropSession,
  killSessionByName,
  reattachSession,
  pasteFollowUp,
  sendTurn,
  mirrorModelViaPicker,
  getSessionLaunchEffort,
  hasSessionState,
  sessionExists,
  sessionExistsByName,
  sessionIdleInfo,
  sessionLiveness,
  sessionNameFor,
  probeSessionActivity,
  jsonlPathFor,
  interruptTaskSession,
  setContinuationRunFactory,
  setHeldSessionProbe,
  setActiveRunProbe,
  setBackgroundTaskSettledHandler,
  setLocalSettingChangedHandler,
  type LocalSettingInfo,
} from "./claude-tmux.ts";
import {
  parseClaudeLocalSetting,
  describeLocalSettingSync,
  describeUnrepresentableLocalSetting,
  describeKeptModelNotSynced,
} from "./claude-local-setting.ts";
import {
  dropCodexSession,
  reattachCodexSession,
} from "./codex-tmux.ts";
import {
  dropCursorSession,
  reattachCursorSession,
} from "./cursor-tmux.ts";
import {
  dropGeminiSession,
  reattachGeminiSession,
} from "./gemini-tmux.ts";
import {  dropFxSession,
} from "./fx-acp.ts";
import {
  attachSubagentWatcher,
  handleBackgroundTaskNotification,
  orphanRunningSubagents,
  pumpWatcherForHoldCheck,
  setParkedDiscoveryHandler,  setSubagentEmitter,
  setSubagentSettleHook,
} from "./claude-subagents.ts";
import {
  prepareWorkdir,
  removeWorktree,
  detachWorktree,
  repoRoot,
  resolveRef,
  branchName,
  ensureUniqueBranch,
  fetchBranch,
  WORKTREES_DIR,
  parseWorktreeGitPointer,
  pruneWorktrees,
  hasUncommittedChanges,
  getAheadCount,
  isMergedIntoDefaultBranch,
  mergeBranch,
  abortMerge,
  isBranchMerged,
  treeFingerprintSync,
} from "./worktree.ts";
import { killTerminalsForTask } from "./terminals.ts";
import { ensureInstalledForCwd } from "./hook-installer.ts";
import {
  PIPELINE_SPEC_FILE,
  PIPELINE_PLAN_FILE,
  PIPELINE_TASKS_FILE,
  PIPELINE_CONSTITUTION_FILE,
  parsePipelineVerdict,
  parseSpecAcceptanceCriteria,
  analyzeCoverage,
  parseBuildPlan,
  mergeResolutionPrompt,
  stagePrompt,
  buildPlanWarnings,
  appendPromptExtras,
  type StageExtras,
  type PlanReviewVerdict,
  type TestingVerdict,
} from "./pipeline-prompts.ts";
import { tickBuild, completeChildBuild, buildBarrierState } from "./build-scheduler.ts";
import { markStalled, clearStalled } from "./stall-registry.ts";
import type {
  BlockReason,
  ColumnId,
  GlobalEvent,
  RunEvent,
  RunStatus,
  SentFileEntry,
  Task,
  WorktreeGitStatus,
  WorktreeInfo,
  WorktreeStaleReason,
  WorktreeTeardownResult,
} from "../shared/types.ts";
import {
  WORKTREE_STALE_AFTER_MS,
  PIPELINE_REVISION_CAP,
  PIPELINE_STAGE_COLUMNS,
  isActiveColumn,
  TURN_STALLED_STATUS_PREFIX,
  TURN_STALL_RESUMED_STATUS_PREFIX,
} from "../shared/types.ts";
import {
  SENT_FILES_DELIVERED_RE,
  parseSentFilesToolResult,
  parseSentFilesToolUse,
  sanitizeToolResultAttachments,
  toolResultText,
  type SentFilesRequest,
} from "../shared/sent-files.ts";
import { appendReferences } from "../shared/refs.ts";
import { promptByteOverage } from "../shared/prompt-limits.ts";
import { expandAtReferencesDetailed } from "./project-files.ts";
import { pipelineState, type PrecheckSummary } from "./pipeline-state.ts";
import { readRepoProfile, renderProjectCommands, ensureDependenciesInstalled } from "./repo-profile.ts";
import { extractHandoff, renderHandoff } from "./stage-handoff.ts";
import { writeReviewDiff, removeReviewDiff } from "./review-diff.ts";
import { runPipelinePrecheck, precheckPasses, precheckEnabled, testerSkipEnabled, precheckPassedChecks } from "./pipeline-precheck.ts";
import { filterClaudeMdForPipeline } from "./claude-md-filter.ts";

type Listener = (e: RunEvent) => void;
const listeners = new Set<Listener>();

type GlobalListener = (e: GlobalEvent) => void;
const globalListeners = new Set<GlobalListener>();

interface ActiveRun {
  taskId: string;
  agent: Task["agent"];
  kill: () => void;
  cancelled: boolean;
  /**
   * Send a follow-up user message. For claude-code this routes through tmux
   * (paste-buffer + Enter) and creates a brand-new run row in `sendInput`.
   * For codex it writes to the spawned process's stdin and stays within the
   * same run row.
   */
  writeInput: (line: string) => boolean;
  /** Set when claude code emitted an `isApiErrorMessage` line during this
   *  run (e.g. 529 Overloaded). The chunk handler flips the column to
   *  `blocked` immediately; the done handler reads this on resolution to
   *  keep the column at `blocked` (instead of bouncing to `ready`) and
   *  record the run as `failed`. */
  apiError: boolean;
  /** Set when the run's tmux session died unexpectedly mid-turn (the driver
   *  emitted the `SESSION_DIED_STATUS_PREFIX` sentinel). Like `apiError`, the
   *  chunk handler flips the column to `blocked` immediately and the done
   *  handler reads this on resolution to keep it there (record the run as
   *  `failed`, not bounce to `ready`). */
  sessionDied: boolean;
  /** Set when claude's TUI rejected the pasted message as an unknown slash
   *  command (the driver emitted the `CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX`
   *  sentinel — no JSONL line was ever written for that turn). Like
   *  `apiError`/`sessionDied`, the chunk handler flips the column to
   *  `blocked` immediately and the done handler reads this on resolution to
   *  keep it there (record the run as `failed`, not bounce to `ready`). */
  unknownCommand: boolean;
}
const active = new Map<string, ActiveRun>(); // runId -> handle

// Guards `reapIdleSessions` against overlapping sweeps — the boot one-shot
// and the recurring `setInterval` in index.ts could otherwise both be
// in-flight if a sweep ever ran long (many candidate tasks, a slow tmux
// probe). A simple boolean is enough: sweeps are infrequent (every
// `SESSION_REAP_SWEEP_MS`) and idempotent, so skipping one entirely when
// another is still running just means its candidates get picked up next tick.
let reapInFlight = false;

// Archive/delete teardown (tmux session kill, terminal teardown, worktree
// detach/remove) is deferred onto a per-source-workdir FIFO queue so
// `archiveTask` can flip the DB column and respond in milliseconds instead of
// blocking on tmux kills (async `Bun.spawn` since the fix-task-details-load-
// delay conversion, but still real wall-clock latency, not free) and `git
// worktree remove --force`/`prune`. The serialization is deliberate, not
// incidental: concurrent `git
// worktree remove`/`prune` invocations against the SAME source repo contend
// on git's internal locks (`.git/worktrees/.lock` etc.), so archiving several
// tasks that share a workdir must still tear them down one at a time — just
// not on the request's critical path. Tasks in *different* source repos have
// no such lock contention, so they get independent chains and never wait on
// each other — a big worktree removal for repo A must not stall a DELETE in
// unrelated repo B. `teardownTails` keys the chain by `task.workdir` (the raw
// string, not a resolved repo root — two tasks pointed at different subdirs
// of the same repo would therefore get separate chains and could still
// contend on git's locks; accepted as rare, and best-effort teardown plus the
// boot sweep heal any resulting strand). `teardowns` is unchanged: it lets
// callers (unarchive/start/delete, plus the boot-time sweep) await a specific
// task's in-flight teardown before touching the same worktree, keyed by task
// id as before — this still works under per-workdir chains because a task's
// workdir can't change while a teardown is pending (archived tasks are
// PATCH-frozen, and every materializing path awaits `pendingTeardown` first).
const teardownTails = new Map<string, Promise<void>>();
const teardowns = new Map<string, Promise<void>>();

/**
 * Chain `job` onto the teardown FIFO for `key` (the task's source `workdir`)
 * and track it per-task so `pendingTeardown` can be awaited by callers that
 * must not race a deferred teardown (unarchive, start, delete, the orphan
 * sweep). Errors from `job` are caught and logged — a single misbehaving
 * teardown must never break the chain for every task queued behind it on the
 * same workdir.
 */
function enqueueTeardown(taskId: string, key: string, job: () => Promise<void>): Promise<void> {
  const tail = teardownTails.get(key) ?? Promise.resolve();
  const p = tail
    .then(job)
    .catch((err) => {
      console.warn(`[agetor] deferred teardown failed for task ${taskId}:`, err);
    });
  teardownTails.set(key, p);
  p.finally(() => {
    // Only clear the entry if it's still the current tail for this key — a
    // later enqueue for the same workdir must not have its chain slot
    // clobbered by this settle, and this also bounds the map's size (an idle
    // workdir's entry is removed once its chain drains).
    if (teardownTails.get(key) === p) teardownTails.delete(key);
  });
  teardowns.set(taskId, p);
  p.finally(() => {
    // Only clear the entry if it's still ours — a later enqueue for the same
    // task (e.g. delete right after archive) must not have its promise
    // clobbered by this settle.
    if (teardowns.get(taskId) === p) teardowns.delete(taskId);
  });
  return p;
}

/**
 * Await any deferred teardown currently in flight (or queued) for `taskId`.
 * Resolves immediately when nothing is pending. Exported so `unarchiveTask`,
 * `startTask`, and the boot-time sweep can serialize against a still-running
 * archive/delete teardown before touching the same worktree, and so tests can
 * drain the queue deterministically.
 */
export function pendingTeardown(taskId: string): Promise<void> {
  return teardowns.get(taskId) ?? Promise.resolve();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(e: RunEvent) {
  for (const fn of listeners) fn(e);
}

// The subagent watcher (armed inside the claude-tmux tailer) persists its
// tagged events itself but needs the orchestrator's SSE fan-out to reach the
// run panel. Register `emit` as its sink once, at module load — there's exactly
// one listener set and the subagent stream rides the same `/tasks/:id/events`
// channel the UI already subscribes to.
setSubagentEmitter(emit);

// A held task's terminal run is already `succeeded`, so nothing in the run
// lifecycle will ever move it out of `running` — the release has to be driven
// by the background agents themselves. Register the release as the subagent
// settle hook so the last-agent-finishing edge lands the card in `review`.
setSubagentSettleHook(maybeReleaseHeldTask);

// Parked-discovery: a subagent newly (or once again) `running` should pull a
// `review` card back to `running` — the mirror-image of the settle hook
// above. Registered here (not inline) so it's visible alongside the other
// claude-subagents.ts seams; see `pullBackParkedTask` below for the policy
// (only from `review`, only when the terminal run actually succeeded).
setParkedDiscoveryHandler(pullBackParkedTask);

// Continuation-run adoption: claude-tmux calls this when a genuinely-new
// content line arrives on a task's session with no turn in flight — the case
// a post-`end_turn` background-task auto-continuation produces. See
// `startContinuationRun` below.
setContinuationRunFactory(startContinuationRun);

// Death-watch during a #92 hold: keep polling `tmux has-session` even though
// no turn is in flight, so a session dying mid-hold is caught instead of
// silently stranding the card in `running` until the next boot. Reuses the
// existing DB-derived hold predicate — no new state to track.
setHeldSessionProbe(isHeldByBackgroundAgents);

// Run association for `signalSubagentApiError` (#93): answers "what run id
// is currently in flight for this task, per the orchestrator's OWN `active`
// map?" so a stale async subagent from an older run can't abort a newer
// run's turn. `task.runId` alone isn't enough — it's set the instant
// `startTask` inserts the run row, before `spawnAgent` returns and
// `registerActiveRun` populates `active`, and it's also left stale after a
// run resolves — so the extra `active.has` check (the exact idiom used
// throughout this file, e.g. the busy/idle branch in `sendInput`) is what
// actually answers "in flight right now."
setActiveRunProbe((taskId) => {
  const task = tasks.get(taskId);
  if (!task?.runId) return null;
  return active.has(task.runId) ? task.runId : null;
});

// Local-command setting sync (§10 of the model/effort local-command plan):
// claude answers `/model` and `/effort` inside its own TUI and never writes
// an `assistant`/`end_turn` for them — the driver parses the
// `<local-command-stdout>` outcome and fires this regardless of whether the
// change came from the dropdown mirror, a typed command, a picker/slider
// card answer, or a terminal-side edit. `applyClaudeLocalSetting` syncs
// `task.model`/`task.effort` from that outcome WITHOUT re-mirroring back
// into the session (that would be `reconcileTaskSession`'s job, and calling
// it here would bounce a spurious second confirm off the very update we're
// recording).
setLocalSettingChangedHandler((taskId, info) => {
  applyClaudeLocalSetting(taskId, info);
});

// Background-task notification signal: a parent task-notification JSONL line
// named a background agent/task id. The raw payload is handed to
// claude-subagents, which owns the receipt rule: for ordinary rows ANY
// notification naming the id is the harness's authoritative completion
// receipt (DB flip → lifecycle emit → settle hook → `maybeReleaseHeldTask`,
// `source: "receipt"` so a trailing assistant/attachment flush can't resurrect
// the row the way an inferred settle would allow) — but a Claude Code
// Monitor's ordinary events ride the SAME `<task-notification>` envelope as
// its completion, so a `monitor` row settles only on a terminal receipt and
// records everything else as activity. Tolerant by design: an id matching no
// row, or a duplicate fired again on reattach replay, is a no-op.
setBackgroundTaskSettledHandler((taskId, agentId, body, lineTimestampMs) => {
  handleBackgroundTaskNotification(taskId, agentId, body, lineTimestampMs);
});

/**
 * Subscribe to the app-wide lifecycle stream — terminal run-status
 * transitions and column changes. Live-only: subscribers see events from the
 * moment they connect, never a replay. Drives the toast hook in the webview.
 */
export function subscribeGlobal(fn: GlobalListener): () => void {
  globalListeners.add(fn);
  return () => globalListeners.delete(fn);
}

function emitGlobal(e: GlobalEvent) {
  for (const fn of globalListeners) fn(e);
}

/**
 * Publish an app-wide lifecycle event from outside the orchestrator (e.g.
 * the auto-updater). Exported so subsystems with their own lifecycle don't
 * have to re-implement the listener set — there's exactly one
 * `subscribeGlobal` channel and the SSE endpoint that feeds the UI is wired
 * to it once.
 */
export function publishGlobalEvent(e: GlobalEvent): void {
  emitGlobal(e);
}

/** Canonicalize CR/LF in user-supplied text before it's emitted as a
 *  `user` stream event. The JSONL emit path in claude-tmux.ts does the
 *  same — keeping both sides symmetric guarantees the panel's dedup
 *  (keyed on `data.slice(0,200)`) collapses live + JSONL into one
 *  bubble even when the input arrived with Windows line endings
 *  (`\r\n`) from a clipboard paste. */
function normalizeUserText(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/**
 * Update a task's column and broadcast the transition. Reads the row's
 * current column first so the global event carries `prev` — saves the UI
 * from keeping its own diff state. Pass `null` for `runId` when the change
 * isn't tied to a specific run (e.g. orphan reconciliation).
 */
function toBlockReason(
  reason?: "api-error" | "approval" | "session-died" | "unknown-command" | "stage-advance" | "revision-cap" | "pipeline-failed",
): BlockReason | null {
  switch (reason) {
    case "api-error":
    case "session-died":
    case "unknown-command":
    case "revision-cap":
    case "pipeline-failed":
      return reason;
    default:
      return null;
  }
}

function updateColumn(
  taskId: string,
  runId: string | null,
  next: ColumnId,
  reason?:
    | "api-error" | "approval" | "session-died" | "unknown-command"
    | "stage-advance" | "revision-cap" | "pipeline-failed",
): void {
  const before = tasks.get(taskId);
  const prev: ColumnId | null = before?.column ?? null;
  // Persist WHY a task is blocked so the UI can render a durable recovery
  // banner (survives reload/restart) instead of only reacting to the
  // one-shot GlobalEvent emitted below. Cleared the moment the task leaves
  // `blocked`, regardless of what it's transitioning to. Landing on
  // `blocked` with NO reason (a bare re-affirm of an already-blocked
  // column, or a future call site that doesn't know why) leaves whatever
  // reason is already there untouched rather than nulling it out — a call
  // site missing its reason must never be able to silently corrupt a real
  // one a moment-earlier call already set.
  const blockReason: BlockReason | null | undefined =
    next === "blocked"
      ? (reason !== undefined ? toBlockReason(reason) : undefined)
      : prev === "blocked" ? null : undefined;
  tasks.update(taskId, blockReason !== undefined ? { column: next, blockReason } : { column: next });
  if (prev !== next) {
    emitGlobal({ kind: "column", taskId, runId, column: next, prev, ts: Date.now(), reason });
  }
}

/**
 * A task is "held" when its terminal run already succeeded but background
 * agents are still running. Derived purely from the DB (not the in-memory
 * `active` map) so the answer survives a restart and doesn't depend on
 * whether the subagent's settle fired before or after the run's completion
 * landed — either interleaving reads the same committed rows.
 *
 * Split into a pure `(task) => boolean` predicate plus a taskId-keyed
 * wrapper so callers that already hold a freshly-fetched `Task` row (e.g.
 * `reapIdleSessions`'s per-candidate guard) can reuse it without a second,
 * redundant `tasks.get`.
 */
function isTaskHeldByBackgroundAgents(task: Task): boolean {
  if (task.column !== "running" || task.runId == null) return false;
  if (runs.get(task.runId)?.status !== "succeeded") return false;
  return subagents.hasRunning(task.id);
}

function isHeldByBackgroundAgents(taskId: string): boolean {
  const task = tasks.get(taskId);
  return task ? isTaskHeldByBackgroundAgents(task) : false;
}

/**
 * Flip a held task to `review` (or, for a pipeline task, advance its stage)
 * once its last subagent finishes. Called on every subagent completion (via
 * the settle hook), so it must be cheap and safe to call repeatedly — it
 * no-ops unless the task is still held-and-clear: the user hasn't moved the
 * card, the terminal run still succeeded, and no subagent is left running. A
 * newer in-flight run (status !== succeeded) also bails, so a held release
 * can't stomp a follow-up turn's `running` state.
 *
 * The held run's own terminal status is already known to be `"succeeded"`
 * (checked above) — so for a pipeline task, `advancePipelineStage` gets the
 * same `{kind:"success"}` outcome `attachDoneHandler` would have computed
 * for this run had it not been held, deferred only by however long the
 * subagents took to finish.
 */
function maybeReleaseHeldTask(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task || !isActiveColumn(task.column) || task.runId == null) return;
  if (runs.get(task.runId)?.status !== "succeeded") return;
  if (subagents.hasRunning(taskId)) return;
  if (task.pipelineStage != null) {
    advancePipelineStage(taskId, task.runId, { kind: "success" });
  } else {
    updateColumn(taskId, task.runId, "review");
  }
}

/**
 * Pull a `review` card back to `running` when a background agent is
 * discovered (newly, or once again) `running` for its task — the mirror
 * image of `maybeReleaseHeldTask` above. Fired from claude-subagents.ts'
 * `setParkedDiscoveryHandler` on every fresh-insert or resumed-running edge,
 * so it must be cheap and idempotent (a no-op call is the common case: most
 * discoveries happen while the card is already `running`, not `review`).
 *
 * Deliberately narrow — only `review → running`, and only when the card's
 * own terminal run actually `succeeded` (i.e. this looks like the #92 hold
 * shape: the visible turn finished, background work continued after it).
 * Never pulls from `done`/`blocked`/`ready`/`backlog` — those encode user
 * intent or an error state the discovery of a background agent must not
 * override.
 */
function pullBackParkedTask(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task || task.column !== "review" || task.runId == null) return;
  if (runs.get(task.runId)?.status !== "succeeded") return;
  const runId = task.runId;
  updateColumn(taskId, runId, "running");
  const data = "background agent active — task pulled back to running";
  const ts = Date.now();
  runs.appendEvent(runId, "status", data);
  emit({ runId, taskId, stream: "status", data, ts });
}

/** Test hook: drive the event bus directly to verify SSE routing without
 *  needing a live agent. Not part of the public surface. */
export function __emitForTest(e: RunEvent): void {
  emit(e);
}

/** Test hook: drive the global event bus directly to verify the `/events`
 *  SSE wiring without orchestrating a real run. Not part of the public
 *  surface. */
export function __emitGlobalForTest(e: GlobalEvent): void {
  emitGlobal(e);
}

/**
 * Test hook: build and immediately fire a `makeChunkHandler` chunk for a
 * given run/task — the SAME handler real runs use (`runs.appendEvent` +
 * SSE emit + todo-progress/claude-plan detection + the api-error/
 * session-died/unknown-command sentinel checks). Lets orchestrator-level
 * tests (e.g. `orchestrator-claude-plan.test.ts`) drive synthetic
 * `tool_use`/`tool_result` chunks through the real detection pipeline
 * without a canned fake-driver scenario for every shape under test. Not
 * part of the public surface. */
export function __dispatchChunkForTest(
  runId: string,
  taskId: string,
  kind: AgentKind,
  stream: RunEvent["stream"],
  data: string,
): void {
  makeChunkHandler(runId, taskId, kind, null)(stream, data);
}

/**
 * Bridge: interactions.ts publishes new/resolved entries here so they ride the
 * same SSE stream the UI is already subscribed to (the UI distinguishes them
 * from regular log events via `stream === "interaction"`) AND the app-level
 * global bus so the notification hook can alert the user.
 *
 * Exported and idempotent because `setBroadcaster`/`setResolvedBroadcaster`
 * install a single process-wide callback: any code that overrides it (e.g. a
 * test capturing raw broadcasts) would otherwise permanently detach the global
 * emit. Tests that need the real wiring can re-call this to restore it.
 */
export function wireInteractionBroadcast(): void {
  setBroadcaster((req: AnyRequest) => {
    emit({
      runId: req.runId,
      taskId: req.taskId,
      stream: "interaction",
      data: JSON.stringify(req),
      ts: req.createdAt,
    });
    // Also ride the app-level bus so the notification hook can alert the user
    // even when no panel for this task is open (or it's open but the window is
    // backgrounded and can't repaint the card). The per-task `interaction`
    // event above only reaches the RunPanel subscribed to this task.
    emitGlobal({
      kind: "interaction",
      taskId: req.taskId,
      runId: req.runId,
      state: "pending",
      interactionId: req.id,
      ts: req.createdAt,
    });
  });

  // Companion bridge for the *removal* side. Every answer*/cancel* path in
  // interactions.ts calls into this, so the run panel can drop the card
  // immediately instead of waiting for a refresh poll. Without this, scraper
  // auto-cancel and run-cancellation leave stale cards in the panel (the
  // existing additions-only SSE plumbing has no way to signal "this is gone").
  setResolvedBroadcaster((res: InteractionResolved) => {
    emit({
      runId: res.runId,
      taskId: res.taskId,
      stream: "interaction_resolved",
      data: JSON.stringify({ id: res.id, kind: res.kind }),
      ts: Date.now(),
    });
    // App-level companion to the pending emit above — lets the notification
    // hook clear its "Waiting on you" alert once the last prompt is gone.
    emitGlobal({
      kind: "interaction",
      taskId: res.taskId,
      runId: res.runId,
      state: "resolved",
      interactionId: res.id,
      ts: Date.now(),
    });
  });
}

wireInteractionBroadcast();

// Companion bridge for the *removal* side. Every answer*/cancel* path
// in interactions.ts calls into this, so the run panel can drop the
// card immediately instead of waiting for a refresh poll. Without
// this, scraper auto-cancel and run-cancellation leave stale cards in
// the panel (the existing additions-only SSE plumbing has no way to
// signal "this is gone").
setResolvedBroadcaster((res: InteractionResolved) => {
  emit({
    runId: res.runId,
    taskId: res.taskId,
    stream: "interaction_resolved",
    data: JSON.stringify({ id: res.id, kind: res.kind }),
    ts: Date.now(),
  });
});

/**
 * Decide what to do with runs left in `status='running'` from a previous
 * agetor process. For claude-code runs whose tmux session is still alive
 * (the REPL is detached — it survives our exit), we *reattach* and resume
 * tailing claude's JSONL; the run stays in `running` and the user picks up
 * where they left off. Anything else (tmux gone, JSONL missing, codex run
 * whose child process died with us) is flipped to `orphaned`.
 *
 * We never enumerate-and-kill `agetor-*` sessions here. Agetor runs on the
 * user's *shared* default tmux socket, so a blind sweep would reap sessions
 * belonging to a different agetor instance (dev vs release DB) or to a
 * `bun test` run — the bug this deliberately avoids. Every kill agetor issues
 * is keyed to a specific task id from *this* instance's own DB (see the
 * per-row `killSessionByName` below, `killTaskSession` on delete/archive, and
 * codex's own teardown), so it can never touch a foreign instance's sessions.
 * A genuinely-leaked session (crash artifact, or a task deleted while agetor
 * was offline) is simply left alive rather than risk killing a live one.
 *
 * Called once at boot from `src/bun/index.ts`.
 */
export async function reconcileOrphans(): Promise<number> {
  // Sort newest-first so the at-most-one-reattach-per-task rule below keeps
  // the latest run row. If agetor crashed in the narrow window between
  // `sendTurnInExistingSession` inserting Run2 and `attachDoneHandler`
  // marking Run1 succeeded, the DB has two `running` rows for the same
  // task; only the latest reflects the user's current intent. Older
  // siblings get flipped to orphaned so we never have two SessionState
  // objects fighting for the same tmux session.
  const stale = db.query<{ id: string; task_id: string; tmux_session: string | null; claude_session_id: string | null; codex_session_id: string | null; cursor_session_id: string | null; gemini_session_id: string | null; fx_session_id: string | null; agent: string }, []>(
    `SELECT id, task_id, tmux_session, claude_session_id, codex_session_id, cursor_session_id, gemini_session_id, fx_session_id, agent FROM runs WHERE status = 'running' ORDER BY started_at DESC, id DESC`,
  ).all();

  const reattachedTaskIds = new Set<string>();
  const orphaned: { id: string; task_id: string; prevColumn: ColumnId | null; isPipeline: boolean }[] = [];

  for (const row of stale) {
    const task = tasks.get(row.task_id);
    const prevColumn: ColumnId | null = task?.column ?? null;
    const kind = resolveHarness(row.agent)?.kind ?? null;
    // claude-code, codex, cursor, and gemini runs can all be reattached when
    // their detached tmux session is still alive. The reattach key differs
    // by kind: claude needs its JSONL session uuid (`claude_session_id`),
    // codex needs its thread id (`codex_session_id`), cursor needs its
    // `session_id` (`cursor_session_id`), gemini needs its self-issued uuid
    // (`gemini_session_id`) — the per-run log path is derived from the run
    // id in every case. Note codex's, cursor's, gemini's, and fx's sessions
    // only live WHILE their turn is in flight (one process per turn), so a
    // reattachable one of those is by definition one that was still running
    // when agetor restarted. Also: if we already reattached a newer sibling
    // for this task, orphan the older one — only one SessionState can drive
    // a given tmux session at a time.
    const reattachKey =
      kind === "claude-code" ? row.claude_session_id
      : kind === "codex" ? row.codex_session_id
      : kind === "cursor" ? row.cursor_session_id
      : kind === "gemini" ? row.gemini_session_id
      : null;
    // fx is driven over ACP/stdio, not tmux — nothing to reattach to, so a
    // `running` fx row at boot always takes the orphaned→ready path.
    // Split into a cheap sync pre-check and a separate async liveness probe
    // (rather than one `&&` chain) — `sessionExistsByName` is genuinely async
    // now (wave 1), and a boolean-context `&&` with an un-awaited Promise
    // operand would evaluate to always-truthy (the Promise object itself),
    // silently skipping the actual liveness check. The `if` guard preserves
    // the original short-circuit (never probes tmux for a row that can't
    // possibly reattach) and keeps TS's narrowing of `row.tmux_session` to
    // `string` for everything below.
    let canTryReattach = false;
    if (
      (kind === "claude-code" || kind === "codex" || kind === "cursor" || kind === "gemini")
      && task !== null
      && row.tmux_session !== null
      && reattachKey !== null
      && !reattachedTaskIds.has(row.task_id)
    ) {
      canTryReattach = await sessionExistsByName(row.tmux_session);
    }

    if (canTryReattach && task) {
      const cwd = task.worktreePath ?? task.workdir;
      const harness = resolveHarness(task.agent);
      const onChunk = makeChunkHandler(row.id, row.task_id, kind as AgentKind, task.mode);
      const spawned = kind === "claude-code"
        ? await reattachSession({
            taskId: row.task_id,
            cwd,
            sessionId: row.claude_session_id as string,
            configDir: harness?.home ?? null,
            onChunk,
            seenLineUuids: runs.seenLineUuidsForTask(row.task_id),
            mode: task.mode,
          })
        : kind === "codex"
        ? await reattachCodexSession({
            taskId: row.task_id,
            runId: row.id,
            sessionName: row.tmux_session as string,
            onChunk,
            seenLineUuids: runs.seenLineUuidsForTask(row.task_id),
          })
        : kind === "cursor"
        ? await reattachCursorSession({
            taskId: row.task_id,
            runId: row.id,
            sessionName: row.tmux_session as string,
            onChunk,
            seenLineUuids: runs.seenLineUuidsForTask(row.task_id),
          })
        : await reattachGeminiSession({
            taskId: row.task_id,
            runId: row.id,
            sessionName: row.tmux_session as string,
            onChunk,
            seenLineUuids: runs.seenLineUuidsForTask(row.task_id),
          });
      if (spawned) {
        registerActiveRun(row.id, row.task_id, task, spawned);
        // Pre-seed `handle.apiError` when the prior process had already
        // emitted the api-error status to run_events for this run. The
        // reattach replay can't re-emit it — the assistant-line uuid is in
        // seenLineUuids, so `dispatchLine` short-circuits before the
        // mapper runs — so without this seed `attachDoneHandler` would
        // resolve with `wasApiError=false` and bounce the column from the
        // (correctly-persisted) `blocked` back to `review` on the first
        // pending-end-turn fire. `EXISTS` short-circuits on first match
        // and reads more clearly than `COUNT(*) > 0`.
        // subagent_id IS NULL: a subagent tailer's own transient api-error
        // status row (since #81) must not seed the main run's apiError.
        const priorApiError = db.query<{ found: 0 | 1 }, [string, string]>(
          `SELECT EXISTS(
             SELECT 1 FROM run_events
             WHERE run_id = ? AND stream = 'status' AND data LIKE ? AND subagent_id IS NULL
           ) AS found`,
        ).get(row.id, `${CLAUDE_API_ERROR_STATUS_PREFIX}%`)?.found ?? 0;
        if (priorApiError === 1) {
          const handle = active.get(row.id);
          if (handle) handle.apiError = true;
        }
        attachDoneHandler(row.id, row.task_id, spawned);
        reattachedTaskIds.add(row.task_id);
        // Visible seam in the run panel so the user can tell where the
        // process boundary is. Non-JSONL chunk → no dedup key needed.
        onChunk("status", "reconnected to live session after agetor restart");
        continue;
      }
      // JSONL missing despite live tmux — can't safely resume; kill the
      // session and fall through to orphan marking.
      await killSessionByName(row.tmux_session as string);
    }
    orphaned.push({ id: row.id, task_id: row.task_id, prevColumn, isPipeline: task?.pipelineStage != null });
  }

  const now = Date.now();
  if (orphaned.length > 0) {
    const reconcile = db.transaction(() => {
      for (const row of orphaned) {
        db.run(
          `UPDATE runs SET status = 'orphaned', ended_at = ?, exit_code = -1 WHERE id = ?`,
          [now, row.id],
        );
        db.run(
          `INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, ?, ?, ?)`,
          [row.id, "status", "orphaned — agetor restarted while this run was active", now],
        );
        // A pipeline task orphaned mid-stage lands on `blocked`, not `ready`
        // — nothing auto-resumes a bare `ready` pipeline task the way a
        // plain task's Run button does, so `blocked` is where a human is
        // actually expected to look. `WHERE "column" = ?` matches whatever
        // column the row was actually in (`running` for an ordinary task,
        // one of the 9 stage columns for a pipeline one) rather than
        // hardcoding "running", so a pipeline row isn't silently skipped.
        const targetColumn: ColumnId = row.isPipeline ? "blocked" : "ready";
        db.run(
          `UPDATE tasks SET "column" = ?, run_id = NULL WHERE id = ? AND "column" = ?`,
          [targetColumn, row.task_id, row.prevColumn],
        );
      }
    });
    reconcile();
    for (const row of orphaned) {
      emitGlobal({
        kind: "run-status",
        taskId: row.task_id,
        runId: row.id,
        status: "orphaned",
        ts: now,
      });
      if (row.prevColumn != null && (row.prevColumn === "running" || PIPELINE_STAGE_COLUMNS.includes(row.prevColumn))) {
        const targetColumn: ColumnId = row.isPipeline ? "blocked" : "ready";
        emitGlobal({ kind: "column", taskId: row.task_id, runId: null, column: targetColumn, prev: row.prevColumn, ts: now });
      }
    }
  }

  // Deliberately NO straggler sweep here. Sessions live on the shared default
  // tmux socket, so enumerating + killing every un-reattached `agetor-*`
  // session would reap a sibling instance's (dev vs release DB) or a test
  // run's live sessions. We reattach what we can, orphan the rest in the DB,
  // and leave any unaccounted-for session alive.
  if (reattachedTaskIds.size > 0) {
    console.log(`[agetor] reattached to ${reattachedTaskIds.size} live tmux session(s)`);
  }
  if (orphaned.length > 0) {
    console.log(`[agetor] orphaned ${orphaned.length} run(s) with no recoverable session`);
  }

  // Held tasks — and, more generally, ANY task with a stuck `running`
  // subagents row — are invisible to the pass above: their terminal run is
  // already `succeeded`, so it never appears in the `status='running'` scan
  // and nothing re-arms the subagent watcher that would eventually release
  // the card. Left alone, a restart strands them forever. This used to only
  // scan `tasks WHERE column = 'running'`, which covers the classic
  // held-in-running case but has a blind spot: a `review`/`done`-column task
  // whose subagents row is still `running` after a restart (the terminal run
  // resolved and moved the card out of `running` *before* the crash, so the
  // old scan skipped it entirely) was invisible here too — nothing ever
  // re-armed its watcher or orphaned its rows, and the badge/tab dot stayed
  // stuck forever. Source the wider set instead: every task with at least
  // one `running` subagents row, regardless of column.
  let reArmed = 0;
  let released = 0;
  const heldTaskIds = subagents.taskIdsWithRunning();
  for (const heldId of heldTaskIds) {
    const task = tasks.get(heldId);
    if (!task) continue;
    // Only claude-code writes subagent rows; a codex or cursor task can never
    // be held, so it never reaches here. Guard the session probe on kind for
    // clarity.
    if (resolveHarness(task.agent)?.kind !== "claude-code") continue;

    if (task.column === "running") {
      // Classic held-task path, unchanged: only proceed when the terminal run
      // has actually succeeded (i.e. this is a genuinely stuck "held for
      // background agents" task, not an ordinary run still legitimately in
      // progress that just happens to also have live subagent rows).
      if (!isHeldByBackgroundAgents(heldId)) continue;
      if (await sessionExistsByName(sessionNameFor(heldId))) {
        const run = task.runId ? runs.get(task.runId) : null;
        // No JSONL session id means no watch directory to derive, so nothing will
        // ever observe these agents finishing. Treat it exactly like a dead
        // session and release, rather than leaving the card held forever.
        if (!run?.claudeSessionId) {
          orphanRunningSubagents(heldId);
          released++;
          continue;
        }
        const cwd = task.worktreePath ?? task.workdir;
        const harness = resolveHarness(task.agent);
        attachSubagentWatcher({
          taskId: heldId,
          jsonlPath: jsonlPathFor(cwd, run.claudeSessionId, harness?.home ?? null),
        });
        reArmed++;
      } else {
        // Session gone: no watcher could ever observe these agents finishing, so
        // flip the rows now. `orphanRunningSubagents` fires the settle hook →
        // `maybeReleaseHeldTask` → the card advances to `review`.
        orphanRunningSubagents(heldId);
        released++;
      }
      continue;
    }

    // Blind-spot path: any column other than `running` (review, done, ready,
    // blocked, archived or not). `isHeldByBackgroundAgents` doesn't apply
    // here — it only ever looks at `column === 'running'` rows — but the
    // task's terminal run resolved normally (that's how the card got out of
    // `running` before the crash), so `task.runId` still reliably points at
    // that succeeded run and its `claudeSessionId`. Mirror the exact same
    // session-alive / session-id-recoverable branch structure as above.
    // HARD INVARIANT: never kill or create tmux sessions here — only re-arm
    // watchers and flip DB rows.
    if (await sessionExistsByName(sessionNameFor(heldId))) {
      const run = task.runId ? runs.get(task.runId) : null;
      if (!run?.claudeSessionId) {
        orphanRunningSubagents(heldId);
        released++;
        continue;
      }
      const cwd = task.worktreePath ?? task.workdir;
      const harness = resolveHarness(task.agent);
      attachSubagentWatcher({
        taskId: heldId,
        jsonlPath: jsonlPathFor(cwd, run.claudeSessionId, harness?.home ?? null),
      });
      reArmed++;
    } else {
      // Session gone: orphan the rows. Unlike the held-in-running case, the
      // settle hook's `maybeReleaseHeldTask` safely bails here (task.column
      // isn't `running`), so this only clears the stale subagent rows — it
      // does not move the card, which is already sitting wherever the user
      // (or the earlier normal completion) left it.
      orphanRunningSubagents(heldId);
      released++;
    }
  }
  if (reArmed > 0 || released > 0) {
    console.log(`[agetor] held tasks: re-armed ${reArmed} watcher(s), released ${released} background-agent row(s)`);
  }

  return orphaned.length;
}

/**
 * Boot-time companion to `reconcileOrphans`, for a gap that function can't
 * cover: `reconcileOrphans` only finds tasks with an active *run*
 * (`status='running'`), but a parent mid-build (fresh-entry/DAG mode) has
 * no run of its own while its children work — nothing surfaces it there.
 * Scans for exactly that shape and re-drives build-scheduler.ts's
 * `tickBuild` on each, which is naturally idempotent: if the build was
 * already complete or aborted before the crash, its own guards (parent no
 * longer in an active "building" column) make this a no-op; if a child was
 * mid-run when agetor restarted, that child's own row is picked up by the
 * ordinary `reconcileOrphans` pass instead (it's a plain task with a plain
 * run) — tickBuild just resumes deciding what (if anything) needs to
 * happen next once that settles.
 *
 * Called once at boot from both `src/bun/index.ts` and `src/bun/headless.ts`
 * — this feature has two boot entry points, and both need it.
 */
export function resumeInFlightBuilds(): number {
  const parents = tasks.list().filter(
    (t) => t.pipelineStage === "building" && t.parentTaskId == null && t.archivedAt == null,
  );
  for (const parent of parents) {
    void tickBuild(parent.id).catch((err) => {
      console.error(`[agetor] boot resume: tickBuild failed for task ${parent.id}:`, err);
    });
  }
  return parents.length;
}

/**
 * Wraps `spawnAgent` so a failure inside it — either a *synchronous* throw
 * before a process is ever spawned (`buildCommand` can throw on gemini's
 * argv-size cap, "model is required", …) or an *async rejection* partway
 * through spawning (e.g. a `git` failure inside `buildCodexCommand`'s
 * external-git escalation check, or any other awaited step of `spawnAgent`
 * that rejects) — can't strand the run row it was called for. `await
 * spawnAgent(args)` inside the `try` catches both shapes identically; the
 * catch block below doesn't need to know which one fired. Every call site
 * below has already inserted the run row and flipped the task to `running`
 * by the time it calls this, so on a throw/rejection there's persisted state
 * to unwind: emit the error as a stderr chunk, fail the run, and bounce the
 * task back to `ready` — the same recovery each call site already does for a
 * missing harness (see the neighboring `if (!harness)` branches). Returns
 * `{ agent: null, message }` on failure so callers can early-return exactly
 * the way they already did when this returned a bare `null` (`if (!agent)`
 * still works unchanged after destructuring), while `startTask` — the one
 * call site that needs to surface *why* — can report `message` instead of a
 * generic "check the run log" string. `args` carries `runId`/`taskId`/
 * `onChunk` itself (see `SpawnAgentArgs`), so there's no separate parameter
 * for them.
 */
async function spawnAgentOrFail(
  args: SpawnAgentArgs,
): Promise<{ agent: SpawnedAgent; message?: undefined } | { agent: null; message: string }> {
  try {
    return { agent: await spawnAgent(args) };
  } catch (err) {
    const { runId, taskId, onChunk } = args;
    const message = err instanceof Error ? err.message : String(err);
    onChunk("stderr", `failed to start agent: ${message}`);
    runs.update(runId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
    tasks.update(taskId, { column: "ready", runId: null });
    return { agent: null, message };
  }
}

/**
 * Guards against two overlapping "mint a fresh run for this task" calls
 * racing each other. The same failure shape shows up at every entry point
 * that (a) reads `task.runId && active.has(task.runId)` (or, for claude,
 * the `sessionLiveness`/`hasSessionState` equivalent) as "nothing in flight
 * for this task", then (b) walks a chain of awaits — `pendingTeardown`,
 * `checkHarness`, `prepareWorkdir`, `resolveRef`, `sessionLiveness`, the
 * async `spawnAgentOrFail` itself — before it has registered the new run in
 * `active` or (for codex/cursor/gemini/fx) even written `task.runId` via
 * `tasks.update`. A second overlapping call can read that same stale "idle"
 * snapshot before the first call's DB write lands, race in behind it, and
 * reach its own mint path too: two run rows, two spawned agents — or worse,
 * the second spawn's unconditional tmux pre-kill (`spawnClaudeViaTmux` et
 * al.) tearing down the first turn's session mid-spawn — for one task.
 *
 * ONE module-level set closes this window for every caller that mints a
 * fresh run without an existing one to fold into:
 *   - `startTask`'s wrapper directly below (double clicks / rapid re-POSTs
 *     to `/tasks/:id/start`);
 *   - claude's idle/dead-session mint paths (`sendClaudeTurn`'s fresh-spawn
 *     branch and `sendTurnInExistingSession`'s idle branch) — these used to
 *     share a separate `startingClaudeIdleTurns` set; unified here so a
 *     `startTask` and a claude idle-send can't each claim their own
 *     disjoint keyspace and both mint against the same task;
 *   - the four one-shot `spawn{Codex,Cursor,Gemini,Fx}TurnNow` functions,
 *     which claim at entry (before `runs.insert`) and release in `finally`.
 *
 * Deliberately NOT claimed by claude's fold-while-busy path (`pasteFollowUp`,
 * inside `sendTurnInExistingSession`, above its idle branch) — folding a
 * message into an already-active run is safe under any amount of
 * concurrency by design, and serializing it here would only add latency
 * with no correctness benefit.
 *
 * Whichever call claims a taskId first proceeds through its whole function;
 * every other overlapping call for the same taskId is rejected immediately
 * with a friendly "try again" result instead of racing through the awaits
 * behind it. Trade-off, accepted: a permanently wedged tmux op (its owner
 * declined to add a timeout) leaves the claim held and that task un-startable
 * / un-sendable for the remaining lifetime of the process — strictly better
 * than the old app-wide synchronous hang this replaced, and scoped to one
 * task rather than the whole app. Revisit if/when that op grows a timeout.
 */
const startingTaskIds = new Set<string>();

/**
 * Verdict-only pipeline stages read and judge — they don't generate
 * original artifacts. Running these on the task's own (often top-tier)
 * model wastes budget; Sonnet 5 handles them reliably at a fraction of the
 * cost.
 */
const PIPELINE_VERDICT_STAGES = new Set<NonNullable<Task["pipelineStage"]>>([
  "plan-review",
  "code-review",
  "testing",
]);
const PIPELINE_VERDICT_MODEL = "sonnet-5";

/**
 * Model to use for this specific run. For claude-code pipeline tasks in
 * verdict-only stages (plan-review, code-review, testing) we tier down to
 * Sonnet — those stages read and judge, they don't generate original
 * artifacts. All other paths return task.model unchanged.
 *
 * Exported so the model selection is directly unit-testable.
 */
export function resolveRunModel(
  task: Task,
  harnessKind: AgentKind,
): string | null | undefined {
  if (
    harnessKind === "claude-code" &&
    task.pipelineStage != null &&
    PIPELINE_VERDICT_STAGES.has(task.pipelineStage)
  ) {
    return PIPELINE_VERDICT_MODEL;
  }
  return task.model;
}

/**
 * Lean-context launch options for a pipeline turn (stage turn or build
 * child) on claude-code — see `AgentRunOptions.leanContext` in agents.ts for
 * the measurements behind it. Plain tasks, codex/gemini, and
 * `AGETOR_PIPELINE_LEAN_CONTEXT=0` all get `null` (today's full-context
 * spawn). The worktree's own `CLAUDE.md` (at `cwd`, the prepared worktree
 * or raw workdir) is re-injected so the target repo's conventions survive
 * while ancestor files — the operator's personal `$HOME/CLAUDE.md`, pulled
 * in only because worktrees live under `$HOME` — are dropped.
 *
 * Exported so the selection is directly unit-testable.
 */
export function pipelineLeanContext(task: Task, harnessKind: AgentKind, cwd: string): LeanContext | null {
  if (harnessKind !== "claude-code") return null;
  if (task.pipelineStage == null && task.parentTaskId == null) return null;
  if (!leanContextEnabled()) return null;
  const claudeMd = join(cwd, "CLAUDE.md");
  return {
    tools: pipelineToolset(task.pipelineStage),
    appendSystemPromptFile: existsSync(claudeMd) ? claudeMd : null,
  };
}

/** Env kill-switch for O-14 (mirrors leanContextEnabled/autoInstallEnabled's
 *  convention): `AGETOR_PIPELINE_CLAUDE_MD_FILTER=0` restores the raw,
 *  unfiltered worktree CLAUDE.md for pipeline/child sessions — today's O-2
 *  behavior, byte for byte. */
function claudeMdFilterEnabled(): boolean {
  return process.env.AGETOR_PIPELINE_CLAUDE_MD_FILTER !== "0";
}

/**
 * O-14: narrow the CLAUDE.md O-2 re-injects for a pipeline/child claude-code
 * turn to the one matching "Agent command shape" harness bullet and drop the
 * JubarteAI section outright (see docs/plans/pipeline-token-efficiency.md
 * §7/§9 open item and CLAUDE.md's own "Agent command shape" /
 * "JubarteAI Agent Identity" sections). Writes the filtered copy to
 * `<cwd>/.agetor/CLAUDE.filtered.md` — the real `CLAUDE.md` on disk is never
 * touched. `claudeMdPath` is `pipelineLeanContext`'s own
 * `appendSystemPromptFile` (already null when the worktree has none, or when
 * O-2 itself is off/inapplicable) — this function only narrows a path that's
 * already been decided on, it never turns a null into a path or vice versa
 * except in the two fail-open cases below. Fails open at every step: any
 * error here falls back to `claudeMdPath` unchanged, so a pipeline turn is
 * never blocked by this optimisation and, at worst, sees the same
 * un-narrowed file O-2 already re-injects today.
 */
export function resolvePipelineSystemPromptFile(
  claudeMdPath: string | null,
  agentKind: AgentKind,
  cwd: string,
): string | null {
  if (claudeMdPath == null) return null;
  if (!claudeMdFilterEnabled()) return claudeMdPath;
  let original: string;
  try {
    original = readFileSync(claudeMdPath, "utf8");
  } catch {
    return claudeMdPath;
  }
  let filtered: string;
  try {
    filtered = filterClaudeMdForPipeline(original, { agentKind });
  } catch {
    return claudeMdPath;
  }
  if (filtered.trim() === "") return null; // degenerate output — same as "no CLAUDE.md" (O-2's existing null path)
  try {
    const outDir = join(cwd, ".agetor");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "CLAUDE.filtered.md");
    writeFileSync(outPath, filtered);
    return outPath;
  } catch {
    return claudeMdPath;
  }
}

/**
 * Effort tiering next to model tiering (O-8). Effort drives thinking tokens
 * AND tool-call count, and both measured pipelines ran every stage and
 * every child at the parent's `high`. Verdict stages read and judge → `low`;
 * build children implement a bounded slice → `medium`; everything else
 * keeps the task's own effort. Only when the task HAS an effort (a null
 * effort means the model declines the flag, and inventing one would change
 * behaviour), and only for kinds whose effort ids share the low/medium/high
 * vocabulary (claude-code, codex; gemini ignores effort entirely).
 * `AGETOR_PIPELINE_EFFORT_TIERING=0` disables it. Exported for tests.
 */
export function resolveRunEffort(task: Task, harnessKind: AgentKind): string | null | undefined {
  if (task.effort == null) return task.effort;
  if (harnessKind !== "claude-code" && harnessKind !== "codex") return task.effort;
  if (process.env.AGETOR_PIPELINE_EFFORT_TIERING === "0") return task.effort;
  if (task.pipelineStage != null && PIPELINE_VERDICT_STAGES.has(task.pipelineStage)) return "low";
  if (task.parentTaskId != null) return "medium";
  return task.effort;
}

/** Env kill-switch for the pre-spawn dependency install (O-4). */
function autoInstallEnabled(): boolean {
  return process.env.AGETOR_PIPELINE_AUTO_INSTALL !== "0";
}

/** Stages whose agent runs project commands and so benefits from knowing
 *  them up front. Planner/Critic/Decomposer only read code. */
const COMMAND_RUNNING_STAGES = new Set<NonNullable<Task["pipelineStage"]>>(["building", "code-review", "testing"]);
const STAGE_HANDOFF_CHAR_BUDGET = 1500;

/**
 * Deterministic prompt extras for a pipeline turn (O-4 project commands +
 * dependency install, O-6 precomputed review diff, O-11 stage handoff,
 * O-5 precheck hand-over). Every block is independent and fail-open: an
 * exception in one leaves the others intact and the prompt otherwise
 * identical to the pre-optimisation one. `log` lands status lines on the
 * run being spawned, so a two-minute `npm ci` is visible in the run log
 * rather than looking like a hung spawn.
 */
async function pipelinePromptExtras(
  task: Task,
  cwd: string,
  log: (line: string) => void,
): Promise<StageExtras> {
  const extras: StageExtras = {};
  const isChild = task.parentTaskId != null;
  const stage = task.pipelineStage;

  // O-5/O-12: read the precheck FIRST so the testing stage's own
  // ## Project commands block (below) can omit an already-green check's
  // runnable line instead of just narrating it — Finding 1. Read failure
  // degrades to "no precheck" here, which also disables the omission; it
  // never blocks the run.
  let precheckSummary: PrecheckSummary | null = null;
  if (stage === "testing") {
    try {
      precheckSummary = pipelineState.getPrecheck(task.id);
      extras.precheck = precheckSummary;
    } catch (err) {
      console.error(`[agetor] precheck read failed for task ${task.id}:`, err);
    }
  }

  // O-4: repo profile + one-time install. Children each get their own
  // worktree, so each installs once (lockfile-hash marker makes re-runs a
  // no-op) — the same install the agent used to run itself, minus the
  // discovery turns around it.
  if (isChild || (stage != null && COMMAND_RUNNING_STAGES.has(stage))) {
    try {
      const profile = readRepoProfile(cwd);
      let installed = existsSync(join(cwd, "node_modules"));
      if (profile.install && autoInstallEnabled()) {
        log(`preparing worktree: ${profile.install}`);
        const r = await ensureDependenciesInstalled(cwd, profile);
        if (r.ran) log(r.ok ? "dependencies installed" : `dependency install failed — leaving it to the agent: ${r.detail.slice(-400)}`);
        installed = installed || r.ok;
      }
      const skipChecks = precheckSummary ? precheckPassedChecks(precheckSummary) : undefined;
      extras.projectCommands = renderProjectCommands(profile, { installed, skipChecks }) || null;
    } catch (err) {
      console.error(`[agetor] repo profile failed for task ${task.id}:`, err);
    }
  }

  // O-11: what earlier stages already Read / ran. Children get theirs at
  // creation time (build-scheduler folds a lane-filtered block into the
  // stored prompt), so only stage turns look it up here.
  if (!isChild && stage != null && stage !== "specify") {
    try {
      extras.handoff = renderHandoff(pipelineState.getHandoffs(task.id), { charBudget: STAGE_HANDOFF_CHAR_BUDGET }) || null;
    } catch (err) {
      console.error(`[agetor] handoff render failed for task ${task.id}:`, err);
    }
  }

  // O-6: the Code Reviewer's diff, taken once, outside the worktree. A
  // revision pass diffs from the sha reviewed last time.
  if (stage === "code-review") {
    try {
      const since = (task.revisionCount > 0 ? pipelineState.getReviewSha(task.id) : null) ?? task.baseRef;
      if (since) {
        const diff = await writeReviewDiff({ cwd, taskId: task.id, sinceSha: since, dataDir });
        if (diff) {
          extras.reviewDiff = diff;
          pipelineState.setReviewSha(task.id, diff.headSha);
          log(`review diff precomputed since ${since.slice(0, 7)}: ${Math.round(diff.bytes / 1024)} KB → ${diff.file}`);
        }
      }
    } catch (err) {
      console.error(`[agetor] review diff failed for task ${task.id}:`, err);
    }
  }

  return extras;
}

export async function startTask(
  taskId: string,
): Promise<{ runId: string; unresolvedRefs?: string[] } | { error: string }> {
  let task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.runId && active.has(task.runId)) return { error: "task already running" };
  if (startingTaskIds.has(taskId)) return { error: "task is already starting" };
  startingTaskIds.add(taskId);
  try {
    return await startTaskInner(taskId, task);
  } finally {
    startingTaskIds.delete(taskId);
  }
}

async function startTaskInner(taskId: string, task: Task): Promise<{ runId: string; unresolvedRefs?: string[] } | { error: string }> {
  // startTask auto-unarchives and materializes the worktree below — it must
  // not race a teardown archiveTask (or deleteTask) deferred for this task,
  // or a `detachWorktree`/`removeWorktree` still in flight could yank the
  // directory out from under the freshly-prepared one.
  await pendingTeardown(taskId);

  // Starting an archived task auto-unarchives it — otherwise the card would
  // move through columns (running → review/ready) while hidden behind the
  // archive filter, which is confusing at best.
  if (task.archivedAt != null) {
    task = tasks.update(taskId, { archivedAt: null }) ?? task;
  }

  const harness = resolveHarness(task.agent);
  if (!harness) {
    return { error: `harness "${task.agent}" not found — pick another in the task's settings` };
  }
  // Soft-delete gate: disabled harnesses still resolve (so historical rows
  // and currently-running children stay attributable), but new runs are
  // blocked. The user re-enables in Settings to recover.
  if (!harness.enabled) {
    return { error: `${harness.label} is disabled — re-enable it in Settings to start new runs.` };
  }
  // `freshAuth: true` bypasses agent-status.ts's fx status-cache (60s TTL) —
  // a Start click must never be refused by a stale cached "logged out" from
  // before the user ran `fx login`. The 15s `/harnesses` poll that paints the
  // header status dots is the only caller that tolerates the cached value.
  const status = await checkHarness(harness, { freshAuth: true });
  if (!status.available) {
    const hint = status.installHint ? ` Install it with: ${status.installHint}` : "";
    return { error: `${harness.label} is not available — ${status.reason}.${hint}` };
  }
  // Fail-open: only an explicit `false` means the CLI positively reported
  // it's logged out. `null` (not probed / unknown) must never block a run.
  // Empirically (real fx v0.0.6, v0.0.7, and v0.0.8 — 0.0.8 re-verified
  // 2026-09-08, HOME pointed at an empty dir): env-var auth IS reflected by
  // the probe (AI_GATEWAY_API_KEY / VERCEL_OIDC_TOKEN both report a
  // non-"missing" `auth` value) — since the probe runs with the same
  // harnessEnv(harness) a real spawn uses, a key-authenticated user is never
  // gated out here. As of 0.0.7 (unchanged in 0.0.8 — the credential
  // re-check code paths are byte-identical 0.0.7→0.0.8), that same explicit
  // `false` can also come from an expired login that can't self-refresh
  // (`auth_expired === true && auth_refreshable === false`) — but that gate
  // explicitly exempts the env-key `auth` values above (see agent-status.ts's
  // probeStatus doc comment for the full rationale), so the "never gated
  // out" guarantee holds with no exception.
  if (status.loggedIn === false) {
    return { error: `${harness.label} isn't logged in — ${status.authHelp ?? "run its login command"}` };
  }

  // Pass the branches other tasks have pinned. If materializing this task's
  // branch hits a create-time uniqueness race, the recovery re-pins to a name
  // that's free of both existing refs AND those not-yet-started pins.
  const prepared = await prepareWorkdir(task, {
    takenBranches: new Set(
      tasks.list()
        .filter((t) => t.id !== taskId)
        .map((t) => t.branch)
        .filter((b): b is string => Boolean(b)),
    ),
  });
  if ("error" in prepared) return { error: prepared.error };

  // Expand `@`-tokens into absolute paths now, right after `prepareWorkdir`
  // returns — this is the EARLIEST point in the whole flow that knows the
  // agent's real cwd: `prepared.cwd` is the worktree root once it has just
  // been materialized (isolation "worktree"), or the raw workdir otherwise.
  // No code before this line could have resolved a token correctly. Only
  // `expandedPrompt` (a local) carries the expansion — `task.prompt` itself
  // is left untouched in the DB, so editing the task or re-running it later
  // keeps the `@tokens` and re-resolves them against whatever cwd that next
  // run gets (a fresh worktree, a moved workdir, etc).
  // A pipeline task's turn text is the current stage's prompt template
  // (which already folds task.prompt — the ticket — back in), not the raw
  // ticket alone. Still runs through the same @-expansion/budget pipeline
  // as any other prompt. The project constitution (specify stage only) is
  // read from the materialized cwd — the real worktree root once one
  // exists, the source repo on a fresh isolation:none task.
  // Deterministic prompt extras for pipeline turns (stage turns AND build
  // children) — docs/plans/pipeline-token-efficiency.md O-4/O-6/O-11. Each
  // one is fail-open: an error degrades to "the prompt looks like today's".
  // Computed here, before the run row exists, because the prompt must be
  // final before the @-expansion budget check below; status lines collect
  // in `pendingExtraStatus` and flush onto the run once it has a handler.
  const pendingExtraStatus: string[] = [];
  const extras = (task.pipelineStage != null || task.parentTaskId != null)
    ? await pipelinePromptExtras(task, prepared.cwd, (line) => pendingExtraStatus.push(line))
    : null;
  let sourcePrompt = task.pipelineStage ? task.prompt : appendPromptExtras(task.prompt, extras);
  if (task.pipelineStage) {
    let constitutionRaw: string | null = null;
    if (task.pipelineStage === "specify") {
      const constitutionPath = join(prepared.cwd, PIPELINE_CONSTITUTION_FILE);
      if (existsSync(constitutionPath)) {
        try { constitutionRaw = readFileSync(constitutionPath, "utf8"); } catch { /* proceed without */ }
      }
    }
    sourcePrompt = stagePrompt(task, task.pipelineStage, constitutionRaw, extras);
  }
  const { text: expandedPrompt, unresolved: unresolvedRefs } = expandAtReferencesDetailed(sourcePrompt, prepared.cwd);
  // Budget-check the fully expanded + reffed prompt against what the RAW
  // (pre-expansion) prompt would already have needed. Expansion can turn a
  // handful of short `@tokens` into long absolute paths and push a prompt
  // over an agent's argv-launch cap (gemini today, see prompt-limits.ts)
  // even though the raw text the user typed comfortably fit under it —
  // that's the ONLY case this pre-check exists to catch early, before any
  // run row is inserted or the task flips to `running`. A prompt that was
  // ALREADY over budget with no `@` tokens involved (`rawOverage` truthy
  // too) is deliberately left alone here and falls through to the
  // pre-existing hardening below — `buildCommand`'s own throw inside
  // `spawnAgentOrFail`'s catch, exercised (with a run row landing `failed`)
  // by orchestrator-fx.test.ts's "spawn-throw hardening (gemini)" test —
  // so that pre-existing behavior/error text is unchanged by this feature.
  const expandedOverage = promptByteOverage(harness.kind, appendReferences(expandedPrompt, task.references));
  // Skip re-encoding the same text twice (R19, code review) when expansion
  // was a no-op — a prompt with no `@` tokens at all (or none that resolved)
  // has `expandedPrompt === task.prompt`, so `expandedOverage` already IS
  // what re-running `promptByteOverage` on the raw prompt would compute.
  const rawOverage = expandedPrompt === sourcePrompt
    ? expandedOverage
    : promptByteOverage(harness.kind, appendReferences(sourcePrompt, task.references));
  if (expandedOverage && !rawOverage) {
    return {
      error:
        `prompt is ${expandedOverage.bytes - expandedOverage.limit} bytes over ${harness.label}'s `
        + `${expandedOverage.limit}-byte launch limit after expanding @ file references — shorten it or `
        + `reference fewer files`,
    };
  }

  // Lazy-pin baseRef: workdir wasn't a git repo when the task was created but
  // is one now. Pin the sha actually used so re-runs stay reproducible.
  if (!task.baseRef && prepared.worktreePath) {
    const sha = await resolveRef(task.workdir, "HEAD");
    if (sha) tasks.update(taskId, { baseRef: sha });
  }

  const runId = randomUUID();
  const now = Date.now();
  const prevColumn: ColumnId = task.column;
  // A pipeline task's "running" column IS its current stage — startTask is
  // what actually spawns each stage's turn (called directly for the first
  // stage, and again by advancePipelineStage for every stage after). An
  // ordinary task (and a build child, whose own pipelineStage is null) keeps
  // the plain "running" column.
  const startColumn: ColumnId = task.pipelineStage ?? "running";

  // Single transaction: flip the task into running with the new run id, branch,
  // worktree path; insert the run row. Either everything sticks or nothing does.
  const persist = db.transaction(() => {
    tasks.update(taskId, {
      column: startColumn,
      // A fresh run always supersedes whatever `blocked` reason applied to
      // the PREVIOUS run — this is the retry path the RunPanel's
      // blocked-task recovery banner's "Retry stage"/"Retry" actions use,
      // and `updateColumn` (which owns clearing this field on every OTHER
      // blocked→non-blocked transition) is never called here.
      blockReason: null,
      branch: prepared.branch,
      worktreePath: prepared.worktreePath,
      runId,
    });
    runs.insert({
      id: runId,
      taskId,
      agent: task.agent,
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      // All four kinds now run in a per-task tmux session. fx is the
      // exception — it's driven over ACP/stdio, not tmux — but it still
      // gets a `tmuxSession` name here for symmetry with the run row shape;
      // `spawnFxViaAcp` simply doesn't use it.
      tmuxSession: sessionNameFor(taskId),
      // Filled in by spawnAgent's onSessionId callback once the session id is
      // known: claude's JSONL uuid → claudeSessionId, codex's thread_id →
      // codexSessionId, cursor's session_id → cursorSessionId, gemini's
      // self-issued uuid → geminiSessionId, fx's ACP session id →
      // fxSessionId. Exactly one is non-null per run.
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      // Provenance stamp: startTask is the ONLY spawner of pipeline stage
      // turns (spawnPipelineStage, the UI's "Retry stage", boot-resume) and
      // of a build child's own build turn (tickBuild). Runs created anywhere
      // else — user follow-ups via sendInput, auto-continuations, resumed
      // sessions — carry no stamp, and advancePipelineStage/settleChildRun
      // refuse to act on them. This is what makes "only stage runs move the
      // pipeline" structural rather than hoped-for (postmortem RC-6).
      origin: (task.pipelineStage != null || task.parentTaskId != null) ? "pipeline-stage" : null,
    });
  });
  persist();
  if (prevColumn !== startColumn) {
    emitGlobal({ kind: "column", taskId, runId, column: startColumn, prev: prevColumn, ts: now });
  }

  const promptWithRefs = appendReferences(expandedPrompt, task.references);

  const onChunk = makeChunkHandler(runId, taskId, harness.kind, task.mode);
  // Status lines the pre-spawn pipeline extras collected before the run
  // row existed (dependency install, diff precompute) — flushed onto the
  // run now that it has a chunk handler.
  for (const line of pendingExtraStatus) onChunk("status", line);
  // Echo the initial prompt as a "user" event so the panel renders a
  // bubble for it right away — claude won't transcribe the prompt into
  // its JSONL until it boots (can take a few seconds). The JSONL-flush
  // path will emit the same line again once claude writes it; the run
  // panel's dedup keys user events on (runId, data) so we don't double
  // up.
  onChunk("user", normalizeUserText(promptWithRefs));

  const lean = pipelineLeanContext(task, harness.kind, prepared.cwd);
  const leanContext = lean
    ? { ...lean, appendSystemPromptFile: resolvePipelineSystemPromptFile(lean.appendSystemPromptFile ?? null, harness.kind, prepared.cwd) }
    : lean;
  const { agent, message } = await spawnAgentOrFail({
    taskId,
    runId,
    harness,
    prompt: promptWithRefs,
    cwd: prepared.cwd,
    onChunk,
    onSessionId: (sessionId) => {
      runs.update(runId, harness.kind === "claude-code"
        ? { claudeSessionId: sessionId }
        : harness.kind === "codex"
        ? { codexSessionId: sessionId }
        : harness.kind === "cursor"
        ? { cursorSessionId: sessionId }
        : harness.kind === "gemini"
        ? { geminiSessionId: sessionId }
        : { fxSessionId: sessionId });
    },
    opts: { mode: task.mode, model: resolveRunModel(task, harness.kind) ?? DEFAULT_MODEL[harness.kind], effort: resolveRunEffort(task, harness.kind), fast: task.fast, maxMode: task.maxMode, leanContext },
  });
  if (!agent) return { error: `failed to start agent: ${message}` };
  registerActiveRun(runId, taskId, task, agent);
  const runModel = resolveRunModel(task, harness.kind);
  const modelNote = runModel !== task.model
    ? `${runModel ?? "—"} (stage override; task default ${task.model ?? "—"})`
    : (runModel ?? "—");
  emit({
    runId,
    taskId,
    stream: "status",
    data: `started — ${prepared.note} — agent=${task.agent}, model=${modelNote}, mode=${task.mode ?? "auto"}`,
    ts: now,
  });

  attachDoneHandler(runId, taskId, agent);

  return { runId, ...(unresolvedRefs.length ? { unresolvedRefs } : {}) };
}

/** Cheap pre-filter before doing the more expensive JSON-parse + DB query a
 *  todo-family chunk triggers below — TodoWrite/TaskCreate/TaskUpdate chunks
 *  are rare (most chunks are assistant text, thinking, or unrelated tool
 *  calls), so a plain substring check keeps the hot path a single `includes`
 *  away from a no-op. Markers are the literal serialized `"name":"<Tool>"`
 *  envelope form (see `claude-tmux.ts`'s `JSON.stringify` of `tool_use`
 *  blocks — no spaces), not a bare tool name substring: agetor dogfoods
 *  itself, so an assistant/tool_result chunk quoting "TaskCreate" in prose
 *  (e.g. describing this very code) is a real false positive with the bare
 *  form, not a theoretical one.
 *
 *  Split by stream, mirroring `runs.todoRelevantEventsForTask`'s SQL LIKE
 *  filter in db.ts (same split, same reason): a `tool_use` row carries
 *  `"name":"<Tool>"`, but a `tool_result` row never does (`{toolUseId,
 *  content, isError}`) — its ONLY todo-family shape `deriveTodoProgress`
 *  ever consults is a `TaskCreate` result's `"Task #N created successfully"`
 *  text, so that's the marker for the `tool_result` side. Without this
 *  separate check, `tool_result` rows would never re-trigger the board
 *  summary, and a TaskCreate's claude-assigned number wouldn't be reflected
 *  until some unrelated LATER tool_use chunk happened to fire the recompute. */
const TODO_FAMILY_TOOL_USE_MARKERS = ['"name":"TodoWrite"', '"name":"TaskCreate"', '"name":"TaskUpdate"'];
const TODO_FAMILY_TOOL_RESULT_MARKER = "created successfully";

function isTodoFamilyChunk(stream: RunEvent["stream"], data: string): boolean {
  if (stream === "tool_use") return TODO_FAMILY_TOOL_USE_MARKERS.some((m) => data.includes(m));
  if (stream === "tool_result") return data.includes(TODO_FAMILY_TOOL_RESULT_MARKER);
  return false;
}

/**
 * Re-derive and persist the board-level `tasks.todo_progress` summary after a
 * todo-family `tool_use`/`tool_result` chunk lands. Works for every agent
 * kind — chunks are a generic `{stream,data}` shape, and gating this on
 * `kind` would be one more thing to keep in sync with whichever harnesses
 * grow Task-tools-style tools next (plan §3).
 *
 * Must be called AFTER `runs.appendEvent` has persisted the chunk that
 * triggered it (see the call site in `makeChunkHandler`, which appends
 * before running any detection): `runs.todoRelevantEventsForTask` re-reads
 * `run_events` synchronously via `bun:sqlite`, so the just-arrived chunk is
 * already in the result set — there is no separate "append the current
 * chunk in memory" step needed, and none is done here.
 *
 * Writes only when the derived summary actually changed (by value, not
 * reference — `deriveTodoProgress` re-parses the whole history every call),
 * so a `TaskUpdate` that round-trips to an unchanged summary (e.g. an
 * unknown taskId, tolerated as a no-op by `deriveTodoProgress`) doesn't
 * churn the row. Never throws — same "detection bugs must not break run
 * settlement" contract as `detectCursorPlan` (plan §7); the caller wraps
 * this in try/catch too, belt-and-braces.
 */
function maybeUpdateTodoProgress(taskId: string): void {
  const events = runs.todoRelevantEventsForTask(taskId);
  const summary = summarizeTodoProgress(deriveTodoProgress(events));
  const task = tasks.get(taskId);
  if (!task) return;
  const current = task.todoProgress ?? null;
  const changed = summary === null
    ? current !== null
    : current === null || current.completed !== summary.completed || current.total !== summary.total;
  if (changed) tasks.update(taskId, { todoProgress: summary });
}

/**
 * Claude-code-only: detect and persist `ExitPlanMode` plan history from the
 * generic chunk stream, mirroring `detectCursorPlan`'s "pure helper in
 * task-plans.ts + thin DB-touching wrapper here" split. Unlike cursor's
 * detection (run-settlement only), this runs on every `tool_use`/
 * `tool_result` chunk as it arrives — claude's plan-approval loop is a live
 * keystroke-driven flow the run panel needs to reflect in near-real-time
 * (plan §3/§6), not just after the run resolves.
 *
 * - `tool_use` chunk with `name === "ExitPlanMode"` → `upsertClaudePlanFromExitPlanMode`
 *   records a `pending` plan keyed by the tool_use's `id`, superseding any
 *   prior pending claude plan.
 * - `tool_result` chunk whose `toolUseId` matches a `pending` claude plan →
 *   `resolveClaudePlan` transitions it to `approved` (capturing an edited
 *   plan when present) or `rejected`.
 *
 * Re-reads `tasks.get` rather than trusting a snapshot, same race-avoidance
 * rationale as `detectCursorPlan`: `plans` can be mutated concurrently (e.g.
 * a PATCH edit path on some other plan kind, or two chunks for the same task
 * landing in close succession), and both `task-plans.ts` helpers are pure
 * transforms over whatever array they're handed. Never throws — same
 * try/catch-at-call-site contract as `detectCursorPlan`.
 *
 * Two cheap pre-filters keep `JSON.parse` off the common-case chunk (this
 * runs on EVERY `tool_use`/`tool_result` chunk of every claude-code run —
 * assistant text/thinking chunks never reach here at all, but tool chunks
 * for ordinary tools like Read/Write/Bash are still the overwhelming
 * majority, and a large `tool_result` — a big file read, a long command's
 * output — is exactly the case where an unconditional parse is wasteful):
 *  - `tool_use`: skip unless `data` contains the literal `"name":"ExitPlanMode"`
 *    envelope substring (see `claude-tmux.ts`'s unspaced `JSON.stringify`).
 *  - `tool_result`: skip unless the task already has a `pending` claude plan
 *    — `resolveClaudePlan` only ever acts on a `tool_result` whose
 *    `toolUseId` matches an existing pending plan, so with none pending
 *    there is nothing this chunk could possibly resolve. This read is cheap
 *    relative to parsing a potentially large result body, and results in
 *    exactly one `tasks.get` either way (reused below, not re-fetched).
 */
function maybeTrackClaudePlan(taskId: string, runId: string, stream: RunEvent["stream"], data: string): void {
  let task: Task | null;
  if (stream === "tool_use") {
    if (!data.includes('"name":"ExitPlanMode"')) return;
    task = null; // fetched below, after confirming the parse is worthwhile
  } else if (stream === "tool_result") {
    task = tasks.get(taskId);
    if (!task || !task.plans.some((p) => p.status === "pending")) return;
  } else {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const chunk = parsed as Record<string, unknown>;

  if (stream === "tool_use") {
    if (chunk.name !== "ExitPlanMode") return;
    const toolCallId = chunk.id;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) return;
    const input = chunk.input;
    if (!input || typeof input !== "object") return;
    const plan = (input as Record<string, unknown>).plan;
    if (typeof plan !== "string" || plan.trim() === "") return;

    task = tasks.get(taskId);
    if (!task) return;
    const next = upsertClaudePlanFromExitPlanMode(task.plans, {
      toolCallId,
      runId,
      content: plan,
      now: Date.now(),
    });
    if (next !== task.plans) tasks.update(taskId, { plans: next });
    return;
  }

  // tool_result — `task` was already fetched (and confirmed to have a
  // pending plan) by the pre-filter above.
  const toolUseId = chunk.toolUseId;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) return;
  const content = chunk.content;
  const resultText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .map((x) => (x && typeof x === "object" && (x as { type?: string }).type === "text" ? (x as { text?: string }).text ?? "" : ""))
        .join("")
      : "";
  if (!resultText) return;

  const next = resolveClaudePlan(task!.plans, toolUseId, resultText, Date.now());
  if (next !== task!.plans) tasks.update(taskId, { plans: next });
}

/** Literal envelope substring for a `SendUserFile` tool_use chunk (see
 *  `claude-tmux.ts`'s unspaced `JSON.stringify({ id, name, input, … })`) —
 *  same cheap-prefilter idea as `TODO_FAMILY_TOOL_USE_MARKERS`, keeping the
 *  common case (every other tool) a single `includes` away from a no-op. */
const SENT_FILES_TOOL_USE_MARKER = '"name":"SendUserFile"';

/** Loose substring pre-check on a `tool_result` chunk's raw JSON, cheaper
 *  than `JSON.parse` + `toolResultText` — a real delivery message always
 *  contains this phrase (`SENT_FILES_DELIVERED_RE` anchors on it), so a
 *  `tool_result` chunk lacking it can only matter when a `tool_use` for the
 *  SAME run is still pending in {@link pendingSentFilesByRun} (checked
 *  first, and cheaply, in `maybeTrackSentFiles` below). */
const SENT_FILES_RESULT_TEXT_MARKER = "delivered to user";

/** Per-run, in-memory `toolUseId → SentFilesRequest` scratch space — plan §3
 *  decision 4. Populated from a `SendUserFile` `tool_use` chunk, consumed
 *  (and removed) by its confirming `tool_result`. Capped at
 *  {@link MAX_PENDING_SENT_FILES_PER_RUN} entries per run (oldest evicted
 *  first via `Map`'s insertion-order iteration) so a pathological run that
 *  never gets a matching result can't grow this unbounded; cleared entirely
 *  once the run leaves `active` (both `attachDoneHandler` settle branches
 *  below) since nothing can arrive for a run that's no longer running. */
const pendingSentFilesByRun = new Map<string, Map<string, SentFilesRequest>>();
const MAX_PENDING_SENT_FILES_PER_RUN = 64;

function rememberSentFilesRequest(runId: string, toolUseId: string, req: SentFilesRequest): void {
  let stash = pendingSentFilesByRun.get(runId);
  if (!stash) {
    stash = new Map();
    pendingSentFilesByRun.set(runId, stash);
  }
  // A repeat tool_use id (shouldn't happen — ids are unique per call — but
  // cheap to guard) re-inserts at the END of Map's iteration order, which is
  // fine: it's still the same entry being tracked, just refreshed.
  stash.delete(toolUseId);
  stash.set(toolUseId, req);
  if (stash.size > MAX_PENDING_SENT_FILES_PER_RUN) {
    const oldestKey = stash.keys().next().value;
    if (oldestKey !== undefined) stash.delete(oldestKey);
  }
}

/**
 * Detect and persist delivered `SendUserFile` files from the generic chunk
 * stream — plan §3 decision 4, `docs/plans/send-files-to-user.md`. Runs for
 * EVERY agent kind (unlike claude-only plan tracking): the fx driver emits
 * a synthetic `SendUserFile` tool_use/tool_result pair in the exact same
 * wire shape claude-tmux uses (`fx-acp.ts`'s dormant `resource_link`
 * mapping), so gating this on `kind` would silently drop fx's sends.
 *
 * - `tool_use` whose data matches {@link SENT_FILES_TOOL_USE_MARKER} and
 *   parses via `parseSentFilesToolUse` is stashed in
 *   {@link pendingSentFilesByRun} keyed by its tool_use id — nothing is
 *   persisted yet (persisting on request, not delivery, would count files
 *   that were never actually delivered).
 * - `tool_result` looks up its `toolUseId` in the stash first (the common
 *   case — same run, no restart in between). On a miss, falls back to
 *   `runs.findToolUseEvent` (a restart or reattach-replay dropped the
 *   in-memory stash) — re-parsing the original tool_use from `run_events` —
 *   but only when the result text itself looks like a delivery
 *   confirmation ({@link SENT_FILES_DELIVERED_RE}), so an ordinary
 *   tool_result for some unrelated tool never pays for the DB lookup. A
 *   still-unresolved `toolUseId` (map miss + fallback miss, e.g. a
 *   coincidental "delivered to user" phrase in some other tool's output
 *   with no matching `SendUserFile` request) is a silent no-op.
 * - A delivered (non-error, {@link parseSentFilesToolResult}'s content-aware
 *   `delivered` check) result persists one {@link SentFileEntry} per
 *   ENTRY IN `res.attachments` when that array is non-empty — claude's own
 *   structured, authoritative record of what actually went out — and falls
 *   back to one entry per `req.files` path only when `res.attachments` is
 *   empty (an unrecognized-but-attachment-less success shape). This means a
 *   request for N files whose attachments only confirm M < N of them
 *   persists M entries, not N — attachments are the ground truth for "what
 *   was delivered", the request is only "what was asked for". Persistence
 *   goes through `tasks.mergeSentFiles` (dedupes by path — a replayed pair,
 *   or the same file delivered twice, is idempotent) and fires the
 *   live-only `files-sent` `GlobalEvent` with `count = entries.length`
 *   (reflecting whichever source produced the entries). A non-delivered
 *   result (`is_error`, or a non-error result that still didn't deliver —
 *   e.g. a declined/interrupted call, see `sent-files.ts`) persists nothing
 *   and fires nothing — it shouldn't inflate the badge.
 *
 * Relative paths (in `res.attachments` paths, or in `req.files` on the
 * fallback) resolve against the run's cwd (`task.worktreePath ??
 * task.workdir` — the same precedence `/open-path` uses); an already-
 * absolute path passes through unchanged. When sourced from attachments,
 * `size`/`mediaType`/`isImage` come straight off that attachment; on the
 * `req.files` fallback (no attachments at all) they're `null`.
 *
 * Gated on `eventId !== null` at the very top: `null` means
 * `runs.appendEvent`'s dedup path found the row already persisted (a
 * reattach replay re-delivering a line this process already streamed
 * before a restart) — that pair was already handled the first time
 * through, so re-running detection here would be redundant work at best
 * and, for the `tool_use` stash, would re-add an entry nothing will ever
 * consume (its `tool_result` was already deduped away too, on the same
 * replay). Never throws — the caller wraps this in try/catch, same
 * "detection bugs must never break run settlement" contract as
 * `maybeUpdateTodoProgress`/`maybeTrackClaudePlan` above.
 */
function maybeTrackSentFiles(
  taskId: string,
  runId: string,
  stream: RunEvent["stream"],
  data: string,
  eventId: number | null,
): void {
  if (eventId === null) return;

  if (stream === "tool_use") {
    if (!data.includes(SENT_FILES_TOOL_USE_MARKER)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const chunk = parsed as Record<string, unknown>;
    const toolUseId = chunk.id;
    const name = chunk.name;
    if (typeof toolUseId !== "string" || toolUseId.length === 0) return;
    if (typeof name !== "string") return;

    const req = parseSentFilesToolUse(name, chunk.input);
    if (!req) return;
    rememberSentFilesRequest(runId, toolUseId, req);
    return;
  }

  if (stream !== "tool_result") return;

  const stash = pendingSentFilesByRun.get(runId);
  const hasPending = !!stash && stash.size > 0;
  if (!hasPending && !data.includes(SENT_FILES_RESULT_TEXT_MARKER)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const chunk = parsed as Record<string, unknown>;
  const toolUseId = chunk.toolUseId;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) return;

  let req: SentFilesRequest | null = stash?.get(toolUseId) ?? null;
  if (req) {
    stash!.delete(toolUseId);
  } else {
    if (!SENT_FILES_DELIVERED_RE.test(toolResultText(chunk.content))) return;
    const fallback = runs.findToolUseEvent(runId, toolUseId);
    if (!fallback) return;

    let fallbackParsed: unknown;
    try {
      fallbackParsed = JSON.parse(fallback.data);
    } catch {
      return;
    }
    if (!fallbackParsed || typeof fallbackParsed !== "object") return;
    const fallbackChunk = fallbackParsed as Record<string, unknown>;
    const fallbackName = fallbackChunk.name;
    if (typeof fallbackName !== "string") return;
    req = parseSentFilesToolUse(fallbackName, fallbackChunk.input);
    if (!req) return;
  }

  const isError = chunk.isError === true;
  const attachments = sanitizeToolResultAttachments(chunk.attachments) ?? [];
  const res = parseSentFilesToolResult(chunk.content, isError, attachments);
  if (!res.delivered) return;

  const task = tasks.get(taskId);
  if (!task) return;
  const cwd = task.worktreePath ?? task.workdir;

  const now = Date.now();
  const resolveAgainstCwd = (rawPath: string): string =>
    isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  // res.attachments is claude's own structured, authoritative record of what
  // was actually delivered — prefer it over the request whenever it's
  // non-empty: a request for N files whose attachments only confirm M < N
  // of them persists M entries, carrying each attachment's real size/type,
  // not N entries padded with nulls for files that may never have gone out.
  // Fall back to req.files (no metadata) only when the result reports no
  // attachments at all.
  const entries: SentFileEntry[] = res.attachments.length > 0
    ? res.attachments.map((a) => ({
        path: resolveAgainstCwd(a.path),
        size: a.size,
        mediaType: a.mediaType,
        isImage: a.isImage,
        sentAt: now,
        runId,
      }))
    : req.files.map((rawPath) => ({
        path: resolveAgainstCwd(rawPath),
        size: null,
        mediaType: null,
        isImage: null,
        sentAt: now,
        runId,
      }));

  tasks.mergeSentFiles(taskId, entries);
  emitGlobal({
    kind: "files-sent",
    taskId,
    runId,
    count: entries.length,
    caption: req.caption,
    proactive: req.status === "proactive",
    ts: now,
  });
}

/**
 * Per-run chunk handler. Appends every event to `run_events`, fans out to
 * SSE listeners, and runs the claude API-error → `blocked` flip.
 *
 * Note: there is no longer a codex approval-prompt heuristic. Codex now runs
 * non-interactively via `codex exec --json` (`--full-auto` auto-approves;
 * `ask` falls back to a read-only sandbox), so it never emits an interactive
 * "waiting on approval" prompt to its output stream — the old raw-stdout
 * heuristic had no signal to match. `mode` is retained on the signature for
 * symmetry with the claude path and possible future use.
 */
function makeChunkHandler(
  runId: string,
  taskId: string,
  kind: AgentKind,
  _mode: Task["mode"],
) {
  return (stream: RunEvent["stream"], data: string, lineUuid?: string) => {
    const eventId = runs.appendEvent(runId, stream, data, lineUuid);
    emit({ runId, taskId, stream, data, ts: Date.now() });
    // Todo/task-tools board summary: re-derive + persist on any
    // TodoWrite/TaskCreate/TaskUpdate chunk, for every agent kind. Cheap
    // substring pre-filter keeps the common case (unrelated chunks) a no-op.
    if (isTodoFamilyChunk(stream, data)) {
      try {
        maybeUpdateTodoProgress(taskId);
      } catch {
        // Never let todo-progress derivation break run settlement.
      }
    }
    // Unread-indicator watermark: bump on every top-level assistant event.
    // `makeChunkHandler`'s closure has no `subagentId` — every call site that
    // builds one (see the `onChunk` call sites above) is the MAIN-stream
    // dispatcher for a task's own run. Subagent transcript lines never reach
    // here at all: they're appended via a completely separate call site
    // (`runs.appendEvent(fs.runId, stream, data, lineUuid, fs.subagentId)` in
    // claude-subagents.ts) with their own `emitFn`, and the live-only
    // `"subagent"` stream (lifecycle deltas) is explicitly never persisted
    // (see `RunEventStream`'s doc comment in shared/types.ts) — so it can't
    // reach `appendEvent` either. That makes every `stream === "assistant"`
    // chunk seen here unconditionally "no subagent attribution" by
    // construction; no extra `subagent_id` check is needed (or possible —
    // this closure never receives one). `eventId` is `null` when
    // `appendEvent`'s dedup (`INSERT OR IGNORE` on `line_uuid`) found the row
    // already persisted — e.g. a reattach replay re-delivering a line this
    // process already streamed before restart — in which case the watermark
    // was already bumped by the original insert and must not be bumped
    // again here.
    if (stream === "assistant" && eventId != null) {
      try {
        tasks.noteAssistantEvent(taskId, eventId);
      } catch {
        // Never let unread-watermark tracking break run settlement.
      }
    }
    // Claude plan history: ExitPlanMode tool_use/tool_result pairs, claude
    // only — cursor's plan detection stays exclusively in `detectCursorPlan`
    // at run settlement.
    if (kind === "claude-code") {
      try {
        maybeTrackClaudePlan(taskId, runId, stream, data);
      } catch {
        // Never let plan-history tracking break run settlement.
      }
    }
    // Sent-files ("Files sent to you" cards): SendUserFile tool_use/
    // tool_result pairs, every agent kind (fx synthesizes the same pair).
    try {
      maybeTrackSentFiles(taskId, runId, stream, data, eventId);
    } catch {
      // Never let sent-files detection break run settlement.
    }
    // Claude API-error path: claude-tmux emits a sentinel status chunk on
    // synthetic `isApiErrorMessage` lines (529, 400, …) and resolves the
    // turn. Flip to `blocked` here so the card stops sitting in `running`,
    // and mark the handle so `attachDoneHandler` doesn't bounce it back to
    // `ready` when the resolution lands a moment later.
    if (
      kind === "claude-code"
      && stream === "status"
      && data.startsWith(CLAUDE_API_ERROR_STATUS_PREFIX)
    ) {
      const handle = active.get(runId);
      if (handle && !handle.apiError) {
        handle.apiError = true;
        const task = tasks.get(taskId);
        if (task && task.runId === runId) {
          updateColumn(taskId, runId, "blocked", "api-error");
        }
      }
    }
    // Session-died path (both agents): the driver emits this sentinel when a
    // running turn's tmux session vanished. Flip to `blocked` so the card
    // stops sitting in `running`, and mark the handle so `attachDoneHandler`
    // keeps it there (and records `failed`) when the run settles a beat later.
    if (stream === "status" && data.startsWith(SESSION_DIED_STATUS_PREFIX)) {
      const handle = active.get(runId);
      if (handle && !handle.sessionDied) {
        handle.sessionDied = true;
        const task = tasks.get(taskId);
        if (task && task.runId === runId) {
          updateColumn(taskId, runId, "blocked", "session-died");
        }
      }
    }
    // Turn-stall watchdog path (claude-code only today — codex/gemini/cursor
    // turns are headless one-shots with no TUI to wedge on): the driver flags
    // an in-flight turn whose transcript has gone silent past the stall
    // threshold. Soft signal only — the session is alive, so no column flip,
    // no handle flag, no settle; just mark/unmark the task so the API can
    // decorate `stalledSince` and the board can show "may be stuck".
    if (stream === "status" && data.startsWith(TURN_STALLED_STATUS_PREFIX)) {
      const task = tasks.get(taskId);
      if (task && task.runId === runId) markStalled(taskId, Date.now());
    }
    if (stream === "status" && data.startsWith(TURN_STALL_RESUMED_STATUS_PREFIX)) {
      clearStalled(taskId);
    }
    // Unknown-slash-command path (claude-code only): claude's TUI rejected
    // the pasted message as an unknown slash command — no JSONL line was
    // ever written for it, so claude-tmux's pane scraper is the only source
    // of this sentinel. Flip to `blocked` here so the card stops sitting in
    // `running`, and mark the handle so `attachDoneHandler` doesn't bounce
    // it back to `ready` when the resolution lands a moment later.
    if (
      kind === "claude-code"
      && stream === "status"
      && data.startsWith(CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX)
    ) {
      const handle = active.get(runId);
      if (handle && !handle.unknownCommand) {
        handle.unknownCommand = true;
        const task = tasks.get(taskId);
        if (task && task.runId === runId) {
          updateColumn(taskId, runId, "blocked", "unknown-command");
        }
      }
    }
  };
}

function registerActiveRun(
  runId: string,
  taskId: string,
  task: Task,
  // NOT `ReturnType<typeof spawnAgent>` — `spawnAgent` itself resolves to
  // `Promise<SpawnedAgent>` (wave 1 async contract); every caller here
  // already passes the awaited value. Using the raw ReturnType would
  // silently retype this as `Promise<SpawnedAgent>` the moment agents.ts
  // lands its own async conversion, breaking every call site with no
  // typecheck signal in THIS file (the mismatch would only surface as a
  // runtime `.kill is not a function` once a Promise is stored and later
  // used as if it were the resolved agent).
  agent: SpawnedAgent,
): void {
  active.set(runId, {
    taskId,
    agent: task.agent,
    kill: () => agent.kill(),
    cancelled: false,
    apiError: false,
    sessionDied: false,
    unknownCommand: false,
    writeInput: (line) => agent.writeInput(line),
  });
}

/**
 * Cursor-only: when a run resolves `succeeded`, check whether its LAST
 * `tool_use` event is `createPlanToolCall` — cursor's "finished after
 * planning" signature (plan §2, confirmed 5/5 on real runs) — and if so,
 * persist a `TaskPlan` record on the task. Kind is resolved the same way
 * `sendInput`'s cursor branch resolves it (`resolveHarness(task.agent)?.kind`)
 * so an aliased harness (multi-account) is still recognized as cursor.
 *
 * Re-reads `tasks.get` rather than trusting the `task` snapshot the caller
 * already has — `attachDoneHandler`'s two call sites for a given task can in
 * principle race a concurrent `plans` write (e.g. a PATCH edit landing
 * between the caller's fetch and this running), and `upsertDetectedPlan` is
 * a pure transform over whatever `plans` array it's given, so reading fresh
 * avoids clobbering that write.
 *
 * Never throws — the caller wraps this in try/catch too (belt-and-braces),
 * but every internal failure mode (malformed JSON, missing/empty plan text,
 * unexpected shapes) already resolves to a silent no-op here, matching plan
 * §7: a detection failure must never break run settlement.
 */
function detectCursorPlan(task: Task, runId: string): void {
  if (resolveHarness(task.agent)?.kind !== "cursor") return;

  const lastToolUse = runs.lastToolUseData(runId);
  if (lastToolUse === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastToolUse);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const chunk = parsed as Record<string, unknown>;
  if (chunk.name !== "createPlanToolCall") return;

  const callId = chunk.id;
  if (typeof callId !== "string" || callId.length === 0) return;
  const input = chunk.input;
  if (!input || typeof input !== "object") return;
  const createPlanToolCall = (input as Record<string, unknown>).createPlanToolCall;
  if (!createPlanToolCall || typeof createPlanToolCall !== "object") return;
  const args = (createPlanToolCall as Record<string, unknown>).args;
  if (!args || typeof args !== "object") return;
  const plan = (args as Record<string, unknown>).plan;
  if (typeof plan !== "string" || plan.trim() === "") return;
  const nameRaw = (args as Record<string, unknown>).name;
  const name = typeof nameRaw === "string" ? nameRaw : null;

  const fresh = tasks.get(task.id);
  if (!fresh) return;
  const nextPlans = upsertDetectedPlan(fresh.plans, {
    toolCallId: callId,
    runId,
    name,
    content: plan,
    now: Date.now(),
  });
  if (nextPlans !== fresh.plans) tasks.update(task.id, { plans: nextPlans });
}

/**
 * Wire the per-run `done` promise to its terminal DB / event side-effects.
 * Pulled out so `startTask` and `sendInput` (which also creates run rows for
 * claude-code) can share the lifecycle handling.
 */
function attachDoneHandler(
  runId: string,
  taskId: string,
  // See `registerActiveRun`'s doc: `SpawnedAgent`, not
  // `ReturnType<typeof spawnAgent>` — every caller passes the already-awaited
  // agent handle, never the promise `spawnAgent` itself returns.
  agent: SpawnedAgent,
): void {
  agent.done
    // Async: `drainCodexQueue`/`drainCursorQueue`/`drainGeminiQueue`/
    // `drainFxQueue` below now await their own spawn (wave 1's async
    // `spawnAgentOrFail`). This callback is never itself awaited by anything
    // (attachDoneHandler returns void; the `.then()`/`.catch()` chain is
    // fire-and-forget from every caller's perspective, same as before), so
    // making it `async` only changes how ITS OWN internal steps are
    // sequenced — still strictly sequential, matching the pre-wave-1
    // back-to-back synchronous calls exactly. A throw here still flows into
    // the `.catch()` below exactly as a synchronous throw always did.
    .then(async (code) => {
      const handle = active.get(runId);
      const wasCancelled = handle?.cancelled ?? false;
      const wasApiError = handle?.apiError ?? false;
      const wasSessionDied = handle?.sessionDied ?? false;
      const wasUnknownCommand = handle?.unknownCommand ?? false;
      active.delete(runId);
      // Nothing can arrive for a run that's no longer running — drop its
      // sent-files scratch space (plan §3 decision 4) so it can't leak.
      pendingSentFilesByRun.delete(runId);

      // API error / session-death / unknown-command override the exit-code
      // mapping: the driver resolves the turn with code 0 (a clean end_turn
      // was staged), but the run really failed — record it as such so the
      // badge and history are honest.
      const newStatus: RunStatus = wasCancelled
        ? "cancelled"
        : (wasApiError || wasSessionDied || wasUnknownCommand) ? "failed"
        : code === 0 ? "succeeded" : "failed";
      runs.update(runId, { status: newStatus, endedAt: Date.now(), exitCode: code });
      // Only flip the task's column when the run that just resolved is
      // still the latest one. If the user pipelined a follow-up while
      // this run was in flight, `task.runId` already points at the
      // queued run — leave the task in `running` so the UI doesn't
      // briefly bounce to `review`/`ready` between turns. The global
      // run-status emit is gated on the same condition so the toast
      // hook doesn't fire "succeeded" mid-conversation for a turn the
      // user has already moved past.
      const task = tasks.get(taskId);
      // Cursor plan detection: runs whenever THIS run resolved `succeeded`,
      // not gated on `isTerminalRun` — a folded/superseded run's tool_use
      // history is just as real, and `upsertDetectedPlan`'s supersede
      // transition already handles a newer plan landing while an older one
      // is still pending. Wrapped so a detection bug can never break run
      // settlement (plan §7 blast radius).
      if (newStatus === "succeeded" && task) {
        try {
          detectCursorPlan(task, runId);
        } catch {
          // Never let plan detection break run settlement.
        }
      }
      const isTerminalRun = !!task && task.runId === runId;
      if (isTerminalRun) {
        // A clean success with background agents still in flight is HELD in
        // `running` rather than advanced to `review` — the run finished but the
        // task's work hasn't. `runs.update(..., "succeeded")` already landed
        // above, so the concurrent-settle path (`maybeReleaseHeldTask`) reads
        // the correct terminal status; whichever of the two fires last wins and
        // both interleavings converge on the right column, so no lock is needed.
        // Give the subagent watcher one synchronous cycle before asking it
        // whether anything is still running. The rows that answer that
        // question are created by the watcher's own poll, and a task that has
        // not discovered a background agent yet polls on the SLOW/DEEP_IDLE
        // tier (4-10s) — while this runs ~END_TURN_IDLE_FIRE_MS after the
        // turn's end_turn. So an agent (or a `/workflow`) launched in the
        // closing moments of a turn is usually NOT in the DB yet at this
        // point, and the card would flip to `review` only to be dragged back
        // by `pullBackParkedTask` a few seconds later — a visible bounce and a
        // misleading breadcrumb. Pumping here reads the launch line that is
        // already on disk and makes the hold decision deterministic.
        try {
          pumpWatcherForHoldCheck(taskId);
        } catch {
          // Belt-and-braces: the callee already swallows its own errors, but a
          // watcher problem must never derail run settlement.
        }
        const holdForSubagents =
          newStatus === "succeeded"
          && !wasCancelled
          && !wasApiError
          && !wasSessionDied
          && !wasUnknownCommand
          && subagents.hasRunning(taskId);
        if (holdForSubagents) {
          const runningCount = subagents.runningCountForTask(taskId);
          emit({
            runId,
            taskId,
            stream: "status",
            data: `background agents still running (${runningCount}) — holding in running`,
            ts: Date.now(),
          });
        } else if (task.parentTaskId != null) {
          const outcome: PipelineOutcome = wasCancelled
            ? { kind: "cancelled" }
            : wasApiError ? { kind: "hard-failure", reason: "api-error" }
            : wasSessionDied ? { kind: "hard-failure", reason: "session-died" }
            : wasUnknownCommand ? { kind: "hard-failure", reason: "unknown-command" }
            : { kind: "success" };
          settleChildRun(taskId, runId, outcome);
        } else if (task.pipelineStage != null) {
          const outcome: PipelineOutcome = wasCancelled
            ? { kind: "cancelled" }
            : wasApiError ? { kind: "hard-failure", reason: "api-error" }
            : wasSessionDied ? { kind: "hard-failure", reason: "session-died" }
            : wasUnknownCommand ? { kind: "hard-failure", reason: "unknown-command" }
            : { kind: "success" };
          advancePipelineStage(taskId, runId, outcome);
        } else {
          // Cancellation wins over api-error here, matching the newStatus
          // resolution above — a user-cancelled run shouldn't land in
          // `blocked` just because it had previously hit an API error.
          const nextColumn: ColumnId = wasCancelled
            ? "ready"
            : (wasApiError || wasSessionDied || wasUnknownCommand) ? "blocked"
            : newStatus === "succeeded" ? "review" : "ready";
          // This re-affirms the SAME `blocked` column the chunk-handler
          // already flipped to (with its own reason) a moment earlier — pass
          // the reason again here too, or `updateColumn` would clear it back
          // to null.
          const nextReason = wasApiError ? "api-error" : wasSessionDied ? "session-died" : wasUnknownCommand ? "unknown-command" : undefined;
          updateColumn(taskId, runId, nextColumn, nextReason);
        }
      }
      emit({
        runId,
        taskId,
        stream: "status",
        data: wasCancelled ? `cancelled (exit:${code})` : `exit:${code}`,
        ts: Date.now(),
      });
      if (isTerminalRun) {
        emitGlobal({ kind: "run-status", taskId, runId, status: newStatus, ts: Date.now() });
      }
      // Spawn the next queued codex/cursor/gemini/fx follow-up, if any (no-op
      // for a task of a different kind).
      await drainCodexQueue(taskId);
      await drainCursorQueue(taskId);
      await drainGeminiQueue(taskId);
      await drainFxQueue(taskId);
    })
    .catch(async (err) => {
      const handle = active.get(runId);
      const wasCancelled = handle?.cancelled ?? false;
      const wasSessionDied = handle?.sessionDied ?? false;
      const wasUnknownCommand = handle?.unknownCommand ?? false;
      active.delete(runId);
      pendingSentFilesByRun.delete(runId);
      const newStatus: RunStatus = wasCancelled ? "cancelled" : "failed";
      runs.update(runId, { status: newStatus, endedAt: Date.now(), exitCode: -1 });
      const task = tasks.get(taskId);
      const isTerminalRun = !!task && task.runId === runId;
      if (isTerminalRun) {
        if (task.parentTaskId != null) {
          const outcome: PipelineOutcome = wasCancelled
            ? { kind: "cancelled" }
            : wasSessionDied ? { kind: "hard-failure", reason: "session-died" }
            : wasUnknownCommand ? { kind: "hard-failure", reason: "unknown-command" }
            : { kind: "hard-failure", reason: "pipeline-failed" };
          settleChildRun(taskId, runId, outcome);
        } else if (task.pipelineStage != null) {
          const outcome: PipelineOutcome = wasCancelled
            ? { kind: "cancelled" }
            : wasSessionDied ? { kind: "hard-failure", reason: "session-died" }
            : wasUnknownCommand ? { kind: "hard-failure", reason: "unknown-command" }
            // A bare rejection with none of the sentinel flags set isn't
            // meant to happen today (see the comment below) — a genuinely
            // unexpected internal error, not any of the three known causes.
            : { kind: "hard-failure", reason: "pipeline-failed" };
          advancePipelineStage(taskId, runId, outcome);
        } else {
          // A session-death / unknown-command that reaches the reject path (not
          // the case today — both drivers resolve on these — but keep the
          // column consistent with the resolve path if a future refactor ever
          // rejects instead). Pass the reason too — see the matching comment
          // on the resolve-path's `updateColumn` call above.
          updateColumn(
            taskId, runId,
            (wasSessionDied || wasUnknownCommand) ? "blocked" : "ready",
            wasSessionDied ? "session-died" : wasUnknownCommand ? "unknown-command" : undefined,
          );
        }
      }
      emit({
        runId,
        taskId,
        stream: wasCancelled ? "status" : "stderr",
        data: wasCancelled ? "cancelled" : String(err),
        ts: Date.now(),
      });
      if (isTerminalRun) {
        emitGlobal({ kind: "run-status", taskId, runId, status: newStatus, ts: Date.now() });
      }
      // Spawn the next queued codex/cursor/gemini/fx follow-up, if any (no-op
      // for a task of a different kind).
      await drainCodexQueue(taskId);
      await drainCursorQueue(taskId);
      await drainGeminiQueue(taskId);
      await drainFxQueue(taskId);
    });
}

export type PipelineOutcome =
  | { kind: "success" }
  | { kind: "cancelled" }
  | { kind: "hard-failure"; reason: "api-error" | "session-died" | "unknown-command" | "pipeline-failed" };

/** Read a run's LAST main-stream (non-subagent) assistant message and parse
 *  it for the PIPELINE_VERDICT sentinel. `{ ok: false }` when the run has no
 *  assistant output at all (shouldn't happen for a real turn, but a fake
 *  driver or a crash-before-first-token run could hit this). */
function lastPipelineVerdict(runId: string, stage: "plan-review"): PlanReviewVerdict;
function lastPipelineVerdict(runId: string, stage: "testing"): TestingVerdict;
function lastPipelineVerdict(runId: string, stage: "code-review"): PlanReviewVerdict;
function lastPipelineVerdict(
  runId: string,
  stage: "plan-review" | "testing" | "code-review",
): PlanReviewVerdict | TestingVerdict {
  const events = runs.events(runId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.stream === "assistant" && e.subagentId == null) {
      if (stage === "testing") return parsePipelineVerdict("testing", e.data);
      if (stage === "code-review") return parsePipelineVerdict("code-review", e.data);
      return parsePipelineVerdict("plan-review", e.data);
    }
  }
  return { ok: false };
}

/**
 * Close a pipeline stage's claude session once the stage has settled. Every
 * stage runs in a fresh session (startTask → spawnClaudeViaTmux kills the
 * same-named session before `tmux new-session`), so a settled stage's REPL
 * has no future — yet it lingered for the whole of the next stage (or the
 * whole build, for the decompose session while children ran), holding
 * 300–500MB and, worse, staying eligible for claude's own auto-continuation:
 * a background task left over from the turn finishes, claude auto-continues,
 * and a full-context `continuation` run burns tokens on a stage the
 * pipeline already left (2.3M tokens across two measured pipelines; RC-6
 * refuses to *act* on such runs but can't stop them being *spent*). See
 * docs/plans/pipeline-token-efficiency.md O-7.
 *
 * Never on `blocked` (the human may want to talk to the failed session) and
 * never while a turn is in flight (`active`) — this is called strictly on
 * the settle → next-stage / done edges. claude-code only: codex/gemini
 * sessions are one-shot per turn and already gone. Emits a status line on
 * the settled run so the run log (and the gate tests) can see it happened.
 */
function dropSettledStageSession(taskId: string, runId: string | null): void {
  const task = tasks.get(taskId);
  if (!task || task.parentTaskId != null) return; // children settle through completeChildBuild → archive
  if (resolveHarness(task.agent)?.kind !== "claude-code") return;
  if (task.runId && active.has(task.runId)) return;
  try {
    dropSession(taskId);
    if (runId) pipelineStatus(runId, taskId, `stage "${task.pipelineStage}" settled — its agent session was closed (a fresh session runs the next stage)`);
  } catch (err) {
    console.error(`[agetor] dropSettledStageSession failed for task ${taskId}:`, err);
  }
}

/**
 * The Tester gate (O-5): after the Code Reviewer approves, run the repo's
 * typecheck/lint/test ourselves (deterministic space) before spending an
 * agent turn on it. Three outcomes:
 *   - no known commands / precheck disabled → spawn the Tester as before;
 *   - all commands green AND every SPEC.md AC id is referenced from a test
 *     file → skip the Tester: `implementationApproved`, `done`, with the
 *     command tails recorded as status events (unless
 *     AGETOR_PIPELINE_TESTER_SKIP=0);
 *   - anything red, or an AC no test mentions → spawn the Tester with the
 *     summary folded into its prompt (pipelineState.precheck), so it starts
 *     from the failures instead of rediscovering how to run the project.
 * Fail-open: any exception falls back to spawning the Tester untouched.
 */
async function runTesterGate(taskId: string, runId: string): Promise<void> {
  const spawnTester = () => spawnPipelineStage(taskId, runId, "testing", { pipelineFeedback: null, pipelineBounceFingerprint: null });
  const task = tasks.get(taskId);
  if (!task) return;
  if (!precheckEnabled()) { pipelineState.setPrecheck(taskId, null); spawnTester(); return; }
  try {
    const cwd = task.worktreePath ?? task.workdir;
    const profile = readRepoProfile(cwd);
    if (!profile.typecheck && !profile.lint && !profile.test) {
      pipelineState.setPrecheck(taskId, null);
      spawnTester();
      return;
    }
    const specPath = join(cwd, PIPELINE_SPEC_FILE);
    let specAcIds: string[] = [];
    if (existsSync(specPath)) {
      try { specAcIds = parseSpecAcceptanceCriteria(readFileSync(specPath, "utf8")); } catch { /* no ACs */ }
    }
    pipelineStatus(runId, taskId, "code review approved — running the project's own checks before the Tester");
    const summary = await runPipelinePrecheck({
      cwd, profile, specAcIds,
      onProgress: (line) => pipelineStatus(runId, taskId, line),
    });
    // The world may have moved while the checks ran (delete, pause, a human
    // override). Only act if the task is still where we left it.
    const now = tasks.get(taskId);
    if (!now || now.pipelineStage !== "code-review" || now.runId !== runId) return;
    if (precheckPasses(summary) && testerSkipEnabled()) {
      pipelineStatus(
        runId, taskId,
        `precheck green (${summary.results.map((r) => r.name).join(", ")}) and every AC-N is referenced from a test file — ` +
        `Tester turn skipped; pipeline complete`,
      );
      pipelineState.setPrecheck(taskId, null);
      tasks.update(taskId, { implementationApproved: true, pipelineFeedback: null, pipelineBounceFingerprint: null });
      dropSettledStageSession(taskId, runId);
      updateColumn(taskId, runId, "done", "stage-advance");
      return;
    }
    const failed = summary.results.filter((r) => !r.ok).map((r) => r.name);
    pipelineStatus(
      runId, taskId,
      failed.length > 0
        ? `precheck: ${failed.join(", ")} failed — spawning the Tester with the failure output`
        : `precheck green but ${summary.unreferencedAcs.join(", ")} not referenced by any test — spawning the Tester to verify`,
    );
    pipelineState.setPrecheck(taskId, summary);
    spawnTester();
  } catch (err) {
    console.error(`[agetor] tester precheck failed for task ${taskId}; spawning the Tester untouched:`, err);
    pipelineState.setPrecheck(taskId, null);
    if (tasks.get(taskId)?.pipelineStage === "code-review") spawnTester();
  }
}

/**
 * Move a pipeline task to `nextStage`, persisting `patch` first so
 * `startTask` (which re-reads the task row) picks up the new stage's
 * prompt and, on a resume, the new `pipelineFeedback`. If the task was
 * paused, the column still lands on the target stage (so the card
 * reflects where it's "at"), but no run is spawned — resuming (or, for a
 * "building" fresh-entry, `tickBuild` continuing) fires it later.
 *
 * Hoisted out of `advancePipelineStage` (was a trapped closure there) so
 * build-scheduler.ts's `tickBuild` can call it too, for the ONE transition
 * `advancePipelineStage` itself never reaches: the "building" barrier
 * completing (parent has no terminal run of its own to trigger
 * `attachDoneHandler` in fresh-entry/DAG mode — see build-scheduler.ts).
 * `runId` is nullable for exactly that caller (no run to attribute the
 * column-change event to).
 */
export function spawnPipelineStage(
  taskId: string,
  runId: string | null,
  nextStage: NonNullable<Task["pipelineStage"]>,
  patch: Partial<Task> = {},
): void {
  // Close the settled stage's session BEFORE the stage flip is observable
  // as "running the next stage" — the previous stage is over either way,
  // paused or not (O-7).
  dropSettledStageSession(taskId, runId);
  tasks.update(taskId, { pipelineStage: nextStage, ...patch });
  updateColumn(taskId, runId, nextStage, "stage-advance");
  if (tasks.get(taskId)?.pausedAt != null) return;
  void startTask(taskId).then(
    (result) => {
      // startTask signals failure by RESOLVING with { error }, not by
      // rejecting — a bare .catch() alone would miss this (harness
      // unavailable, bad workdir, etc. all resolve this way).
      if ("error" in result && tasks.get(taskId)?.runId == null) {
        console.error(`[agetor] pipeline auto-advance failed for task ${taskId} (stage ${nextStage}): ${result.error}`);
        updateColumn(taskId, null, "blocked", "pipeline-failed");
      }
    },
    (err) => {
      console.error(`[agetor] pipeline auto-advance failed for task ${taskId} (stage ${nextStage}):`, err);
      // Nothing else surfaces a startTask failure here — land it on
      // blocked ourselves so the task doesn't silently stall.
      if (tasks.get(taskId)?.runId == null) {
        updateColumn(taskId, null, "blocked", "pipeline-failed");
      }
    },
  );
}

/**
 * Block a pipeline task (its own `updateColumn(..., "blocked", reason)`
 * plus an optional `pipelineFeedback` patch naming why). Exported so
 * build-scheduler.ts can call it on a merge conflict or a child hard
 * failure without reaching into orchestrator-private state itself.
 */
export function blockPipelineTask(
  taskId: string,
  runId: string | null,
  reason: "api-error" | "session-died" | "unknown-command" | "pipeline-failed" | "revision-cap",
  feedback?: string,
): void {
  if (feedback != null) tasks.update(taskId, { pipelineFeedback: feedback });
  updateColumn(taskId, runId, "blocked", reason);
}

/**
 * Cancel every still-running child of `parentTaskId` — used when one child
 * hard-fails or its merge conflicts, aborting the whole build rather than
 * letting siblings keep working toward a result that's already moot.
 * Exported so build-scheduler.ts can call it without reaching into the
 * `active` map itself (that's `cancelRun`'s job, already exported).
 */
export function cancelSiblingChildren(parentTaskId: string): void {
  for (const child of tasks.list()) {
    if (child.parentTaskId === parentTaskId && child.runId && active.has(child.runId)) {
      cancelRun(child.runId);
    }
  }
}

/**
 * Settle a CHILD task's terminal run — the third branch `attachDoneHandler`
 * checks, ahead of the `pipelineStage` check, since a child is an ordinary
 * task (`pipelineStage: null`; the DAG lives in `parentTaskId`/
 * `planSubtaskId`) that would otherwise fall into the plain `nextColumn`
 * ternary and land a successful child on `review` — wrong, since a
 * successful child still needs its merge-back before anything is truly
 * "done".
 *
 * Success: hands off to build-scheduler.ts's `completeChildBuild`, which
 * merges the child's branch into the parent's and continues the build.
 * Anything else (cancelled or hard-failure): the child moves to `blocked`
 * — never `ready`, which is what the ordinary cancelled-run treatment
 * would do (looks like "nothing to see here, click Run") and would be
 * actively misleading for a child cancelled because a SIBLING failed and
 * the whole build is aborting. If the parent is still actively building
 * (`column === "building"`), THIS is the failure that aborts the build:
 * block the parent and cancel every other still-running sibling. If the
 * parent is already blocked, this settle is itself one of those cascading
 * cancellations — the abort already happened, so it's a no-op past
 * landing this one child on `blocked`.
 *
 * Two gates run before any of that:
 *   - Provenance (RC-6): only a `origin: "pipeline-stage"` run — the
 *     child's own build turn, spawned by startTask — may settle the child's
 *     build state. A user follow-up conversation with a child that happens
 *     to end cleanly must NOT trigger a merge of a possibly-half-done
 *     branch (mergeBranch on a branch with no new commits reports "already
 *     up to date" as success, which would wrongly mark the subtask merged
 *     and unblock its dependents). Restarting the child (Run) is the
 *     explicit way to hand its work back to the pipeline.
 *   - Boot-flake retry (RC-1): a hard failure whose run produced ZERO agent
 *     output (no assistant/tool_use event — claude died before its first
 *     token, e.g. the JSONL-discovery timeout) gets ONE automatic respawn
 *     before the failure escalates to the build-abort cascade. A boot
 *     hiccup and a real build failure are different events; the 2DOT2DOT
 *     run lost its whole build to four consecutive boot flakes that each
 *     hard-aborted everything.
 */
const childBootRetried = new Set<string>();

function runHasNoAgentOutput(runId: string): boolean {
  return runs.events(runId).every((e) => e.stream !== "assistant" && e.stream !== "tool_use");
}

/** Persist + broadcast a status line on a run — the two-step every other
 *  durable status message uses (makeChunkHandler's shape), pulled out for
 *  the pipeline-gate paths that emit outside any chunk handler. */
function pipelineStatus(runId: string, taskId: string, data: string): void {
  runs.appendEvent(runId, "status", data);
  emit({ runId, taskId, stream: "status", data, ts: Date.now() });
}

/**
 * Explicit human hand-back of a build child's finished work to the pipeline
 * — the deliberate counterpart of the RC-6 provenance gate below. The gate
 * refuses to INFER "this work is done" from a chat turn ending cleanly; this
 * route is the human SAYING it, so no inference (and no fresh agent turn) is
 * needed. Deterministic from here: park the child as `merge-deferred` (the
 * exact state `tickBuild` already merges first) and, if the parent is
 * actively building, tick it — the merge, barrier check, and stage advance
 * all reuse the scheduler's existing, tested paths.
 *
 * Guards mirror the derived `awaitingHandBack` flag that renders the button:
 * only a build child, only `childMergeStatus: "pending"`, and only off a
 * SUCCEEDED latest run (which also rules out an in-flight turn — a live run
 * is `"running"`). A failed/cancelled run keeps Run-to-restart as the path.
 */
export async function handBackChild(taskId: string): Promise<{ ok: true } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task || !task.parentTaskId) return { error: "not a build subtask" };
  if (task.archivedAt != null) return { error: "task is archived" };
  if (task.childMergeStatus !== "pending") {
    return { error: `nothing to hand back — merge status is "${task.childMergeStatus}"` };
  }
  const run = task.runId ? runs.get(task.runId) : null;
  if (!run || run.status !== "succeeded") {
    return {
      error: run?.status === "running"
        ? "a turn is still in flight — wait for it to finish first"
        : "the latest run didn't succeed — press Run to restart the build turn instead",
    };
  }
  tasks.update(taskId, { childMergeStatus: "merge-deferred" });
  updateColumn(taskId, run.id, "review");
  pipelineStatus(run.id, taskId, "handed back to the pipeline — merge queued");
  const parent = tasks.get(task.parentTaskId);
  if (parent && parent.pipelineStage === "building" && parent.column === "building") {
    void tickBuild(parent.id).catch((err) => {
      console.error(`[agetor] hand-back: tickBuild failed for parent ${parent.id}:`, err);
    });
  }
  return { ok: true };
}

/**
 * Spawn an agent-driven merge-conflict-resolution turn on a pipeline PARENT
 * whose child's merge-back just conflicted (build-scheduler.ts's
 * `mergeChildIntoParent` is the only caller). The merge has been left IN
 * PROGRESS in the parent's worktree — conflict markers and MERGE_HEAD intact
 * — and the child sits in `childMergeStatus: "merge-conflict"`, which is
 * both the scheduler's "one merge in flight, everyone else defer" latch and
 * how `settleMergeResolution` finds the child again after a restart (no
 * in-memory state to lose).
 *
 * The turn rides the task's normal per-kind conversation machinery
 * (sendClaudeTurn / sendCodexTurn / sendCursorTurn / sendGeminiTurn /
 * sendFxTurn — same session the parent's stage turns used, so the agent has
 * the pipeline context), then the fresh run row is stamped
 * `origin: "pipeline-merge"` so its settle routes to
 * `settleMergeResolution` instead of the stage-advance switch. The
 * stamp-after-spawn is safe: the run can't settle before this async
 * function's continuation finishes (the done handler fires on agent exit,
 * strictly later).
 *
 * Returns false when no resolution turn could be spawned — parent busy
 * (an in-flight run would fold/queue the prompt into the WRONG turn), no
 * session to resume, spawn failure — in which case the caller falls back to
 * the pre-resolution behavior (abort + block + cancel siblings).
 */
export async function spawnMergeResolution(parent: Task, child: Task, conflictDetail: string): Promise<boolean> {
  if (parent.runId && active.has(parent.runId)) return false;
  const prompt = mergeResolutionPrompt(parent, child);
  const kind = resolveHarness(parent.agent)?.kind;
  let runId: string | null = null;
  try {
    if (kind === "claude-code") runId = (await sendClaudeTurn(parent.id, prompt))?.runId ?? null;
    else if (kind === "codex") runId = await sendCodexTurn(parent.id, prompt);
    else if (kind === "cursor") runId = await sendCursorTurn(parent.id, prompt);
    else if (kind === "gemini") runId = await sendGeminiTurn(parent.id, prompt);
    else if (kind === "fx") runId = await sendFxTurn(parent.id, prompt);
  } catch (err) {
    console.error(`[agetor] merge-resolution spawn failed for parent ${parent.id}:`, err);
    return false;
  }
  if (!runId) return false;
  // Defense in depth: the idle guard above should make a fold-into-active-run
  // impossible, but if the returned id is a pre-existing run (already
  // stamped, or mid-flight), do not repurpose it as a merge turn.
  if (runs.get(runId)?.origin != null) return false;
  runs.setOrigin(runId, "pipeline-merge");
  pipelineStatus(
    runId, parent.id,
    `merge of subtask "${child.planSubtaskId}" (branch ${child.branch}) hit conflicts — ` +
    `spawned a merge-resolution turn instead of aborting (${conflictDetail.slice(0, 200)})`,
  );
  return true;
}

/**
 * Settle a `origin: "pipeline-merge"` run (spawned by
 * {@link spawnMergeResolution}). The agent's own outcome is deliberately
 * IGNORED as evidence: whether the merge landed is re-derived from git alone
 * (`isBranchMerged` — merge concluded AND the branch's commits reachable
 * from the parent's HEAD). An agent that resolved+committed but then errored
 * still counts as landed; an agent that reported success but left MERGE_HEAD
 * parked does not — that half-state is exactly what stranded the
 * 2dot2dot-redesign worktree.
 *
 * Landed → child `"merged"`/done + resume the DAG (tickBuild). Not landed →
 * the pre-resolution conflict behavior: abort the merge, child
 * `"merge-failed"`/blocked, parent blocked with a merge-scoped feedback
 * (names the branch, forbids re-implementation — that text is folded into
 * any later "Retry stage" fixup prompt via `buildingPrompt`), siblings
 * cancelled.
 */
async function settleMergeResolution(taskId: string, runId: string): Promise<void> {
  const parent = tasks.get(taskId);
  if (!parent) return;
  const child = tasks.list().find(
    (t) => t.parentTaskId === taskId && t.childMergeStatus === "merge-conflict",
  );
  if (!child) {
    pipelineStatus(runId, taskId, "merge-resolution turn ended but no subtask is awaiting a merge — nothing to settle");
    return;
  }
  const parentWorktree = parent.worktreePath ?? parent.workdir;
  const landed = child.branch != null && (await isBranchMerged(parentWorktree, child.branch));
  if (landed) {
    tasks.update(child.id, { childMergeStatus: "merged", column: "done" });
    pipelineStatus(
      runId, taskId,
      `merge conflict resolved — subtask "${child.planSubtaskId}" landed on the parent branch; resuming the build`,
    );
    // Re-affirm the building column (the resolution turn pulled the card to
    // "running") before the tick decides what's next.
    if (parent.pipelineStage === "building") {
      updateColumn(taskId, runId, "building", "stage-advance");
    }
    void tickBuild(taskId).catch((err) => {
      console.error(`[agetor] post-resolution tickBuild failed for parent ${taskId}:`, err);
      if (tasks.get(taskId)?.column === "building") {
        blockPipelineTask(taskId, null, "pipeline-failed", String(err));
      }
    });
    return;
  }
  await abortMerge(parentWorktree);
  tasks.update(child.id, { childMergeStatus: "merge-failed", column: "blocked" });
  blockPipelineTask(
    taskId, runId, "pipeline-failed",
    `merge conflict on subtask "${child.planSubtaskId}" could not be auto-resolved. ` +
    `The subtask's finished work is on branch "${child.branch}" — resolve that merge into ` +
    `this worktree (or mark the subtask satisfied if its work already landed another way); ` +
    `do NOT re-implement the feature.`,
  );
  cancelSiblingChildren(taskId);
}

// Exported for unit tests (orchestrator-pipeline-guards.test.ts) — production
// callers are attachDoneHandler + maybeReleaseHeldTask only.
export function settleChildRun(taskId: string, runId: string, outcome: PipelineOutcome): void {
  const task = tasks.get(taskId);
  if (!task || task.runId !== runId) return;

  if (runs.get(runId)?.origin !== "pipeline-stage") {
    if (outcome.kind === "success") {
      pipelineStatus(
        runId, taskId,
        "conversation turn ended — child build state unchanged (only the child's own build run hands work back to the pipeline; use \"Hand back & merge\" when the work is done, or press Run to restart the build turn)",
      );
      return;
    }
    // A cancelled/failed conversation (or continuation) turn must still land
    // the CARD somewhere honest — build state stays untouched (RC-6), but a
    // bare return here left the child parked on "running" forever with no
    // in-flight run and no derived badge (awaitingHandBack requires a
    // succeeded run). That's the 2dot2dot-redesign puzzle-canvas zombie
    // (2026-08-16): a user interrupt settled the build turn, an
    // auto-continuation run adopted the card back to "running", then ITS
    // cancellation hit this branch and vanished. Mirror the ordinary-task
    // ternary in attachDoneHandler: cancelled → "ready" (Run restarts the
    // build turn, exactly what the success-path breadcrumb tells the user),
    // hard-failure → "blocked" with the reason. The parent is deliberately
    // NOT escalated — only the child's own build run may abort the build.
    if (outcome.kind === "cancelled") {
      updateColumn(taskId, runId, "ready");
      pipelineStatus(
        runId, taskId,
        "conversation turn cancelled — child build state unchanged (press Run to restart the build turn)",
      );
    } else {
      updateColumn(taskId, runId, "blocked", outcome.reason);
      pipelineStatus(
        runId, taskId,
        `conversation turn failed (${outcome.reason}) — child build state unchanged (press Run to restart the build turn)`,
      );
    }
    return;
  }

  if (outcome.kind === "success") {
    void completeChildBuild(taskId).catch((err) => {
      console.error(`[agetor] completeChildBuild failed for child ${taskId}:`, err);
    });
    return;
  }

  const escalate = (): void => {
    updateColumn(taskId, runId, "blocked", outcome.kind === "hard-failure" ? outcome.reason : undefined);
    const parentTaskId = task.parentTaskId;
    if (!parentTaskId) return;
    const parent = tasks.get(parentTaskId);
    if (parent && parent.column === "building") {
      const why = outcome.kind === "cancelled" ? "was cancelled" : `failed (${outcome.reason})`;
      blockPipelineTask(parentTaskId, null, "pipeline-failed", `subtask "${task.planSubtaskId}" ${why}`);
      cancelSiblingChildren(parentTaskId);
    }
  };

  if (
    outcome.kind === "hard-failure"
    && !childBootRetried.has(taskId)
    && runHasNoAgentOutput(runId)
  ) {
    childBootRetried.add(taskId);
    pipelineStatus(
      runId, taskId,
      "child agent died before producing any output — retrying the spawn once",
    );
    void startTask(taskId).then(
      (result) => { if ("error" in result) escalate(); },
      (err) => {
        console.error(`[agetor] child boot-flake retry failed for ${taskId}:`, err);
        escalate();
      },
    );
    return;
  }

  escalate();
}

/**
 * Advance (or block) a pipeline task once its current stage's terminal run
 * has resolved. Called from `attachDoneHandler` in place of the plain
 * `nextColumn` ternary whenever `task.pipelineStage != null`. No-ops if the
 * task vanished, isn't a pipeline task, or `task.runId !== runId` (a
 * superseded run) — callers already guard on the latter via `isTerminalRun`
 * before invoking this, but it's re-checked here since this function can
 * also be reached from `maybeReleaseHeldTask`'s release path.
 *
 * A hard failure or cancellation always lands on `blocked` with
 * `pipelineStage` left exactly where it was, so a human sees precisely
 * where the run died and can manually re-`startTask` the same stage to
 * retry. Everything else is per-stage:
 *   - specify success: requires SPEC.md to exist → advance to clarify.
 *   - clarify success: requires SPEC.md still present → advance to planning.
 *   - planning success: requires PLAN.md to exist → advance to plan-review.
 *   - plan-review: parses the Critic's verdict. approve → planApproved=true,
 *     advance to decompose (or straight to done if implementationApproved
 *     was already true from an earlier pass). revise → bump the shared
 *     revision counter; over cap → blocked; under cap → back to planning
 *     with the reason folded into pipelineFeedback.
 *   - decompose success: not verdict-bearing — requires TASKS.json to exist
 *     AND parse/validate, then runs the inline analyze step (AC coverage
 *     check, zero agent turns). Coverage ok → fresh entry into building via
 *     tickBuild. Gap found → bounce to decompose (same revision cap).
 *   - analyze: handled inline inside the "decompose" case; never has its own
 *     terminal run — this switch arm is a safety no-op.
 *   - building success: not verdict-bearing, straight to code-review. This
 *     is the BOUNCE-entry path only (a plain single-agent fixup turn) —
 *     the fresh-entry path is handled entirely in the "decompose" case above.
 *   - code-review: parses the Code Reviewer's verdict (same approve/revise
 *     shape plan-review uses, reviewing the merged diff and AC checklist).
 *     approve → straight to testing. revise → same cap arithmetic,
 *     bounce target is building (plain fixup, no re-decomposition).
 *   - testing: same verdict shape. pass → implementationApproved=true,
 *     straight to done — the pipeline's terminal column (planApproved is
 *     true by construction). fail → same cap arithmetic, bounce target is
 *     building (not planning).
 *
 * The `startTask` call for the next stage is fired-and-forgotten
 * (`void ...catch(...)`), never awaited — it must not block the caller's
 * own `emit`/`emitGlobal`/`drainCodexQueue`/`drainGeminiQueue` tail calls,
 * matching the existing "must never derail run settlement" treatment
 * `pumpWatcherForHoldCheck` already gets a few lines up in
 * `attachDoneHandler`. A `startTask` failure (harness unavailable, etc.)
 * has no other path to the user, so it's caught here and landed on
 * `blocked` itself.
 */
// Exported for unit tests (orchestrator-pipeline-guards.test.ts) — production
// callers are attachDoneHandler + maybeReleaseHeldTask only.
export function advancePipelineStage(taskId: string, runId: string, outcome: PipelineOutcome): void {
  const task = tasks.get(taskId);
  if (!task || task.pipelineStage == null || task.runId !== runId) return;

  // A merge-resolution turn settles through its own git-verified path — the
  // agent's outcome (success, failure, even a user Stop) is only the trigger;
  // `settleMergeResolution` re-derives whether the merge landed from git and
  // never trusts the run. Routed before the provenance gate below since
  // "pipeline-merge" is its own provenance.
  if (runs.get(runId)?.origin === "pipeline-merge") {
    void settleMergeResolution(taskId, runId).catch((err) => {
      console.error(`[agetor] settleMergeResolution failed for task ${taskId}:`, err);
      if (tasks.get(taskId)?.column === "building" || tasks.get(taskId)?.column === "running") {
        blockPipelineTask(taskId, null, "pipeline-failed", `merge-resolution settle failed: ${String(err)}`);
      }
    });
    return;
  }

  // Provenance gate (RC-6): only a run startTask stamped as a stage turn may
  // move the pipeline. A user follow-up ("continue"), an auto-continuation
  // after a background task, or a resumed-session chat turn ends here — the
  // stage stays exactly where it is. On a clean end the column is re-affirmed
  // to the stage (a continuation run pulls the card to "running"; without
  // this it would stick there); failures need nothing — the chunk handler's
  // sentinel paths already landed the card on `blocked` with the reason.
  if (runs.get(runId)?.origin !== "pipeline-stage") {
    if (outcome.kind === "success") {
      // A COMPLETE pipeline (both gates approved) has no gate left to park
      // at — re-affirming the stage column here would drag a finished task
      // out of `done` and make the user override the testing gate again
      // after every chat turn (the 2dot2dot-fresh loop, 2026-08-19).
      const complete = task.planApproved && task.implementationApproved;
      pipelineStatus(
        runId, taskId,
        complete
          ? `conversation turn ended — pipeline already complete (both gates approved); card stays in done`
          : `conversation turn ended — pipeline stage "${task.pipelineStage}" not advanced (only stage runs move the pipeline; use Retry stage or the gate override)`,
      );
      updateColumn(taskId, runId, complete ? "done" : task.pipelineStage, "stage-advance");
    }
    return;
  }

  if (outcome.kind !== "success") {
    updateColumn(taskId, runId, "blocked", outcome.kind === "hard-failure" ? outcome.reason : undefined);
    return;
  }

  // O-11: harvest what this stage Read and ran, for the next stage's prompt.
  // Deterministic extraction over the persisted events; fail-open.
  try {
    pipelineState.appendHandoff(
      taskId,
      extractHandoff(runs.events(runId), { stage: task.pipelineStage, worktreeRoot: task.worktreePath ?? task.workdir }),
    );
  } catch (err) {
    console.error(`[agetor] handoff capture failed for task ${taskId}:`, err);
  }

  const spawnStage = (nextStage: NonNullable<Task["pipelineStage"]>, patch: Partial<Task> = {}) =>
    spawnPipelineStage(taskId, runId, nextStage, patch);

  const bounceOrBlock = (
    targetStage: NonNullable<Task["pipelineStage"]>,
    reason: string,
    resetPatch: Partial<Task>,
  ) => {
    // Clamped at cap+1: a restart of an already-capped task re-enters this
    // arithmetic and must block again WITHOUT growing the counter — the
    // 2DOT2DOT run's `revisionCount: 23` against a cap of 6 was seventeen
    // human-attended retries each incrementing a number that had stopped
    // meaning anything (RC-5).
    const revisionCount = Math.min(task.revisionCount + 1, PIPELINE_REVISION_CAP + 1);
    if (revisionCount > PIPELINE_REVISION_CAP) {
      tasks.update(taskId, { revisionCount });
      emit({
        runId, taskId, stream: "status",
        data: `revision cap (${PIPELINE_REVISION_CAP}) reached — ${reason}`,
        ts: Date.now(),
      });
      updateColumn(taskId, runId, "blocked", "revision-cap");
      return;
    }

    // No-progress loop-breaker (RC-5): fingerprint the tree now and compare
    // against the fingerprint stored when the PREVIOUS bounce to this same
    // target spawned. Identical means the whole bounce cycle (fixup turn +
    // re-review) changed nothing on disk — looping again is guaranteed
    // waste, so block immediately instead of one no-op cycle at a time.
    // Null fingerprint (non-git workdir, git failure) skips the check.
    const treeHash = treeFingerprintSync(task.worktreePath ?? task.workdir);
    const fingerprint = treeHash != null ? `${targetStage}:${treeHash}` : null;
    if (fingerprint != null && task.pipelineBounceFingerprint === fingerprint) {
      tasks.update(taskId, {
        pipelineFeedback:
          `bounce to ${targetStage} produced no changes — human input needed. Last gate feedback: ${reason}`,
      });
      pipelineStatus(
        runId, taskId,
        `bounce to ${targetStage} produced no changes since the last bounce — blocking for human input instead of looping`,
      );
      updateColumn(taskId, runId, "blocked", "pipeline-failed");
      return;
    }

    // DAG-aware building bounce (RC-4): a revise/fail whose real cause is
    // "subtasks never built or merged" cannot be fixed by a single-agent
    // fixup turn — that agent has no way to run the DAG (the 2DOT2DOT
    // Builder said so out loud, seventeen times). Re-enter the scheduler
    // instead: merge any deferred children, spawn what's missing, and let
    // the barrier decide when building is actually complete. The fixup turn
    // remains the bounce vehicle only when the barrier is satisfied — i.e.
    // the review found defects in code that actually exists.
    if (targetStage === "building") {
      const barrier = buildBarrierState(task);
      if (barrier.kind === "invalid") {
        tasks.update(taskId, { pipelineFeedback: barrier.reason });
        pipelineStatus(runId, taskId, `cannot bounce to building — ${barrier.reason}`);
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      if (barrier.kind === "incomplete") {
        tasks.update(taskId, {
          pipelineStage: "building",
          revisionCount,
          pipelineFeedback: reason,
          pipelineBounceFingerprint: fingerprint,
          ...resetPatch,
        });
        updateColumn(taskId, runId, "building", "stage-advance");
        pipelineStatus(
          runId, taskId,
          `build barrier not met (unmerged: ${barrier.unmet.join(", ")}) — resuming the build DAG instead of a fixup turn`,
        );
        void tickBuild(taskId).catch((err) => {
          console.error(`[agetor] tickBuild failed for task ${taskId}:`, err);
          if (tasks.get(taskId)?.column === "building") {
            blockPipelineTask(taskId, null, "pipeline-failed", String(err));
          }
        });
        return;
      }
    }

    spawnStage(targetStage, {
      revisionCount,
      pipelineFeedback: reason,
      pipelineBounceFingerprint: fingerprint,
      ...resetPatch,
    });
  };

  switch (task.pipelineStage) {
    case "specify": {
      const specPath = join(task.worktreePath ?? task.workdir, PIPELINE_SPEC_FILE);
      if (!existsSync(specPath)) {
        emit({
          runId, taskId, stream: "status",
          data: `${PIPELINE_SPEC_FILE} was not found in the worktree — cannot advance to clarify`,
          ts: Date.now(),
        });
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      spawnStage("clarify", { pipelineFeedback: null });
      return;
    }
    case "clarify": {
      const specPath = join(task.worktreePath ?? task.workdir, PIPELINE_SPEC_FILE);
      if (!existsSync(specPath)) {
        emit({
          runId, taskId, stream: "status",
          data: `${PIPELINE_SPEC_FILE} was not found in the worktree after clarify — cannot advance to planning`,
          ts: Date.now(),
        });
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      spawnStage("planning", { pipelineFeedback: null });
      return;
    }
    case "planning": {
      const planPath = join(task.worktreePath ?? task.workdir, PIPELINE_PLAN_FILE);
      if (!existsSync(planPath)) {
        emit({
          runId, taskId, stream: "status",
          data: `${PIPELINE_PLAN_FILE} was not found in the worktree — cannot advance to plan-review`,
          ts: Date.now(),
        });
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      spawnStage("plan-review", { pipelineFeedback: null });
      return;
    }
    case "plan-review": {
      const verdict = lastPipelineVerdict(runId, "plan-review");
      if (!verdict.ok) {
        emit({
          runId, taskId, stream: "status",
          data: "no PIPELINE_VERDICT found in the Critic's response — cannot advance",
          ts: Date.now(),
        });
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      if (verdict.kind === "approve") {
        tasks.update(taskId, { planApproved: true, pipelineFeedback: null });
        if (tasks.get(taskId)?.implementationApproved) {
          // Both gates approved — the pipeline is complete. Terminal column
          // is `done`, not `ready`: `ready` reads as "waiting to run" and a
          // finished pipeline parked there is indistinguishable from a task
          // that never started (the 2dot2dot-fresh confusion, 2026-08-19).
          dropSettledStageSession(taskId, runId);
          updateColumn(taskId, runId, "done", "stage-advance");
          return;
        }
        // Reset the shared revision budget so decompose/build phases each get
        // a full PIPELINE_REVISION_CAP of their own (plan-review bounces must
        // not eat into the decompose/build budget). Fingerprint cleared for
        // the same reason — approve is confirmed progress.
        spawnStage("decompose", { revisionCount: 0, pipelineBounceFingerprint: null });
        return;
      }
      bounceOrBlock("planning", verdict.reason, { planApproved: false });
      return;
    }
    case "decompose": {
      const tasksPath = join(task.worktreePath ?? task.workdir, PIPELINE_TASKS_FILE);
      if (!existsSync(tasksPath)) {
        emit({
          runId, taskId, stream: "status",
          data: `${PIPELINE_TASKS_FILE} was not found in the worktree — cannot advance to analyze`,
          ts: Date.now(),
        });
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      const parsed = parseBuildPlan(readFileSync(tasksPath, "utf8"));
      if (!parsed.ok) {
        emit({
          runId, taskId, stream: "status",
          data: `${PIPELINE_TASKS_FILE} is invalid — ${parsed.reason} — cannot advance`,
          ts: Date.now(),
        });
        tasks.update(taskId, { pipelineFeedback: parsed.reason });
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      // O-3/O-9: soft sizing warnings (too many subtasks, oversized subtask
      // prompts) — status events, never a gate; the plan still runs.
      for (const warning of buildPlanWarnings(parsed.plan)) {
        pipelineStatus(runId, taskId, `decomposition warning: ${warning}`);
      }
      // Inline the analyze step — no agent turn needed, just a deterministic
      // AC-coverage check. Advance column to "analyze" for UI visibility of
      // this (instant) stage, then immediately resolve it.
      tasks.update(taskId, { pipelineStage: "analyze" });
      updateColumn(taskId, runId, "analyze", "stage-advance");

      const specPath = join(task.worktreePath ?? task.workdir, PIPELINE_SPEC_FILE);
      let specAcIds: string[] = [];
      if (existsSync(specPath)) {
        try { specAcIds = parseSpecAcceptanceCriteria(readFileSync(specPath, "utf8")); } catch { /* no ACs */ }
      }
      const coverage = analyzeCoverage(specAcIds, parsed.plan);
      if (!coverage.ok) {
        const reason = coverage.reason;
        emit({
          runId, taskId, stream: "status",
          data: `AC coverage gap in ${PIPELINE_TASKS_FILE} — ${reason}`,
          ts: Date.now(),
        });
        // bounce back to decompose so the Decomposer can fix the gap
        const revisionCount = task.revisionCount + 1;
        tasks.update(taskId, { pipelineStage: "decompose" });
        if (revisionCount > PIPELINE_REVISION_CAP) {
          tasks.update(taskId, { revisionCount });
          emit({
            runId, taskId, stream: "status",
            data: `revision cap (${PIPELINE_REVISION_CAP}) reached — ${reason}`,
            ts: Date.now(),
          });
          updateColumn(taskId, runId, "blocked", "revision-cap");
          return;
        }
        spawnPipelineStage(taskId, runId, "decompose", { revisionCount, pipelineFeedback: reason });
        return;
      }
      // Coverage OK — fresh entry into building (same pattern as the old
      // pre-builder case: no agent turn of its own, hand off to DAG scheduler).
      // The decompose session is the one that used to linger for the whole
      // build — the parent has no turn of its own while children run, so
      // nothing else would ever close it until the next stage spawned (O-7).
      dropSettledStageSession(taskId, runId);
      tasks.update(taskId, { pipelineStage: "building", pipelineFeedback: null });
      updateColumn(taskId, runId, "building", "stage-advance");
      if (tasks.get(taskId)?.pausedAt == null) {
        void tickBuild(taskId).catch((err) => {
          console.error(`[agetor] tickBuild failed for task ${taskId}:`, err);
          if (tasks.get(taskId)?.column === "building") {
            blockPipelineTask(taskId, null, "pipeline-failed", String(err));
          }
        });
      }
      return;
    }
    case "analyze": {
      // analyze is handled inline in the "decompose" case above — it never
      // has its own terminal run, so advancePipelineStage is never called
      // with pipelineStage === "analyze". This branch is a safety no-op.
      return;
    }
    case "building": {
      // Barrier check (RC-2): a run ending while the stage is "building"
      // proves nothing about the build — this edge used to advance to
      // code-review unconditionally, which is how the 2DOT2DOT parent
      // reviewed an empty branch 2.5 minutes into its build (an
      // auto-continuation run took this edge with 0 of 7 subtasks merged;
      // the provenance gate above now also blocks that specific caller).
      // Only the DAG state decides: complete → advance; incomplete → resume
      // the build (tickBuild merges deferred children, spawns what's
      // missing, and advances itself once everything is merged); invalid →
      // blocked, same as decompose's own gate.
      const barrier = buildBarrierState(task);
      if (barrier.kind === "invalid") {
        tasks.update(taskId, { pipelineFeedback: barrier.reason });
        pipelineStatus(runId, taskId, `cannot leave building — ${barrier.reason}`);
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      if (barrier.kind === "complete") {
        spawnStage("code-review", { pipelineFeedback: null });
        return;
      }
      pipelineStatus(
        runId, taskId,
        `build barrier not met (unmerged: ${barrier.unmet.join(", ")}) — resuming the build instead of advancing`,
      );
      void tickBuild(taskId).catch((err) => {
        console.error(`[agetor] tickBuild failed for task ${taskId}:`, err);
        if (tasks.get(taskId)?.column === "building") {
          blockPipelineTask(taskId, null, "pipeline-failed", String(err));
        }
      });
      return;
    }
    case "code-review": {
      const verdict = lastPipelineVerdict(runId, "code-review");
      if (!verdict.ok) {
        emit({
          runId, taskId, stream: "status",
          data: "no PIPELINE_VERDICT found in the Code Reviewer's response — cannot advance",
          ts: Date.now(),
        });
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      if (verdict.kind === "approve") {
        // Fingerprint cleared inside the gate: an approve is confirmed
        // progress, so the next bounce (if any) starts a fresh no-progress
        // baseline. The gate runs the deterministic checks first and either
        // skips the Tester or hands it the failures (O-5); fire-and-forget
        // like every other next-stage spawn.
        void runTesterGate(taskId, runId).catch((err) => {
          console.error(`[agetor] runTesterGate failed for task ${taskId}:`, err);
          if (tasks.get(taskId)?.pipelineStage === "code-review") {
            spawnStage("testing", { pipelineFeedback: null, pipelineBounceFingerprint: null });
          }
        });
        return;
      }
      // Revise bounces to "building" — a plain single-agent fixup when the
      // build barrier is satisfied, or a DAG re-entry when it isn't (see
      // bounceOrBlock) — consuming a slot from the SAME shared revision-cap
      // counter as the other edges. The gate name is folded into the
      // feedback so the Builder knows which review it is answering.
      bounceOrBlock("building", `code review: ${verdict.reason}`, {});
      return;
    }
    case "testing": {
      const verdict = lastPipelineVerdict(runId, "testing");
      if (!verdict.ok) {
        emit({
          runId, taskId, stream: "status",
          data: "no PIPELINE_VERDICT found in the Tester's response — cannot advance",
          ts: Date.now(),
        });
        updateColumn(taskId, runId, "blocked", "pipeline-failed");
        return;
      }
      pipelineState.setPrecheck(taskId, null);
      if (verdict.kind === "pass") {
        tasks.update(taskId, { implementationApproved: true, pipelineFeedback: null, pipelineBounceFingerprint: null });
        // planApproved is true by construction here — testing is only
        // reachable after an approved plan (see the plan-review case above).
        // `done` is the pipeline's terminal column (see the plan-review
        // case above for why not `ready`). Terminal → the tester's session
        // has nothing left to do either (O-7).
        dropSettledStageSession(taskId, runId);
        updateColumn(taskId, runId, "done", "stage-advance");
        return;
      }
      bounceOrBlock("building", `testing: ${verdict.reason}`, { implementationApproved: false });
      return;
    }
  }
}

/**
 * Apply inline config edits to a live tmux session where possible — keeps
 * the claude conversation alive (and its accumulated context) across
 * mode/model/effort changes. Called by the PATCH /tasks/:id route after the
 * DB row is updated.
 *
 *   • Agent change (claude ↔ codex ↔ cursor ↔ gemini): kills any claude tmux
 *     session we had for this task. The new agent will spawn fresh on next Run.
 *   • Same-agent mode / model / effort change on a live claude session: the
 *     permission mode has no slash command, so we call `cycleToMode` which
 *     sends Shift+Tab keystrokes (or `/plan` when the target is plan). Model
 *     is mirrored via claude 2.1.246's `/model` PICKER, confirmed with `s`
 *     (session-only — see `mirrorModelViaPicker` in claude-tmux.ts), never a
 *     typed `/model <id>` (that rewrites the user's global claude default).
 *     Effort is NEVER mirrored into the live session at all — a smoke test on
 *     2.1.246 showed `CLAUDE_CODE_EFFORT_LEVEL` (the env var agetor pins at
 *     spawn) takes precedence over every `/effort` form, so the old
 *     slash-command mirror just desynced the row instead of changing
 *     anything; only a breadcrumb records that the new value takes effect on
 *     the NEXT run (docs/plans/model-effort-local-command-turns.md §10, owner
 *     decisions 1 & 2). The session keeps running with the new posture in
 *     every case.
 *   • Anything else (codex, cursor, gemini; no live session): no-op — the
 *     change just persists for the next spawn.
 */
export async function reconcileTaskSession(taskId: string, before: Task, after: Task): Promise<void> {
  const beforeKind = resolveHarness(before.agent)?.kind ?? null;
  const afterKind = resolveHarness(after.agent)?.kind ?? null;
  // Treat any harness id change as a session-killing event for claude — the
  // alias's HOME/env block changes, so the on-disk JSONL & login differ. Even
  // same-kind alias swaps (claude-work → claude-personal) need a fresh tmux.
  if (before.agent !== after.agent) {
    if (beforeKind === "claude-code") await dropSession(taskId);
    else if (beforeKind === "codex") await dropCodexSession(taskId);
    else if (beforeKind === "cursor") await dropCursorSession(taskId);
    else if (beforeKind === "gemini") await dropGeminiSession(taskId);
    else if (beforeKind === "fx") dropFxSession(taskId); // fx has no tmux session — stays sync
    // Any queued codex/cursor/gemini/fx follow-ups belong to the old agent —
    // drop them so a later drain doesn't spawn them against the new harness.
    codexTurnQueue.delete(taskId);
    cursorTurnQueue.delete(taskId);
    geminiTurnQueue.delete(taskId);
    fxTurnQueue.delete(taskId);
    // Cross-kind switches (e.g. claude-code → codex alias) leave mode/
    // model/effort ids that belong to the old kind's option set; the
    // next spawn would error or fall through to verbatim flags. Reset
    // them server-side so direct API edits get the same safety the
    // RunPanel's `onAgentChange` already applies client-side. Same-kind
    // alias swaps keep the picks — those ids stay valid.
    if (afterKind && beforeKind !== afterKind) {
      const nextMode = AGENT_OPTIONS[afterKind].modes[0]?.id ?? "auto";
      tasks.update(taskId, { mode: nextMode, model: null, effort: null, fast: false, maxMode: false });
    }
    return;
  }
  if (afterKind !== "claude-code") return;
  if (!(await sessionExists(taskId))) return;

  // `after.mode` guard: a PATCH that clears the mode (mode → null) leaves
  // the live session alone — the UI doesn't expose a "clear mode" control
  // and there's no canonical "unset" mode to dial claude back to, so
  // silently keeping the current posture is the least-surprising option.
  if (before.mode !== after.mode && after.mode) {
    const result = await cycleToMode(taskId, after.mode);
    emitModeChangeStatus(taskId, after.mode, result);
    // Only refresh the PreToolUse matcher when the mode change actually
    // took effect. Otherwise we'd narrow the matcher (e.g. to bypass's
    // narrow-no-mcp scope) while claude is still in the old mode — the
    // hook stops firing for routine Bash but claude's own permission
    // modal still pops inside tmux, deadlocking the run. The matcher is
    // set at spawn-time by `ensureInstalledForCwd` (narrow for auto/
    // bypass, full for everything else); leaving it in place on a
    // failed cycle preserves the existing intercept-and-surface flow,
    // which is the right fallback for "we couldn't switch modes."
    if (result.ok) {
      const cwd = after.worktreePath ?? after.workdir;
      const refreshed = await ensureInstalledForCwd(cwd, after.mode);
      if (!refreshed) emitMatcherRefreshFailure(taskId, cwd);
    }
  }
  // Model mirror: claude 2.1.246's `/model` PICKER, confirmed with `s`
  // (session-only), not a typed `/model <id>` — that writes the user's
  // GLOBAL claude default, which a card click inside agetor must never do
  // (docs/plans/model-effort-local-command-turns.md §10, owner decision 2,
  // smoke-tested on claude 2.1.246). `claudeModelPickerFamily` maps the
  // agetor id to the coarse family the picker actually offers as a row
  // (`Opus`/`Sonnet`/`Fable`/`Haiku`); an id the 2.1.246 picker can't select
  // exactly (an older pinned version within a family the picker only offers
  // the CURRENT release of — including the now-superseded `fable-5`, demoted
  // once `fable-5.1` took over the "Fable" row — `mythos-5`, `mythos-5.1`, or
  // an unknown id) is a live-session no-op — the row already has the new id,
  // only the mirror into the running session is skipped.
  // `mirrorModelViaPicker`'s own resolved result already
  // carries a `reason` for every `ok:false` outcome (no live session, a turn
  // already in flight, a withheld keystroke, the picker never rendering, the
  // target not being offered, or a keystroke itself failing), so
  // `onPasteFailure` here has nothing further to report — a second
  // breadcrumb from it would just duplicate the one below.
  if (before.model !== after.model && after.model) {
    const modelId = after.model;
    const family = claudeModelPickerFamily(modelId);
    if (!family) {
      emitModelMirrorUnsupportedStatus(taskId, modelId);
    } else {
      const result = await mirrorModelViaPicker(taskId, family, { onPasteFailure: () => {} });
      if (!result.ok) {
        // `"no live session"` and `"turn in flight"` are not failures — they
        // mean the mirror never got a chance to run at all (there is no
        // session to drive, or the picker can't be opened without stepping
        // on an in-progress turn), not that it tried and something broke.
        // Route those to the same next-run wording `emitModelMirrorUnsupportedStatus`
        // uses for a picker-incompatible id, rather than the ⚠️ failure
        // framing, which is reserved for a mirror that actually attempted
        // and failed (a withheld keystroke, the picker not appearing, the
        // target family not offered, or a keystroke itself failing) — see
        // finding #4, §10 re-review. Checked via a membership test rather
        // than `result.reason === "no live session" || result.reason ===
        // "turn in flight"` directly so this compiles independent of
        // whether claude-tmux.ts's `MirrorModelFailureReason` union has
        // landed `"turn in flight"` yet — the two files are being edited
        // concurrently.
        if (MODEL_MIRROR_NEXT_RUN_REASONS.has(result.reason)) {
          emitModelMirrorNextRunStatus(taskId, modelId, result.reason);
        } else {
          emitModelMirrorFailureStatus(taskId, modelId, result.reason);
        }
      }
    }
  }
  // Effort mirror: NONE. A smoke test on claude 2.1.246 showed
  // `CLAUDE_CODE_EFFORT_LEVEL` (the env var agetor pins on the spawned
  // process — see agents.ts) takes precedence over every `/effort` form —
  // the old slash-command mirror printed "Not applied:
  // CLAUDE_CODE_EFFORT_LEVEL=high overrides effort this session…" and
  // desynced the row from the (unchanged) live session. So unlike model,
  // effort is never pushed into a live session at all; only a breadcrumb
  // records that the new value takes effect on the NEXT run
  // (docs/plans/model-effort-local-command-turns.md §10, owner decision 1).
  if (before.effort !== after.effort && after.effort) {
    emitEffortPinnedStatus(taskId, after.effort, before.effort);
  }
}

/**
 * Surface a live-session model mirror that claude 2.1.246's `/model` picker
 * can't perform exactly for this id (see `claudeModelPickerFamily`'s doc).
 * The task row already has the new value — the PATCH that triggered this
 * reconcile already committed — this is purely informational: the NEXT spawn
 * (or a later change that lands on a picker-representable id) will pick it
 * up. Mirrors `emitModeChangeStatus`'s append+emit pattern.
 */
function emitModelMirrorUnsupportedStatus(taskId: string, modelId: string): void {
  const recent = runs.listForTask(taskId)[0];
  if (!recent) return;
  const data = `model ${modelId} applies on the next run — claude's picker can't select it for this session`;
  runs.appendEvent(recent.id, "status", data);
  emit({ runId: recent.id, taskId, stream: "status", data, ts: Date.now() });
}

/**
 * `mirrorModelViaPicker` reasons that mean "the mirror never got a chance to
 * run at all" rather than "it ran and failed" (finding #4, §10 re-review):
 * there was no live session to drive, or claude was mid-turn and opening the
 * picker would have stepped on it. Both get the same informational
 * next-run wording `emitModelMirrorNextRunStatus` gives a picker-
 * incompatible id, NOT the ⚠️ framing `emitModelMirrorFailureStatus` reserves
 * for an attempt that actually broke (a withheld keystroke, the picker never
 * appearing, the target family not offered, or a keystroke itself failing).
 *
 * Deliberately a runtime `Set<string>` membership check rather than a
 * `result.reason === "no live session" || result.reason === "turn in
 * flight"` literal comparison: claude-tmux.ts (owned by a different agent in
 * this same review pass) is concurrently adding `"turn in flight"` to
 * `MirrorModelFailureReason`. A literal comparison against a string not yet
 * in that union is a TS2367 compile error until that lands; `.has()` takes a
 * plain `string` argument, so it type-checks either way and needs no
 * follow-up edit once the union catches up.
 */
const MODEL_MIRROR_NEXT_RUN_REASONS = new Set(["no live session", "turn in flight"]);

/**
 * Surface a `mirrorModelViaPicker` outcome where the mirror never ran at all
 * — see `MODEL_MIRROR_NEXT_RUN_REASONS`'s doc for which reasons land here vs.
 * `emitModelMirrorFailureStatus`. The task row already has the new value;
 * this is purely informational, mirroring `emitModelMirrorUnsupportedStatus`'s
 * "applies on the next run" framing for a picker-incompatible id. Mirrors
 * `emitModeChangeStatus`'s append+emit pattern.
 */
function emitModelMirrorNextRunStatus(taskId: string, modelId: string, reason: string): void {
  const recent = runs.listForTask(taskId)[0];
  if (!recent) return;
  const detail = reason === "turn in flight" ? "claude is mid-turn" : reason;
  const data = `model ${modelId} applies on the next run — ${detail}`;
  runs.appendEvent(recent.id, "status", data);
  emit({ runId: recent.id, taskId, stream: "status", data, ts: Date.now() });
}

/**
 * Surface a `mirrorModelViaPicker` failure that actually attempted and broke
 * — a withheld keystroke (a blocking claude modal was still on the pane),
 * the picker never rendering, the target family not being offered, or a
 * keystroke itself failing. (`"no live session"` / `"turn in flight"` route
 * to `emitModelMirrorNextRunStatus` instead — see
 * `MODEL_MIRROR_NEXT_RUN_REASONS`.) The task row already has the new value;
 * the live session kept its previous one until the user (or a later
 * successful mirror) fixes it. Mirrors `emitModeChangeStatus`'s append+emit
 * pattern.
 */
function emitModelMirrorFailureStatus(taskId: string, modelId: string, reason: string): void {
  const recent = runs.listForTask(taskId)[0];
  if (!recent) return;
  const data = `⚠️ model change not applied — ${reason}; the task's model is ${modelId} but the session kept its previous one`;
  runs.appendEvent(recent.id, "status", data);
  emit({ runId: recent.id, taskId, stream: "status", data, ts: Date.now() });
}

/**
 * Surface that an `after.effort` change was recorded on the task row but
 * deliberately never pushed into the live session — see this function's call
 * site in `reconcileTaskSession` for why (`CLAUDE_CODE_EFFORT_LEVEL` always
 * wins over every `/effort` form on claude 2.1.246). `getSessionLaunchEffort`
 * reports what the live session was ACTUALLY pinned to at spawn;
 * `beforeEffort` is only a fallback for the (shouldn't-happen) case where the
 * in-memory session state has already been disposed. Mirrors
 * `emitModeChangeStatus`'s append+emit pattern.
 */
function emitEffortPinnedStatus(taskId: string, effortId: string, beforeEffort: string | null): void {
  const recent = runs.listForTask(taskId)[0];
  if (!recent) return;
  const pinned = getSessionLaunchEffort(taskId) ?? beforeEffort ?? "its launch effort";
  const data = `effort ${effortId} applies on the next run — this session is pinned to ${pinned} by CLAUDE_CODE_EFFORT_LEVEL`;
  runs.appendEvent(recent.id, "status", data);
  emit({ runId: recent.id, taskId, stream: "status", data, ts: Date.now() });
}

/**
 * Mirrors kanban/RunPanel.tsx's own effort-fallback effect (~4917-4928)
 * EXACTLY, INCLUDING the retain rule (see plan §3 "Cascade rule" in
 * docs/plans/add-gpt-6-astra.md): when a task's model changes, the
 * previously-saved effort may no longer be valid for the new model (Haiku
 * 4.5 takes no effort param at all; Sonnet 4.6 has no `xhigh`) — but an
 * effort either the discovered or the curated set still supports
 * (`retainableEfforts`, the union of both) is kept as-is; only an effort
 * neither source supports triggers a fallback. This is deliberate: a
 * discovery refresh that happens to omit an id the curated table still
 * lists (e.g. `none` on GPT-5.6 Sol, which Codex's own catalog never lists
 * but the API accepts) must not silently PATCH away an effort the user
 * already chose. `undefined` means "no change needed" — the current effort
 * (even `null`) is already retainable for `model`. Otherwise this is the
 * value the effort column should be patched to alongside the model
 * (including `null`, for the "model accepts no effort at all" case); the
 * fallback itself narrows to the discovered-wins set (`supportedEfforts`),
 * not the wider retainable union — new intent should reflect what's
 * actually offered.
 */
function effortFallbackForModelChange(
  kind: AgentKind,
  model: string,
  currentEffort: string | null,
  discoveredEfforts?: readonly string[] | null,
): string | null | undefined {
  const offered = supportedEfforts(kind, model, discoveredEfforts);
  if (currentEffort && retainableEfforts(kind, model, discoveredEfforts).has(currentEffort)) return undefined;
  if (offered.length === 0) {
    return currentEffort !== null ? null : undefined;
  }
  const fallback = offered.some((o) => o.id === DEFAULT_EFFORT[kind]) ? DEFAULT_EFFORT[kind] : offered[0]!.id;
  return currentEffort !== fallback ? fallback : undefined;
}

/**
 * Sync `task.model` / `task.effort` from claude's OWN `/model` / `/effort`
 * outcome (a typed command, a picker/slider card answer, or a terminal-side
 * change — see `docs/plans/model-effort-local-command-turns.md` §10). This
 * is the mirror image of `reconcileTaskSession`'s `/model`/`/effort`
 * branch: that path takes an agetor-side change and pushes it INTO the
 * session; this path takes a session-side change and pulls it back onto the
 * task row. It must never call `reconcileTaskSession` / `sendSlashCommand`
 * — the change already happened in the live session, so re-mirroring it
 * would pop a spurious second "Switch model?"/"Change effort level?"
 * confirm off the very update we're recording.
 *
 * No-op (returns false) when: the task doesn't exist, its agent isn't
 * claude-code, the stdout doesn't parse to a known setting, the parsed
 * value is unchanged, claude landed on a value agetor can't represent
 * (`kind: "unrepresentable"` — a breadcrumb is still emitted so the drift
 * isn't silent), or — for an effort outcome — the parsed id isn't supported
 * by the task's current model (`supportedEfforts`, discovered-then-curated,
 * the same contract the RunPanel picker filters against). Model equality is
 * checked both by raw id AND via `toClaudeModelArg` so an alias (e.g. claude
 * reporting "sonnet" resolved to agetor id `sonnet-5`) can never flip the
 * stored id against an already-equivalent one. A `null` `task.model` (the
 * row has never had an explicit model written to it — the task simply runs
 * on claude's/agetor's default) is compared as if it already held
 * `DEFAULT_MODEL["claude-code"]`: a bare `/model` immediately followed by Esc
 * reports `Kept model as <the default's display name>`, which resolves to
 * that same default id — without this, the row would get pinned to an
 * explicit id it never asked for, just because the user opened and closed
 * the picker without changing anything.
 *
 * A `Kept model as <X>` outcome (`ClaudeLocalModelOutcome.kept`) that DOES
 * differ from the row is additionally gated on `info.viaMirror`: it only
 * writes the row when agetor's own `mirrorModelViaPicker` provoked the
 * `Switch model?` the user then declined. A user's own bare `/model` + Esc
 * reports the same line but must NOT overwrite a next-run model the user
 * deliberately chose in the dropdown (typically one the installed picker
 * can't select at all) — that case emits a breadcrumb naming both values and
 * returns false. See `SessionState.lastModelMirrorAt` in claude-tmux.ts for
 * how the attribution is established, and `ClaudeLocalModelOutcome` for why
 * the parse can't make this call itself.
 *
 * A model sync that lands on a model which no longer supports the task's
 * saved effort adjusts the effort in the SAME `tasks.update` — mirroring
 * `effortFallbackForModelChange` above (itself a mirror of the RunPanel's
 * own effect) — rather than leaving a row with an impossible (model,
 * effort) pair until the next unrelated PATCH happens to fix it. This
 * cascaded effort adjustment is, like every other write this function makes,
 * NEVER mirrored into the live session via `sendSlashCommand` — claude's own
 * live model/effort pair is left exactly as claude set it; the row-side
 * adjustment only governs what the model dropdown shows and what the NEXT
 * spawn (or the next explicit `/effort` from the dropdown) will use. The
 * breadcrumb says so explicitly ("for the next run") so the user doesn't
 * read it as "agetor just changed your live effort".
 *
 * Returns true when a row actually changed (and a status breadcrumb was
 * attempted on the task's most recent run, if one exists).
 */
export function applyClaudeLocalSetting(taskId: string, info: LocalSettingInfo): boolean {
  const task = tasks.get(taskId);
  if (!task) return false;
  if ((resolveHarness(task.agent)?.kind ?? null) !== "claude-code") return false;

  const outcome = parseClaudeLocalSetting(info);
  if (!outcome) return false;

  const recent = runs.listForTask(taskId)[0];
  const announce = (data: string) => {
    if (!recent) return;
    runs.appendEvent(recent.id, "status", data);
    emit({ runId: recent.id, taskId, stream: "status", data, ts: Date.now() });
  };

  if (outcome.kind === "unrepresentable") {
    const current = outcome.setting === "model" ? task.model : task.effort;
    announce(describeUnrepresentableLocalSetting(outcome, current));
    return false;
  }

  let patch: Partial<Task>;
  let breadcrumb: string;

  if (outcome.kind === "model") {
    // A never-set row (`task.model === null`) runs on the default model, so
    // compare against DEFAULT_MODEL rather than `null`/"" — otherwise a bare
    // `/model` + Esc ("Kept model as <default>") would pin an explicit id
    // onto a task that never asked for one (see the function doc).
    const effectiveCurrentModel = task.model ?? DEFAULT_MODEL["claude-code"];
    const unchanged =
      outcome.id === effectiveCurrentModel
      || toClaudeModelArg(outcome.id) === toClaudeModelArg(effectiveCurrentModel);
    if (unchanged) return false;

    // `Kept model as <X>` is claude RESTATING the live session's model, not
    // changing it (`ClaudeLocalModelOutcome.kept`). Two different events
    // produce that line and only `info.viaMirror` tells them apart:
    //
    //   - viaMirror TRUE — agetor's own dropdown mirror
    //     (`mirrorModelViaPicker`) popped `Switch model?` and the user
    //     declined it. The row was already written optimistically by the
    //     PATCH that triggered the mirror, so it is genuinely drifted and
    //     falls through to the normal sync below.
    //   - viaMirror FALSE — the user opened a bare `/model` themselves and
    //     dismissed it (Esc). Syncing here DISCARDS a deliberate next-run
    //     model choice: the live smoke had a row pinned to a model the
    //     2.1.246 picker cannot select ("applies on the next run"), and a
    //     later bare `/model` + Esc reported `Kept model as Sonnet 5`, which
    //     silently overwrote it. Leave the row alone and explain the split.
    //
    // Reached only when the two genuinely differ (the `unchanged` early
    // return above already covered the agree case), so the breadcrumb never
    // fires on an ordinary open-and-dismiss of a row that matches the
    // session. A `Set model to` outcome is a real change and is never gated.
    if (outcome.kept && !info.viaMirror) {
      announce(describeKeptModelNotSynced(outcome.id, effectiveCurrentModel));
      return false;
    }

    patch = { model: outcome.id };
    breadcrumb = describeLocalSettingSync(outcome);

    const effortFallback = effortFallbackForModelChange(
      "claude-code",
      outcome.id,
      task.effort,
      getDiscoveredEfforts("claude-code", outcome.id, task.agent),
    );
    if (effortFallback !== undefined) {
      patch.effort = effortFallback;
      // "for the next run" — this cascaded adjustment is NEVER mirrored into
      // the live session (see the function doc); it only governs the next
      // spawn, so the wording must not read as "your live effort changed".
      breadcrumb += effortFallback === null
        ? `; effort cleared for the next run (not supported on ${outcome.id})`
        : `; effort adjusted to ${effortFallback} for the next run (not supported on ${outcome.id})`;
    }
  } else {
    // outcome.kind === "effort" — validate against the (agent, model) pair
    // before writing, same discovered-wins-then-curated contract the
    // RunPanel picker filters against (claude-code reports no discovered
    // efforts today, so this is curated-only in practice — but it keeps one
    // contract with every other `supportedEfforts` call site). A
    // representable-but-unsupported id (claude accepted `/effort xhigh` on
    // a model whose agetor entry doesn't list it) must not silently widen
    // the task row past what the picker would ever allow.
    const allowed = new Set(
      supportedEfforts(
        "claude-code",
        task.model,
        getDiscoveredEfforts("claude-code", task.model, task.agent),
      ).map((o) => o.id),
    );
    if (!allowed.has(outcome.id)) {
      const modelLabel = task.model ?? DEFAULT_MODEL["claude-code"];
      announce(
        `effort "${outcome.id}" isn't supported on ${modelLabel} in agetor — left as ${task.effort ?? "unset"}`,
      );
      return false;
    }
    if (outcome.id === task.effort) return false;
    patch = { effort: outcome.id };
    breadcrumb = describeLocalSettingSync(outcome);
  }

  // Direct DB update — deliberately NOT `reconcileTaskSession` /
  // `sendSlashCommand`. The change came FROM claude; pushing it back in
  // would re-trigger the very confirm modal we just resolved.
  const updated = tasks.update(taskId, patch);
  if (!updated) return false;

  announce(breadcrumb);
  return true;
}

/**
 * Surface a `cycleToMode` outcome on the task's most recent run so the user
 * sees it in the run panel. Both success and skip ride the `status` stream
 * — skipping is an orchestrator-side decision (e.g. asking for `bypass` on
 * a session that wasn't launched with the flag), not an agent error, so
 * `stderr` would mislead the user into thinking claude crashed. We
 * disambiguate with a "⚠️" prefix on the skip case. Silent when there's no
 * run row to attach to (shouldn't happen — a live tmux session implies at
 * least one prior run — but defensive).
 */
function emitModeChangeStatus(
  taskId: string,
  agetorMode: string,
  result: CycleResult,
): void {
  const recent = runs.listForTask(taskId)[0];
  if (!recent) return;
  const runId = recent.id;
  const ts = Date.now();
  const data = result.ok
    ? (result.via === "noop"
      ? null
      : `mode → ${agetorMode} (${result.via === "slash-plan" ? "via /plan" : `via Shift+Tab ×${result.presses}`})`)
    : formatModeChangeFailure(agetorMode, result);
  if (!data) return;
  runs.appendEvent(runId, "status", data);
  emit({ runId, taskId, stream: "status", data, ts });
}

/**
 * Tell the user when the PreToolUse hook matcher couldn't be rewritten
 * after a successful mode change. The mode itself did take effect on the
 * live session, so the user sees claude responding to the new posture —
 * but the on-disk matcher is stale, which on the next spawn (or on a
 * mid-session settings-reread, if claude does that) would surface routine
 * tools as approvals (or, in the other direction, swallow ones the user
 * wanted prompts for). The most common cause is the user having
 * hand-edited `.claude/settings.local.json` into malformed JSON — point
 * them at the file so they can fix it.
 */
function emitMatcherRefreshFailure(taskId: string, cwd: string): void {
  const recent = runs.listForTask(taskId)[0];
  if (!recent) return;
  const data = `⚠️ mode took effect but the hook matcher couldn't be refreshed — check ${cwd}/.claude/settings.local.json for malformed JSON. The matcher will sync on the next session start.`;
  runs.appendEvent(recent.id, "status", data);
  emit({ runId: recent.id, taskId, stream: "status", data, ts: Date.now() });
}

/**
 * Build the user-facing warning string for an unsuccessful `cycleToMode`
 * outcome. Switch is exhaustive on `result.reason` (a literal union); the
 * TS compiler flags any future reason that isn't handled here. The
 * verification-* reasons carry the most diagnostic value — we surface
 * the observed mode so the user can see exactly where claude landed.
 */
function formatModeChangeFailure(agetorMode: string, result: Extract<CycleResult, { ok: false }>): string {
  const seen = result.lastObserved ?? "unknown";
  switch (result.reason) {
    case "verification timed out": {
      // The auto opt-in modal is by far the most common reason a press
      // produces no JSONL event, but only when the target is `auto`. For
      // any other target the modal advice is misleading, so we drop it.
      const tail = agetorMode === "auto"
        ? " If this is the first time cycling to auto on this account, accept the opt-in prompt in the run panel and try again."
        : "";
      return `⚠️ mode change to ${agetorMode}: claude didn't acknowledge after ${result.attempts ?? "?"} attempt(s) (last seen: ${seen}).${tail}`;
    }
    case "verification mismatch":
      return `⚠️ mode change to ${agetorMode} failed after ${result.attempts ?? "?"} attempt(s) (claude landed on ${seen}). Your account may not have access to this mode — pick a different one in the task details.`;
    case "mode not in cycle":
      return `⚠️ mode change to ${agetorMode} skipped: '${result.target ?? agetorMode}' isn't in this session's Shift+Tab cycle — stop the run and start again with that mode at launch.`;
    case "no live session":
    case "current mode unknown":
      return `⚠️ mode change to ${agetorMode} skipped: ${result.reason} — stop the run and start again to apply.`;
    // T7's paste guard (docs/plans/model-effort-local-command-turns.md §10):
    // `cycleToMode`'s `/plan` path withheld its own paste because a blocking
    // claude modal (permission prompt, AskUserQuestion, another confirm) was
    // still on the pane when the grace window elapsed — no keystrokes were
    // sent at all, so the mode never changed. `ensureInstalledForCwd` is
    // correctly skipped for this case too: it only runs under `result.ok`
    // above, and this branch is exclusively reachable via `result.ok === false`.
    case "paste withheld":
      return `⚠️ ${agetorMode} mode not applied — claude is waiting on a prompt; answer it (or the terminal), then change the mode again.`;
  }
}

/**
 * Stop the active handle `h`'s task. `kill()` sends Ctrl+C to the tmux
 * session, which also clears claude's queued-input buffer, so every queued
 * run in this task is going down too. Mark each active handle as cancelled
 * so their done handlers record "cancelled" (not "failed") when their
 * slot's reject fires. Resolve any in-flight approval / question for this
 * task BEFORE the interrupt — otherwise the hook script's curl and the MCP
 * server's fetch would sit on a doomed HTTP response until their own
 * timeouts. Shared by `cancelRun` (Stop button) and `archiveTask`
 * (`stopRun`) so the two can't drift.
 */
function stopActiveHandle(h: ActiveRun, reason: string): void {
  for (const [, handle] of active) {
    if (handle.taskId === h.taskId) handle.cancelled = true;
  }
  cancelPendingForTask(h.taskId, reason);
  h.kill();
}

/**
 * Stop a task that's "held" (see `isHeldByBackgroundAgents`) — its terminal
 * run already succeeded but background agents are still running, so there's
 * no `active` handle to kill. Interrupt the live session and release the
 * hold. Shared by `cancelRun` (Stop button) and `archiveTask` (`stopRun`).
 */
async function stopHeldTask(taskId: string, reason: string): Promise<void> {
  cancelPendingForTask(taskId, reason);
  // Ordering rule (§7 of the async-warmup plan): the interrupt must complete
  // — not fire-and-forget — before this returns, matching `deleteTask`'s and
  // `enqueueArchiveTeardown`'s kill-before-teardown discipline. Awaited here
  // rather than left as a bare call now that `interruptTaskSession` is async.
  await interruptTaskSession(taskId);
  orphanRunningSubagents(taskId);
}

export async function cancelRun(runId: string): Promise<boolean> {
  const h = active.get(runId);
  if (!h) {
    // A held task (turn succeeded, background agents still running) has no
    // `active` handle — `attachDoneHandler` dropped it before parking the card
    // in `running`. Its Stop button must still do something, or a background
    // agent that wedges without dying leaves the user no way out short of a
    // restart. Interrupt the live session and release the hold; the run itself
    // already succeeded, so the card advances to `review`.
    const taskId = runs.get(runId)?.taskId;
    if (!taskId || !isHeldByBackgroundAgents(taskId)) return false;
    await stopHeldTask(taskId, "cancelled by user");
    return true;
  }
  // Stop targets the whole task, not just one run.
  stopActiveHandle(h, "cancelled by user");
  return true;
}

/**
 * `delivered: false` normally means dispatch never happened at all (task/run
 * not found, worktree restore failed, unknown agent kind). For claude-code,
 * `sendTurnInExistingSession` now AWAITS the paste's real `PasteOutcome`
 * (docs/plans/model-effort-local-command-turns.md §10, "withheld sends
 * surface at the HTTP layer") before resolving, so a THIRD case reaches this
 * type: the message WAS recorded (the optimistic "user" bubble is already in
 * the transcript, and — for an idle send — a new run row exists and the task
 * moved to `running`) but the actual paste never reached claude because a
 * blocking modal was still on the pane. That case sets `withheld: true` and
 * `savedToBacklog: true` — `handlePasteWithheld` has already re-stashed the
 * text into the task's backlog tray and left its own status breadcrumb on
 * the run by the time this resolves, so the caller doesn't need to do
 * anything further with the text itself, just tell the user their message
 * didn't reach the agent. A genuine tmux subprocess failure (not a modal
 * withhold) keeps this plain `{ delivered: false, reason }` shape with no
 * `withheld`/`savedToBacklog` flags.
 *
 * `unresolvedRefs` (delivered variant only, omitted when empty): the raw
 * `@`-tokens (`token.raw` — e.g. `@nope.md`, `@"my file.md"`) the send-time
 * expansion left verbatim because they didn't resolve against this task's
 * cwd — a typo, a file not present in this cwd's tree, or an `@name`
 * extension mention (`@github`) are all indistinguishable here; the server
 * reports the fact, callers decide what's noise.
 */
export type SendInputResult =
  | { delivered: true; runId: string; unresolvedRefs?: string[] }
  | { delivered: false; reason: string; withheld?: true; savedToBacklog?: true };

/**
 * Forward a line of user-supplied input to the agent. Behavior depends on
 * agent kind:
 *
 *   • claude-code: when the session is idle, each user message is its own
 *     turn → its own run row (paste into the live tmux session + a new turn
 *     slot via `sendTurn`). When a turn is already in flight, the message is
 *     *folded* into the active run instead (`pasteFollowUp` — paste into the
 *     session, record a user event on the current run, no new row/slot). This
 *     keeps at most one in-flight run per task so claude coalescing queued
 *     messages can't strand surplus run rows in `running`. See
 *     `sendTurnInExistingSession`.
 *
 *   • codex: each follow-up is queued and spawned as its own `codex exec
 *     resume <thread_id>` turn once the active turn resolves — codex `exec`
 *     is a one-shot process, not a REPL, so there's no live stdin to write
 *     to mid-turn. See `sendCodexTurn`/`drainCodexQueue`.
 *
 *   • cursor: same queue-and-resume shape as codex (`sendCursorTurn`/
 *     `drainCursorQueue`), spawning a fresh `cursor-agent --resume
 *     <session-id>` turn for each queued follow-up — cursor's CLI is
 *     one-shot per turn too.
 *
 *   • gemini: same queue-and-resume shape as codex (`sendGeminiTurn`/
 *     `drainGeminiQueue`), spawning `gemini --resume <session-id>` for each
 *     queued follow-up — gemini's CLI is one-shot per turn too.
 *
 *   • fx: same queue-and-resume shape as codex/cursor/gemini (`sendFxTurn`/
 *     `drainFxQueue`), resuming via fx's ACP session id for each queued
 *     follow-up — fx has no persistent REPL either (see fx-acp.ts).
 *
 * Archived / detached-worktree restore: a message to an archived task
 * auto-unarchives it (sending is an unambiguous signal of continued
 * interest), and if the task's worktree was detached (by archive) or is
 * otherwise missing on disk, it's rematerialized via `prepareWorkdir` before
 * dispatch — same deterministic path, branch, and history, so the resumed
 * turn lands in the same place the agent left off. A hard restore failure
 * (e.g. the branch was deleted or checked out elsewhere) is surfaced as a
 * `delivered: false` result rather than silently falling back to an
 * unisolated cwd.
 */
export async function sendInput(runId: string, line: string): Promise<SendInputResult> {
  const row = db.query<{ task_id: string; agent: string }, [string]>(
    `SELECT task_id, agent FROM runs WHERE id = ?`,
  ).get(runId);
  if (!row) return { delivered: false, reason: "run not found" };

  const task = tasks.get(row.task_id);
  if (!task) return { delivered: false, reason: "task not found" };

  if (task.archivedAt != null) {
    tasks.update(row.task_id, { archivedAt: null });
  }

  // Same race as unarchiveTask/startTask: a deferred archive teardown may
  // still be removing this task's worktree — let it finish before the
  // existsSync check decides whether a restore is needed.
  await pendingTeardown(row.task_id);

  if (task.worktreePath && !existsSync(task.worktreePath)) {
    // Re-fetch so the restore sees the just-cleared archivedAt (prepareWorkdir
    // doesn't care about it, but keeping the object fresh avoids acting on a
    // stale snapshot).
    const fresh = tasks.get(row.task_id) ?? task;
    try {
      const restored = await prepareWorkdir(fresh);
      if ("error" in restored) {
        return { delivered: false, reason: `worktree restore failed: ${restored.error}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { delivered: false, reason: `worktree restore failed: ${msg}` };
    }
  }

  // Single choke point for `@`-token expansion on every follow-up path:
  // webview sends, the backlog tray, the diff composer, ask-card free-text
  // answers, and the CLI all funnel through `sendInput`, so expanding here
  // once — rather than in each per-kind `send*Turn` below — covers all of
  // them with no per-caller change. Re-read the task (rather than reuse the
  // `task` fetched above) because the worktree-restore branch just above may
  // have materialized `worktreePath` for the first time; a stale read would
  // expand against a cwd that didn't exist yet.
  const cwdTask = tasks.get(row.task_id) ?? task;
  // Keep the pre-expansion text around: a claude paste that gets withheld by
  // the modal guard re-stashes into the task's backlog tray (see
  // `handlePasteWithheld`/`restashPasteWithheldText`), and that re-stash must
  // dedupe against the RAW `@token` text a draft/tray item was saved with
  // (plan §3.2) — re-stashing the EXPANDED absolute-path text would never
  // match, producing a duplicate backlog entry every time the same message is
  // retried (R2, code review).
  const rawLine = line;
  const expanded = expandAtReferencesDetailed(line, cwdTask.worktreePath ?? cwdTask.workdir);
  line = expanded.text;
  const unresolvedRefs = expanded.unresolved;

  const harness = resolveHarness(row.agent);
  const kind = harness?.kind;

  // Re-check the argv-launch budget AFTER expansion, mirroring `startTask`'s
  // pre-check (R5, code review): expanding a handful of short `@tokens` into
  // long absolute paths can push a follow-up over gemini's one-shot argv cap
  // even though the raw text the user typed comfortably fit under it. Must
  // run before the per-kind dispatch below — once a kind's `send*Turn` is
  // called it may already queue behind (or fold into) a live session with no
  // way to un-send. A prompt that was ALREADY over budget with no `@` tokens
  // involved (`rawOverage` truthy too) is left alone here, same as
  // `startTask`'s identical carve-out.
  if (kind) {
    const expandedOverage = promptByteOverage(kind, line);
    const rawOverage = line === rawLine ? expandedOverage : promptByteOverage(kind, rawLine);
    if (expandedOverage && !rawOverage) {
      return {
        delivered: false,
        reason:
          `message is ${expandedOverage.bytes - expandedOverage.limit} bytes over `
          + `${harness?.label ?? row.agent}'s ${expandedOverage.limit}-byte launch limit after expanding `
          + `@ file references — shorten it or reference fewer files`,
      };
    }
  }

  if (kind === "claude-code") {
    const result = await sendClaudeTurn(row.task_id, line, rawLine);
    if (!result) return { delivered: false, reason: "internal: task lookup failed" };
    if (!result.delivered) {
      if (result.withheld) {
        return {
          delivered: false,
          withheld: true,
          savedToBacklog: true,
          reason: "claude is waiting on a prompt — your message was saved to the backlog tray",
        };
      }
      return { delivered: false, reason: result.reason };
    }
    return { delivered: true, runId: result.runId, ...(unresolvedRefs.length ? { unresolvedRefs } : {}) };
  }
  // The four `send*Turn` helpers below return `null` in two cases: the task
  // vanished between `sendInput`'s own lookup above and their internal
  // re-fetch (a genuine, rare lookup race), or their `spawn*TurnNow` call
  // found `startingTaskIds` already claimed for this task and declined to
  // mint a second run rather than risk the double-mint race `startingTaskIds`
  // exists to close (see that set's doc, near `startTask`). The second case
  // is overwhelmingly the common one in practice, so the message leads with
  // it — matching the wording claude's own idle-mint guard already uses —
  // while still being accurate ("try again") for the rare lookup race too.
  if (kind === "codex") {
    const result = await sendCodexTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result, ...(unresolvedRefs.length ? { unresolvedRefs } : {}) }
      : {
          delivered: false,
          reason: "another message is already starting a new turn for this task — try again in a moment",
        };
  }
  if (kind === "cursor") {
    const result = await sendCursorTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result, ...(unresolvedRefs.length ? { unresolvedRefs } : {}) }
      : {
          delivered: false,
          reason: "another message is already starting a new turn for this task — try again in a moment",
        };
  }
  if (kind === "gemini") {
    const result = await sendGeminiTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result, ...(unresolvedRefs.length ? { unresolvedRefs } : {}) }
      : {
          delivered: false,
          reason: "another message is already starting a new turn for this task — try again in a moment",
        };
  }
  if (kind === "fx") {
    const result = await sendFxTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result, ...(unresolvedRefs.length ? { unresolvedRefs } : {}) }
      : {
          delivered: false,
          reason: "another message is already starting a new turn for this task — try again in a moment",
        };
  }
  return { delivered: false, reason: `unknown agent kind for "${row.agent}"` };
}

/**
 * Per-task queue of follow-up lines received while a codex turn is in flight.
 * codex `exec` can't take conversational input mid-turn (it's not a REPL), so
 * we hold the message and spawn a fresh `codex exec resume` turn for it once
 * the active turn resolves (`drainCodexQueue`, called from
 * `attachDoneHandler`). This is the codex analogue of claude's fold-while-busy
 * — but codex turns are discrete processes, so it's a real FIFO, not a
 * paste-into-the-live-session fold.
 */
const codexTurnQueue = new Map<string, string[]>();

/**
 * Send a follow-up to a codex task. Each follow-up is its own run row + its own
 * `codex exec resume <thread_id>` turn (sequential-turn model). When a turn is
 * already running, the message is queued; otherwise it spawns immediately.
 * Returns the run id the message was attached to, or null on lookup failure —
 * or when `spawnCodexTurnNow` declined to mint a run because `startingTaskIds`
 * was already claimed for this task (see that set's doc, near `startTask`).
 */
async function sendCodexTurn(taskId: string, line: string): Promise<string | null> {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.runId && active.has(task.runId)) {
    const q = codexTurnQueue.get(taskId) ?? [];
    q.push(line);
    codexTurnQueue.set(taskId, q);
    // Record the user bubble on the active run so the panel reflects it right
    // away; the queued turn that answers it lands as a later run row.
    const runId = task.runId;
    const data = normalizeUserText(line);
    runs.appendEvent(runId, "user", data);
    emit({ runId, taskId, stream: "user", data, ts: Date.now() });
    return runId;
  }
  return spawnCodexTurnNow(task, taskId, line);
}

/**
 * Spawn a fresh codex turn that resumes the task's prior conversation via
 * `codex exec resume <thread_id>`. New run row, new tmux session (the previous
 * turn's exited), same `thread_id` carried forward.
 */
async function spawnCodexTurnNow(task: Task, taskId: string, line: string): Promise<string | null> {
  // Claim the unified "starting" slot before touching the DB — see
  // `startingTaskIds`'s doc (near `startTask`) for the double-mint race this
  // closes: a second overlapping call could otherwise race in behind
  // `tasks.update` below and reach `spawnAgentOrFail` too, minting a second
  // run row and (via the driver's own session pre-kill) tearing down this
  // turn's tmux session mid-spawn. `null` is unambiguous here — every other
  // return path below yields `newRunId`, so a caller seeing `null` knows
  // this call never touched the DB and should treat it as "try again".
  if (startingTaskIds.has(taskId)) return null;
  startingTaskIds.add(taskId);
  try {
    const priorThreadId = findLastCodexSessionId(taskId);
    const cwd = task.worktreePath ?? task.workdir;
    const harness = resolveHarness(task.agent);

    const newRunId = randomUUID();
    const now = Date.now();
    runs.insert({
      id: newRunId,
      taskId,
      agent: task.agent,
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      tmuxSession: sessionNameFor(taskId),
      claudeSessionId: null,
      // Carry the thread id forward up front so a reattach mid-turn finds it even
      // before this run's own `thread.started` re-emits it. onSessionId below
      // re-stamps the same value (idempotent).
      codexSessionId: priorThreadId,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    });
    const prevColumn: ColumnId = task.column;
    tasks.update(taskId, { column: "running", runId: newRunId, blockReason: null });
    if (prevColumn !== "running") {
      emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
    }

    const kind: AgentKind = harness?.kind ?? "codex";
    const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
    onChunk("user", normalizeUserText(line));
    onChunk(
      "status",
      priorThreadId
        ? `resuming codex thread ${priorThreadId.slice(0, 8)}…`
        : "no prior codex thread — starting fresh",
    );

    if (!harness) {
      onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
      runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
      tasks.update(taskId, { column: "ready", runId: null });
      return newRunId;
    }

    const { agent } = await spawnAgentOrFail({
      taskId,
      runId: newRunId,
      harness,
      prompt: line,
      cwd,
      onChunk,
      onSessionId: (sessionId) => {
        runs.update(newRunId, { codexSessionId: sessionId });
      },
      opts: {
        mode: task.mode,
        model: task.model ?? DEFAULT_MODEL[harness.kind],
        effort: task.effort,
        fast: task.fast,
        maxMode: task.maxMode,
        resumeSessionId: priorThreadId,
      },
    });
    if (!agent) {
      // spawnAgentOrFail already failed this run row and bounced the task to
      // `ready` — attachDoneHandler (the only caller of drainCodexQueue) never
      // runs, so any follow-ups queued behind this one would otherwise be
      // stranded and resurface out of order on a later, unrelated turn. The
      // dropped messages were already recorded as `user` events on their
      // originating run, so dropping the queue here is more honest than
      // re-delivering them later.
      codexTurnQueue.delete(taskId);
      return newRunId;
    }
    registerActiveRun(newRunId, taskId, task, agent);
    attachDoneHandler(newRunId, taskId, agent);
    return newRunId;
  } finally {
    startingTaskIds.delete(taskId);
  }
}

/**
 * After a codex turn resolves, spawn the next queued follow-up (if any) as a
 * fresh resume turn. No-op for claude tasks (their queue is always empty) and
 * while a run is still active for the task.
 */
async function drainCodexQueue(taskId: string): Promise<void> {
  const q = codexTurnQueue.get(taskId);
  if (!q || q.length === 0) return;
  const task = tasks.get(taskId);
  // Task vanished, or its agent was switched away from codex while a turn was
  // in flight — abandon the stale queue. Without this guard, draining after a
  // codex→claude switch would spawn the follow-up against the new claude
  // harness with a codex thread id (`claude --resume <codexThreadId>`), which
  // claude rejects.
  if (!task || resolveHarness(task.agent)?.kind !== "codex") {
    codexTurnQueue.delete(taskId);
    return;
  }
  if (task.runId && active.has(task.runId)) return;
  const next = q.shift();
  if (q.length === 0) codexTurnQueue.delete(taskId);
  if (next !== undefined) await spawnCodexTurnNow(task, taskId, next);
}

/** Most-recent codex thread id across the task's runs (for `resume`). */
function findLastCodexSessionId(taskId: string): string | null {
  const row = db.query<{ codex_session_id: string }, [string]>(
    `SELECT codex_session_id FROM runs
     WHERE task_id = ? AND codex_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.codex_session_id ?? null;
}

/**
 * Per-task queue of follow-up lines received while a cursor turn is in
 * flight. `cursor-agent -p` is one-shot per invocation (not a REPL), so we
 * hold the message and spawn a fresh `cursor-agent --resume <session_id>`
 * turn for it once the active turn resolves (`drainCursorQueue`, called from
 * `attachDoneHandler`). Structural clone of `codexTurnQueue` — see that
 * comment for the full rationale.
 */
const cursorTurnQueue = new Map<string, string[]>();

/**
 * Send a follow-up to a cursor task. Each follow-up is its own run row + its
 * own `cursor-agent --resume <session_id>` turn (sequential-turn model). When
 * a turn is already running, the message is queued; otherwise it spawns
 * immediately. Returns the run id the message was attached to, or null on
 * lookup failure — or when `spawnCursorTurnNow` declined to mint a run
 * because `startingTaskIds` was already claimed for this task (see that
 * set's doc, near `startTask`).
 */
async function sendCursorTurn(taskId: string, line: string): Promise<string | null> {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.runId && active.has(task.runId)) {
    const q = cursorTurnQueue.get(taskId) ?? [];
    q.push(line);
    cursorTurnQueue.set(taskId, q);
    // Record the user bubble on the active run so the panel reflects it right
    // away; the queued turn that answers it lands as a later run row.
    const runId = task.runId;
    const data = normalizeUserText(line);
    runs.appendEvent(runId, "user", data);
    emit({ runId, taskId, stream: "user", data, ts: Date.now() });
    return runId;
  }
  return spawnCursorTurnNow(task, taskId, line);
}

/**
 * Spawn a fresh cursor turn that resumes the task's prior conversation via
 * `cursor-agent --resume <session_id>`. New run row, new tmux session (the
 * previous turn's exited), same `session_id` carried forward.
 */
async function spawnCursorTurnNow(task: Task, taskId: string, line: string): Promise<string | null> {
  // Claim the unified "starting" slot before touching the DB — see
  // `startingTaskIds`'s doc (near `startTask`) and the matching comment in
  // `spawnCodexTurnNow` for the double-mint race this closes. `null` is
  // unambiguous: every other return path below yields `newRunId`.
  if (startingTaskIds.has(taskId)) return null;
  startingTaskIds.add(taskId);
  try {
    const priorSessionId = findLastCursorSessionId(taskId);
    const cwd = task.worktreePath ?? task.workdir;
    const harness = resolveHarness(task.agent);

    const newRunId = randomUUID();
    const now = Date.now();
    runs.insert({
      id: newRunId,
      taskId,
      agent: task.agent,
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      tmuxSession: sessionNameFor(taskId),
      claudeSessionId: null,
      codexSessionId: null,
      // Carry the session id forward up front so a reattach mid-turn finds it
      // even before this run's own first event re-emits it. onSessionId below
      // re-stamps the same value (idempotent).
      cursorSessionId: priorSessionId,
      geminiSessionId: null,
      fxSessionId: null,
    });
    const prevColumn: ColumnId = task.column;
    tasks.update(taskId, { column: "running", runId: newRunId, blockReason: null });
    if (prevColumn !== "running") {
      emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
    }

    const kind: AgentKind = harness?.kind ?? "cursor";
    const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
    onChunk("user", normalizeUserText(line));
    onChunk(
      "status",
      priorSessionId
        ? `resuming cursor session ${priorSessionId.slice(0, 8)}…`
        : "no prior cursor session — starting fresh",
    );

    if (!harness) {
      onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
      runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
      tasks.update(taskId, { column: "ready", runId: null });
      return newRunId;
    }

    const { agent } = await spawnAgentOrFail({
      taskId,
      runId: newRunId,
      harness,
      prompt: line,
      cwd,
      onChunk,
      onSessionId: (sessionId) => {
        runs.update(newRunId, { cursorSessionId: sessionId });
      },
      opts: {
        mode: task.mode,
        model: task.model ?? DEFAULT_MODEL[harness.kind],
        effort: task.effort,
        fast: task.fast,
        maxMode: task.maxMode,
        // Same generic resume-session field claude-code and codex already
        // thread through `spawnAgent` → `buildCommand` — cursor's `session_id`
        // rides the same `AgentRunOptions.resumeSessionId` contract rather than
        // a cursor-specific field name (see this function's file-level header
        // note on the resume option-field contract).
        resumeSessionId: priorSessionId,
      },
    });
    if (!agent) {
      // See the matching comment in spawnCodexTurnNow: spawnAgentOrFail already
      // failed this run and attachDoneHandler (the only caller of
      // drainCursorQueue) never runs, so drop the queue rather than let queued
      // follow-ups resurface out of order on a later turn.
      cursorTurnQueue.delete(taskId);
      return newRunId;
    }
    registerActiveRun(newRunId, taskId, task, agent);
    attachDoneHandler(newRunId, taskId, agent);
    return newRunId;
  } finally {
    startingTaskIds.delete(taskId);
  }
}

/**
 * After a cursor turn resolves, spawn the next queued follow-up (if any) as a
 * fresh resume turn. No-op for claude/codex/gemini tasks (their queue is
 * always empty) and while a run is still active for the task.
 */
async function drainCursorQueue(taskId: string): Promise<void> {
  const q = cursorTurnQueue.get(taskId);
  if (!q || q.length === 0) return;
  const task = tasks.get(taskId);
  // Task vanished, or its agent was switched away from cursor while a turn
  // was in flight — abandon the stale queue. Without this guard, draining
  // after a cursor→claude/codex/gemini switch would spawn the follow-up
  // against the new harness with a cursor session id, which the new harness
  // rejects.
  if (!task || resolveHarness(task.agent)?.kind !== "cursor") {
    cursorTurnQueue.delete(taskId);
    return;
  }
  if (task.runId && active.has(task.runId)) return;
  const next = q.shift();
  if (q.length === 0) cursorTurnQueue.delete(taskId);
  if (next !== undefined) await spawnCursorTurnNow(task, taskId, next);
}

/** Most-recent cursor session id across the task's runs (for `--resume`). */
function findLastCursorSessionId(taskId: string): string | null {
  const row = db.query<{ cursor_session_id: string }, [string]>(
    `SELECT cursor_session_id FROM runs
     WHERE task_id = ? AND cursor_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.cursor_session_id ?? null;
}

/**
 * Per-task queue of follow-up lines received while a gemini turn is in
 * flight. Gemini's CLI is one-shot per turn (not a REPL), so — exactly like
 * codex — we hold the message and spawn a fresh `--resume <uuid>` turn for it
 * once the active turn resolves (`drainGeminiQueue`, called from
 * `attachDoneHandler`).
 */
const geminiTurnQueue = new Map<string, string[]>();

/**
 * Send a follow-up to a gemini task. Each follow-up is its own run row + its
 * own `gemini --resume <uuid>` turn (sequential-turn model, same as codex).
 * When a turn is already running, the message is queued; otherwise it spawns
 * immediately. Returns the run id the message was attached to, or null on
 * lookup failure — or when `spawnGeminiTurnNow` declined to mint a run
 * because `startingTaskIds` was already claimed for this task (see that
 * set's doc, near `startTask`).
 */
async function sendGeminiTurn(taskId: string, line: string): Promise<string | null> {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.runId && active.has(task.runId)) {
    const q = geminiTurnQueue.get(taskId) ?? [];
    q.push(line);
    geminiTurnQueue.set(taskId, q);
    // Record the user bubble on the active run so the panel reflects it right
    // away; the queued turn that answers it lands as a later run row.
    const runId = task.runId;
    const data = normalizeUserText(line);
    runs.appendEvent(runId, "user", data);
    emit({ runId, taskId, stream: "user", data, ts: Date.now() });
    return runId;
  }
  return spawnGeminiTurnNow(task, taskId, line);
}

/**
 * Spawn a fresh gemini turn that resumes the task's prior conversation via
 * `gemini --resume <uuid>`. New run row, new tmux session (the previous
 * turn's exited), same self-issued session uuid carried forward — unlike
 * codex's thread id (discovered post-hoc from `thread.started`), gemini's
 * session id is already known synchronously, so it's stamped on the new run
 * row directly rather than via an `onSessionId` re-stamp.
 */
async function spawnGeminiTurnNow(task: Task, taskId: string, line: string): Promise<string | null> {
  // Claim the unified "starting" slot before touching the DB — see
  // `startingTaskIds`'s doc (near `startTask`) and the matching comment in
  // `spawnCodexTurnNow` for the double-mint race this closes. `null` is
  // unambiguous: every other return path below yields `newRunId`.
  if (startingTaskIds.has(taskId)) return null;
  startingTaskIds.add(taskId);
  try {
    const priorSessionId = findLastGeminiSessionId(taskId);
    const cwd = task.worktreePath ?? task.workdir;
    const harness = resolveHarness(task.agent);

    const newRunId = randomUUID();
    const now = Date.now();
    runs.insert({
      id: newRunId,
      taskId,
      agent: task.agent,
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      tmuxSession: sessionNameFor(taskId),
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: priorSessionId,
      fxSessionId: null,
    });
    const prevColumn: ColumnId = task.column;
    tasks.update(taskId, { column: "running", runId: newRunId, blockReason: null });
    if (prevColumn !== "running") {
      emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
    }

    const kind: AgentKind = harness?.kind ?? "gemini";
    const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
    onChunk("user", normalizeUserText(line));
    onChunk(
      "status",
      priorSessionId
        ? `resuming gemini session ${priorSessionId.slice(0, 8)}…`
        : "no prior gemini session — starting fresh",
    );

    if (!harness) {
      onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
      runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
      tasks.update(taskId, { column: "ready", runId: null });
      return newRunId;
    }

    const { agent } = await spawnAgentOrFail({
      taskId,
      runId: newRunId,
      harness,
      prompt: line,
      cwd,
      onChunk,
      // Normally re-stamps the same `priorSessionId` already written above
      // (idempotent) — kept for the edge case where a task somehow has no
      // prior session id yet (spawnAgent mints a fresh uuid via
      // crypto.randomUUID() when resumeSessionId is absent, and this is the
      // only way that freshly-minted id gets persisted).
      onSessionId: (sessionId) => {
        runs.update(newRunId, { geminiSessionId: sessionId });
      },
      opts: {
        mode: task.mode,
        model: task.model ?? DEFAULT_MODEL[harness.kind],
        effort: task.effort,
        fast: task.fast,
        maxMode: task.maxMode,
        resumeSessionId: priorSessionId,
      },
    });
    if (!agent) {
      // See the matching comment in spawnCodexTurnNow: spawnAgentOrFail already
      // failed this run and attachDoneHandler (the only caller of
      // drainGeminiQueue) never runs, so drop the queue rather than let queued
      // follow-ups resurface out of order on a later turn. Reachable in
      // practice via GEMINI_PROMPT_ARGV_MAX_BYTES on a long follow-up.
      geminiTurnQueue.delete(taskId);
      return newRunId;
    }
    registerActiveRun(newRunId, taskId, task, agent);
    attachDoneHandler(newRunId, taskId, agent);
    return newRunId;
  } finally {
    startingTaskIds.delete(taskId);
  }
}

/**
 * After a gemini turn resolves, spawn the next queued follow-up (if any) as a
 * fresh resume turn. No-op while a run is still active for the task, or if
 * the task's agent was switched away from gemini mid-flight.
 */
async function drainGeminiQueue(taskId: string): Promise<void> {
  const q = geminiTurnQueue.get(taskId);
  if (!q || q.length === 0) return;
  const task = tasks.get(taskId);
  // Task vanished, or its agent was switched away from gemini while a turn
  // was in flight — abandon the stale queue. Without this guard, draining
  // after a gemini→claude switch would spawn the follow-up against the new
  // claude harness with a gemini session id, which claude rejects.
  if (!task || resolveHarness(task.agent)?.kind !== "gemini") {
    geminiTurnQueue.delete(taskId);
    return;
  }
  if (task.runId && active.has(task.runId)) return;
  const next = q.shift();
  if (q.length === 0) geminiTurnQueue.delete(taskId);
  if (next !== undefined) await spawnGeminiTurnNow(task, taskId, next);
}

/** Most-recent gemini session id across the task's runs (for `--resume`). */
function findLastGeminiSessionId(taskId: string): string | null {
  const row = db.query<{ gemini_session_id: string }, [string]>(
    `SELECT gemini_session_id FROM runs
     WHERE task_id = ? AND gemini_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.gemini_session_id ?? null;
}

/** * Per-task queue of follow-up lines received while an fx turn is in flight.
 * fx is driven over ACP/stdio (`fx-acp.ts`), one turn per spawn — no
 * persistent REPL, no tmux session — so exactly like codex/cursor/gemini we
 * hold the message and spawn a fresh resumed turn once the active turn
 * resolves (`drainFxQueue`, called from `attachDoneHandler`).
 */
const fxTurnQueue = new Map<string, string[]>();

/**
 * Send a follow-up to an fx task. Each follow-up is its own run row + its own
 * resumed ACP turn (sequential-turn model, same as codex/cursor/gemini). When
 * a turn is already running, the message is queued; otherwise it spawns
 * immediately. Returns the run id the message was attached to, or null on
 * lookup failure — or when `spawnFxTurnNow` declined to mint a run because
 * `startingTaskIds` was already claimed for this task (see that set's doc,
 * near `startTask`).
 */
async function sendFxTurn(taskId: string, line: string): Promise<string | null> {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.runId && active.has(task.runId)) {
    const q = fxTurnQueue.get(taskId) ?? [];
    q.push(line);
    fxTurnQueue.set(taskId, q);
    // Record the user bubble on the active run so the panel reflects it right
    // away; the queued turn that answers it lands as a later run row.
    const runId = task.runId;
    const data = normalizeUserText(line);
    runs.appendEvent(runId, "user", data);
    emit({ runId, taskId, stream: "user", data, ts: Date.now() });
    return runId;
  }
  return spawnFxTurnNow(task, taskId, line);
}

/**
 * Spawn a fresh fx turn that resumes the task's prior conversation via fx's
 * ACP session id. New run row, new spawn — fx has no persistent tmux session
 * to reuse (see fx-acp.ts) — same session id carried forward. Like codex's
 * thread id, fx's session id is DISCOVERED post-hoc (from ACP's `session/new`
 * response), so it's carried forward on the insert below and re-stamped
 * (idempotently) once `onSessionId` fires again for this turn.
 */
async function spawnFxTurnNow(task: Task, taskId: string, line: string): Promise<string | null> {
  // Claim the unified "starting" slot before touching the DB — see
  // `startingTaskIds`'s doc (near `startTask`) and the matching comment in
  // `spawnCodexTurnNow` for the double-mint race this closes. `null` is
  // unambiguous: every other return path below yields `newRunId`.
  if (startingTaskIds.has(taskId)) return null;
  startingTaskIds.add(taskId);
  try {
    const priorSessionId = findLastFxSessionId(taskId);
    const cwd = task.worktreePath ?? task.workdir;
    const harness = resolveHarness(task.agent);

    const newRunId = randomUUID();
    const now = Date.now();
    runs.insert({
      id: newRunId,
      taskId,
      agent: task.agent,
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      tmuxSession: sessionNameFor(taskId),
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: priorSessionId,
    });
    const prevColumn: ColumnId = task.column;
    tasks.update(taskId, { column: "running", runId: newRunId, blockReason: null });
    if (prevColumn !== "running") {
      emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
    }

    const kind: AgentKind = harness?.kind ?? "fx";
    const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
    onChunk("user", normalizeUserText(line));
    onChunk(
      "status",
      priorSessionId
        ? `resuming fx session ${priorSessionId.slice(0, 8)}…`
        : "no prior fx session — starting fresh",
    );

    if (!harness) {
      onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
      runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
      tasks.update(taskId, { column: "ready", runId: null });
      return newRunId;
    }

    const { agent } = await spawnAgentOrFail({
      taskId,
      runId: newRunId,
      harness,
      prompt: line,
      cwd,
      onChunk,
      onSessionId: (sessionId) => {
        runs.update(newRunId, { fxSessionId: sessionId });
      },
      opts: {
        mode: task.mode,
        model: task.model ?? DEFAULT_MODEL[harness.kind],
        effort: task.effort,
        fast: task.fast,
        maxMode: task.maxMode,
        resumeSessionId: priorSessionId,
      },
    });
    if (!agent) {
      // See the matching comment in spawnCodexTurnNow: spawnAgentOrFail already
      // failed this run and attachDoneHandler (the only caller of
      // drainFxQueue) never runs, so drop the queue rather than let queued
      // follow-ups resurface out of order on a later turn.
      fxTurnQueue.delete(taskId);
      return newRunId;
    }
    registerActiveRun(newRunId, taskId, task, agent);
    attachDoneHandler(newRunId, taskId, agent);
    return newRunId;
  } finally {
    startingTaskIds.delete(taskId);
  }
}

/**
 * After an fx turn resolves, spawn the next queued follow-up (if any) as a
 * fresh resume turn. No-op while a run is still active for the task, or if
 * the task's agent was switched away from fx mid-flight.
 */
async function drainFxQueue(taskId: string): Promise<void> {
  const q = fxTurnQueue.get(taskId);
  if (!q || q.length === 0) return;
  const task = tasks.get(taskId);
  // Task vanished, or its agent was switched away from fx while a turn was
  // in flight — abandon the stale queue. Without this guard, draining after
  // an fx→claude switch would spawn the follow-up against the new claude
  // harness with an fx session id, which claude rejects.
  if (!task || resolveHarness(task.agent)?.kind !== "fx") {
    fxTurnQueue.delete(taskId);
    return;
  }
  if (task.runId && active.has(task.runId)) return;
  const next = q.shift();
  if (q.length === 0) fxTurnQueue.delete(taskId);
  if (next !== undefined) await spawnFxTurnNow(task, taskId, next);
}

/** Most-recent fx session id across the task's runs (for resume). */
function findLastFxSessionId(taskId: string): string | null {
  const row = db.query<{ fx_session_id: string }, [string]>(
    `SELECT fx_session_id FROM runs
     WHERE task_id = ? AND fx_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.fx_session_id ?? null;
}

/**
 * Outcome of dispatching one claude-code follow-up turn (`sendClaudeTurn` /
 * `sendTurnInExistingSession`). Both now AWAIT the paste's real
 * `PasteOutcome` before resolving (docs/plans/model-effort-local-command-
 * turns.md §10, "withheld sends surface at the HTTP layer") instead of
 * reporting success purely optimistically. `runId` always names the run the
 * message was recorded against — the folded run for a busy session, or the
 * freshly-created row for an idle send/respawn — even when the paste itself
 * never reached the pane: the optimistic "user" bubble (and, for an idle
 * send, the whole run-row-insert + column-flip) has already happened by the
 * time this resolves, and is never rolled back.
 *
 *   • `delivered: true` — the paste landed (or no `pasteOutcome` was offered
 *     to await, e.g. `spawnResumedSession`'s fresh-spawn path, which has no
 *     live modal to withhold against).
 *   • `delivered: false; withheld: true` — the underlying `PasteOutcome` was
 *     specifically the modal-guard withhold (a blocking claude modal was
 *     still on the pane when the paste's grace window elapsed). This is the
 *     ONLY case `sendInput` reports as `{ withheld: true, savedToBacklog:
 *     true, ... }` rather than a plain failure — `handlePasteWithheld` (wired
 *     as `onPasteFailure` below) has already re-stashed the text into the
 *     task's backlog tray and left its own status breadcrumb on the run by
 *     the time this resolves.
 *   • `delivered: false; reason` — a genuine tmux subprocess failure
 *     (`load-buffer`/`paste-buffer`/`send-keys` exiting non-zero), not a
 *     modal withhold. `handlePasteWithheld` still re-stashes and leaves its
 *     own breadcrumb for this case too; this result just doesn't get the
 *     withheld/savedToBacklog framing.
 */
type ClaudeTurnResult =
  | { runId: string; delivered: true }
  | { runId: string; delivered: false; withheld: true }
  | { runId: string; delivered: false; withheld: false; reason: string };

/**
 * Bound how long `sendTurnInExistingSession` waits for a paste's real
 * `PasteOutcome` before treating it as delivered. This is a driver-bug
 * backstop, not a latency budget — a normal send resolves within the paste
 * guard's own grace window (`PASTE_MODAL_GRACE_MS`, 1.5s) plus at most one
 * poll tick, comfortably under even the old 5s bound. But the same per-task
 * tmux op chain (`queueTmuxOp`) can queue a `/model` picker mirror
 * (`mirrorModelViaPicker`) AHEAD of this paste — its own poll-for-the-picker
 * window plus arrow-walk plus confirm can run ~4.7s before this paste's op
 * even starts, and THEN this paste still has to clear its own 1.5s modal
 * grace on top of that. A 5s bound could time out on that ordinary
 * (non-buggy) queueing delay and report a real withhold as delivered — the
 * worst possible outcome, a lost message the user is told was sent. 15s
 * gives that queueing headroom while still bounding a genuinely stuck
 * driver. If a driver-side bug ever left it unsettled even past that,
 * hanging every claude follow-up send would be far worse than the rare case
 * of reporting an actually-withheld paste as delivered, so a timeout
 * resolves to `undefined` ("no answer") rather than rejecting —
 * `resolveClaudeTurnOutcome` treats that identically to a genuine
 * `{ ok: true }`.
 */
const PASTE_OUTCOME_TIMEOUT_MS = 15_000;

/**
 * Claude's idle/dead-session mint paths (`sendClaudeTurn`'s fresh-spawn
 * branch, via `spawnResumedSession`, and `sendTurnInExistingSession`'s idle
 * branch) claim the unified `startingTaskIds` set declared near `startTask`
 * above — see that doc comment for the full double-mint race this closes.
 * Before wave 1, `sendClaudeTurn` read `sessionLiveness` (and
 * `sessionExists`) SYNCHRONOUSLY, so the whole stretch from that read through
 * the new run row's `tasks.update` executed as one uninterrupted tick of JS;
 * `sessionLiveness` becoming genuinely async (a real tmux probe) opened a
 * real event-loop gap that made this claim necessary. Scoped to ONLY the
 * idle/dead-session paths — the fold-while-busy path (`pasteFollowUp`, above
 * the idle branch in `sendTurnInExistingSession`) is unaffected and still
 * allows any number of concurrent follow-ups to fold onto the one active
 * run. (This used to be a claude-only `startingClaudeIdleTurns` set; it was
 * folded into `startingTaskIds` so a `startTask` and a claude idle-send can't
 * each claim their own disjoint keyspace and both mint.)
 */

/**
 * Await a paste's `pasteOutcome` (from `sendTurn`/`pasteFollowUp`, §10
 * "withheld sends surface at the HTTP layer") and translate it into the
 * `ClaudeTurnResult` `sendInput`'s caller sees. `handlePasteWithheld` (passed
 * as `onPasteFailure` at both `sendTurnInExistingSession` call sites) has
 * ALREADY done the backlog re-stash + run status breadcrumb by the time this
 * resolves — this helper only shapes the HTTP-facing result; it never
 * stashes anything itself, so there's no double-stash.
 */
async function resolveClaudeTurnOutcome(
  runId: string,
  pasteOutcome: Promise<{ ok: boolean; op?: string; stderr?: string }> | undefined,
): Promise<ClaudeTurnResult> {
  if (!pasteOutcome) return { runId, delivered: true };
  // `clearTimeout` once the race settles — whichever side wins, the loser's
  // timer must not linger. Left running it would (a) hold the Bun test
  // runner open for up to `PASTE_OUTCOME_TIMEOUT_MS` past the real outcome on
  // every test that exercises this path, and (b) is simply wasted work once
  // the real answer is already in hand.
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), PASTE_OUTCOME_TIMEOUT_MS);
  });
  const outcome = await Promise.race([pasteOutcome, timeout]);
  clearTimeout(timer!);
  if (!outcome || outcome.ok) return { runId, delivered: true };
  if (outcome.op === "modal-guard") return { runId, delivered: false, withheld: true };
  // Prefer the driver's own descriptive `stderr` (finding #5, §10 re-review)
  // — e.g. "paste dropped: the session was torn down or replaced before the
  // keystrokes went out" for a dropped queued op, which reads correctly
  // rather than the generic `tmux <op>` framing implying a real tmux
  // subprocess failure. Falls back to the op-based message for an older/
  // synthesized outcome with no `stderr`.
  return {
    runId,
    delivered: false,
    withheld: false,
    reason: outcome.stderr || `paste failed: tmux ${outcome.op ?? "unknown"}`,
  };}

/**
 * Send a follow-up prompt to a claude task. Always creates a new run row so
 * the run history shows each user message as its own entry.
 *
 *   • If we hold live in-memory session state AND the tmux session is not
 *     unambiguously gone, we paste the prompt into it as a fresh turn
 *     (`sendTurn`).
 *   • Otherwise (session gone, or a tmux session that outlived our process
 *     after a restart with no in-memory state) we spawn a brand-new session
 *     resuming via `claude --resume <sessionId>` so claude reloads the prior
 *     conversation from its JSONL and keeps going.
 *
 * Returns null only on internal lookup failure (missing task row). Sessions
 * are always recoverable as long as the task itself still exists.
 *
 * `rawLine` is `line` BEFORE `sendInput` expanded its `@tokens` into absolute
 * paths — threaded through so a withheld paste (see `sendTurnInExistingSession`
 * → `handlePasteWithheld`) re-stashes the RAW text into the task's backlog,
 * matching the `@token` form a draft/tray item was saved with (plan §3.2).
 * Optional and defaults to `line` for callers with nothing to distinguish
 * (there are none in production — `sendInput` always passes it — but keeping
 * it optional avoids forcing every test/helper caller to thread a value that
 * happens to equal `line` anyway).
 */
async function sendClaudeTurn(taskId: string, line: string, rawLine?: string): Promise<ClaudeTurnResult | null> {
  const task = tasks.get(taskId);
  if (!task) return null;

  // Route to the live-session paste path unless we're SURE the session is
  // dead. `sessionLiveness` (not the raw `sessionExists` boolean it replaces
  // here) distinguishes an unambiguous `gone` from an `unreachable` probe —
  // the same tri-state #88 introduced for the death watch, because a bare
  // `.ok` boolean conflates "session absent" with "tmux hiccuped" (busy-server
  // EAGAIN under load). Boot reconciliation no longer sweeps idle sessions, so
  // a tmux session can outlive our process with no SessionState — in which
  // case `sendTurn` would reject with "no live session" — so we also require
  // in-memory state. `unreachable` (inconclusive) deliberately still takes the
  // non-destructive paste path: if the session really is dead the paste fails
  // gracefully and the death-watch/boot-reconcile recovers it later; routing
  // it to `spawnResumedSession` instead would risk its unconditional
  // pre-kill (`spawnClaudeViaTmux`) tearing down a live, possibly mid-turn
  // session over a transient probe failure. Only an unambiguous `gone` (or no
  // in-memory state at all) reaches the destructive respawn path.
  if (hasSessionState(taskId) && (await sessionLiveness(sessionNameFor(taskId))) !== "gone") {
    return sendTurnInExistingSession(task, taskId, line, rawLine);
  }
  // Dead/no session: about to mint a brand-new run. Claim the unified
  // per-task "starting" slot first — see `startingTaskIds`'s doc (near
  // `startTask`) for why this is needed now that `sessionLiveness` above is
  // a genuine await.
  if (startingTaskIds.has(taskId)) {
    return {
      runId: task.runId ?? "",
      delivered: false,
      withheld: false,
      reason: "another message is already starting a new turn for this task — try again in a moment",
    };
  }
  startingTaskIds.add(taskId);
  try {
    // A fresh spawn has no live modal to withhold a keystroke against, so
    // there's no `pasteOutcome` to await here — always delivered.
    return { runId: await spawnResumedSession(task, taskId, line), delivered: true };
  } finally {
    startingTaskIds.delete(taskId);
  }
}

/**
 * `rawLine` is `line` before `@token` expansion — see `sendClaudeTurn`'s doc
 * for why a withheld paste must re-stash that raw form, not the expanded one.
 */
async function sendTurnInExistingSession(
  task: Task,
  taskId: string,
  line: string,
  rawLine?: string,
): Promise<ClaudeTurnResult> {
  // Fold-while-busy: if a turn is already in flight, paste the message into
  // the live session and record it on the ACTIVE run — no new run row, no new
  // turn slot. Claude's TUI queues the keystrokes and replays them as part of
  // the current response. This keeps at most one in-flight run per task, which
  // is what prevents the stranding bug: claude can coalesce several queued
  // messages into fewer `end_turn` events than messages, and one slot per
  // message would leave the surplus slots (and their run rows) stuck `running`
  // forever. `active.has(task.runId)` is true iff the latest run hasn't
  // resolved yet (registerActiveRun adds; attachDoneHandler deletes on done) —
  // a more reliable "in flight" signal than the polled `task.column`.
  if (task.runId && active.has(task.runId)) {
    const activeRunId = task.runId;
    // `onPasteFailure` covers T7's paste guard (docs/plans/model-effort-
    // local-command-turns.md §10): a blocking claude modal was still on the
    // pane when the queued paste's grace window elapsed, so this follow-up
    // was never actually delivered to the live session — re-stash it into
    // the task's backlog tray (rather than lose it outright) and say so on
    // the run, since the "user" bubble below is appended optimistically
    // before the paste's real outcome is known.
    const pasted = await pasteFollowUp(taskId, line, {
      onPasteFailure: (outcome) => handlePasteWithheld(taskId, activeRunId, rawLine ?? line, outcome),
    });
    // `pasteFollowUp` returns `false` only when no live session exists (falls
    // through to the idle/respawn path below); otherwise `{ delivered: true;
    // pasteOutcome }` — `pasted` is truthy in that branch, so a plain
    // truthiness check narrows away the `false` case without needing to read
    // a `.delivered` field off it.
    if (pasted) {
      const data = normalizeUserText(line);
      // Record the user bubble optimistically — `pasteFollowUp` only confirms a
      // live session exists, not that claude consumed the keystrokes. If the
      // user hits Stop before claude drains its input buffer, Ctrl+C clears the
      // queued message (see `cancelRun`) and this bubble has no reply. That's the
      // same optimism `sendTurn` already runs with; the bubble correctly reflects
      // that the user did send the message.
      runs.appendEvent(activeRunId, "user", data);
      emit({ runId: activeRunId, taskId, stream: "user", data, ts: Date.now() });
      return resolveClaudeTurnOutcome(activeRunId, pasted.pasteOutcome);
    }
  }

  // Idle (or the paste raced a vanishing session): about to mint a brand-new
  // run row. Claim the unified per-task "starting" slot first — see
  // `startingTaskIds`'s doc (near `startTask`) for why this is needed now
  // that `sendClaudeTurn`'s `sessionLiveness` read is a genuine await: two
  // overlapping sends can both arrive here having each independently
  // observed "idle" from their own stale snapshot.
  if (startingTaskIds.has(taskId)) {
    return {
      runId: task.runId ?? "",
      delivered: false,
      withheld: false,
      reason: "another message is already starting a new turn for this task — try again in a moment",
    };
  }
  startingTaskIds.add(taskId);
  try {
    // One run row per user turn — the runs list mirrors the conversation
    // history at turn granularity. The race that used to make a fast claude
    // reply land the new row as "succeeded" before the UI ever observed the
    // "running" transition no longer matters: the unified task-level event
    // stream surfaces the new user/assistant messages live regardless of
    // which run row they belong to.
    const newRunId = randomUUID();
    const now = Date.now();
    const inheritedSessionId = findLastClaudeSessionId(taskId);
    runs.insert({
      id: newRunId,
      taskId,
      agent: task.agent,
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      tmuxSession: sessionNameFor(taskId),
      claudeSessionId: inheritedSessionId,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    });
    const prevColumn: ColumnId = task.column;
    tasks.update(taskId, { column: "running", runId: newRunId, blockReason: null });
    if (prevColumn !== "running") {
      emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
    }

    const harness = resolveHarness(task.agent);
    const kind: AgentKind = harness?.kind ?? "claude-code";
    const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
    onChunk("user", normalizeUserText(line));

    const agent = await sendTurn(taskId, line, onChunk, {
      onPasteFailure: (outcome) => handlePasteWithheld(taskId, newRunId, rawLine ?? line, outcome),
    });
    registerActiveRun(newRunId, taskId, task, agent);
    attachDoneHandler(newRunId, taskId, agent);
    return resolveClaudeTurnOutcome(newRunId, agent.pasteOutcome);
  } finally {
    startingTaskIds.delete(taskId);
  }
}

/**
 * Shared `onPasteFailure` hook for BOTH claude paste paths in
 * `sendTurnInExistingSession` above — the fold-while-busy follow-up (via
 * `pasteFollowUp`) and a fresh idle turn (via `sendTurn`): a blocking claude
 * modal (T7's paste guard, docs/plans/model-effort-local-command-turns.md
 * §10) was still on the pane when the queued paste's grace window elapsed,
 * so `text` was never actually delivered to the live session as intended.
 * The optimistic "user" bubble the caller already appended stays in the
 * transcript (matching every other optimistic-paste case), but `text` itself
 * would otherwise be lost. `outcome.op`/`outcome.phase` say WHERE the
 * withhold happened:
 *
 *   - `outcome.op !== "modal-guard"` (finding #5, §10 re-review): a REAL
 *     tmux subprocess failure — `load-buffer`/`paste-buffer`/`send-keys`
 *     exited non-zero (dead server, socket gone, session vanished mid-op) —
 *     forwarded verbatim by `sendTurn`/`pasteFollowUp` with no `phase` at
 *     all (only the driver's own synthesized `"modal-guard"` outcomes carry
 *     one). Falling through to the phase-based branches below used to
 *     mislabel this as "claude is waiting on a prompt", which it isn't. The
 *     driver's `reportPasteFailure` already emitted a `"paste failed: tmux
 *     <op> — …"` status chunk on this run before calling `onPasteFailure`,
 *     so this branch does NOT repeat that wording — it re-stashes `text`
 *     and adds a separate, backlog-focused status.
 *   - `"pre-enter"`: the bracketed paste itself landed — `text` is already
 *     sitting in claude's input box, just missing its trailing Enter. Also
 *     re-stashed (finding #3, §10 re-review): the driver's composer-clear
 *     flow now actively CLEARS this leftover text with `Escape Escape`
 *     before the session's next paste (finding #2, §10 re-review), so
 *     leaving it un-stashed here would mean it's silently wiped with no
 *     record once that clear runs. `restashPasteWithheldText`'s dedupe
 *     (a scan of the WHOLE backlog, not just its most-recent item — finding
 *     #3, §10 re-review) still prevents pile-up across repeated pre-enter
 *     withholds of the same message.
 *   - `"composer-dirty"`: an EARLIER withheld message is still sitting in
 *     claude's input box (mid-turn there's no safe way to clear it), so this
 *     NEW paste was withheld before ever reaching the pane. Re-stashed like
 *     `"pre-paste"`, with its own status wording naming the earlier message.
 *   - `"pre-paste"` (or a missing `phase` on an otherwise-`"modal-guard"`
 *     outcome, which shouldn't happen in practice): nothing reached the pane
 *     at all — re-stash `text` into the task's backlog tray so it isn't
 *     lost outright.
 *
 * Re-stashing dedupes against every existing backlog item (not just the
 * most-recently-added one at `task.backlog[0]` — items are unshifted onto
 * the front, see `backlog.add` in db.ts), so a paste that keeps failing
 * across retries with the same text doesn't pile up duplicate drafts, AND so
 * resending a withheld message straight from the tray (`sendBacklogItem` in
 * RunPanel.tsx) doesn't leave a duplicate sitting behind the original
 * (finding #3, §10 re-review) — that item is very often NOT at index 0 by
 * the time its resend is withheld again, since other drafts may have been
 * added or reordered since.
 *
 * `backlog.add` is called directly rather than through the server's
 * `backlogGuard` (an HTTP-route-level check, not something this internal
 * plumbing goes through) — that's safe ONLY because every caller of this
 * function is reachable exclusively through `sendInput`, which auto-
 * unarchives the task before dispatching a turn. This function still
 * re-checks `tasks.get(taskId)?.archivedAt == null` immediately before
 * adding, in case a concurrent `archiveTask` raced the unarchive between
 * `sendInput`'s check and this callback (`onPasteFailure` fires
 * synchronously inside the tmux call chain, not on the same tick as
 * `sendInput`'s own unarchive) — skip + log rather than resurrect an
 * archived task's backlog out from under an in-flight archive.
 *
 * `text` is already the fully-composed message (references, if any, are
 * flattened into it client-side before it ever reaches `sendInput` — see
 * the `/runs/:id/input` route), so there's nothing further to pass through —
 * except that both call sites in `sendTurnInExistingSession` deliberately
 * pass the PRE-expansion (`rawLine ?? line`) text, not the `@token`-expanded
 * one `sendInput` actually hands to claude (R2, code review): a draft/tray
 * backlog item is saved with the raw `@token` form, and this function's own
 * dedupe (`restashPasteWithheldText`'s `item.text === text` scan) would never
 * match an expanded absolute-path re-stash against it, producing a duplicate
 * entry every time the same withheld message is retried.
 */
function handlePasteWithheld(
  taskId: string,
  runId: string,
  text: string,
  outcome: { ok: false; op: string; phase?: "pre-paste" | "pre-enter" | "composer-dirty"; stderr: string },
): void {
  let data: string;
  if (outcome.op !== "modal-guard") {
    // A genuine tmux subprocess failure, not a modal withhold (finding #5,
    // §10 re-review) — see this function's doc for why this must be checked
    // BEFORE the phase-based branches below. Prefers the driver's own
    // descriptive `stderr` — e.g. "paste dropped: the session was torn down
    // or replaced before the keystrokes went out" for a dropped queued op —
    // over a generic "the paste … failed" line that would otherwise misread
    // a dropped op (session disposed/respawned mid-flight) as an ordinary
    // tmux subprocess failure.
    restashPasteWithheldText(taskId, text);
    data = `message saved to your backlog — ${outcome.stderr || "the paste to claude's session failed"}; resend from the tray`;
  } else if (outcome.phase === "pre-enter") {
    // Re-stashed (finding #3, §10 re-review) — see this function's doc.
    restashPasteWithheldText(taskId, text);
    data =
      "paste withheld: claude opened a prompt before your message was sent — it's saved to your backlog (claude's input box will be cleared before your next send); resend from the tray";
  } else if (outcome.phase === "composer-dirty") {
    restashPasteWithheldText(taskId, text);
    data = "paste withheld: claude's input box still holds an earlier message — saved this one to your backlog; resend from the tray once claude is idle";
  } else {
    // "pre-paste", or a missing phase (an older/synthesized outcome) —
    // nothing reached the pane at all.
    restashPasteWithheldText(taskId, text);
    data = "message saved to your backlog — claude is waiting on a prompt; answer it and send the message from the tray";
  }
  runs.appendEvent(runId, "status", data);
  emit({ runId, taskId, stream: "status", data, ts: Date.now() });
}

/** Re-stash a withheld paste's text into the task's backlog tray, deduping
 *  against the most-recently-added item so retries of the same failed paste
 *  don't pile up duplicate drafts. Skips (and logs) rather than adding when
 *  the task is gone or archived — see `handlePasteWithheld`'s doc for why
 *  that race is possible despite `sendInput` auto-unarchiving up front. */
function restashPasteWithheldText(taskId: string, text: string): void {
  const task = tasks.get(taskId);
  if (!task || task.archivedAt != null) {
    console.warn(`[agetor] handlePasteWithheld: task ${taskId} not found or archived — skipping backlog re-stash`);
    return;
  }
  // Scan the WHOLE backlog, not just `task.backlog[0]` (finding #3, §10
  // re-review) — a repeated withhold of the same message is the common case
  // this dedupes, but the item can easily have moved off the front by then
  // (another draft added in between, or a manual reorder), and checking only
  // the front would silently let a duplicate through in exactly that case.
  const alreadyStashed = task.backlog.some((item) => item.text === text);
  if (!alreadyStashed) backlog.add(taskId, { text });
}

/** Test hook: exercise `handlePasteWithheld` directly against a real task
 *  row without driving a full tmux paste-failure scenario. Not part of the
 *  public surface. */
export function __handlePasteWithheldForTest(
  taskId: string,
  runId: string,
  text: string,
  outcome: { ok: false; op: string; phase?: "pre-paste" | "pre-enter" | "composer-dirty"; stderr: string },
): void {
  handlePasteWithheld(taskId, runId, text, outcome);
}

/**
 * Factory installed via `setContinuationRunFactory` (module init, above).
 * claude-tmux's `dispatchLine` calls this when a genuinely-new content line
 * arrives on a task's session with no turn in flight and nothing queued to
 * receive it — the case a post-`end_turn` background-task auto-continuation
 * produces (claude legitimately resolved the visible turn, then kept talking
 * once the delegated work finished). Mirrors the idle branch of
 * `sendTurnInExistingSession` above (run-row insert with an inherited
 * `claudeSessionId`, column pull-back to `running`, chunk handler, active-run
 * registration) minus the `sendTurn`/keystroke-paste step — claude is already
 * mid-response, so there's no prompt to send, only a new run row to listen
 * with.
 *
 * Returns `null` for a task the caller can't safely adopt a run for, which
 * falls back to claude-tmux's pre-existing `lastChunk` routing:
 *   - the synthetic `"__rebuild__"` taskId `rebuildEventsFromJsonl` uses for
 *     its local, DB-detached synthetic SessionState — that id can never
 *     resolve to a real task row via `tasks.get` either, but the check is
 *     spelled out explicitly so it's visible here (and testable) rather than
 *     relying on that incidental fact alone;
 *   - an unknown task (deleted out from under a live session); or
 *   - an archived task (no new run should reopen the card).
 *   - a non-claude-code task: continuations are a claude-JSONL concept (a
 *     background-task auto-continuation observed via `dispatchLine`'s tail of
 *     the session's own JSONL); codex is one-shot per turn and has no
 *     equivalent notion of "kept talking after end_turn", so there's nothing
 *     to adopt a run for. Only claude-tmux's `dispatchLine` calls this
 *     factory today, so this is defense in depth rather than a live path.
 */
function startContinuationRun(taskId: string): ContinuationHooks | null {
  if (taskId === "__rebuild__") return null;
  const task = tasks.get(taskId);
  if (!task || task.archivedAt != null) return null;
  if (resolveHarness(task.agent)?.kind !== "claude-code") return null;

  const newRunId = randomUUID();
  const now = Date.now();
  const inheritedSessionId = findLastClaudeSessionId(taskId);
  runs.insert({
    id: newRunId,
    taskId,
    agent: task.agent,
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: inheritedSessionId,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    origin: "continuation",
  });
  const prevColumn: ColumnId = task.column;
  // Continuation turns always pull the card to `running`, regardless of
  // prior column (mirrors the idle branch above, and matches the owner
  // decision in the plan: the session genuinely resumed talking, so the
  // card must reflect that live activity).
  tasks.update(taskId, { column: "running", runId: newRunId, blockReason: null });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const harness = resolveHarness(task.agent);
  const kind: AgentKind = harness?.kind ?? "claude-code";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("status", "auto-continued after background task");

  return {
    onChunk,
    onAdopted: (handle) => {
      registerActiveRun(newRunId, taskId, task, handle);
      attachDoneHandler(newRunId, taskId, handle);
    },
  };
}

/**
 * Spawn a brand-new tmux session for the task, resuming the previous run's
 * claude conversation via `claude --resume <sessionId>`. claude loads the
 * full prior conversation from its own JSONL (text + thinking + tool_use +
 * tool_result history) so we don't have to prepend any context text to the
 * new prompt — the next message is just the user's new line.
 *
 * Falls back to a fresh session (no --resume) when we don't have a tracked
 * sessionId on any prior run — that path exists for legacy rows created
 * before the claude_session_id column was added.
 *
 * Reuses the existing worktree (`task.worktreePath`) so the agent operates
 * on the same checkout as before.
 */
async function spawnResumedSession(task: Task, taskId: string, line: string): Promise<string> {
  const priorSessionId = findLastClaudeSessionId(taskId);
  const cwd = task.worktreePath ?? task.workdir;

  const newRunId = randomUUID();
  const now = Date.now();
  runs.insert({
    id: newRunId,
    taskId,
    agent: task.agent,
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: priorSessionId,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId, blockReason: null });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const harness = resolveHarness(task.agent);
  const kind: AgentKind = harness?.kind ?? "claude-code";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("user", normalizeUserText(line));
  onChunk(
    "status",
    priorSessionId
      ? `resuming claude session ${priorSessionId.slice(0, 8)}…`
      : "no prior claude session — starting fresh",
  );

  if (!harness) {
    onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
    runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
    tasks.update(taskId, { column: "ready", runId: null });
    return newRunId;
  }
  const { agent } = await spawnAgentOrFail({
    taskId,
    runId: newRunId,
    harness,
    prompt: line,
    cwd,
    onChunk,
    onSessionId: (sessionId) => {
      runs.update(newRunId, { claudeSessionId: sessionId });
    },
    opts: {
      mode: task.mode,
      model: task.model ?? DEFAULT_MODEL[harness.kind],
      effort: task.effort,
      fast: task.fast,
      maxMode: task.maxMode,
      resumeSessionId: priorSessionId,
    },
  });
  // claude has no turn queue (spawnResumedSession is only reached from the
  // idle branch of sendInput) — nothing to drop on failure here.
  if (!agent) return newRunId;

  registerActiveRun(newRunId, taskId, task, agent);
  attachDoneHandler(newRunId, taskId, agent);
  return newRunId;
}

/**
 * Find the most recently-recorded claude_session_id across the task's runs.
 * Iterating across runs (not just the latest) because a row may not have
 * had its sessionId stamped if the JSONL discovery raced — we still want to
 * resume the prior conversation if any earlier run has the id.
 */
function findLastClaudeSessionId(taskId: string): string | null {
  const row = db.query<{ claude_session_id: string }, [string]>(
    `SELECT claude_session_id FROM runs
     WHERE task_id = ? AND claude_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.claude_session_id ?? null;
}

export interface CreateTaskInput extends Partial<Task> {
  title: string;
  prompt: string;
  /** Optional ref name (branch / tag / sha). Defaults to "HEAD". Resolved to a sha at create time. */
  baseRef?: string;
  /**
   * Check the worktree out on this pre-existing branch (e.g. a PR's head
   * branch) instead of minting a fresh one. Requires worktree isolation and
   * a git `workdir`; sets `task.branchSource = "existing"` and pins `baseRef`
   * to the branch's current sha rather than resolving `baseRef`/`branch`
   * from a template.
   */
  existingBranch?: string;
  /**
   * Issue URL this task is created from — validated with `parseIssueUrl` and
   * same-repo-checked against `workdir`'s remote (see `createTask`'s body).
   * Also settable via the inherited `Partial<Task>` field; listed here too
   * so its doc comment lives next to `issueSnapshot`, which only makes sense
   * alongside it.
   */
  issueUrl?: string | null;
  /**
   * Full markdown snapshot of the issue + its comment thread
   * (`renderIssueThreadMarkdown`). When present (and `issueUrl` validates),
   * written to `dataDir/issue-threads/<taskId>/<ISSUE_SNAPSHOT_FILENAME>`
   * and appended to the task's references so the agent can read the full
   * thread regardless of the prompt's inline cap. Ignored (no-op, not an
   * error) when `issueUrl` is absent or fails validation.
   */
  issueSnapshot?: string;
  /**
   * Opt-in: create this task as a pipeline task (`pipelineStage: "specify"`,
   * the first of 9 spec-driven auto-advancing stages — see
   * pipeline-prompts.ts and advancePipelineStage). Never inferred from any
   * other field — always explicit. Absent/false is a completely ordinary
   * task.
   */
  pipeline?: boolean;
}

/**
 * Create a task. When `isolation === "worktree"` and `workdir` is a git repo,
 * resolves the requested base (default "HEAD") to a concrete sha now, so re-runs
 * always start from the same commit even after the source repo moves. Returns
 * `{ error }` if a non-default base ref was specified but can't be resolved
 * (typo, deleted branch, etc.).
 */
export async function createTask(
  input: CreateTaskInput,
): Promise<{ task: Task } | { error: string }> {
  const now = Date.now();
  // Only the trimmed, explicitly-provided workdir counts as user intent. We
  // still fall back to process.cwd() for the task itself so direct API
  // callers don't break, but we DON'T register that fallback as a project —
  // the projects list should only contain folders the user actually chose.
  const explicitWorkdir = input.workdir?.trim() ? input.workdir.trim() : null;
  const workdir = explicitWorkdir ?? process.cwd();
  const isolation = input.isolation ?? "worktree";
  const requestedRef = input.baseRef?.trim() || "HEAD";
  const existingBranch = input.existingBranch?.trim() || null;

  let baseRef: string | null = null;
  let plannedBranch: string | null = null;
  let branchSource: Task["branchSource"] = "created";
  const workdirRoot = isolation === "worktree" ? await repoRoot(workdir) : null;

  if (existingBranch) {
    if (isolation !== "worktree" || !workdirRoot) {
      return {
        error: `existingBranch requires worktree isolation and a git repo — "${workdir}" isn't one, or isolation is "${isolation}"`,
      };
    }
    if (existingBranch.startsWith("-")) {
      return { error: `invalid branch name: ${existingBranch}` };
    }
    const validated = validateBranchName(existingBranch);
    if (!validated.ok) {
      return { error: `invalid branch name "${existingBranch}": ${validated.reason}` };
    }
    const collision = tasks.list().some(
      (t) => !t.archivedAt && t.workdir === workdir && t.branch === existingBranch,
    );
    if (collision) {
      return { error: `another task already has "${existingBranch}" checked out in ${workdir}` };
    }
    await fetchBranch(workdir, existingBranch);
    const sha =
      (await resolveRef(workdir, `refs/remotes/origin/${existingBranch}`)) ??
      (await resolveRef(workdir, `refs/heads/${existingBranch}`));
    if (!sha) {
      return { error: `branch not found: "${existingBranch}" (checked origin and local refs)` };
    }
    baseRef = sha;
    plannedBranch = existingBranch;
    branchSource = "existing";
  } else if (workdirRoot) {
    const sha = await resolveRef(workdir, requestedRef);
    if (!sha) {
      if (requestedRef !== "HEAD") {
        return { error: `base ref "${requestedRef}" not found in ${workdir}` };
      }
    } else {
      baseRef = sha;
    }
  }

  // Projects table is populated EXCLUSIVELY through the explicit folder
  // picker (POST /projects/pick) — never auto-added from a task's workdir.
  // Previously we upserted on every task create, which silently surfaced
  // worktree temp paths and stray ad-hoc dirs in the sidebar.

  const id = randomUUID();

  // Resolve the harness so we can default model/effort by kind. A bad alias
  // id is rejected up-front rather than persisted and surfacing as a launch
  // failure later. Falls back to the built-in claude-code id when the caller
  // omits `agent` entirely.
  const agentId = input.agent ?? "claude-code";
  const harness = resolveHarness(agentId);
  if (!harness) {
    return { error: `unknown harness "${agentId}"` };
  }
  const kind = harness.kind;
  const model = input.model ?? DEFAULT_MODEL[kind];
  // Discovered efforts (e.g. Codex's own app-server catalog) win when the
  // harness reported a non-empty list for this model; the curated
  // MODEL_EFFORT_SUPPORT table is only the fallback (see
  // `supportedEfforts`/`getDiscoveredEfforts`). The default effort is the
  // kind default (`DEFAULT_EFFORT[kind]`) when it's among the offered ids,
  // else the strongest offered id — mirroring the picker's own "kind default
  // if offered, else first row" rule. Haiku 4.5 (and any future model whose
  // effort support list is empty either way) sends null effort.
  //
  // Deliberate side effect versus the old direct-table read: an *unlisted*
  // gemini/fx model id used to store `high` here (`MODEL_EFFORT_SUPPORT[kind][model]`
  // read `undefined` for an unknown key, which failed the `Array.isArray`
  // check and fell through to `DEFAULT_EFFORT[kind]`), while a *listed*
  // gemini/fx model (whose curated set is `[]`) stored `null`. Routing
  // through `supportedEfforts` makes both cases resolve to `null` — that's
  // what the PATCH null-clear guard and every picker already compute for an
  // unknown id, so this closes a known inconsistency, on purpose.
  const support = supportedEfforts(kind, model, getDiscoveredEfforts(kind, model, harness.id));
  const effort = input.effort
    ?? (support.length === 0
      ? null
      : support.some((o) => o.id === DEFAULT_EFFORT[kind]) ? DEFAULT_EFFORT[kind] : support[0]!.id);

  // Validate taskType against the known set so a bogus value can't poison
  // the row (the picker only ever sends one of the canonical ids, but
  // direct API callers don't have that constraint).
  const requestedType = input.taskType;
  const taskType: TaskType =
    requestedType && TASK_TYPES.some((t) => t.id === requestedType)
      ? requestedType
      : DEFAULT_TASK_TYPE;

  // Pin the branch name now so renaming the task later (before the first run)
  // doesn't produce a different name on each start attempt. Only set when the
  // workdir is a git repo. An explicit override (from the New Task sidebar's
  // editable branch field) wins when valid; otherwise the name is composed from
  // the project's branch nomenclature (falling back to the built-in defaults).
  // Either way, any branch-template tags (`<slug>`, `<project_name>`, `<type>`,
  // `<date>`, `<timestamp>`, `<token>`) are resolved server-side (the server is
  // authoritative for direct API callers and for `<timestamp>` at true creation
  // time) BEFORE validation, and the resolved name is made unique within the
  // repo so two same-title/type tasks don't collide on one branch. Skipped
  // entirely when `existingBranch` already pinned `plannedBranch` above.
  if (!existingBranch && workdirRoot) {
    const override = typeof input.branch === "string" ? input.branch.trim() : "";
    const token = id.replace(/-/g, "").slice(0, 6);
    const ctx = { title: input.title, projectName: basename(workdir), taskType, token, now: new Date() };
    let desired: string;
    if (override) {
      const rendered = renderBranchTemplate(override, ctx);
      const v = validateBranchName(rendered);
      if (!v.ok) {
        const detail = rendered !== override
          ? `invalid branch name "${rendered}" (from template "${override}"): ${v.reason}`
          : `invalid branch name "${override}": ${v.reason}`;
        return { error: detail };
      }
      desired = rendered;
    } else {
      const config = projects.get(workdir)?.branchConfig ?? DEFAULT_BRANCH_CONFIG;
      desired = renderBranchTemplate(branchPattern(config, taskType), ctx);
      // Defensive: a hand-edited/corrupt config shouldn't hard-fail task
      // creation — fall back to the legacy scheme if it produced an illegal name.
      if (!validateBranchName(desired).ok) desired = branchName({ id, title: input.title });
    }
    const taken = new Set(
      tasks.list().map((t) => t.branch).filter((b): b is string => Boolean(b)),
    );
    plannedBranch = await ensureUniqueBranch(workdirRoot, desired, taken);
  }

  // Issue provenance (docs/plans/new-task-from-git-issue.md): validated once,
  // at create time only — `issueUrl` is never patchable afterward (kept out
  // of the PATCH allow-list in server.ts). A bad or wrong-repo URL rejects
  // the whole create, since "View issue" and the PR-body "Closes #N" prefill
  // both trust this field being correct. The stored value is the
  // `normalizeIssueUrl` form (lowercased host, no query/hash/slug tail), not
  // the raw string the caller sent — so the durable field is always
  // canonical and directly comparable via `normalizeIssueUrl`/`sameIssueUrl`
  // elsewhere, regardless of which slug/query the user happened to paste.
  let validatedIssueUrl: string | null = null;
  let parsedIssue: ReturnType<typeof parseIssueUrl> = null;
  const rawIssueUrl = input.issueUrl?.trim() || "";
  if (rawIssueUrl) {
    parsedIssue = parseIssueUrl(rawIssueUrl);
    if (!parsedIssue) return { error: "issueUrl is not a recognized issue URL" };
    const repoInfo = await providerRepoForDir(workdir);
    if (!repoInfo) return { error: `${workdir} has no ${parsedIssue.provider} remote for that issue` };
    const sameRepo = repoInfo.provider === parsedIssue.provider
      && `${repoInfo.owner}/${repoInfo.name}`.toLowerCase() === `${parsedIssue.owner}/${parsedIssue.repo}`.toLowerCase();
    if (!sameRepo) {
      return {
        error: `issue URL points at ${parsedIssue.owner}/${parsedIssue.repo}, but the project's remote is ${repoInfo.owner}/${repoInfo.name}`,
      };
    }
    validatedIssueUrl = normalizeIssueUrl(rawIssueUrl);
  }

  const task = tasks.insert({
    id,
    title: input.title,
    prompt: input.prompt,
    column: input.column ?? "backlog",
    agent: agentId,
    workdir,
    isolation,
    taskType,
    branch: plannedBranch,
    branchSource,
    worktreePath: null,
    baseRef,
    // No PR exists for a brand-new task; set server-side by pull-create.
    prUrl: null,
    issueUrl: validatedIssueUrl,
    mode: input.mode ?? null,
    model,
    effort,
    fast: input.fast === true,
    maxMode: input.maxMode === true,
    references: input.references ?? [],
    // Brand-new tasks start with an empty backlog; drafts are added later from
    // the run panel.
    backlog: [],
    // Composer draft starts empty; autosaved from the run panel thereafter.
    draft: null,
    // Brand-new tasks have no detected Cursor/claude plans yet — populated
    // later by `attachDoneHandler` (cursor) or the chunk handler (claude).
    plans: [],
    // Brand-new tasks have no todo-family tool activity yet — populated
    // later by the chunk handler's `maybeUpdateTodoProgress`.
    todoProgress: null,
    runId: null,
    // Derived at fetch time via SQL EXISTS — supply `false` here so the
    // `Task` shape is complete; `tasks.insert` re-fetches and the real
    // value flows back to the caller.
    hasOpenableRun: false,
    // Derived from the in-memory interactions Maps in `interactions.ts`; a
    // brand-new task has no pending interactions, so 0 is the correct seed.
    pendingInteractionCount: 0,
    // Derived from the in-memory terminal manager in `terminals.ts`; a
    // brand-new task has no open terminals, so 0 is the correct seed.
    openTerminalCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    // Pipeline opt-in (input.pipeline): the task's whole subsequent
    // lifecycle — column choices in startTask, prompt selection, stage
    // transitions — is driven off pipelineStage from here on, never off
    // input.pipeline again. An ordinary task gets all-zero/null defaults.
    pipelineStage: input.pipeline ? "specify" : null,
    planApproved: false,
    implementationApproved: false,
    revisionCount: 0,
    pipelineFeedback: null,
    pausedAt: null,
    // A brand-new task has never been blocked.
    blockReason: null,
    // Child-linking fields — only ever passed by build-scheduler.ts's
    // tickBuild (the public POST /tasks route strips them from the request
    // body before calling createTask). null for every ordinary/top-level
    // task, including pipeline tasks themselves.
    parentTaskId: input.parentTaskId ?? null,
    planSubtaskId: input.planSubtaskId ?? null,
    childMergeStatus: input.parentTaskId ? "pending" : null,
    satisfiedSubtasks: [],
  });

  // Write the full thread snapshot (issue body + every fetched comment) to
  // its own per-task directory and reference it, so the agent can read the
  // complete thread regardless of the prompt's inline cap. Best-effort: the
  // prompt already carries an inline excerpt, so a write failure shouldn't
  // fail task creation — just log and hand back the task as-is.
  if (validatedIssueUrl && parsedIssue && input.issueSnapshot) {
    try {
      const snapshotDir = join(dataDir, "issue-threads", task.id);
      mkdirSync(snapshotDir, { recursive: true });
      const snapshotPath = join(snapshotDir, ISSUE_SNAPSHOT_FILENAME(parsedIssue.number));
      writeFileSync(snapshotPath, input.issueSnapshot);
      if (!task.references.some((r) => r.path === snapshotPath)) {
        const updated = tasks.update(task.id, {
          references: [...task.references, { path: snapshotPath, isDirectory: false }],
        });
        if (updated) return { task: updated };
      }
    } catch (e) {
      console.warn(`[agetor] failed to write issue thread snapshot for task ${task.id}:`, e);
    }
  }

  return { task };
}

/**
 * Shared teardown job for archiving a task — tmux/codex session kill, then
 * open terminal tabs, then `detachWorktree` — in that exact order, because a
 * live shell cwd'd inside the worktree would block `git worktree remove`.
 * Both `archiveTask` (the fresh-archive path AND the already-archived
 * re-enqueue path below) and the boot-time `sweepArchivedTeardowns` route
 * through this one function so the three call sites can never drift apart.
 *
 * The harness kind is resolved synchronously here, before the job closure is
 * built and handed to `enqueueTeardown` — same as the original inline code,
 * just no longer duplicated at each call site.
 *
 * `enqueueTeardown` deliberately swallows job errors to keep its per-workdir
 * FIFO chain alive for every other task queued behind this one (see its doc
 * comment) — so it can't just return the `detachWorktree` result. Instead the
 * result is captured in a closure variable (`result`, exposed via the
 * returned getter) that a caller reads AFTER awaiting `promise`. This is the
 * same idiom `deleteOrphanWorktree` already uses to get a real outcome out of
 * a swallowed job.
 */
function enqueueArchiveTeardown(
  task: Task,
  opts?: { force?: boolean },
): { promise: Promise<void>; result: () => WorktreeTeardownResult | undefined } {
  const kind = resolveHarness(task.agent)?.kind;
  let result: WorktreeTeardownResult | undefined;
  const promise = enqueueTeardown(task.id, task.workdir, async () => {
    // `enqueueTeardown` only guarantees this job runs after everything already
    // queued for `task.workdir` — it can sit behind other jobs for seconds,
    // and `task` was captured at ENQUEUE time by every call site (fresh
    // archive, already-archived re-enqueue, boot sweep). The
    // `pendingTeardown(taskId)` discipline elsewhere only protects
    // materialize-AFTER-teardown; it does nothing about the opposite
    // interleaving: `sendInput`/`startTask` clear `archivedAt` and start
    // `prepareWorkdir`'s multi-second `git worktree add` BEFORE a fresh
    // `archiveTask` call (e.g. the Worktrees page's delete button) can see the
    // half-built directory and enqueue a teardown job right behind it. By the
    // time that job reaches the front of the queue, the task has moved on —
    // tearing down with the stale `task` snapshot would rip out a worktree the
    // agent is (or is about to be) running in. So re-read the row here, at job
    // execution time, and bail if it moved: gone entirely, un-archived
    // (`archivedAt == null` — both `sendInput` and `startTask` clear it
    // *before* calling `prepareWorkdir`, so this check is the same signal that
    // closes the window), or a run has since started. A bail is reported as
    // `"failed"` (not `"no-worktree"`/`"already-absent"`, which the client
    // reads as silent success) because the directory is still there — the
    // caller should retry, not assume it's clean.
    //
    // The live-run check keys on `cancelled`, NOT on `active.has(runId)`:
    // `archiveTask({ stopRun: true })` — what the Worktrees page's delete
    // button always sends — stops the run via `stopActiveHandle`, which
    // flags the handle `cancelled` and kills it, but the `active.delete`
    // only happens later in the async exit handler. A bare `active.has`
    // would therefore see the run we ourselves just stopped, bail, and
    // report a bogus failure for every delete of a *running* worktree. A
    // handle that's present and NOT cancelled is the real signal: a run
    // that started after we enqueued, which we must not tear down under.
    const cur = tasks.get(task.id);
    const liveHandle = cur?.runId ? active.get(cur.runId) : undefined;
    if (!cur || cur.archivedAt == null || (liveHandle && !liveHandle.cancelled)) {
      result = { removed: false, reason: "failed" };
      return;
    }
    // Terminals → sessions → worktree. Terminal tabs hold only PTYs rooted
    // in the worktree dir, not a tmux session, so they can die independently
    // of (and, under the scheduler, sooner than) the drop*Session awaits
    // below — killing them first is what keeps `killTerminalsForTask`'s own
    // completion honest relative to the drop*Session ordering guarantee the
    // next paragraph documents, and both must still land before the
    // worktree is detached/removed.
    await killTerminalsForTask(cur.id);
    // Same contract as deleteTask: dropSession is non-throwing (it
    // best-efforts tmux teardown internally). Don't wrap — a silent catch
    // would hide a regression in claude-tmux from the next reviewer. Awaited
    // (wave 1 made every drop* async) so the session kill genuinely completes
    // BEFORE detachWorktree below — ordering rule from
    // docs/plans/fix-archive-teardown-queue.md, still load-bearing now that
    // "complete" means "the awaited promise settled" rather than "the
    // synchronous call returned".
    if (kind === "claude-code") await dropSession(cur.id);
    else if (kind === "codex") await dropCodexSession(cur.id);
    else if (kind === "cursor") await dropCursorSession(cur.id);
    else if (kind === "gemini") await dropGeminiSession(cur.id);
    else if (kind === "fx") dropFxSession(cur.id); // fx has no tmux session — stays sync
    result = await detachWorktree(cur, { force: opts?.force });
  });
  return { promise, result: () => result };
}

/**
 * Archive a finished task: stamp `archivedAt`, kill its claude tmux session
 * AND any open terminal tabs (both best-effort) so no background shell outlives
 * the user's interest in the task — once archived the card is hidden, so the
 * user can no longer reach those shells to close them — then **detach** the
 * worktree from disk (`detachWorktree`): the checkout is removed to reclaim
 * space, but the branch, every commit, the run/run_events history, and
 * claude's external JSONL transcript all survive untouched. Sending a
 * follow-up message or unarchiving later rematerializes the worktree at the
 * same deterministic path (`prepareWorkdir`'s re-attach path) and resumes the
 * conversation right where it left off.
 *
 * Only allowed when the task is in the `done` column — archive is the
 * terminal step of the explicit review → done → archive flow. Pass
 * `{ force: true }` to bypass ONLY that column gate (e.g. the Worktrees page's
 * delete action, which archives a stale worktree's task regardless of where
 * it sits on the board) — the active-run rejection, `archivedAt` stamping,
 * and deferred teardown below are unchanged either way.
 *
 * Pass `{ stopRun: true }` to archive a task with an in-flight (or
 * held-by-background-agents) run anyway: the run is stopped exactly the way
 * the Stop button stops it (`stopActiveHandle`/`stopHeldTask`, shared with
 * `cancelRun`) before the normal archive path below proceeds. Without it,
 * the active-run guard stays in place as a backstop.
 *
 * Pass `{ forceWorktree: true }` to have the detach discard uncommitted
 * changes in the checkout rather than leaving it in place (threaded straight
 * through to `detachWorktree`'s `force` option) — an explicit, user-confirmed
 * opt-in from the Worktrees page, since it's a destructive, unrecoverable
 * discard of anything not committed.
 *
 * Pass `{ awaitTeardown: true }` to block until the deferred teardown above
 * has actually run and get its real `WorktreeTeardownResult` back as
 * `teardown` — the Worktrees page's delete action needs to know the
 * directory is truly gone before it refreshes the list, unlike the kanban
 * archive button, which stays fire-and-forget by leaving this unset.
 */
export async function archiveTask(
  taskId: string,
  opts?: { force?: boolean; stopRun?: boolean; forceWorktree?: boolean; awaitTeardown?: boolean },
): Promise<{ task: Task; teardown?: WorktreeTeardownResult } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.column !== "done" && !opts?.force) {
    return { error: "only tasks in Done can be archived" };
  }
  // Defence-in-depth: column='done' should imply no live run, but column is
  // freely PATCHable (drag-to-Done on a running card is allowed today). If a
  // run is still active, refuse rather than killing tmux out from under it —
  // the exit handler would then flip the now-archived task to 'ready' and
  // leave the row in a contradictory state — UNLESS the caller explicitly
  // asked us to stop it first (`stopRun`), in which case we do exactly what
  // the Stop button does before proceeding.
  if (task.runId && active.has(task.runId)) {
    if (!opts?.stopRun) {
      return { error: "task is still running — cancel the run before archiving" };
    }
    stopActiveHandle(active.get(task.runId)!, "task archived");
  } else if (opts?.stopRun && isHeldByBackgroundAgents(taskId)) {
    await stopHeldTask(taskId, "task archived");
  }
  if (task.archivedAt != null) {
    // Already archived is normally a cheap no-op — repeat-archives (e.g. a
    // double click) shouldn't re-enqueue teardown work every time. But when
    // the worktree is STILL on disk, the previous teardown either never ran
    // (this instance crashed before the boot sweep got to it) or never
    // finished — and this is exactly the reported bug: the Worktrees page's
    // "archive & delete" action calls archive on a row that's already
    // archived, and the old bare `return { task }` here meant that row could
    // never be cleaned up. Re-enqueue instead, gated on the same
    // `worktreePath && existsSync(...)` condition `sweepArchivedTeardowns`
    // already uses at boot, so an ordinary repeat-archive with nothing left
    // to remove stays a bare return.
    if (task.worktreePath && existsSync(task.worktreePath)) {
      const { promise, result } = enqueueArchiveTeardown(task, { force: opts?.forceWorktree });
      if (opts?.awaitTeardown) {
        await promise;
        // A requested outcome should never come back silently absent — if
        // the job threw and enqueueTeardown swallowed it, `result()` is
        // still undefined here, so report it as a failed removal instead of
        // omitting `teardown` from the response.
        return { task, teardown: result() ?? { removed: false, reason: "failed" } };
      }
      void promise;
    } else if (opts?.awaitTeardown) {
      // Same "never come back silently absent" contract as the branch above,
      // for the case where there was never anything to tear down. Both
      // outcomes are successes for the client (nothing left to remove) — this
      // only stops the response from omitting `teardown` when it was asked
      // for, matching `WorktreeTeardownResult`'s documented contract.
      return {
        task,
        teardown: task.worktreePath
          ? { removed: false, reason: "already-absent" }
          : { removed: false, reason: "no-worktree" },
      };
    }
    return { task };
  }
  const updated = tasks.update(taskId, { archivedAt: Date.now() });
  if (!updated) return { error: "task not found" };
  // Turn queues are cheap in-memory bookkeeping (no I/O), so they're dropped
  // inline rather than folded into the deferred job.
  codexTurnQueue.delete(taskId);
  cursorTurnQueue.delete(taskId);
  geminiTurnQueue.delete(taskId);
  fxTurnQueue.delete(taskId);
  // Deferred: the actual teardown (tmux kill, terminal shells, worktree
  // detach) is pushed onto this task's source-workdir teardown queue rather
  // than awaited here, so `archiveTask` can flip the DB column and return in
  // milliseconds. Archiving several tasks against the same workdir back-to-
  // back no longer blocks each POST on tmux kills (async `Bun.spawn` now,
  // but still real wall-clock latency) or `git worktree remove --force`/
  // `prune` — those still run (serialized per
  // workdir, see `enqueueTeardown`), just off the request's critical path;
  // tasks in a different workdir proceed independently. Callers that must
  // not race a deferred teardown (unarchive, start, delete, the boot sweep)
  // await `pendingTeardown(taskId)` first. `awaitTeardown` is the one opt-in
  // exception: the Worktrees page explicitly wants to block on this specific
  // teardown to get a truthful result back.
  const { promise, result } = enqueueArchiveTeardown(updated, { force: opts?.forceWorktree });
  if (opts?.awaitTeardown) {
    await promise;
    return { task: updated, teardown: result() ?? { removed: false, reason: "failed" } };
  }
  void promise;
  return { task: updated };
}

/**
 * Reverse of `archiveTask`: clear the timestamp and, best-effort, restore the
 * worktree if `archiveTask` detached it (or it's otherwise missing on disk).
 * Restore failure doesn't block the unarchive — the card comes back either
 * way; a later send/start/terminal-open retries the restore lazily.
 */
export async function unarchiveTask(taskId: string): Promise<{ task: Task } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.archivedAt == null) return { task };
  // Wait out any teardown archiveTask deferred for this task BEFORE deciding
  // whether the worktree needs restoring. Without this, a still-in-flight
  // `detachWorktree` could delete the worktree right after the `existsSync`
  // check below decided it was still present (or right after a restore
  // recreated it), leaving the task unarchived but pointing at a directory
  // that's about to vanish out from under it.
  await pendingTeardown(taskId);
  const updated = tasks.update(taskId, { archivedAt: null });
  if (!updated) return { error: "task not found" };
  if (updated.worktreePath && updated.branch && !existsSync(updated.worktreePath)) {
    try {
      const restored = await prepareWorkdir(updated);
      if ("error" in restored) {
        console.warn(`[agetor] unarchiveTask: worktree restore failed for ${taskId}: ${restored.error}`);
      }
    } catch (err) {
      console.warn(`[agetor] unarchiveTask: worktree restore failed for ${taskId}:`, err);
    }
  }
  return { task: updated };
}

/**
 * Pause a pipeline task's auto-advance: `advancePipelineStage` already
 * checks `pausedAt` before spawning the *next* stage's run (see the
 * `spawnStage` closure) — this just sets the flag. Never interrupts an
 * in-flight stage's agent; that stage still runs to completion, it's only
 * the one after it that doesn't auto-start. Errors rather than silently
 * no-oping on a non-pipeline task, since pausing one has no meaning.
 */
export function pausePipelineTask(taskId: string): { task: Task } | { error: string } {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.pipelineStage == null) return { error: "not a pipeline task" };
  if (task.pausedAt != null) return { task }; // already paused — no-op
  const updated = tasks.update(taskId, { pausedAt: Date.now() });
  return updated ? { task: updated } : { error: "task not found" };
}

/**
 * Resume a paused pipeline task. Clears `pausedAt` and, if there's no run
 * currently active for it (the common case — pause's whole point was to
 * skip spawning the next stage), starts one for whatever stage the task is
 * currently sitting on. If a stage's run happened to still be in flight
 * when pause was requested, that run's own resolution will now correctly
 * auto-advance again since `pausedAt` is clear by the time it checks.
 */
export async function resumePipelineTask(taskId: string): Promise<{ task: Task } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.pipelineStage == null) return { error: "not a pipeline task" };
  const updated = tasks.update(taskId, { pausedAt: null });
  if (!updated) return { error: "task not found" };
  if (!updated.runId || !active.has(updated.runId)) {
    const started = await startTask(taskId);
    if ("error" in started) return { error: started.error };
  }
  return { task: tasks.get(taskId) ?? updated };
}

/**
 * Explicit human declaration that a build subtask's work is satisfied
 * WITHOUT a merged child — `POST /tasks/:id/satisfy-subtask`. The durable
 * escape hatch for bookkeeping-vs-reality divergence: a subtask whose work
 * landed some other way (re-implemented on the parent branch after a failed
 * merge) otherwise re-trips the build barrier on every bounce back into
 * building, forever.
 *
 * Persisted on `task.satisfiedSubtasks`, consumed by `buildBarrierState`
 * (counts as met) and `tickBuild` (never spawns a child for it, counts it as
 * a met dependency). A leftover un-merged child row for the subtask is
 * archived (force) so the board reflects the decision and no later tick can
 * retry its doomed merge. Audited as a status event on the latest run, same
 * treatment as the gate override.
 */
export async function satisfyPipelineSubtask(
  taskId: string,
  subtaskId: string,
): Promise<{ task: Task } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.pipelineStage == null || task.parentTaskId != null) return { error: "not a pipeline task" };
  if (task.archivedAt != null) return { error: "task is archived" };
  if (typeof subtaskId !== "string" || !subtaskId.trim()) return { error: "subtaskId required" };

  // Validate against the declared plan so a typo can't silently "satisfy"
  // nothing. Missing/unparseable TASKS.json is a real error here, mirroring
  // buildBarrierState's "invalid" posture.
  const planPath = join(task.worktreePath ?? task.workdir, PIPELINE_TASKS_FILE);
  if (!existsSync(planPath)) return { error: `${PIPELINE_TASKS_FILE} is missing` };
  const parsed = parseBuildPlan(readFileSync(planPath, "utf8"));
  if (!parsed.ok) return { error: parsed.reason };
  if (!parsed.plan.subtasks.some((s) => s.id === subtaskId)) {
    return { error: `subtask "${subtaskId}" is not declared in ${PIPELINE_TASKS_FILE}` };
  }

  const child = tasks.list().find((t) => t.parentTaskId === taskId && t.planSubtaskId === subtaskId);
  if (child?.childMergeStatus === "merged") {
    return { error: `subtask "${subtaskId}" is already merged — nothing to satisfy` };
  }
  if (child?.childMergeStatus === "merge-conflict") {
    // Refuse only while the resolution turn is genuinely LIVE. A stale
    // "merge-conflict" (the resolution run died/orphaned across a restart)
    // must stay satisfiable — it's the human's only unwedge — and the parked
    // merge it left in the parent worktree gets aborted below.
    if (task.runId && active.has(task.runId)) {
      return { error: `subtask "${subtaskId}" has a merge-resolution turn in flight — stop it or let it finish first` };
    }
    await abortMerge(task.worktreePath ?? task.workdir);
  }
  if (task.satisfiedSubtasks.includes(subtaskId)) {
    return { error: `subtask "${subtaskId}" is already marked satisfied` };
  }

  tasks.update(taskId, { satisfiedSubtasks: [...task.satisfiedSubtasks, subtaskId] });
  const latest = runs.listForTask(taskId)[0];
  if (latest) {
    pipelineStatus(
      latest.id, taskId,
      `subtask "${subtaskId}" marked satisfied by user — the build barrier no longer requires its merge`,
    );
  }
  if (child && child.archivedAt == null) {
    // Its branch will never be merged now; park the card honestly and tear
    // down the redundant worktree, same treatment the barrier-completion
    // sweep gives merged children.
    const result = await archiveTask(child.id, { force: true, stopRun: true });
    if ("error" in result) {
      console.error(`[agetor] failed to archive satisfied subtask's child ${child.id}:`, result.error);
    }
  }
  const updated = tasks.get(taskId);
  return updated ? { task: updated } : { error: "task not found" };
}

/**
 * Explicit human override of a pipeline gate — `POST
 * /tasks/:id/pipeline-override`. The legitimate need behind a human wanting
 * to wave a gate through in-chat: with the provenance gate in
 * `advancePipelineStage`, a coerced in-chat verdict line on a conversation
 * turn no longer works at all — this route is the ONLY way to force a gate.
 *
 * Advances exactly one stage, mirroring each gate's own approve/pass edge
 * (same patches, including the fingerprint/feedback resets), and records a
 * durable status event on the task's latest run naming the override. Only
 * the four gate-bearing stages can be overridden: the artifact stages
 * (specify/clarify/planning/decompose) gate on file existence/validity —
 * there is no judgment call to overrule. `building`'s override force-skips
 * the DAG barrier — that is exactly the "human decides the unmet subtasks
 * don't matter" case, and it is recorded as such.
 */
export function overridePipelineGate(taskId: string): { task: Task } | { error: string } {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.pipelineStage == null || task.parentTaskId != null) return { error: "not a pipeline task" };
  if (task.archivedAt != null) return { error: "task is archived" };
  if (task.runId && active.has(task.runId)) {
    return { error: "a stage run is still in flight — stop it or wait for it to finish first" };
  }

  const audit = (next: string): void => {
    const latest = runs.listForTask(taskId)[0];
    if (!latest) return;
    pipelineStatus(
      latest.id, taskId,
      `pipeline gate overridden by user — ${task.pipelineStage} forced to ${next}`,
    );
  };

  switch (task.pipelineStage) {
    case "plan-review": {
      tasks.update(taskId, { planApproved: true, pipelineFeedback: null, pipelineBounceFingerprint: null });
      if (tasks.get(taskId)?.implementationApproved) {
        audit("done");
        updateColumn(taskId, null, "done", "stage-advance");
      } else {
        audit("decompose");
        spawnPipelineStage(taskId, null, "decompose", { revisionCount: 0 });
      }
      break;
    }
    case "building": {
      // Make the override DURABLE, not amnesiac: mark every currently-unmet
      // subtask as satisfied so a later bounce back into building can't
      // re-trip the barrier on the exact state the human just waved through.
      // Recorded per-subtask in the audit.
      const barrier = buildBarrierState(task);
      if (barrier.kind === "incomplete" && barrier.unmet.length > 0) {
        const merged = Array.from(new Set([...task.satisfiedSubtasks, ...barrier.unmet]));
        tasks.update(taskId, { satisfiedSubtasks: merged });
        const latest = runs.listForTask(taskId)[0];
        if (latest) {
          pipelineStatus(
            latest.id, taskId,
            `gate override marked unmet subtasks satisfied: ${barrier.unmet.join(", ")}`,
          );
        }
      }
      audit("code-review");
      spawnPipelineStage(taskId, null, "code-review", { pipelineFeedback: null, pipelineBounceFingerprint: null });
      break;
    }
    case "code-review": {
      audit("testing");
      spawnPipelineStage(taskId, null, "testing", { pipelineFeedback: null, pipelineBounceFingerprint: null });
      break;
    }
    case "testing": {
      audit("done");
      tasks.update(taskId, { implementationApproved: true, pipelineFeedback: null, pipelineBounceFingerprint: null });
      updateColumn(taskId, null, "done", "stage-advance");
      break;
    }
    default:
      return { error: `stage "${task.pipelineStage}" has no gate to override — it advances on its artifact alone` };
  }

  const updated = tasks.get(taskId);
  return updated ? { task: updated } : { error: "task not found" };
}

/**
 * Delete a task and best-effort tear down its worktree. Kills any active run
 * first so we don't leave a stale process around.
 */
export async function deleteTask(taskId: string): Promise<void> {
  const task = tasks.get(taskId);
  if (!task) return;
  // Cascade: a pipeline task's "building" stage may have live children
  // (parentTaskId === taskId) with their own runs/worktrees. Tear each down
  // the same way (recursive — children never have children of their own, so
  // this can't recurse past one extra level) BEFORE the parent itself, so
  // nothing is left stranded with a dangling parentTaskId once the parent
  // row is gone.
  for (const child of tasks.list().filter((t) => t.parentTaskId === taskId)) {
    await deleteTask(child.id);
  }
  if (task.runId && active.has(task.runId)) active.get(task.runId)?.kill();
  // Resolve any pending interactions for this task so hook scripts / MCP
  // children blocked on agetor unblock immediately. Done before dropSession
  // so the curl / fetch awaiters return before tmux kills them.
  cancelPendingForTask(taskId, "task deleted");
  // The precomputed review diff (O-6) lives outside the worktree, so the
  // worktree teardown below never sees it — remove it here. Best-effort.
  removeReviewDiff(dataDir, taskId);
  // Kill the task's tmux session before tearing down the worktree so we don't
  // leave an orphaned session behind. For claude it outlives individual runs;
  // for codex/cursor/gemini it only exists during an in-flight turn —
  // dropCodexSession/dropCursorSession/dropGeminiSession also clear any
  // in-memory tailer. fx has no tmux session at all (ACP/stdio) — dropFxSession
  // just clears its in-memory state. No-op when no session exists.
  const deleteKind = resolveHarness(task.agent)?.kind;
  codexTurnQueue.delete(taskId);
  cursorTurnQueue.delete(taskId);
  geminiTurnQueue.delete(taskId);
  fxTurnQueue.delete(taskId);
  // Routed through the same per-workdir teardown queue archiveTask uses —
  // DELETE's semantics are unchanged (still awaited before `tasks.delete`
  // below), but this serializes it behind any archive teardown already in
  // flight for another task in the SAME source workdir, so two `git worktree
  // remove`/`prune` calls against the same repo never contend on git's locks
  // at the same time. A delete against an unrelated workdir is unaffected.
  await enqueueTeardown(taskId, task.workdir, async () => {
    // Terminals → sessions → worktree. Terminal tabs hold only PTYs rooted
    // in the worktree dir, not a tmux session, so they can die independently
    // of (and sooner than) the drop*Session awaits below — kill them first,
    // then the drop*Session calls (awaited — wave 1 made every drop* async —
    // so the session kill genuinely completes, not just gets kicked off,
    // same ordering discipline as enqueueArchiveTeardown above), then remove
    // the worktree. A live shell still sitting in the worktree dir would
    // block `git worktree remove`, so both kills must land before it.
    await killTerminalsForTask(taskId);
    if (deleteKind === "claude-code") await dropSession(taskId);
    else if (deleteKind === "codex") await dropCodexSession(taskId);
    else if (deleteKind === "cursor") await dropCursorSession(taskId);
    else if (deleteKind === "gemini") await dropGeminiSession(taskId);
    else if (deleteKind === "fx") dropFxSession(taskId); // fx has no tmux session — stays sync
    await removeWorktree(task);
  });
  // Refs are otherwise path-only — agetor never copies anything to disk for
  // them — except the per-task issue-thread snapshot directory (written by
  // `createTask` when `issueSnapshot` is provided), which is the one thing
  // under `dataDir` this task might own. Best-effort: a task without one
  // (the common case) makes this a no-op, and a failure here shouldn't block
  // the delete itself.
  try {
    rmSync(join(dataDir, "issue-threads", taskId), { recursive: true, force: true });
  } catch (e) {
    console.warn(`[agetor] failed to remove issue thread snapshot dir for task ${taskId}:`, e);
  }
  tasks.delete(taskId);
}

/**
 * Boot-time healing pass for teardowns that never ran: if agetor quit or
 * crashed between an `archiveTask` response landing (DB flipped, teardown
 * enqueued) and the deferred job actually executing, the in-memory queue is
 * gone on restart but the worktree is still sitting on disk. This also heals
 * the pre-existing crash-mid-archive case that could strand a worktree even
 * before teardown was deferred (a crash between the DB update and the old
 * synchronous `detachWorktree` call).
 *
 * `tasks.list()` already includes archived rows (no archived filter in its
 * query), so a plain scan is enough. Re-enqueues the identical teardown job
 * `archiveTask` would have run — session drop keyed to the task's own id,
 * `killTerminalsForTask`, `detachWorktree` — through the same per-workdir
 * queue (keyed on each task's own `workdir`), so it's serialized against
 * anything already in flight for that source repo without waiting on
 * unrelated repos' backlogs. Kills are always keyed to a specific task id
 * from this instance's own DB; this never enumerates or kills `agetor-*`
 * tmux sessions directly (the shared-socket rule reconcileOrphans documents
 * above applies here too).
 *
 * Fire-and-forget from the caller's perspective — returns the count enqueued,
 * not a promise, since it only needs to kick the jobs off.
 */
export function sweepArchivedTeardowns(): number {
  let enqueued = 0;
  for (const task of tasks.list()) {
    if (task.archivedAt == null) continue;
    if (!task.worktreePath) continue;
    if (!existsSync(task.worktreePath)) continue;
    // Defensive: an archived task shouldn't have a live run (archiveTask
    // refuses to archive one), but mirror that guard here too rather than
    // risk tearing down a worktree out from under an in-flight run.
    if (task.runId && active.has(task.runId)) continue;
    // No `force` — an explicit owner decision (see the plan doc): discarding
    // uncommitted work with no human in the loop, unattended at boot, is not
    // a trade worth making. A dirty worktree just stays stuck until the user
    // forces it from the Worktrees page.
    enqueueArchiveTeardown(task);
    enqueued++;
  }
  return enqueued;
}

/**
 * Idle-session reaper (T4, `docs/plans/reduce-cpu-and-memory.md` §3.1). Kills
 * the tmux session backing a claude-code task's REPL once it's sat idle —
 * no turn in flight, nothing waiting on the user, no session activity — for
 * `IDLE_SESSION_REAP_MS` (30min), reclaiming the ~300–500MB "node" process
 * and every per-session timer (`disposeSessionState`, invoked via
 * `dropSession`). A follow-up sent afterward still works: `sendClaudeTurn`
 * falls back to `spawnResumedSession` (`claude --resume <id>`) whenever
 * `hasSessionState` is false, so this is invisible to the user beyond a
 * slightly slower first reply.
 *
 * Candidates come ONLY from this instance's own DB — this must never
 * enumerate-and-kill tmux sessions (the shared-socket rule documented on
 * `reconcileOrphans` above applies here identically: a blind sweep would
 * reap a sibling agetor instance's or a `bun test` run's sessions). Probing
 * a specific candidate task id we already own (`probeSessionActivity`,
 * `sessionIdleInfo`) is fine — that's a keyed lookup, not a sweep. Codex and
 * gemini are never candidates: their sessions are one-shot per turn and
 * self-dispose (`codex-tmux.ts`, `gemini-tmux.ts`), so there's nothing to
 * reap.
 *
 * Two performance properties keep a sweep from becoming a synchronous burst
 * that stalls the main process for the duration of the scan (previously: N
 * non-archived claude tasks × ~5 DB queries + a blocking tmux probe each, all
 * in one event-loop turn):
 *  - **Cheap pre-filter.** `candidateIds` is derived entirely from the rows
 *    `tasks.list()` already fetched (no per-candidate `tasks.get` yet) and
 *    excludes any task that plainly can't own a session: archived, non-claude,
 *    or — the key trim — neither holding in-memory `SessionState` nor ever
 *    having started a run (`hasSessionState(t.id) || t.runId != null`). A
 *    never-started task fails both and drops out before it costs anything
 *    more than an array filter.
 *  - **Per-candidate yield.** `await Bun.sleep(0)` at the top of every loop
 *    iteration hands control back to the event loop between candidates, so
 *    HTTP requests, SSE pushes, and session tailers keep running throughout a
 *    sweep instead of queuing up behind it. This is what makes the pre-kill
 *    re-check below load-bearing rather than defensive-only: with real
 *    yields between iterations, a message that lands mid-sweep (starts a
 *    turn, opens a pending interaction) MUST be caught by a guard re-read
 *    immediately before the kill, not just the one the loop started with.
 *
 * Every guard is re-checked against a freshly-read task row immediately
 * before the kill, not from the snapshot the loop started with. Guard work
 * itself is hoisted to avoid redundant reads: `isReapable` takes the already
 * -fetched `Task` row and calls the pure `isTaskHeldByBackgroundAgents(task)`
 * predicate directly rather than the taskId-keyed `isHeldByBackgroundAgents`
 * wrapper, which would otherwise re-fetch the same row internally.
 *
 * Called once ~30s after boot (letting boot reattach settle first) and then
 * on a `SESSION_REAP_SWEEP_MS` interval from `src/bun/index.ts` and
 * `src/bun/headless.ts`.
 */
export async function reapIdleSessions(): Promise<{ reaped: string[] }> {
  if (reapInFlight) return { reaped: [] };
  reapInFlight = true;
  try {
    const reaped: string[] = [];
    const candidateIds = tasks
      .list()
      .filter(
        (t) =>
          t.archivedAt == null
          && resolveHarness(t.agent)?.kind === "claude-code"
          && (hasSessionState(t.id) || t.runId != null),
      )
      .map((t) => t.id);

    const isReapable = (task: Task): boolean => {
      if (task.runId && active.has(task.runId)) return false;
      if (isTaskHeldByBackgroundAgents(task)) return false;
      // `isTaskHeldByBackgroundAgents` only covers the `running`-column
      // #92 hold (main run succeeded, subagents still finishing) — it
      // requires `task.column === "running"`. Since #93
      // (`signalSubagentApiError`), a task can leave the `active` map via
      // `blocked` instead: one subagent's API error aborts the main turn
      // while SIBLING subagents are still legitimately running and tailed.
      // That case slips past the check above (column is `blocked`, not
      // `running`), so re-check independently of column/hold state — a
      // task with any running subagent row must never have its tmux
      // session reaped out from under agents still writing to it.
      if (subagents.hasRunning(task.id)) return false;
      if (countPendingForTask(task.id) > 0) return false;
      return true;
    };

    for (const taskId of candidateIds) {
      // Yield between candidates — see the perf-properties doc above. Safe
      // because every guard is re-checked against a fresh row immediately
      // before the kill below.
      await Bun.sleep(0);

      const task = tasks.get(taskId);
      if (!task || !isReapable(task)) continue;

      const idleInfo = sessionIdleInfo(taskId);
      let idleLongEnough: boolean;
      if (idleInfo) {
        idleLongEnough = idleInfo.idleMs >= IDLE_SESSION_REAP_MS;
      } else {
        // No in-memory SessionState — e.g. a done/review task whose session
        // survived a restart (boot reconciliation only reattaches `running`
        // rows). Probe tmux directly for the session's own activity clock
        // (`#{session_activity}`) instead of the previous `task.updatedAt`
        // heuristic, which could read stale on a task nobody touched through
        // agetor but that's still being used interactively in its terminal.
        // `null` means the session is already gone (or unreachable) — nothing
        // to reap. `attached === true` means a human has the pane open right
        // now — never reap that regardless of how long it's been idle by the
        // clock. Otherwise require BOTH tmux's activity clock AND the task
        // row's `updatedAt` past the threshold before reaping a session we
        // have no in-memory visibility into — the extra-conservative choice
        // called out in the review: a session could be driven by something
        // other than agetor (a human at the tmux client) bumping tmux's
        // activity clock without ever updating our DB row, or vice versa.
        const activity = await probeSessionActivity(taskId);
        if (!activity) continue;
        if (activity.attached) continue;
        idleLongEnough =
          Date.now() - activity.activityAt >= IDLE_SESSION_REAP_MS
          && Date.now() - task.updatedAt >= IDLE_SESSION_REAP_MS;
      }
      if (!idleLongEnough) continue;

      // Re-check immediately before the kill against a fresh row — closes
      // the window between the idle check above (which may itself have
      // awaited a yield or a tmux probe) and the kill below.
      const fresh = tasks.get(taskId);
      if (!fresh || !isReapable(fresh)) continue;

      await dropSession(taskId);
      reaped.push(taskId);

      const recent = runs.listForTask(taskId)[0];
      if (recent) {
        const data = findLastClaudeSessionId(taskId)
          ? "session hibernated after 30m idle — next message will resume it"
          : "session hibernated after 30m idle — no saved session id, next message starts a fresh context";
        // Idempotence backstop: a re-reap regression (e.g. the tmux 3.6a
        // `display-message` exact-match bug worked around in
        // `probeSessionActivity`, which made every probe look like "never
        // attached, idle since 1970" and re-reaped every candidate on every
        // sweep) must not re-spam the run with duplicate hibernate
        // breadcrumbs. A legitimate later hibernate always has intervening
        // events (resuming creates a new run / new events), so "the last
        // persisted event for this run is this exact breadcrumb" is safe to
        // treat as "already reaped, skip" — both the append AND the emit,
        // since an emit without persistence would still paint a new chip
        // client-side on every sweep.
        if (runs.lastEventData(recent.id) !== data) {
          runs.appendEvent(recent.id, "status", data);
          emit({ runId: recent.id, taskId, stream: "status", data, ts: Date.now() });
        }
      }
    }

    if (reaped.length > 0) {
      console.log(`[agetor] reaped ${reaped.length} idle claude session(s)`);
    }
    return { reaped };
  } finally {
    reapInFlight = false;
  }
}

/**
 * Enumerate every git worktree materialized on disk under `WORKTREES_DIR` and
 * cross-reference it against `tasks.list()` (the directory basename equals
 * the owning task's id by construction — see `worktreePath` in worktree.ts).
 * Backs `GET /worktrees`.
 *
 * Deliberately fs + DB only — no git subprocesses — so this stays cheap
 * enough to poll. Staleness is classified per `WorktreeStaleReason`:
 *  - `"orphaned"` — no task row for the dir (crash/failed teardown leftover).
 *  - `"archived"` — the owning task is archived but the dir is still present
 *    (teardown pending, failed, or skipped because the worktree was dirty).
 *  - `"inactive"` — not archived, no run in flight, no background
 *    agents/workflows still running, and the task hasn't been touched in
 *    over `WORKTREE_STALE_AFTER_MS`.
 *
 * Returns `[]` when `WORKTREES_DIR` doesn't exist yet (no worktree has ever
 * been created). Non-directory entries and dotfiles are skipped.
 */
export function listWorktrees(): WorktreeInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(WORKTREES_DIR);
  } catch {
    return [];
  }
  const taskById = new Map(tasks.list().map((t) => [t.id, t]));
  // One grouped query for the whole listing (same pattern the `/tasks` route
  // uses, backed by migration 042's partial index) instead of a per-row
  // lookup — cheap enough to run unconditionally, unlike a git subprocess.
  const runningByTask = subagents.runningCountsByTask();
  const out: WorktreeInfo[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dirPath = join(WORKTREES_DIR, name);
    let isDir = false;
    try {
      isDir = statSync(dirPath).isDirectory();
    } catch {
      continue; // vanished between readdir and stat — skip rather than error
    }
    if (!isDir) continue;

    const task = taskById.get(name);
    const staleReasons: WorktreeStaleReason[] = [];
    // Same active-run check archiveTask uses for its defence-in-depth guard.
    const runActive = !!(task?.runId && active.has(task.runId));
    // Background agents/workflows (subagent rows) still writing to the
    // worktree must hold off the "inactive" flag even though the main run's
    // own `active` slot is long gone. Sourced from the grouped map above, so
    // this is a lookup, not a query — always `false` for an orphan (no task).
    const heldByBackgroundAgents = !!task && (runningByTask.get(task.id) ?? 0) > 0;
    if (!task) {
      // No owning row — nothing else applies (can't be archived or idle-by-age).
      staleReasons.push("orphaned");
    } else {
      // A worktree can carry both reasons at once (archived AND past the
      // inactivity threshold), so these are independent checks, not a chain.
      if (task.archivedAt != null) staleReasons.push("archived");
      if (
        !runActive
        && Date.now() - task.updatedAt > WORKTREE_STALE_AFTER_MS
        && !heldByBackgroundAgents
      ) {
        staleReasons.push("inactive");
      }
    }

    out.push({
      id: name,
      path: dirPath,
      taskId: task?.id ?? null,
      taskTitle: task?.title ?? null,
      column: task?.column ?? null,
      archivedAt: task?.archivedAt ?? null,
      taskUpdatedAt: task?.updatedAt ?? null,
      branch: task?.branch ?? null,
      // Owned worktree: the task's own workdir. Orphan: best-effort parse of
      // the `.git` pointer file — plain fs, no git subprocess.
      workdir: task?.workdir ?? parseWorktreeGitPointer(dirPath),
      runActive,
      heldByBackgroundAgents,
      stale: staleReasons.length > 0,
      staleReasons,
    });
  }
  return out;
}

/**
 * Resolve a worktree id (a directory basename under `WORKTREES_DIR`) to its
 * absolute path, with the confinement checks shared by every worktree-id
 * endpoint: no `/`, `\`, `..`, or empty string, and the resolved path must
 * be a direct child of `WORKTREES_DIR`, never the directory itself (guards
 * against ids like `"."` that pass the substring checks but normalize to
 * `WORKTREES_DIR` — an `rm -rf` there would delete every task's worktree).
 * Factored out of `deleteOrphanWorktree` so `worktreeGitStatus` shares the
 * exact same guard rather than a hand-copied one that could drift.
 */
function resolveWorktreeDir(id: string): { dir: string } | { error: string } {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return { error: "invalid worktree id" };
  }
  const dirPath = join(WORKTREES_DIR, id);
  if (basename(dirPath) !== id) {
    return { error: "invalid worktree id" };
  }
  return { dir: dirPath };
}

/**
 * Delete an orphaned worktree directory — one with no owning task row, so
 * there's no ticket for `archiveTask` to archive. Used by the Worktrees
 * page's delete action for `WorktreeInfo` rows where `taskId` is null.
 *
 * Refuses (rather than silently no-oping) when a task row for `id` still
 * exists — that worktree is owned, and the caller should archive the task
 * instead, which routes through the normal teardown path. `id` is validated
 * via `resolveWorktreeDir` so the resolved path can never escape
 * `WORKTREES_DIR`.
 *
 * Awaits `pendingTeardown(id)` before touching the directory — the fleet
 * invariant every worktree-touching path follows, in case a stale teardown
 * from a task that used to own this id is still draining. Never kills any
 * tmux session: an orphan has no owning task, and the fleet rule forbids
 * enumerate-and-kill of `agetor-*` sessions on the shared tmux socket.
 */
export async function deleteOrphanWorktree(id: string): Promise<{ ok: true } | { error: string }> {
  const resolved = resolveWorktreeDir(id);
  if ("error" in resolved) return resolved;
  const dirPath = resolved.dir;

  let isDir = false;
  try {
    isDir = statSync(dirPath).isDirectory();
  } catch {
    return { error: "worktree not found" };
  }
  if (!isDir) return { error: "worktree not found" };
  if (tasks.get(id)) {
    return { error: "this worktree is owned by an active task — archive the task instead" };
  }

  await pendingTeardown(id);

  // Best-effort: find the source repo before the dir is gone so we can prune
  // its stale `.git/worktrees/<id>` registration afterwards.
  const sourceRoot = parseWorktreeGitPointer(dirPath);

  // Run the rm + prune on the source repo's teardown FIFO (keyed by
  // sourceRoot, same as archiveTask/deleteTask's teardown) so an orphan
  // cleanup can't contend on git's `.git/worktrees/.lock` with a concurrent
  // same-repo archive/delete teardown. `enqueueTeardown` swallows job errors
  // — a single misbehaving teardown must not break the chain for every task
  // queued behind it — so the closure-captured `result` is how we still
  // surface a failed rm to the caller after the await. When the source repo
  // can't be determined, key by `dirPath` instead: there's no shared lock
  // domain to serialize against, so this degrades to a private one-entry
  // chain, behaviorally the same as running it inline.
  //
  // Caveat: archive/delete key their chains by the raw `task.workdir` string,
  // whereas `sourceRoot` here is the realpath'd repo root git wrote into the
  // `.git` pointer. If those aren't byte-identical (trailing slash, a symlinked
  // path, or a workdir that's a repo *subdir*), the orphan prune lands on a
  // different FIFO and could still race that repo's `.git/worktrees/.lock` —
  // the same best-effort limitation `teardownTails` already documents. Harmless
  // (a lost lock just skips one prune; the next worktree op in that repo clears
  // the stale registration), so not worth resolving the root to reconcile keys.
  let result: { ok: true } | { error: string } = { ok: true };
  await enqueueTeardown(id, sourceRoot ?? dirPath, async () => {
    try {
      await rm(dirPath, { recursive: true, force: true });
    } catch (err) {
      result = { error: `failed to remove worktree directory: ${err instanceof Error ? err.message : String(err)}` };
      return; // don't prune if the removal failed
    }
    if (sourceRoot) await pruneWorktrees(sourceRoot);
  });

  return result;
}

/**
 * On-demand live git status for a single worktree — dirty / ahead / merged —
 * composing `hasUncommittedChanges`, `getAheadCount`, and
 * `isMergedIntoDefaultBranch`. Deliberately not part of `listWorktrees` (fs +
 * DB only, safe to poll): each of these spawns a git subprocess, so this is
 * fetched per row on demand instead. Backs `GET /worktrees/:id/git-status`.
 *
 * Shares `resolveWorktreeDir`'s confinement with `deleteOrphanWorktree`, but
 * — unlike delete — does not refuse task-owned ids: git status is useful for
 * both orphan and task-backed worktrees, so callers can check staleness
 * before deciding whether to archive.
 *
 * For a task-backed id, resolves the live worktree dir + pinned base ref
 * from the task row (`worktreePath ?? workdir`, `baseRef`). For an orphan id
 * (no task row), uses the `WORKTREES_DIR/id` path directly with no base ref
 * — `getAheadCount` degrades to its unknown-but-not-blocking `0` in that
 * case, same contract as everywhere else `baseRef` may be null.
 */
export async function worktreeGitStatus(id: string): Promise<WorktreeGitStatus | { error: string }> {
  const resolved = resolveWorktreeDir(id);
  if ("error" in resolved) return resolved;

  const task = tasks.get(id);
  const dir = task ? task.worktreePath ?? task.workdir : resolved.dir;
  const baseRef = task ? task.baseRef ?? null : null;

  const dirty0 = await hasUncommittedChanges(dir);
  if (dirty0 === null) {
    return { dirty: false, ahead: 0, merged: null, ignored: true };
  }

  const [aheadResult, merged] = await Promise.all([
    getAheadCount(dir, baseRef),
    isMergedIntoDefaultBranch(dir),
  ]);

  return { dirty: dirty0, ahead: aheadResult ?? 0, merged, ignored: false };
}
