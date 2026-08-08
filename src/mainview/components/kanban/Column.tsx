import { memo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { ColumnId, Task } from "../../../shared/types.ts";
import { TaskCard } from "./TaskCard";

interface Props {
  id: ColumnId;
  /** The dnd-kit droppable id — namespaced per-lane by the caller
   *  (`` `${workdir}::${columnId}` ``) since a swimlane board has one
   *  `Column` per (project, stage) pair and every `id: ColumnId` value
   *  repeats once per lane; the bare `ColumnId` would collide across
   *  lanes if used directly as the droppable id. `id` itself stays the
   *  plain `ColumnId` for column-identity/label/comparator purposes. */
  droppableId: string;
  label: string;
  tasks: Task[];
  /** taskId -> Task, over the FULL task list (not just this column) — lets
   *  a child card look up its parent's title regardless of which column
   *  the parent is currently in. Stable reference across renders where the
   *  underlying task list didn't change (see App.tsx). */
  tasksById: Map<string, Task>;
  /** parentTaskId -> { merged, total } sub-task counts, for the parent
   *  card's progress badge. Same stability guarantee as `tasksById`. */
  childCountsByParent: Map<string, { merged: number; total: number }>;
  /** The only interaction a compact TaskCard offers directly — everything
   *  else (Run/Stop/Archive/Diff/Delete/Mark-Done/Retry) lives in RunPanel,
   *  reached by clicking the tile. See TaskCard.tsx's doc comment. */
  onOpen: (t: Task) => void;
}

/** Array is considered unchanged when same length and every element is the
 *  same object reference at the same index. Relies on the caller (App.tsx's
 *  `reconcileById`) preserving task identity across polls for tasks that
 *  didn't actually change — that's what lets an unaffected column bail out
 *  below even though `visibleTasks.filter(...)` in App.tsx produces a new
 *  array reference on every render. */
function sameTasks(a: Task[], b: Task[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

function ColumnImpl({ id, droppableId, label, tasks, tasksById, childCountsByParent, onOpen }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-56 shrink-0 flex-col gap-2 rounded-lg border border-border/40 bg-muted/30 p-2",
        isOver && "border-primary/60 bg-muted/60",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </h2>
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{tasks.length}</Badge>
      </div>
      <div className="flex flex-col gap-1">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            tasksById={tasksById}
            childCountsByParent={childCountsByParent}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

/** Custom comparator instead of the default shallow-props compare: `tasks`
 *  is an array, so the default `Object.is` per-prop check would see a new
 *  reference on every render (App.tsx's `visibleTasks.filter(...)` always
 *  allocates a fresh array) and re-render every column on every tick. With
 *  `sameTasks` doing an element-wise identity check instead, a column whose
 *  member tasks are all reference-unchanged bails out — so a single task
 *  update (which only changes that one task's object identity, per
 *  App.tsx's `reconcileById`) only re-renders the column(s) that actually
 *  contain the changed task. */
export const Column = memo(ColumnImpl, (prev, next) => (
  prev.id === next.id &&
  prev.droppableId === next.droppableId &&
  prev.label === next.label &&
  prev.onOpen === next.onOpen &&
  // Both are useMemo'd in App.tsx off `tasks` — reference-stable whenever
  // the underlying task list didn't actually change, same guarantee
  // `sameTasks` below relies on for the `tasks` prop itself.
  prev.tasksById === next.tasksById &&
  prev.childCountsByParent === next.childCountsByParent &&
  sameTasks(prev.tasks, next.tasks)
));
