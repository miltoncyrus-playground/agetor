import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FolderGit2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { readCollapsed, writeCollapsed } from "@/lib/panel-collapse";
import { stageBreakdown } from "@/lib/board-status";
import { displayColumnMeta, type DisplayColumnId } from "@/lib/display-columns";
import type { Task } from "../../../shared/types.ts";
import { Column } from "./Column";

interface Props {
  workdir: string;
  label: string;
  /** The columns to render, in board order — filtered by the caller
   *  (App.tsx's `lanes` useMemo via `filterLaneColumns`): the four working
   *  columns (backlog/ready/in-progress/blocked) always appear, while
   *  review/done auto-hide when THIS lane has zero tasks in them (per-lane,
   *  not board-wide). */
  visibleColumns: { id: DisplayColumnId; label: string }[];
  tasksByColumn: Map<DisplayColumnId, Task[]>;
  taskCount: number;
  tasksById: Map<string, Task>;
  childCountsByParent: Map<string, { merged: number; total: number }>;
  onOpen: (t: Task) => void;
}

const EMPTY_TASKS: Task[] = [];

/**
 * One project's row of columns. Owns its own collapsed/expanded state
 * (persisted to localStorage, keyed by workdir) — same lazy-`useState`-
 * initializer pattern `NewTaskForm.tsx`'s sidebar collapse uses, so a
 * reload doesn't flash expanded before snapping shut. Collapsed state has
 * to live HERE (not hoisted to App.tsx as a single `Record<workdir,
 * boolean>`) because the set of lanes is dynamic — a fixed number of
 * `useState` calls in the parent can't cover an unknown, growing list of
 * projects; each lane owning its own hook call is the correct shape for
 * React's rules of hooks here.
 */
export function SwimLane({
  workdir, label, visibleColumns, tasksByColumn, taskCount,
  tasksById, childCountsByParent, onOpen,
}: Props) {
  const collapseKey = `agetor:swimlaneCollapsed:${workdir}`;
  const [collapsed, setCollapsed] = useState(() => readCollapsed(collapseKey));
  useEffect(() => { writeCollapsed(collapseKey, collapsed); }, [collapseKey, collapsed]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1.5 text-left"
        title={collapsed ? "Expand" : "Collapse"}
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        )}
        <FolderGit2 className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </h2>
        <Badge variant="outline">{taskCount}</Badge>
        {/* Per-state breakdown, one chip per non-empty display column in
            THIS lane — replaces what used to be just the flat total above,
            so "where are we in the process" reads without expanding the
            lane. Same dot-color language as TaskCard's state dot. */}
        <div className="flex items-center gap-1.5">
          {visibleColumns.map((c) => {
            const count = tasksByColumn.get(c.id)?.length ?? 0;
            if (count === 0) return null;
            return (
              <span
                key={c.id}
                className="flex items-center gap-1 text-[10px] text-muted-foreground"
                title={`${count} ${c.label}`}
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", displayColumnMeta(c.id).dotClass)} />
                {count}
              </span>
            );
          })}
          {/* The In Progress chip above merges 6 pipeline stages + plain
              running into one number — spell out which stages it's hiding
              ("2 building · 1 testing") so pipeline position reads from the
              lane header without expanding the lane. */}
          {(() => {
            const stages = stageBreakdown(tasksByColumn.get("in-progress") ?? []);
            if (stages.length === 0) return null;
            return (
              <span className="truncate text-[10px] text-muted-foreground/70">
                ({stages.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(" · ")})
              </span>
            );
          })()}
        </div>
      </button>
      {!collapsed && (
        <div className={cn("kanban-scroll overflow-x-auto")}>
          <div className="flex gap-3 pb-2 pl-5">
            {visibleColumns.map((c) => (
              <Column
                key={c.id}
                id={c.id}
                droppableId={`${workdir}::${c.id}`}
                label={c.label}
                droppable={c.id !== "in-progress"}
                tasks={tasksByColumn.get(c.id) ?? EMPTY_TASKS}
                tasksById={tasksById}
                childCountsByParent={childCountsByParent}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
