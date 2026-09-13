import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { DirPickerOverlay } from "./DirPickerOverlay.tsx";
import type { AgetorClient } from "../api-client.ts";
import type { TaskReference } from "../../shared/types.ts";

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const ESC = String.fromCharCode(27);
const DOWN = String.fromCharCode(27) + "[B"; // ESC [ B
const UP = String.fromCharCode(27) + "[A"; // ESC [ A

class FakeApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function fakeClient(opts: {
  pickRefs?: (mode: "files" | "folder") => Promise<{ candidates?: string[]; refs?: TaskReference[] }>;
  selectPickedRef?: (path: string, mode: "files" | "folder") => Promise<{ refs: TaskReference[] }>;
}): AgetorClient {
  return {
    pickRefs: opts.pickRefs ?? (async () => ({ candidates: [] })),
    selectPickedRef: opts.selectPickedRef ?? (async () => ({ refs: [] })),
  } as unknown as AgetorClient;
}

test("candidates path, folder mode: navigate and select a candidate", async () => {
  let captured: unknown = null;
  const client = fakeClient({
    pickRefs: async () => ({ candidates: ["/a", "/b"] }),
    selectPickedRef: async (path, mode) => {
      captured = [path, mode];
      return { refs: [{ path: "/b", isDirectory: true }] };
    },
  });
  let result: unknown = null;
  const { stdin } = render(<DirPickerOverlay client={client} onDone={(r) => { result = r; }} />);
  await wait();
  stdin.write(ENTER); // kind=Folder (default cursor 0)
  await wait();
  stdin.write(DOWN); // cursor -> "/b"
  await wait();
  stdin.write(ENTER); // select "/b"
  await wait();
  expect(captured).toEqual(["/b", "folder"]);
  expect(result).toEqual([{ path: "/b", isDirectory: true }]);
});

test("files mode two-level flow: select a directory, browse files, back out, and confirm", async () => {
  const fileRefs: TaskReference[] = [
    { path: "/dir/one.txt", isDirectory: false },
    { path: "/dir/two.txt", isDirectory: false },
  ];
  const client = fakeClient({
    pickRefs: async () => ({ candidates: ["/dir"] }),
    selectPickedRef: async (_path, mode) => {
      expect(mode).toBe("files");
      return { refs: fileRefs };
    },
  });
  let result: unknown = null;
  const { stdin, lastFrame } = render(<DirPickerOverlay client={client} onDone={(r) => { result = r; }} />);
  await wait();
  stdin.write(DOWN); // kind cursor -> Files
  await wait();
  stdin.write(ENTER); // pick Files kind
  await wait();
  stdin.write(ENTER); // select "/dir" (only candidate, cursor 0)
  await wait();
  expect(lastFrame() ?? "").toContain("one.txt");
  expect(lastFrame() ?? "").toContain("two.txt");
  stdin.write(ESC); // back out to the directory list
  await wait();
  expect(lastFrame() ?? "").toContain("/dir");
  stdin.write(ENTER); // select "/dir" again
  await wait();
  stdin.write(ENTER); // confirm the files listing
  await wait();
  expect(result).toEqual(fileRefs);
});

test("filter narrows the visible candidate list", async () => {
  const client = fakeClient({
    pickRefs: async () => ({ candidates: ["/alpha", "/beta"] }),
  });
  const { stdin, lastFrame } = render(<DirPickerOverlay client={client} onDone={() => {}} />);
  await wait();
  stdin.write(ENTER); // Folder kind
  await wait();
  stdin.write("be");
  await wait();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("/beta");
  expect(frame).not.toContain("/alpha");
  expect(frame).toContain("Enter a path manually");
});

test("manual entry: invalid path shows an inline error and stays editable, then retry succeeds", async () => {
  let calls = 0;
  const client = fakeClient({
    pickRefs: async () => ({ candidates: [] }),
    selectPickedRef: async () => {
      calls++;
      if (calls === 1) throw new FakeApiError("path not found");
      return { refs: [{ path: "/good/path", isDirectory: true }] };
    },
  });
  let result: unknown = null;
  const { stdin, lastFrame } = render(<DirPickerOverlay client={client} onDone={(r) => { result = r; }} />);
  await wait();
  stdin.write(ENTER); // Folder kind
  await wait();
  stdin.write(ENTER); // manual row (only row, since candidates is empty)
  await wait();
  stdin.write("/bogus/path");
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(lastFrame() ?? "").toContain("path not found");
  // The manual text field is still present/editable.
  expect(lastFrame() ?? "").toContain("/bogus/path");
  // Correct it and resubmit.
  for (let i = 0; i < "/bogus/path".length; i++) stdin.write(String.fromCharCode(127));
  await wait();
  stdin.write("/good/path");
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(result).toEqual([{ path: "/good/path", isDirectory: true }]);
});

test("Esc at the very first (kind) screen calls onDone with an empty selection", async () => {
  const client = fakeClient({});
  let result: unknown = null;
  const { stdin } = render(<DirPickerOverlay client={client} onDone={(r) => { result = r; }} />);
  await wait();
  stdin.write(ESC);
  await wait();
  expect(result).toEqual([]);
});

test("Esc at the dirlist screen (folder mode, no selection) calls onDone with an empty selection", async () => {
  const client = fakeClient({ pickRefs: async () => ({ candidates: ["/a"] }) });
  let result: unknown = null;
  const { stdin } = render(<DirPickerOverlay client={client} onDone={(r) => { result = r; }} />);
  await wait();
  stdin.write(ENTER); // Folder kind
  await wait();
  stdin.write(ESC);
  await wait();
  expect(result).toEqual([]);
});

test("Esc at the dirlist screen (files mode, no selection) calls onDone with an empty selection", async () => {
  const client = fakeClient({ pickRefs: async () => ({ candidates: ["/a"] }) });
  let result: unknown = null;
  const { stdin } = render(<DirPickerOverlay client={client} onDone={(r) => { result = r; }} />);
  await wait();
  stdin.write(DOWN); // Files kind
  await wait();
  stdin.write(ENTER);
  await wait();
  stdin.write(ESC);
  await wait();
  expect(result).toEqual([]);
});

test("direct-result short-circuit: onDone fires immediately, no candidate-list screen ever renders", async () => {
  const client = fakeClient({
    pickRefs: async () => ({ refs: [{ path: "/x", isDirectory: true }] }),
  });
  let result: unknown = null;
  const { stdin, lastFrame } = render(<DirPickerOverlay client={client} onDone={(r) => { result = r; }} />);
  await wait();
  stdin.write(ENTER); // Folder kind
  await wait();
  expect(result).toEqual([{ path: "/x", isDirectory: true }]);
  expect(lastFrame() ?? "").not.toContain("Enter a path manually");
});

test("cursor navigation is clamped and does not go out of bounds", async () => {
  const client = fakeClient({ pickRefs: async () => ({ candidates: ["/only"] }) });
  const { stdin, lastFrame } = render(<DirPickerOverlay client={client} onDone={() => {}} />);
  await wait();
  stdin.write(ENTER); // Folder kind
  await wait();
  stdin.write(UP);
  await wait();
  stdin.write(UP);
  await wait();
  // rows = ["/only", manual row]; DOWN past the end should clamp at the manual row.
  stdin.write(DOWN);
  await wait();
  stdin.write(DOWN);
  await wait();
  stdin.write(DOWN);
  await wait();
  expect(lastFrame() ?? "").toContain("Enter a path manually");
});
