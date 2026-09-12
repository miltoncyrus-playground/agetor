import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { homedir } from "node:os";
import path from "node:path";
import type { AgetorClient } from "../api-client.ts";
import type { TaskReference } from "../../shared/types.ts";
import { sanitizeDrop } from "./paste.ts";

const MANUAL_ROW = "› Enter a path manually…";

type Kind = "folder" | "files";
type Screen = "kind" | "loading" | "dirlist" | "manual" | "fileslist";

/** Expand a leading `~` to `homedir()`, then resolve anything relative
 *  against `process.cwd()` — the same convention `src/cli/refs.ts`'s
 *  `resolveRefs` uses for `--ref`. */
function resolveManualPath(raw: string): string {
  let p = raw.trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = path.join(homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * Headless folder/file picker — the interactive TUI equivalent of the
 * packaged app's native "pick a folder/files" dialog. Drives
 * `client.pickRefs`/`client.selectPickedRef` through a small screen state
 * machine (kind → loading → dirlist/manual/fileslist), same
 * component-owns-`useInput`-while-mounted pattern as `AnswerOverlay`.
 *
 * One callback (`onDone`), not an `onDone`/`onCancel` pair: every exit path
 * (top-level cancel, backing out of the directory list, a genuine empty
 * files listing) is "hand back a `TaskReference[]`, possibly empty" — there
 * is no server-side pending state to preserve the way there is for
 * `AnswerOverlay`'s interactions.
 */
export function DirPickerOverlay({
  client,
  onDone,
}: {
  client: AgetorClient;
  onDone: (refs: TaskReference[]) => void;
}) {
  const [screen, setScreen] = useState<Screen>("kind");
  const [kind, setKind] = useState<Kind>("folder");
  const [kindCursor, setKindCursor] = useState(0);

  const [candidates, setCandidates] = useState<string[]>([]);
  const [filterText, setFilterText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [manualText, setManualText] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const [fileRefs, setFileRefs] = useState<TaskReference[]>([]);

  const startPick = (k: Kind) => {
    setKind(k);
    setScreen("loading");
    setLoadError(null);
    void client
      .pickRefs(k)
      .then((res) => {
        if (res.refs) {
          onDone(res.refs);
          return;
        }
        setCandidates(res.candidates ?? []);
        setFilterText("");
        setCursor(0);
        setScreen("dirlist");
      })
      .catch((e) => {
        setCandidates([]);
        setFilterText("");
        setCursor(0);
        setLoadError((e as Error).message);
        setScreen("dirlist");
      });
  };

  const selectDir = (rawPath: string) => {
    setBusy(true);
    setDirError(null);
    void client
      .selectPickedRef(rawPath, kind)
      .then((res) => {
        setBusy(false);
        if (kind === "folder") {
          onDone(res.refs);
          return;
        }
        setFileRefs(res.refs);
        setScreen("fileslist");
      })
      .catch((e) => {
        setBusy(false);
        setDirError((e as Error).message);
      });
  };

  const submitManual = (raw: string) => {
    const resolved = resolveManualPath(raw);
    setBusy(true);
    setManualError(null);
    void client
      .selectPickedRef(resolved, kind)
      .then((res) => {
        setBusy(false);
        if (kind === "folder") {
          onDone(res.refs);
          return;
        }
        setFileRefs(res.refs);
        setScreen("fileslist");
      })
      .catch((e) => {
        setBusy(false);
        setManualError((e as Error).message);
      });
  };

  const rows = candidates.filter((c) => c.toLowerCase().includes(filterText.toLowerCase()));
  const rowCount = rows.length + 1; // + manual row

  useInput(
    (input, key) => {
      if (busy) return;

      if (screen === "kind") {
        if (key.escape) return onDone([]);
        if (key.upArrow) return setKindCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) return setKindCursor((c) => Math.min(1, c + 1));
        if (key.return) return startPick(kindCursor === 0 ? "folder" : "files");
        return;
      }

      if (screen === "loading") return;

      if (screen === "dirlist") {
        if (key.escape) return onDone([]);
        if (key.upArrow) {
          setDirError(null);
          return setCursor((c) => Math.max(0, c - 1));
        }
        if (key.downArrow) {
          setDirError(null);
          return setCursor((c) => Math.min(rowCount - 1, c + 1));
        }
        if (key.return) {
          const idx = Math.min(cursor, rowCount - 1);
          if (idx === rows.length) {
            setManualText("");
            setManualError(null);
            setScreen("manual");
            return;
          }
          const chosen = rows[idx];
          if (chosen) selectDir(chosen);
          return;
        }
        if (key.backspace || key.delete) {
          setDirError(null);
          setCursor(0);
          return setFilterText((s) => s.slice(0, -1));
        }
        if (input && !key.ctrl && !key.meta) {
          setDirError(null);
          setCursor(0);
          const chunk = input.length > 1 ? sanitizeDrop(input) : input;
          return setFilterText((s) => s + chunk);
        }
        return;
      }

      if (screen === "manual") {
        if (key.escape) return setScreen("dirlist");
        if (key.return) {
          const text = manualText.trim();
          if (!text) return;
          submitManual(text);
          return;
        }
        if (key.backspace || key.delete) {
          setManualError(null);
          return setManualText((s) => s.slice(0, -1));
        }
        if (input && !key.ctrl && !key.meta) {
          setManualError(null);
          const chunk = input.length > 1 ? sanitizeDrop(input) : input;
          return setManualText((s) => s + chunk);
        }
        return;
      }

      if (screen === "fileslist") {
        if (key.escape) return setScreen("dirlist");
        if (key.return) return onDone(fileRefs);
        return;
      }
    },
    { isActive: true },
  );

  if (screen === "kind") {
    const labels: Kind[] = ["folder", "files"];
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          Attach a reference
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {["Folder", "Files"].map((label, i) => (
            <Text key={label} color={i === kindCursor ? "cyan" : undefined}>
              {i === kindCursor ? "▸ " : "  "}
              {label}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  if (screen === "loading") {
    return <Text dimColor>loading directories…</Text>;
  }

  if (screen === "dirlist") {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          {kind === "folder" ? "Pick a folder" : "Pick a directory to list files from"}
        </Text>
        {loadError ? <Text color="red">! {loadError} — enter a path manually</Text> : null}
        <Box marginTop={1}>
          <Text>
            <Text color="cyan">filter: </Text>
            {filterText || <Text dimColor>(type to filter)</Text>}
            <Text color="cyan">▏</Text>
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {rows.map((r, i) => (
            <Text key={r} wrap="truncate-end" color={i === cursor ? "cyan" : undefined}>
              {i === cursor ? "▸ " : "  "}
              {r}
            </Text>
          ))}
          <Text color={rows.length === cursor ? "cyan" : undefined}>
            {rows.length === cursor ? "▸ " : "  "}
            {MANUAL_ROW}
          </Text>
        </Box>
        {dirError ? <Text color="red">! {dirError}</Text> : null}
      </Box>
    );
  }

  if (screen === "manual") {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          Enter a path
        </Text>
        <Box marginTop={1}>
          <Text wrap="truncate-start">
            <Text color="cyan">✎ </Text>
            {manualText}
            <Text color="cyan">▏</Text>
          </Text>
        </Box>
        {manualError ? <Text color="red">! {manualError}</Text> : null}
      </Box>
    );
  }

  // "fileslist"
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        Files
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {fileRefs.length === 0 ? (
          <Text dimColor>no files here</Text>
        ) : (
          fileRefs.map((r) => (
            <Text key={r.path} wrap="truncate-end">
              {r.path}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
