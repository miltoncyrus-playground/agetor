import { memo, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { Task } from "../../../shared/types.ts";
import type { DisplayColumnId } from "@/lib/display-columns";
import { partitionRecentDone } from "@/lib/board-status";
import { useMinuteNow } from "@/lib/minute-tick";
import { TaskCard } from "./TaskCard";

interface Props {
  id: DisplayColumnId;
  /** The dnd-kit droppable id — namespaced per-lane by the caller
   *  (`` `${workdir}::${columnId}` ``) since a swimlane board has one
   *  `Column` per (project, stage) pair and every `id: DisplayColumnId`
   *  value repeats once per lane; the bare id would collide across
   *  lanes if used directly as the droppable id. `id` itself stays the
   *  plain display-column id for column-identity/label/comparator
   *  purposes. */
  droppableId: string;
  label: string;
  /** Whether this column accepts drops. Defaults to true; the caller
   *  (SwimLane.tsx) passes false for the merged "in-progress" bucket,
   *  which maps to 6 different real columns with no single unambiguous
   *  drop destination. */
  droppable?: boolean;
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

function ColumnImpl({ id, droppableId, label, droppable = true, tasks, tasksById, childCountsByParent, onOpen }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId, disabled: !droppable });
  const now = useMinuteNow();
  // Done is the one column that grows forever — show only recent finishes,
  // collapse the rest behind a "+N older" toggle. Other columns pass through.
  const { recent, olderCount } = id === "done"
    ? partitionRecentDone(tasks, now)
    : { recent: tasks, olderCount: 0 };
  const [showAllDone, setShowAllDone] = useState(false);
  const shown = showAllDone ? tasks : recent;

  // Empty column → slim stub. It keeps its droppable registration (drops
  // land normally; isOver highlights it) but shrinks to a vertical strip so
  // an idle lane doesn't spend 224px per empty column. Deliberately NOT
  // expanded on drag-hover: growing a column mid-drag shifts every sibling
  // droppable's cached rect and misaligns the rest of the drag. The stub
  // expands the natural way — by gaining a card.
  if (tasks.length === 0) {
    return (
      <div
        ref={setNodeRef}
        className={cn(
          "flex w-9 shrink-0 flex-col items-center gap-2 rounded-lg border border-border/40 bg-muted/20 px-1.5 py-2",
          isOver && "border-primary/60 bg-muted/60",
        )}
      >
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground [writing-mode:vertical-rl]">
          {label}
        </h2>
        <Badge variant="outline" className="h-4 px-1 text-[10px] opacity-60">0</Badge>
      </div>
    );
  }

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
        {/* Total count, not the windowed count — the badge answers "how many
            are done", the window only limits what's painted. */}
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{tasks.length}</Badge>
      </div>
      {/* min-h keeps a nearly-empty column a comfortable drop target. */}
      <div className="flex min-h-10 flex-col gap-1">
        {shown.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            tasksById={tasksById}
            childCountsByParent={childCountsByParent}
            onOpen={onOpen}
          />
        ))}
        {olderCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAllDone((v) => !v)}
            className="rounded-md px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            {showAllDone ? "Show recent only" : `+${olderCount} older`}
          </button>
        )}
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
  prev.droppable === next.droppable &&
  prev.onOpen === next.onOpen &&
  // Both are useMemo'd in App.tsx off `tasks` — reference-stable whenever
  // the underlying task list didn't actually change, same guarantee
  // `sameTasks` below relies on for the `tasks` prop itself.
  prev.tasksById === next.tasksById &&
  prev.childCountsByParent === next.childCountsByParent &&
  sameTasks(prev.tasks, next.tasks)
));
