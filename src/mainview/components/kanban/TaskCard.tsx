import { memo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { COLUMNS, PIPELINE_STAGE_COLUMNS, taskTypeMeta, type Task } from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";

interface Props {
  task: Task;
  /** taskId -> Task over the full board — used to look up a child's parent
   *  title (folded into a tooltip, not shown as its own line — see the
   *  compact-card design note below). Stable reference across renders
   *  where the underlying task list didn't change (see Column.tsx). */
  tasksById: Map<string, Task>;
  /** parentTaskId -> sub-task progress, folded into the state badge for a
   *  parent card. */
  childCountsByParent: Map<string, { merged: number; total: number }>;
  onOpen: (t: Task) => void;
}

/**
 * Compact by design: shows exactly subject (title), harness (agent), and
 * state (one badge) — everything else that used to live on the card face
 * (workdir, branch/baseRef, model/mode, terminal/subagent counts, and
 * every action button) now lives ONLY in `RunPanel`, opened by clicking
 * the tile. `RunPanel` was extended (see its own file) with a real Run
 * button, Mark Done, Delete, and Retry-stage so nothing is actually lost —
 * see the swimlane-board plan for the full inventory of what moved where.
 */
function TaskCardImpl({ task, tasksById, childCountsByParent, onOpen }: Props) {
  const archived = task.archivedAt != null;
  const parentTask = task.parentTaskId ? tasksById.get(task.parentTaskId) : undefined;
  const childProgress = task.pipelineStage != null ? childCountsByParent.get(task.id) : undefined;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    // Archived cards are immutable until unarchived — block drag-to-column so
    // the user has to take the explicit unarchive action first. A pipeline
    // task mid-flight (one of the 6 stage columns) is also undraggable — a
    // human yanking it to another column mid-auto-advance would desync
    // pipelineStage from column. Once it reaches blocked/ready/done it's a
    // normal draggable card again.
    disabled: archived || PIPELINE_STAGE_COLUMNS.includes(task.column),
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const pendingCount = task.pendingInteractionCount;
  const blocked = task.column === "blocked";
  const awaiting = pendingCount > 0 || blocked;
  const type = taskTypeMeta(task.taskType);
  const TypeIcon = taskTypeIcon(type.icon);

  // The single "state" string: pipeline stage (+ pulsing dot while actively
  // mid-stage, + revision count, + sub-task progress) for a pipeline task,
  // else just the plain column label. Collapses what used to be up to 4
  // separate badges (pipeline-stage, revision suffix, terminal count,
  // running-subagents) into one line — those secondary counts are still
  // visible in RunPanel (terminal count) or were never load-bearing enough
  // to justify face space (running-subagents has its own tabs in RunPanel).
  const stageLabel = task.pipelineStage
    ? (COLUMNS.find((c) => c.id === task.pipelineStage)?.label ?? task.pipelineStage)
    : (COLUMNS.find((c) => c.id === task.column)?.label ?? task.column);
  const stateSuffix = [
    task.pipelineStage && task.revisionCount > 0 ? `rev ${task.revisionCount}` : null,
    childProgress ? `${childProgress.merged}/${childProgress.total} sub-tasks` : null,
  ].filter(Boolean).join(" · ");
  const isActivelyMidStage = task.pipelineStage != null && PIPELINE_STAGE_COLUMNS.includes(task.column);

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex cursor-grab select-none flex-col gap-0.5 border-border/60 border-l-4 px-2.5 py-1.5 hover:border-border transition-colors",
        // A pipeline sub-task gets a distinct border color instead of its
        // task-type color, so it reads as "part of a build" at a glance —
        // the "part of <parent>" text is folded into the title's tooltip
        // instead of its own line, to keep the tile compact.
        parentTask ? "border-l-violet-500" : type.borderClass,
        isDragging && "opacity-50",
        awaiting && "ring-2 ring-amber-500/60 ring-offset-2 ring-offset-background animate-awaiting-pulse motion-reduce:animate-none",
        archived && "cursor-default opacity-60",
      )}
      onClick={() => onOpen(task)}
      title={parentTask ? `${task.title} — part of "${parentTask.title}"` : task.title}
      {...listeners}
      {...attributes}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <TypeIcon className={cn("size-3 shrink-0", type.iconClass)} aria-label={type.label} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium leading-tight">{task.title}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
        <AgentIcon kind={task.agent} className="size-3 shrink-0" />
        <span className="shrink-0">{task.agent}</span>
        <span className="opacity-40">·</span>
        {isActivelyMidStage && (
          // Same green-pulsing-dot pattern used elsewhere for "agent
          // actively working" — deliberately NOT the amber awaiting-pulse
          // the card's outer ring already uses, which means the opposite
          // state ("waiting on a human").
          <span className="relative inline-flex size-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
        )}
        <span className="truncate">
          {stageLabel}
          {stateSuffix && ` · ${stateSuffix}`}
        </span>
      </div>
    </Card>
  );
}

// Default shallow-props comparator is correct here (unlike Column, which
// needs a custom comparator for its array prop): `task` is a single object
// whose identity App.tsx's `reconcileById` preserves across polls when
// unchanged, `tasksById`/`childCountsByParent` are useMemo'd in App.tsx
// (reference-stable when unchanged), and `onOpen` is `useCallback`-
// stabilized. dnd-kit's `useDraggable` lives inside the component body, so
// memoizing the outer function doesn't interfere with drag state — that's
// driven by dnd-kit's own context, not props.
export const TaskCard = memo(TaskCardImpl);
