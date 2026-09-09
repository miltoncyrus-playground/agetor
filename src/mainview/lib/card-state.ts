import { COLUMNS, PIPELINE_STAGE_COLUMNS, type Task } from "../../shared/types.ts";

/** The Task fields the card's single state string is computed from. */
export type CardStateInput = Pick<
  Task,
  "column" | "pipelineStage" | "awaitingHandBack" | "gateParked" | "stalledSince"
>;

/**
 * The card face's single "state" string (extracted from TaskCard so it's
 * gate-testable). Priority order:
 *
 *   1. Attention overrides — states where the human is the only thing that
 *      moves the task forward, each of which would otherwise hide behind a
 *      healthy-looking label: `awaiting hand-back` (build child finished
 *      outside the pipeline), `may be stuck` (turn-stall watchdog), `gate
 *      parked` (parent pipeline task parked at its gate by a conversation
 *      turn). Stalled wins over gate-parked in the chain but they're
 *      mutually exclusive in practice (stalled implies a run in flight,
 *      gate-parked implies none).
 *   2. The pipeline stage label — but ONLY while the task is actually
 *      mid-pipeline (sitting in a stage column, or blocked mid-pipeline
 *      where "which stage blocked" is the useful fact). `pipelineStage` is
 *      never cleared when a pipeline completes, so preferring it
 *      unconditionally made a finished pipeline card sit in Ready wearing a
 *      "Testing" badge forever (2dot2dot, 2026-08-15) — reading as "hasn't
 *      moved" when the pipeline had in fact passed testing and landed on
 *      its terminal column.
 *   3. The plain column label.
 */
export function cardStateLabel(t: CardStateInput): string {
  if (t.awaitingHandBack) return "awaiting hand-back";
  if (t.stalledSince != null) return "may be stuck";
  if (t.gateParked) return "gate parked";
  const midPipeline =
    t.pipelineStage != null
    && (PIPELINE_STAGE_COLUMNS.includes(t.column) || t.column === "blocked");
  if (midPipeline) {
    return COLUMNS.find((c) => c.id === t.pipelineStage)?.label ?? t.pipelineStage!;
  }
  return COLUMNS.find((c) => c.id === t.column)?.label ?? t.column;
}
