import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FolderGit2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { readCollapsed, writeCollapsed } from "@/lib/panel-collapse";
import type { ColumnId, Task } from "../../../shared/types.ts";
import { Column } from "./Column";

interface Props {
  workdir: string;
  label: string;
  /** The columns to render, in board order — already filtered to the
   *  board's `statusFilter` selection by the caller, same list every lane
   *  gets (the "which columns are visible" control governs every
   *  swimlane uniformly, not per-lane). */
  visibleColumns: { id: ColumnId; label: string }[];
  tasksByColumn: Map<ColumnId, Task[]>;
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
