import { memo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ListTodo, Paperclip, PauseCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { useCountdown, fxPausedBadgeText, fxPausedBadgeTitle } from "@/lib/fx-auto-resume";
import { PIPELINE_STAGE_COLUMNS, taskTypeMeta, type Task } from "../../../shared/types.ts";
import { sentFileBasename } from "../../../shared/sent-files.ts";
import { isTaskFxPaused } from "../../../shared/fx-recovery.ts";
import { cardStateLabel } from "@/lib/card-state";
import { displayColumnMeta, toDisplayColumn } from "@/lib/display-columns";
import { AGE_BADGE_MIN_MS, formatAge } from "@/lib/board-status";
import { useMinuteNow } from "@/lib/minute-tick";
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
  /** True when this task is the one currently open in the run panel.
   *  Suppresses the unread dot while the user is actively watching it. */
  isOpen?: boolean;
  /** Right-click (or keyboard menu-key) on the card. This is the card's
   *  ACTION SURFACE — see the doc comment below. */
  onContextMenu?: (t: Task, pos: { x: number; y: number }) => void;
}

/**
 * Compact by design: shows exactly subject (title), harness (agent), and
 * state (one badge), plus a small set of at-a-glance count signals.
 * Everything else that used to live on the card face — workdir,
 * branch/baseRef, model/mode, prompt preview, and every action button — is
 * reachable two other ways: the run panel (click the tile) and the task
 * context menu (right-click), which `buildTaskContextMenu` already builds
 * with Run / Stop / Mark done / Archive / View changes / Delete and more.
 * Dropping the buttons costs no reachability, which is what makes a card
 * this small viable across a swimlane board's six columns per project.
 */
function TaskCardImpl({ task, tasksById, childCountsByParent, onOpen, isOpen, onContextMenu }: Props) {
  const archived = task.archivedAt != null;
  const parentTask = task.parentTaskId ? tasksById.get(task.parentTaskId) : undefined;
  const childProgress = task.pipelineStage != null ? childCountsByParent.get(task.id) : undefined;
  // `fx-paused-badge`'s live countdown (see the badge below) — called
  // unconditionally, before any conditional return, so hook order stays
  // stable whether or not this task is actually paused right now; ticks
  // only while `task.fxRecovery.autoResume.at` is actually set (see
  // `useCountdown`'s own doc comment). `task.fxRecovery` is server-managed
  // — this card never inspects `task.agent` to decide whether to show it.
  const fxAutoResumeAt = task.fxRecovery?.autoResume?.at ?? null;
  const fxAutoResumeCountdown = useCountdown(fxAutoResumeAt);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    // Archived cards are immutable until unarchived — block drag-to-column so
    // the user has to take the explicit unarchive action first. A pipeline
    // task mid-flight (one of the stage columns) is also undraggable — a
    // human yanking it to another column mid-auto-advance would desync
    // pipelineStage from column. Once it reaches blocked/ready/review/done
    // it's a normal draggable card again.
    disabled: archived || PIPELINE_STAGE_COLUMNS.includes(task.column),
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const pendingCount = task.pendingInteractionCount;
  const blocked = task.column === "blocked";
  // awaitingHandBack joins the amber-ring club: a build child whose work is
  // done but not handed back is waiting on the human exactly like a pending
  // question is. gateParked (a parent pipeline task parked at its gate by a
  // conversation turn) and stalledSince (the turn-stall watchdog's "may be
  // stuck" mark) join for the same reason: in all three the human is the
  // only thing that moves the task forward, and all three previously hid
  // behind a healthy-looking card.
  const awaiting = pendingCount > 0 || blocked || task.awaitingHandBack === true
    || task.gateParked === true || task.stalledSince != null;
  const type = taskTypeMeta(task.taskType);
  const TypeIcon = taskTypeIcon(type.icon);

  // The single "state" string (priority + wording in lib/card-state.ts).
  // Collapses what used to be up to 4 separate badges (pipeline-stage,
  // revision suffix, terminal count, running-subagents) into one line —
  // those secondary counts are still visible in RunPanel (terminal count)
  // or have their own surface there (running subagents get tabs).
  const stageLabel = cardStateLabel(task);
  const stateSuffix = [
    task.pipelineStage && task.revisionCount > 0 ? `rev ${task.revisionCount}` : null,
    childProgress ? `${childProgress.merged}/${childProgress.total} sub-tasks` : null,
  ].filter(Boolean).join(" · ");
  // A gate-parked card sits on a stage column with nothing running — the
  // pulsing "actively mid-stage" dot would be a lie there.
  const isActivelyMidStage = task.pipelineStage != null && PIPELINE_STAGE_COLUMNS.includes(task.column)
    && !task.gateParked;
  // Time-in-column rot signal, only where dwell time means "a human hasn't
  // acted": review and blocked. Hidden for the first hour (sub-hour dwell is
  // normal flow) and on archived cards. `updatedAt` is bumped by the column
  // transition, so "since last update" is "since it landed here" unless the
  // user actively touched the task — in which case resetting is the point.
  const now = useMinuteNow();
  const ageMs = now - task.updatedAt;
  const showAge = !archived && (task.column === "review" || task.column === "blocked") && ageMs >= AGE_BADGE_MIN_MS;
  // Static state-color dot, shown for every card so a task's place in the
  // (now-merged) display-column taxonomy reads without opening it. Skipped
  // only when the pulsing dot below already covers the exact same signal
  // (an actively-mid-stage pipeline task) — showing both would be a
  // redundant double-dot for the same "in-progress" state.
  const stateDotClass = displayColumnMeta(toDisplayColumn(task.column)).dotClass;
  const sentCount = task.sentFiles?.length ?? 0;
  const todo = task.todoProgress;

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative flex cursor-grab select-none flex-col gap-0.5 border-border/60 border-l-4 px-2.5 py-1.5 hover:border-border transition-colors",
        // A pipeline sub-task gets a distinct border color instead of its
        // task-type color, so it reads as "part of a build" at a glance —
        // the "part of <parent>" text is folded into the title's tooltip
        // instead of its own line, to keep the tile compact.
        parentTask ? "border-l-primary" : type.borderClass,
        isDragging && "opacity-50",
        awaiting && "ring-2 ring-warning/60 ring-offset-2 ring-offset-background animate-awaiting-pulse motion-reduce:animate-none",
        archived && "cursor-default opacity-60",
      )}
      onClick={() => onOpen(task)}
      title={parentTask ? `${task.title} — part of "${parentTask.title}"` : task.title}
      // dnd-kit's `useDraggable` is unaffected by right-click: its
      // `PointerSensor` bails on `event.button !== 0`, so a right-click can
      // never arm a drag — `{...listeners}` and this handler don't fight.
      onContextMenu={(e) => {
        e.preventDefault();
        if (!onContextMenu) return;
        // Keyboard-invoked context menus (Shift+F10 / the menu key) report
        // clientX/Y = 0,0 — anchor those to the card instead of the
        // viewport corner.
        const fromKeyboard = e.clientX === 0 && e.clientY === 0;
        const r = e.currentTarget.getBoundingClientRect();
        onContextMenu(task, fromKeyboard ? { x: r.left, y: r.top } : { x: e.clientX, y: e.clientY });
      }}
      // The card is focusable (dnd-kit's `attributes` add `tabIndex=0`), so
      // a right-click would otherwise focus it and WebKit scrolls a
      // partially-visible card into view; the board would visibly jump under
      // the freshly-opened menu. Only suppress the default for the right
      // button — left-click focus/drag behavior is untouched, and
      // `contextmenu` still fires after a default-prevented `mousedown`.
      onMouseDown={(e) => {
        if (e.button === 2) e.preventDefault();
      }}
      {...listeners}
      {...attributes}
    >
      {task.unread && !isOpen && (
        // Static dot for "has assistant messages you haven't read yet" —
        // deliberately unanimated (the amber awaiting-pulse ring is the only
        // animated attention state). Pinned to the corner so it coexists
        // with that ring (an outline) without visual conflict.
        <span
          className="absolute -top-1.5 -right-1.5 size-2.5 rounded-full bg-info ring-2 ring-background"
          title="New messages"
          role="img"
          aria-label="New messages"
        />
      )}
      {/* `items-start`, not `items-center`: the title clamps to TWO lines, so
          centring would float the type icon and the count badges against the
          middle of a tall title instead of its first line. */}
      <div className="flex min-w-0 items-start gap-1.5">
        <TypeIcon className={cn("mt-px size-3 shrink-0", type.iconClass)} aria-label={type.label} />
        {/* Two lines, not one. Measured at a 1440px viewport the title box is
            163px — about 26 characters — and real task titles run 37-57, so a
            single truncated line hid roughly half of most titles and pushed
            the user to hover or open the panel just to read what a card IS.
            The clamp buys that back out of the one axis there is room in:
            lanes stack vertically and the page scrolls, while a lane with all
            six columns populated already overflows 1440px horizontally by
            ~336px, so widening the column instead would make the worse
            problem worse. Fixed at two lines (not free wrap) so every card
            stays the same height and the grid still scans. */}
        <span className="min-w-0 flex-1 line-clamp-2 text-xs font-medium leading-tight">{task.title}</span>
        {/* Two count signals kept on the face rather than folded into the
            state line: both answer "did something land here" for a card the
            user isn't watching, which the state label can't express. Icon +
            number only — no Badge chrome, which the compact tile has no
            room for. */}
        {todo && todo.total > 0 && (
          <span
            className={cn(
              "mt-px flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums",
              todo.completed === todo.total ? "text-success" : "text-muted-foreground",
            )}
            title={`${todo.completed} of ${todo.total} tasks done`}
          >
            <ListTodo className="size-2.5" aria-hidden />
            {todo.completed}/{todo.total}
          </span>
        )}
        {/* fx's response is paused on a resumable Gateway checkpoint
         *  (`Task.fxRecovery`, server-managed — see `TaskFxRecovery` in
         *  shared/types.ts). Gated on the shared `isTaskFxPaused` helper,
         *  never on `task.agent`, so it stays correct if fx is ever aliased
         *  under a different harness id. Text/title come from
         *  `fxPausedBadgeText`/`fxPausedBadgeTitle` (`@/lib/fx-auto-resume`)
         *  — "paused" or a live "auto-resume m:ss" countdown. Icon + text
         *  only, matching this card's no-Badge-chrome convention. */}
        {isTaskFxPaused(task) && task.fxRecovery && (
          <span
            className="mt-px flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-warning"
            data-testid="fx-paused-badge"
            title={fxPausedBadgeTitle(task.fxRecovery)}
          >
            <PauseCircle className="size-2.5" aria-hidden />
            {fxPausedBadgeText(task.fxRecovery, fxAutoResumeCountdown)}
          </span>
        )}
        {sentCount > 0 && (
          <span
            className="mt-px flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground"
            data-testid="sent-files-badge"
            title={`${sentCount} file${sentCount === 1 ? "" : "s"} sent · ${[...task.sentFiles!]
              .sort((a, b) => b.sentAt - a.sentAt)
              .slice(0, 5)
              .map((f) => sentFileBasename(f.path))
              .join(", ")}`}
          >
            <Paperclip className="size-2.5" aria-hidden />
            {sentCount}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
        {/* When the task was launched from a saved agent profile, show its
         *  name (with the harness id as the tooltip) instead of the raw
         *  harness id — the snapshot is server-managed and always present
         *  once `agentProfileId` is set (plan D1/D14), so no live profile
         *  lookup is needed here. */}
        {task.agentProfile ? (
          <span className="flex min-w-0 shrink-0 items-center gap-1" title={task.agent} data-testid="task-card-agent-profile">
            <AgentIcon kind={task.agentProfile.harnessKind} className="size-3 shrink-0" />
            <span className="shrink-0">{task.agentProfile.name}</span>
          </span>
        ) : (
          <>
            <AgentIcon kind={task.agent} className="size-3 shrink-0" />
            <span className="shrink-0">{task.agent}</span>
          </>
        )}
        <span className="opacity-40">·</span>
        {isActivelyMidStage ? (
          // The "agent actively working" pulse — deliberately NOT the amber
          // awaiting-pulse the card's outer ring uses, which means the
          // opposite state ("waiting on a human").
          <span className="relative inline-flex size-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-solid/60 opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-success-solid" />
          </span>
        ) : (
          <span className={cn("size-1.5 shrink-0 rounded-full", stateDotClass)} />
        )}
        <span className="truncate">
          {stageLabel}
          {stateSuffix && ` · ${stateSuffix}`}
        </span>
        {showAge && (
          <span
            className="ml-auto shrink-0 rounded bg-muted px-1 text-[9px] tabular-nums"
            title={`In ${stageLabel.toLowerCase()} for ${formatAge(ageMs)}`}
          >
            {formatAge(ageMs)}
          </span>
        )}
      </div>
    </Card>
  );
}

// Default shallow-props comparator is correct here (unlike Column, which
// needs a custom comparator for its array prop): `task` is a single object
// whose identity App.tsx's `reconcileById` preserves across polls when
// unchanged, `tasksById`/`childCountsByParent` are useMemo'd in App.tsx
// (reference-stable when unchanged), and `onOpen`/`onContextMenu` are
// `useCallback`-stabilized. dnd-kit's `useDraggable` lives inside the
// component body, so memoizing the outer function doesn't interfere with
// drag state — that's driven by dnd-kit's own context, not props.
export const TaskCard = memo(TaskCardImpl);
