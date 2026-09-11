import { usageFromParsedLine } from "./account-usage.ts";
import { runUsage, tasks } from "./db.ts";

/**
 * The one hook the claude-tmux tailer calls per dispatched JSONL line to feed
 * per-run token accounting (`run_usage`, O-10). Lives outside claude-tmux.ts
 * so the driver's line handler gains a single call and nothing else.
 *
 * Run attribution: a `TurnSlot` carries no run id (only the orchestrator's
 * chunk-handler closure knows it), so the active run is resolved from
 * `task.runId`. That is correct because assistant usage lines only ever
 * appear while a turn is in flight, and every run-creating path stamps
 * `task.runId` before claude can write a line for it: `startTask`, the
 * idle-turn branch of `sendTurnInExistingSession`, continuation adoption's
 * run factory, and boot reattach (the row still `running` IS `task.runId`).
 * A folded follow-up (`pasteFollowUp`) adds no run row on purpose, so its
 * tokens land on the run it folded into — the same row its `user` event was
 * recorded on.
 *
 * Idempotence lives in `runUsage.record` (`run_usage_seen`), so the call is
 * safe on every path that re-reads the JSONL. It is placed BELOW the
 * `seenLineUuids` replay guard in `dispatchLine`, not above: a session can
 * host several runs, and a reattach replay from offset 0 walks lines that
 * belong to EARLIER runs of the task while `task.runId` points at the
 * current one — recording those would credit run #1's messages to run #3
 * (a different `(run_id, message_id)` key, so the seen-table can't catch
 * it). Lines the dedup set holds were recorded under the right run by the
 * process that first dispatched them; lines it lacks (appended while agetor
 * was down) belong to the still-running row, which is `task.runId`.
 *
 * Fail-open by contract: no exception ever escapes to the tailer — a usage
 * write must never break streaming.
 */
export function recordRunUsageFromEvent(taskId: string, evt: unknown): boolean {
  try {
    const sample = usageFromParsedLine(evt);
    if (!sample) return false;
    const runId = tasks.get(taskId)?.runId;
    if (!runId) return false;
    return runUsage.record(runId, sample);
  } catch (err) {
    console.error(`[run-usage] record failed for task ${taskId}:`, err);
    return false;
  }
}
