import { useMemo, useRef, useState } from "react";
import { Folder, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { iconForRef, refBasename } from "@/lib/file-icons";
import type { TaskReference } from "../../../shared/types.ts";

interface Props {
  open: boolean;
  mode: "files" | "folder";
  candidates: string[];
  onDone: (refs: TaskReference[]) => void;
}

/** Resolve anything relative against `.` (there is no reliable client-side
 *  home directory to expand `~` against without a server round trip, unlike
 *  the CLI's `DirPickerOverlay.resolveManualPath` which can call `node:os`'s
 *  `homedir()` — so `~` is left as a literal leading character here and the
 *  server's own path validation surfaces the resulting "not found" error). */
function resolveManualPath(raw: string): string {
  const p = raw.trim();
  if (p.startsWith("/")) return p;
  // Best-effort normalize of a relative path without a real cwd to resolve
  // against; strip a leading "./" and leave the rest for the server to stat.
  return p.startsWith("./") ? p.slice(2) : p;
}

/**
 * Headless folder/file picker — the webview equivalent of the CLI's
 * `DirPickerOverlay`. Rendered by `ReferencesPicker` only when the initial
 * `/refs/pick` call comes back with a flat `candidates` list instead of
 * resolved `refs` (i.e. no native bridge and no `AGETOR_FAKE_PICK_REFS_DIR`
 * fixture). See `PLAN.md` §2 for the full behavior spec.
 */
export function FolderPickerDialog({ open, mode, candidates, onDone }: Props) {
  const [screen, setScreen] = useState<"list" | "fileslist">("list");
  const [filterText, setFilterText] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [fileRefs, setFileRefs] = useState<TaskReference[]>([]);
  const [fileDir, setFileDir] = useState("");
  const [busy, setBusy] = useState(false);
  const manualInputRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => {
    const needle = filterText.toLowerCase();
    return needle ? candidates.filter((c) => c.toLowerCase().includes(needle)) : candidates;
  }, [candidates, filterText]);

  const selectPath = (rawPath: string, onError: (msg: string) => void) => {
    if (busy) return;
    setBusy(true);
    setRowError(null);
    setManualError(null);
    void api
      .selectPickedRef(rawPath, mode)
      .then((res) => {
        setBusy(false);
        if (mode === "folder") {
          onDone(res.refs);
          return;
        }
        setFileRefs(res.refs);
        setFileDir(rawPath);
        setScreen("fileslist");
      })
      .catch((e) => {
        setBusy(false);
        onError(e instanceof Error ? e.message : String(e));
      });
  };

  const submitManual = () => {
    const text = manualPath.trim();
    if (!text) return;
    selectPath(resolveManualPath(text), setManualError);
  };

  return (
    <Dialog
      open={open}
      onClose={() => onDone([])}
      labelledBy="folder-picker-dialog-title"
      initialFocusRef={manualInputRef}
      className="flex max-h-[80vh] w-full max-w-lg flex-col p-0"
    >
      <div data-testid="folder-picker-dialog" className="contents">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <div id="folder-picker-dialog-title" className="text-sm font-semibold">
              {screen === "fileslist"
                ? `Files in ${fileDir}`
                : mode === "folder" ? "Pick a folder" : "Pick a directory to list files from"}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            title="Cancel"
            aria-label="Cancel"
            data-testid="folder-picker-cancel"
            onClick={() => onDone([])}
          >
            <X className="size-4" />
          </Button>
        </header>

        {screen === "list" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            <Input
              ref={manualInputRef}
              data-testid="folder-picker-filter"
              placeholder="Filter…"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
            <div role="listbox" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {rows.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">
                  No matches — try a different filter or type a path above.
                </p>
              ) : (
                rows.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="option"
                    aria-selected={false}
                    data-testid="folder-picker-candidate"
                    data-path={c}
                    disabled={busy}
                    title={c}
                    className="flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent/40 disabled:opacity-50"
                    onClick={() => selectPath(c, setRowError)}
                  >
                    <Folder className="size-3.5 shrink-0 opacity-70" />
                    <span className="truncate font-mono">{c}</span>
                  </button>
                ))
              )}
            </div>
            {rowError && (
              <p data-testid="folder-picker-row-error" className="text-xs text-destructive">
                {rowError}
              </p>
            )}
            <div className="flex items-center gap-1.5 border-t border-border/60 pt-2">
              <Input
                data-testid="folder-picker-manual-input"
                placeholder="Or type an absolute path…"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                value={manualPath}
                disabled={busy}
                onChange={(e) => setManualPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitManual();
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || !manualPath.trim()}
                data-testid="folder-picker-manual-submit"
                onClick={submitManual}
              >
                Use path
              </Button>
            </div>
            {manualError && (
              <p data-testid="folder-picker-manual-error" className="text-xs text-destructive">
                {manualError}
              </p>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="w-fit"
              data-testid="folder-picker-back"
              onClick={() => setScreen("list")}
            >
              ← Back
            </Button>
            <div role="listbox" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {fileRefs.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">No files in this directory.</p>
              ) : (
                fileRefs.map((r) => {
                  const Icon = iconForRef(r);
                  return (
                    <button
                      key={r.path}
                      type="button"
                      role="option"
                      aria-selected={false}
                      data-testid="folder-picker-file"
                      data-path={r.path}
                      title={r.path}
                      className="flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent/40"
                      onClick={() => onDone([r])}
                    >
                      <Icon className="size-3.5 shrink-0 opacity-70" />
                      <span className="truncate font-mono">{refBasename(r.path)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
