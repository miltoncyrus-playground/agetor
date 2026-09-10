import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful clone so the parent refreshes its project list. */
  onCloned: () => void;
}

/** Client-side mirror of the server's repo-name extraction — used only to
 *  preview the default destination in the placeholder. The server re-parses
 *  and is the authority. */
const repoNameFrom = (url: string): string | null => {
  const m = url
    .trim()
    .match(/(?:github\.com[:/][^/\s]+\/|^[^/\s:@]+\/)([^/\s:@]+?)(?:\.git)?\/?$/i);
  return m ? (m[1] ?? null) : null;
};

/**
 * "Checkout from GitHub" flow for the Projects sidebar: paste a repo URL (or
 * owner/repo), optionally override the destination folder, and choose whether
 * agetor should auto-run an explainer task that writes ELI5.md at the clone's
 * root. The clone request stays in flight while the dialog shows a busy state —
 * big repos can take a while.
 */
export function CloneProjectDialog({ open, onClose, onCloned }: Props) {
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [eli5, setEli5] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);

  // Fresh form every open — a stale URL from the previous clone is never
  // what the user wants pre-filled.
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setDest("");
    setEli5(true);
    setError(null);
  }, [open]);

  const repo = repoNameFrom(url);

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.cloneProject(
        trimmed,
        dest.trim() || undefined,
        eli5,
      );
      onCloned();
      onClose();
      toast.success(`Checked out ${result.project.name}`, {
        description: result.eli5TaskId
          ? "ELI5 task started — watch it on the board; it writes ELI5.md at the repo root."
          : result.eli5Error
            ? `Clone succeeded, but the ELI5 task failed: ${result.eli5Error}`
            : result.project.path,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      // Don't let Escape/backdrop abandon a clone mid-flight with no feedback.
      onClose={busy ? () => {} : onClose}
      labelledBy="clone-project-title"
      initialFocusRef={urlRef}
      className="w-full max-w-md"
    >
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <h2 id="clone-project-title" className="text-sm font-semibold">
          Checkout from GitHub
        </h2>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="size-7"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="space-y-4 px-4 py-4 text-sm">
        <div className="space-y-1.5">
          <label htmlFor="clone-url" className="text-xs font-medium text-muted-foreground">
            Repository
          </label>
          <Input
            id="clone-url"
            ref={urlRef}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
            placeholder="https://github.com/owner/repo or owner/repo"
            spellCheck={false}
            disabled={busy}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="clone-dest" className="text-xs font-medium text-muted-foreground">
            Destination folder
          </label>
          <Input
            id="clone-dest"
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
            placeholder={repo ? `default: ~/${repo}` : "default: ~/<repo>"}
            spellCheck={false}
            disabled={busy}
          />
        </div>

        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-xs font-medium">Explain this repo</span>
            <span className="block text-[11px] text-muted-foreground">
              Runs a task that writes an ELI5.md guide at the repo root
            </span>
          </span>
          <Switch checked={eli5} onCheckedChange={setEli5} disabled={busy} />
        </label>

        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border/60 px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={busy || !url.trim()}>
          {busy ? "Cloning…" : "Checkout"}
        </Button>
      </div>
    </Dialog>
  );
}
