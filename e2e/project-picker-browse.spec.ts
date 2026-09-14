import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for `ProjectPicker`'s "Browse for folder…" headless fallback
 * (PLAN.md — wire Project picker's Browse-for-folder to the headless folder
 * picker). Mirrors e2e/folder-picker-dialog.spec.ts's structure: the
 * `headlessPickBackend` fixture (no native bridge, no
 * `AGETOR_FAKE_PICK_REFS_DIR`) exercises the candidates-dialog path
 * (AC-1/2/3/5/7); the default `backend` fixture (which sets
 * `AGETOR_FAKE_PICK_REFS_DIR`) exercises direct single-result resolution
 * with no dialog (AC-4).
 *
 * `ProjectPicker` lives on the always-mounted `NewTaskForm` sidebar, so no
 * task needs to be created first — the spec goes straight to `gotoApp`.
 */

const PROJECT_PICKER_TITLE =
  "Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.";

/** The New Task sidebar `<aside>` — the *first* one mounted in App.tsx
 *  (the run panel, mounted only once a task is open, is the *last*
 *  `<aside>` — see folder-picker-dialog.spec.ts's identical note). */
function newTaskSidebar(page: Page): Locator {
  return page.locator("aside").first();
}

async function openProjectPickerMenu(page: Page): Promise<void> {
  await newTaskSidebar(page).getByTitle(PROJECT_PICKER_TITLE).click();
}

function folderPickerDialog(page: Page): Locator {
  return page.getByTestId("folder-picker-dialog");
}

function projectPickerTrigger(page: Page): Locator {
  return newTaskSidebar(page).getByTitle(PROJECT_PICKER_TITLE);
}

test.describe("Project picker: Browse for folder… headless fallback", () => {
  test("candidates dialog: pick a folder, project becomes selected and listed (AC-1/2/3)", async ({
    page,
    headlessPickBackend: backend,
  }) => {
    await gotoApp(page, backend.bootBase);

    await openProjectPickerMenu(page);
    await page.getByTestId("project-picker-browse").click();

    const dialog = folderPickerDialog(page);
    await expect(dialog).toBeVisible();

    const rows = dialog.getByTestId("folder-picker-candidate");
    // $HOME is always included as a fallback candidate (headlessPickCandidates
    // in src/bun/refs-pick.ts), so this is guaranteed non-empty.
    await expect(rows.first()).toBeVisible();
    const chosenPath = await rows.first().getAttribute("data-path");
    expect(chosenPath).toBeTruthy();

    await rows.first().click();
    await expect(dialog).toBeHidden();

    // AC-2: the picked folder is shown as the selected project.
    const basename = chosenPath!.replace(/\/+$/, "").split("/").pop() || chosenPath!;
    await expect(projectPickerTrigger(page)).toContainText(basename);

    // AC-3: the newly registered project appears in the project list.
    await openProjectPickerMenu(page);
    await expect(page.getByText(chosenPath!, { exact: true })).toBeVisible();
  });

  test("cancelling the dialog leaves the current project selection unchanged (AC-5)", async ({
    page,
    headlessPickBackend: backend,
  }) => {
    await gotoApp(page, backend.bootBase);

    await openProjectPickerMenu(page);
    const before = await projectPickerTrigger(page).textContent();

    await page.getByTestId("project-picker-browse").click();
    const dialog = folderPickerDialog(page);
    await expect(dialog).toBeVisible();

    await dialog.getByTestId("folder-picker-cancel").click();
    await expect(dialog).toBeHidden();

    await expect(projectPickerTrigger(page)).toHaveText(before ?? "");
  });

  test("multi-candidate dialog only reachable because native is unavailable (AC-7)", async ({
    page,
    headlessPickBackend: backend,
  }) => {
    // Implicit: this whole describe block runs against headlessPickBackend,
    // which has no native bridge at all — the dialog above only ever appears
    // because the initial api.pickProject() call 501s. There is no separate
    // native-path e2e coverage needed here, matching how
    // folder-picker-dialog.spec.ts covers only the headless side.
    await gotoApp(page, backend.bootBase);
    await openProjectPickerMenu(page);
    await page.getByTestId("project-picker-browse").click();
    await expect(folderPickerDialog(page)).toBeVisible();
  });

  test("direct resolution: no candidates dialog, folder registered and selected immediately (AC-4)", async ({
    page,
    backend,
  }: { page: Page; backend: E2EBackend }) => {
    await gotoApp(page, backend.bootBase);

    await openProjectPickerMenu(page);
    await page.getByTestId("project-picker-browse").click();

    // The default `backend` fixture sets AGETOR_FAKE_PICK_REFS_DIR (folder
    // mode resolves directly to `fakePickDir` itself — see server.ts), so
    // /refs/pick resolves directly to `{ refs }` — no candidates dialog, and
    // no additional interaction is needed to choose among candidates.
    await expect(folderPickerDialog(page)).not.toBeVisible();

    const basename = backend.fakePickDir.replace(/\/+$/, "").split("/").pop()!;
    await expect(projectPickerTrigger(page)).toContainText(basename);

    // AC-2/3 parity for the direct-resolution path: it's also registered
    // and appears in the project list.
    await openProjectPickerMenu(page);
    await expect(page.getByText(backend.fakePickDir, { exact: true })).toBeVisible();
  });
});
