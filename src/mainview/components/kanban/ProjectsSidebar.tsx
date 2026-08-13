import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, DownloadCloud, GitBranch, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import { BranchNamingDialog } from "@/components/settings/BranchNamingDialog";
import { CloneProjectDialog } from "@/components/kanban/CloneProjectDialog";
import {
  PROJECTS_PANEL_COLLAPSED_KEY,
  readCollapsed,
  writeCollapsed,
} from "@/lib/panel-collapse";
import type { Project } from "../../../shared/types.ts";

/** Last path segment, used as the fallback display label. Copied from
 *  ProjectPicker so the two pickers agree on what a project is "called". */
const basename = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

interface Props {
  /** Source of truth for the list — owned by App, kept fresh via onChanged. */
  projects: Project[];
  /** App re-fetches its projects state after any mutation here. */
  onChanged: () => void;
}

/**
 * Left-side Projects sidebar: add (native folder dialog), inline-rename, edit
 * branch naming, and delete registered projects. Mirrors the New Task
 * sidebar's collapse-to-rail chrome, but with the border on the RIGHT edge and
 * the straddle toggle overhanging into the gutter between it and the New Task
 * sidebar.
 */
export function ProjectsSidebar({ projects, onChanged }: Props) {
  const confirm = useConfirm();
  // Seeded synchronously from localStorage (lazy initial state) so a restart
  // repaints in the state the user left it in — same pattern as NewTaskForm.
  const [collapsed, setCollapsed] = useState(() =>
    readCollapsed(PROJECTS_PANEL_COLLAPSED_KEY),
  );
  useEffect(() => {
    writeCollapsed(PROJECTS_PANEL_COLLAPSED_KEY, collapsed);
  }, [collapsed]);

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [branchProjectPath, setBranchProjectPath] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const onAdd = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { project } = await api.pickProject();
      if (project) onChanged();
    } catch { /* no-op on failure, matches ProjectPicker */ }
    finally { setBusy(false); }
  };

  const startRename = (p: Project) => {
    setRenamingPath(p.path);
    setRenameText(p.name || basename(p.path));
  };
  const cancelRename = () => {
    setRenamingPath(null);
    setRenameText("");
  };
  const commitRename = async (p: Project) => {
    const name = renameText.trim();
    // Empty/whitespace name → cancel (no call). Also skip the call when the
    // name is unchanged.
    if (!name || name === p.name) { cancelRename(); return; }
    try {
      await api.renameProject(p.path, name);
      onChanged();
    } catch { /* leave the list as-is on failure */ }
    finally { cancelRename(); }
  };

  const onDelete = async (p: Project) => {
    const ok = await confirm({
      title: "Remove project?",
      description:
        "Removes it from the project list. Tasks and worktrees are not affected.",
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteProject(p.path);
      onChanged();
    } catch { /* leave the list as-is on failure */ }
  };

  return (
    <aside
      className={cn(
        // Width is the only animated property — <main> next door is flex-1,
        // so the board reclaims the space in the same frame with no resize
        // logic on that side.
        "relative flex h-full shrink-0 flex-col border-r border-border/60 bg-card text-card-foreground",
        "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-11" : "w-72",
      )}
    >
      {/* Collapse control straddling the RIGHT border (overhangs into the
          gutter between it and the New Task sidebar). Collapsed → ChevronRight
          to expand rightward; expanded → ChevronLeft to collapse leftward. */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand projects panel" : "Collapse projects panel"}
        title={collapsed ? "Expand projects panel" : "Collapse projects panel"}
        className="absolute -right-2.5 top-1/2 z-20 flex size-5 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
      >
        {collapsed
          ? <ChevronRight className="size-3.5" />
          : <ChevronLeft className="size-3.5" />}
      </button>

      {/* Clip layer: contents keep their natural width and get cut off while
          the aside's width animates, instead of reflowing through 200ms of
          intermediate widths. Can't live on the <aside> — that would clip the
          toggle button's overhang. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {collapsed ? (
          <div className="flex h-full w-11 flex-col items-center gap-2 py-3">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              title="Expand projects panel"
              className="rounded-md px-1 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground transition-colors [writing-mode:vertical-rl] hover:text-foreground"
            >
              Projects
            </button>
          </div>
        ) : (
          <div className="flex h-full w-72 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
              <span className="text-sm font-semibold">Projects</span>
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setCloneOpen(true)}
                  disabled={busy}
                  title="Checkout an existing GitHub repo"
                  aria-label="Checkout from GitHub"
                  className="size-7"
                >
                  <DownloadCloud className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void onAdd()}
                  disabled={busy}
                  title="Add a local folder (opens the folder picker)"
                  aria-label="Add project"
                  className="size-7"
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            </div>

            <div className="flex-1 space-y-1 overflow-y-auto px-2 py-2 text-xs">
              {projects.length === 0 ? (
                <div className="space-y-2 px-2 py-3 text-muted-foreground">
                  <p>No projects yet.</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void onAdd()}
                    disabled={busy}
                    className="w-full justify-start"
                  >
                    <Plus className="mr-1 size-3.5" />
                    Add project
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCloneOpen(true)}
                    disabled={busy}
                    className="w-full justify-start"
                  >
                    <DownloadCloud className="mr-1 size-3.5" />
                    Checkout from GitHub
                  </Button>
                </div>
              ) : (
                projects.map((p) => (
                  <div
                    key={p.path}
                    className="group rounded-md px-2 py-1.5 hover:bg-accent/40"
                  >
                    {renamingPath === p.path ? (
                      <Input
                        autoFocus
                        value={renameText}
                        onChange={(e) => setRenameText(e.target.value)}
                        onBlur={() => void commitRename(p)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitRename(p); }
                          else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                        }}
                        spellCheck={false}
                        className="h-7 text-xs"
                      />
                    ) : (
                      <>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => startRename(p)}
                            title="Rename"
                            className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                          >
                            {p.name || basename(p.path) || p.path}
                          </button>
                          <button
                            type="button"
                            onClick={() => startRename(p)}
                            title="Rename"
                            aria-label="Rename project"
                            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setBranchProjectPath(p.path)}
                            title="Branch naming"
                            aria-label="Branch naming"
                            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                          >
                            <GitBranch className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDelete(p)}
                            title="Remove project"
                            aria-label="Remove project"
                            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <p
                          className="truncate text-[10px] text-muted-foreground"
                          title={p.path}
                        >
                          {p.path}
                        </p>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <CloneProjectDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        onCloned={onChanged}
      />

      <BranchNamingDialog
        open={branchProjectPath !== null}
        projectPath={branchProjectPath ?? ""}
        projectName={projects.find((p) => p.path === branchProjectPath)?.name}
        onClose={() => setBranchProjectPath(null)}
        onSaved={() => { setBranchProjectPath(null); onChanged(); }}
      />
    </aside>
  );
}
