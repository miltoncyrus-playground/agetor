import { useSyncExternalStore } from "react";

/**
 * One shared 30s ticker for every component that renders wall-clock-relative
 * text (age badges, the Done column's recency window). A single interval +
 * useSyncExternalStore keeps the memo graph intact: subscribing components
 * re-render themselves on tick, so no `now` prop has to be threaded through
 * (and invalidate) the memo'd Column/TaskCard layers. The interval only runs
 * while at least one subscriber is mounted.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (timer === null) {
    // 30s cadence against a minute-granular snapshot: at most 30s of lag on
    // a badge that only ever shows minutes/hours/days.
    timer = setInterval(() => { for (const l of listeners) l(); }, 30_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Minute-granular so the snapshot is stable between ticks (React compares
 *  snapshots on every render; a raw Date.now() would churn every render). */
function snapshot(): number {
  return Math.floor(Date.now() / 60_000);
}

/** Current time in epoch ms, minute granularity, auto-refreshing. */
export function useMinuteNow(): number {
  return useSyncExternalStore(subscribe, snapshot) * 60_000;
}
