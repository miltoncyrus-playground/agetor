import { cn } from "@/lib/utils";
import type { Task } from "../../../shared/types.ts";
import { attentionSummary } from "@/lib/board-status";
import { displayColumnMeta, type DisplayColumnId } from "@/lib/display-columns";

interface Props {
  /** The filter-respecting task list (App's `visibleTasks`) — the strip
   *  summarizes what the board below it actually shows, minus the status
   *  filter (which the strip itself drives). */
  tasks: Task[];
  statusFilter: DisplayColumnId[];
  /** Toggle-filter: focus the board on one status, click again to clear. */
  onToggleStatus: (id: DisplayColumnId) => void;
}

/**
 * Board-level triage line above the lanes: "3 running · 2 blocked · 4 in
 * review · 1 waiting on you", summed across every visible project. The
 * three status chips click through to the existing status filter; the
 * waiting chip is informational (pending interactions are orthogonal to
 * columns, so there's no column filter to jump to — the amber card rings
 * mark the individual tasks).
 */
export function AttentionStrip({ tasks, statusFilter, onToggleStatus }: Props) {
  const s = attentionSummary(tasks);
  const chips: { id: DisplayColumnId; count: number; label: string }[] = [
    { id: "in-progress", count: s.running, label: "running" },
    { id: "blocked", count: s.blocked, label: "blocked" },
    { id: "review", count: s.review, label: "in review" },
  ];
  return (
    <div className="flex items-center gap-2 border-b border-border/40 px-4 py-1.5 text-[11px]">
      {chips.map((c) => {
        const active = statusFilter.length === 1 && statusFilter[0] === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onToggleStatus(c.id)}
            title={active ? "Clear status filter" : `Show only ${c.label} tasks`}
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-transparent px-2 py-0.5",
              c.count > 0 ? "text-foreground" : "text-muted-foreground/60",
              "hover:border-border hover:bg-accent/50",
              active && "border-primary/60 bg-accent/60",
            )}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", displayColumnMeta(c.id).dotClass)} />
            {c.count} {c.label}
          </button>
        );
      })}
      <span
        className={cn(
          "flex items-center gap-1.5 rounded-full px-2 py-0.5",
          s.waiting > 0 ? "font-medium text-amber-500" : "text-muted-foreground/60",
        )}
        title="Tasks with a question waiting on you (amber-ringed cards)"
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", s.waiting > 0 ? "bg-amber-500" : "bg-muted-foreground/40")} />
        {s.waiting} waiting on you
      </span>
    </div>
  );
}
