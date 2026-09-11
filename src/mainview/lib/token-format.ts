import type { Run, RunUsage } from "../../shared/types.ts";

/**
 * Compact token count for the RunPanel's runs list: `0`, `950`, `43K`,
 * `1.2M`. One decimal only where it carries information (1.2M, 4.5K) and
 * dropped when it would be `.0` (43K, not 43.0K) and once the number has
 * three digits (123M, 456K — a decimal there is noise). The unit switches
 * at 999_500, the smallest value that would otherwise round up to `1000K`,
 * so the K column never shows four digits. Pure.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  const scaled = (value: number, unit: string): string => {
    // One rounding step per branch — rounding to a decimal and then again
    // to an integer would carry 999.499 up to 1000.
    if (value >= 100) return `${Math.round(value)}${unit}`;
    const oneDecimal = Math.round(value * 10) / 10;
    const text = Number.isInteger(oneDecimal) ? String(oneDecimal) : oneDecimal.toFixed(1);
    return `${text}${unit}`;
  };
  if (n < 999_500) return scaled(n / 1_000, "K");
  return scaled(n / 1_000_000, "M");
}

/**
 * Tooltip breakdown behind a compact label: every component of the total,
 * fully spelled out, so the short `1.2M ctx` is inspectable on hover.
 */
export function formatUsageTitle(usage: RunUsage): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return [
    `${n(usage.messages)} messages`,
    `input ${n(usage.input)}`,
    `cache write ${n(usage.cacheWrite)}`,
    `cache read ${n(usage.cacheRead)}`,
    `output ${n(usage.output)}`,
    `bootstrap ${n(usage.bootstrap)}`,
  ].join(" · ");
}

/**
 * The right-aligned label next to a run: `1.2M ctx · 43K out`. `ctx` is
 * `usage.context` (input + cache write + cache read — everything the model
 * read), `out` is generated tokens. Null when there is nothing to show so
 * the caller can omit the element entirely instead of rendering `0 ctx`.
 */
export function formatUsageLabel(usage: RunUsage | null | undefined): string | null {
  if (!usage || usage.messages === 0) return null;
  return `${formatTokens(usage.context)} ctx · ${formatTokens(usage.output)} out`;
}

/**
 * Sum the `usage` rows carried on a task's runs (what `GET /tasks/:id/runs`
 * returns). Computed client-side from the same list the panel already polls
 * every 2s, so the per-task total needs no extra request or interval.
 * Returns null when no run has usage yet.
 */
export function sumRunUsage(runs: ReadonlyArray<Pick<Run, "usage">>): RunUsage | null {
  let total: RunUsage | null = null;
  for (const r of runs) {
    const u = r.usage;
    if (!u) continue;
    total = total
      ? {
          runId: total.runId,
          messages: total.messages + u.messages,
          input: total.input + u.input,
          cacheWrite: total.cacheWrite + u.cacheWrite,
          cacheRead: total.cacheRead + u.cacheRead,
          output: total.output + u.output,
          context: total.context + u.context,
          bootstrap: total.bootstrap + u.bootstrap,
          updatedAt: Math.max(total.updatedAt, u.updatedAt),
        }
      : { ...u, runId: "" };
  }
  return total;
}
