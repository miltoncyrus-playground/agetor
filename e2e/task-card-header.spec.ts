import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the compact kanban `TaskCard`'s 2-row layout
 * (src/mainview/components/kanban/TaskCard.tsx):
 *
 *   row 1 — task-type icon + the title, which takes the rest of the row.
 *   row 2 — harness icon + `task.agent` + a state dot + the single state
 *           label (`cardStateLabel`).
 *
 * The card is deliberately this small so a swimlane board can show six
 * columns per project. Everything that used to be on the face — workdir,
 * branch/baseRef, the model·mode line, the prompt preview, and every action
 * button — is reached by clicking the tile (run panel) or right-clicking it
 * (task context menu, which carries Run / Stop / Mark done / Archive /
 * View changes / Delete). This spec asserts that contract: what IS on the
 * face, and that `model`/`mode` are deliberately NOT.
 *
 * Seeds a task directly through the backend API (isolation "none", a plain
 * non-git temp dir as workdir — this spec never starts a run, so nothing
 * ever touches the filesystem or spawns an agent) with a task type, model,
 * and mode set, then asserts presence and geometry via `boundingBox()`
 * reads — coarse tolerances only, no pixel-perfect assertions, per
 * quote.spec.ts's own "no pixel/screenshot assertions" convention for this
 * harness (WKWebView, the app's real target, renders differently from
 * Chromium).
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create (but never start) a task with a task type + model + mode set, so
 *  the board card renders every header row this spec asserts on. isolation
 *  "none" + a plain temp dir keeps this a pure API/DB round-trip — no git,
 *  no worktree, no agent process. */
async function createHeaderTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: {
      title,
      prompt: "investigate and fix the reported defect",
      isolation: "none",
      workdir: tmpdir(),
      agent: "claude-code",
      taskType: "bug",
      model: "opus",
      mode: "auto",
    },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  return (await createRes.json()) as TaskRow;
}

/** Scopes a locator to the board `TaskCard` for the given exact title —
 *  mirrors `e2e/unread-indicator.spec.ts`'s `taskCard` helper: the root
 *  `<Card>` carries `cursor-grab` (drag-handle styling unique to board
 *  cards; the run panel's `<aside>` never has it), so this can't
 *  accidentally match anything else in the DOM. */
function taskCard(page: Page, title: string) {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

/** The row-2 harness name. The compact card renders `task.agent` as a bare
 *  `<span className="shrink-0">` beside the `AgentIcon`, not in a Badge
 *  pill — so unlike the old card this IS matchable by exact text: the
 *  icon's hidden SVG `<title>Claude Code</title>` node lives in a sibling
 *  element, so it no longer lands in this span's own `textContent`. */
function harnessName(card: Locator) {
  return card.getByText("claude-code", { exact: true });
}

/** Bounding boxes are asserted repeatedly below; a thin wrapper keeps every
 *  call site honest about non-null (Playwright returns null only for a
 *  detached/invisible element, which every locator here has already been
 *  proven visible before this is called). */
async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "expected a visible element with a bounding box").not.toBeNull();
  return b!;
}

test.describe("task card header layout", () => {
  test("renders the type icon, title, harness name and state label — and NOT model/mode", async ({
    page,
    request,
    backend,
  }) => {
    const title = `header-e2e ${randomUUID()} verify the compact card renders`;
    await createHeaderTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const card = taskCard(page, title);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Row 1: task-type icon. "bug" -> TASK_TYPES' "Bug" label
    // (src/shared/types.ts), applied verbatim as the icon's aria-label.
    await expect(card.locator('[aria-label="Bug"]')).toBeVisible();
    // Row 1: the full title.
    await expect(card.getByText(title, { exact: true })).toBeVisible();

    // Row 2: `task.agent` verbatim, then the single state label. A freshly
    // created task sits in Backlog and has no pipelineStage, so
    // `cardStateLabel` falls through to the plain column label.
    await expect(harnessName(card)).toBeVisible();
    await expect(card.getByText("Backlog", { exact: true })).toBeVisible();

    // The model·mode line is deliberately gone from the face — it lives in
    // the run panel now. Asserted as an absence so a future re-add has to
    // come with a deliberate update here rather than silently re-growing
    // the card.
    await expect(card.getByText("opus · auto", { exact: true })).toHaveCount(0);
  });

  test("lays the card out as two stacked rows: icon+title, then harness+state", async ({
    page,
    request,
    backend,
  }) => {
    const title = `header-e2e ${randomUUID()} confirm the two row geometry`;
    await createHeaderTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const card = taskCard(page, title);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const icon = card.locator('[aria-label="Bug"]');
    const cardTitle = card.getByText(title, { exact: true });
    const agent = harnessName(card);
    const state = card.getByText("Backlog", { exact: true });
    await expect(icon).toBeVisible();
    await expect(cardTitle).toBeVisible();
    await expect(agent).toBeVisible();
    await expect(state).toBeVisible();

    const [iconBox, titleBox, agentBox, stateBox] = await Promise.all([
      box(icon), box(cardTitle), box(agent), box(state),
    ]);

    // --- Row 1: type icon and title share a visual row -------------------
    const iconMidY = iconBox.y + iconBox.height / 2;
    const titleMidY = titleBox.y + titleBox.height / 2;
    expect(Math.abs(iconMidY - titleMidY), "type icon and title should sit on the same row").toBeLessThan(8);
    expect(iconBox.x, "type icon should sit left of the title").toBeLessThan(titleBox.x);

    // --- Row 2: harness name and state label share a visual row ----------
    const agentMidY = agentBox.y + agentBox.height / 2;
    const stateMidY = stateBox.y + stateBox.height / 2;
    expect(Math.abs(agentMidY - stateMidY), "harness name and state should sit on the same row").toBeLessThan(8);
    expect(agentBox.x, "harness name should sit left of the state label").toBeLessThan(stateBox.x);

    // --- Strict row ordering: row 1 sits entirely above row 2 ------------
    expect(
      titleBox.y + titleBox.height,
      "the title row should sit entirely above the harness/state row",
    ).toBeLessThanOrEqual(agentBox.y + 2);

    // --- The whole card stays compact ------------------------------------
    // Two short rows and nothing else. A regression that re-adds the prompt
    // preview, workdir or branch lines would blow straight past this.
    const cardBox = await box(card);
    expect(cardBox.height, "the compact card should stay two rows tall").toBeLessThan(72);
  });
});
