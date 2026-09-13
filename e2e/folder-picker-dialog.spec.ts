import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the webview `FolderPickerDialog` (docs/plans/webview-
 * folder-file-picker-for-headless.md) — the headless "no native panel"
 * fallback for `POST /refs/pick`, exercised via the `headlessPickBackend`
 * fixture (spawned WITHOUT `AGETOR_FAKE_PICK_REFS_DIR`, so `/refs/pick`
 * returns `{ candidates }` instead of `{ refs }`; every other spec in this
 * repo uses `backend`/`freshBackend`, which set that env var and so always
 * take the native/fixture `{ refs }` shortcut and never render this dialog).
 *
 * Uses RunPanel's inline `ReferencesPicker` (the `refs-dropzone-inline`
 * variant): its Files/Folder buttons render unconditionally, unlike the
 * expandable variant used by NewTaskForm/the issue dialog, which needs a
 * `refs-summary` click first to reveal them — one less step to reach the
 * picker.
 */

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task (isolation "none", `backend.dataDir` as workdir — a real,
 *  already-existing directory) and return it. No run is started: the
 *  composer (and its `ReferencesPicker`) is enabled before a task's first
 *  run, so opening the run panel is enough to reach the Files/Folder
 *  buttons. */
async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt: title, isolation: "none", workdir: backend.dataDir },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  return (await createRes.json()) as TaskRow;
}

/** The run panel's slide-over `<aside>` — see quote.spec.ts's identical
 *  helper for why `.last()` is the right pick (NewTaskForm's sidebar is also
 *  an `<aside>`, mounted first in App.tsx's JSX). */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the run panel to mount
 *  (composer textarea visible) — same idiom as quote.spec.ts's `openTask`. */
async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

function folderPickerDialog(page: Page): Locator {
  return page.getByTestId("folder-picker-dialog");
}

test.describe("folder picker dialog (headless candidates fallback)", () => {
  test("candidate click attaches a folder ref", async ({ page, request, headlessPickBackend: backend }) => {
    const title = `folder-picker-candidate-${randomUUID()}`;
    await createTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    await panel.getByTestId("refs-pick-folder").click();
    const dialog = folderPickerDialog(page);
    await expect(dialog).toBeVisible();

    const rows = dialog.getByTestId("folder-picker-candidate");
    // $HOME is always included as a fallback candidate (headlessPickCandidates
    // in src/bun/refs-pick.ts), so this is guaranteed non-empty even with no
    // tasks/git repos to draw from.
    await expect(rows.first()).toBeVisible();
    const chosenPath = await rows.first().getAttribute("data-path");
    expect(chosenPath).toBeTruthy();

    await rows.first().click();
    await expect(dialog).toBeHidden();

    // `refs-chip`'s own `title` attribute holds the full path (see
    // ReferencesPicker.tsx); these are plain filesystem paths, so no
    // attribute-selector escaping is needed.
    await expect(panel.locator(`[data-testid="refs-chip"][title="${chosenPath}"]`)).toBeVisible();
  });

  test("manual path entry: invalid path errors inline, then succeeds after correction", async ({
    page,
    request,
    headlessPickBackend: backend,
  }) => {
    const title = `folder-picker-manual-${randomUUID()}`;
    await createTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    await panel.getByTestId("refs-pick-folder").click();
    const dialog = folderPickerDialog(page);
    await expect(dialog).toBeVisible();

    const manualInput = dialog.getByTestId("folder-picker-manual-input");
    const manualSubmit = dialog.getByTestId("folder-picker-manual-submit");

    // Invalid path: inline error, dialog stays open.
    await manualInput.fill(path.join(backend.dataDir, "does-not-exist-at-all"));
    await manualSubmit.click();
    await expect(dialog.getByTestId("folder-picker-manual-error")).toBeVisible();
    await expect(dialog).toBeVisible();

    // Correct it: a known-good absolute directory.
    await manualInput.fill("");
    await manualInput.fill(backend.dataDir);
    await manualSubmit.click();
    await expect(dialog).toBeHidden();

    await expect(panel.locator(`[data-testid="refs-chip"][title="${backend.dataDir}"]`)).toBeVisible();
  });

  test("files mode: drill in, pick one file, back button, cancel adds nothing", async ({
    page,
    request,
    headlessPickBackend: backend,
  }) => {
    const title = `folder-picker-files-${randomUUID()}`;
    const task = await createTask(request, backend, title);

    const filesDir = path.join(backend.dataDir, `pick-files-${task.id}`);
    await mkdir(filesDir, { recursive: true });
    const notesPath = path.join(filesDir, "notes.md");
    const specPath = path.join(filesDir, "spec.txt");
    await writeFile(notesPath, "notes\n");
    await writeFile(specPath, "spec\n");

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    await panel.getByTestId("refs-pick-files").click();
    const dialog = folderPickerDialog(page);
    await expect(dialog).toBeVisible();

    const manualInput = dialog.getByTestId("folder-picker-manual-input");
    await manualInput.fill(filesDir);
    await dialog.getByTestId("folder-picker-manual-submit").click();

    // Drill-in landed on the fileslist screen with both planted files.
    const fileRows = dialog.getByTestId("folder-picker-file");
    await expect(fileRows).toHaveCount(2);

    // Back returns to the candidate list (manual input row still present).
    await dialog.getByTestId("folder-picker-back").click();
    await expect(dialog.getByTestId("folder-picker-manual-input")).toBeVisible();
    await expect(dialog.getByTestId("folder-picker-file")).toHaveCount(0);

    // Drill in again and click a single file row: exactly one chip appears,
    // not one per file in the directory (AC-4).
    await dialog.getByTestId("folder-picker-manual-input").fill(filesDir);
    await dialog.getByTestId("folder-picker-manual-submit").click();
    await expect(dialog.getByTestId("folder-picker-file")).toHaveCount(2);
    await dialog.getByTestId("folder-picker-file").filter({ hasText: "notes.md" }).click();

    await expect(dialog).toBeHidden();
    await expect(panel.getByTestId("refs-chip")).toHaveCount(1);
    await expect(panel.locator(`[data-testid="refs-chip"][title="${notesPath}"]`)).toBeVisible();

    // Cancel adds nothing: open the picker again and cancel from the list.
    await panel.getByTestId("refs-pick-folder").click();
    await expect(folderPickerDialog(page)).toBeVisible();
    await folderPickerDialog(page).getByTestId("folder-picker-cancel").click();
    await expect(folderPickerDialog(page)).toBeHidden();
    await expect(panel.getByTestId("refs-chip")).toHaveCount(1);
  });
});
