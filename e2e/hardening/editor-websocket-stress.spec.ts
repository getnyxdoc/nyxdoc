import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  activeRichEditor,
  authenticateHardeningOwner,
  commitCurrentDraft,
  createTopLevelDocument,
  installBrowserErrorGuard,
  waitForDraftState,
} from "./helpers";

const LARGE_BLOCK_COUNT = 360;

type CollaborationState = {
  committedDraftVersion: number;
  draftVersion: number;
  hasUncommittedChanges: boolean;
};

async function readCollaborationState(
  page: Page,
  documentId: string,
): Promise<CollaborationState> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/collaboration/token", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: id }),
    });
    const body = await response.json() as Partial<CollaborationState> & {
      error?: unknown;
    };
    if (
      !response.ok
      || !Number.isInteger(body.draftVersion)
      || !Number.isInteger(body.committedDraftVersion)
      || typeof body.hasUncommittedChanges !== "boolean"
    ) {
      throw new Error(
        `Collaboration state was unavailable (${response.status}): ${JSON.stringify(body)}`,
      );
    }
    return {
      committedDraftVersion: body.committedDraftVersion!,
      draftVersion: body.draftVersion!,
      hasUncommittedChanges: body.hasUncommittedChanges!,
    };
  }, documentId);
}

async function selectEntireEditor(editor: Locator) {
  await editor.evaluate((element) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function focusElementEnd(element: Locator) {
  await element.evaluate((node) => {
    (node as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function selectedTableCellId(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    let current = selection?.anchorNode instanceof Element
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    while (current && !current.hasAttribute("data-table-cell-id")) {
      current = current.parentElement;
    }
    return current?.getAttribute("data-table-cell-id") ?? null;
  });
}

async function focusTableCellEnd(page: Page, cell: Locator) {
  const cellId = await cell.getAttribute("data-table-cell-id");
  if (!cellId) throw new Error("The real table cell did not expose a stable identity.");
  await focusElementEnd(cell);
  await expect.poll(() => selectedTableCellId(page)).toBe(cellId);
  return cellId;
}

function largePlainText(runId: string) {
  return Array.from({ length: LARGE_BLOCK_COUNT }, (_, index) => (
    `WS-BULK-${runId}-${String(index + 1).padStart(4, "0")} `
    + "실제 협업 WebSocket 대용량 붙여넣기와 잘라내기 회귀 문장"
  )).join("\n");
}

test("keeps large clipboard, table, Korean IME, and caret-only activity correct over the real collaboration WebSocket", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const browserErrors = installBrowserErrorGuard(page, "editor-websocket-stress");
  const collaborationSockets = new Set<string>();
  page.on("websocket", (socket) => {
    if (/127\.0\.0\.1:3101|\/collaboration(?:\?|$)/u.test(socket.url())) {
      collaborationSockets.add(socket.url());
    }
  });

  const runId = `${testInfo.project.name}-${Date.now().toString(36)}`;
  let phase = "authenticate";

  try {
    await authenticateHardeningOwner(page);
    await context.grantPermissions(
      ["clipboard-read", "clipboard-write"],
      { origin: new URL(page.url()).origin },
    );

    phase = "create a real collaborative document";
    const document = await createTopLevelDocument(
      page,
      `WebSocket editor stress ${runId}`,
      `WebSocket baseline ${runId}`,
    );
    const editor = activeRichEditor(page);
    await expect.poll(() => collaborationSockets.size, { timeout: 30_000 }).toBeGreaterThan(0);
    await waitForDraftState(page, "clean");

    phase = "prove reading, selection, and caret movement do not mutate server draft state";
    const cleanBeforeNavigation = await readCollaborationState(page, document.id);
    expect(cleanBeforeNavigation.hasUncommittedChanges).toBe(false);
    await editor.click();
    for (const key of [
      "Home",
      "End",
      "ArrowLeft",
      "ArrowRight",
      "Shift+ArrowLeft",
      "Shift+ArrowRight",
      "ArrowUp",
      "ArrowDown",
    ]) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(1_200);
    await waitForDraftState(page, "clean");
    expect(await readCollaborationState(page, document.id)).toEqual(cleanBeforeNavigation);

    phase = "paste hundreds of blocks through the real browser clipboard";
    const bulkText = largePlainText(runId);
    const firstBulkMarker = `WS-BULK-${runId}-0001`;
    const lastBulkMarker = `WS-BULK-${runId}-${String(LARGE_BLOCK_COUNT).padStart(4, "0")}`;
    await page.evaluate((text) => navigator.clipboard.writeText(text), bulkText);
    await selectEntireEditor(editor);
    await page.keyboard.press("Control+V");
    await expect(editor).toContainText(lastBulkMarker, { timeout: 45_000 });
    await expect.poll(() => editor.evaluate((element, markerPrefix) => (
      element.textContent?.split(markerPrefix).length
        ? element.textContent.split(markerPrefix).length - 1
        : 0
    ), `WS-BULK-${runId}-`), { timeout: 45_000 }).toBe(LARGE_BLOCK_COUNT);
    await waitForDraftState(page, "dirty");
    const afterPaste = await readCollaborationState(page, document.id);
    expect(afterPaste.hasUncommittedChanges).toBe(true);
    expect(afterPaste.draftVersion).toBeGreaterThan(cleanBeforeNavigation.draftVersion);

    phase = "cut and restore the entire large document through native clipboard shortcuts";
    await selectEntireEditor(editor);
    await page.keyboard.press("Control+X");
    await expect(editor).not.toContainText(lastBulkMarker, { timeout: 45_000 });
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), {
      timeout: 15_000,
    }).toContain(lastBulkMarker);
    await expect.poll(
      async () => (await readCollaborationState(page, document.id)).draftVersion,
      { timeout: 30_000 },
    ).toBeGreaterThan(afterPaste.draftVersion);
    const afterCut = await readCollaborationState(page, document.id);
    await editor.click();
    await page.keyboard.press("Control+Z");
    await expect(editor).toContainText(firstBulkMarker, { timeout: 45_000 });
    await expect(editor).toContainText(lastBulkMarker, { timeout: 45_000 });
    await expect.poll(() => editor.evaluate((element, markerPrefix) => (
      element.textContent?.split(markerPrefix).length
        ? element.textContent.split(markerPrefix).length - 1
        : 0
    ), `WS-BULK-${runId}-`), { timeout: 45_000 }).toBe(LARGE_BLOCK_COUNT);
    await expect.poll(
      async () => (await readCollaborationState(page, document.id)).draftVersion,
      { timeout: 30_000 },
    ).toBeGreaterThan(afterCut.draftVersion);

    phase = "insert and edit a real table with explicit cell and row navigation";
    await focusElementEnd(editor);
    const insertTable = page.getByRole("button", { name: "3 × 3 표 삽입", exact: true });
    await insertTable.scrollIntoViewIfNeeded();
    await insertTable.click();
    const table = editor.getByRole("table").last();
    await expect(table).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(3);

    const bodyCells = table.getByRole("cell");
    const firstCell = bodyCells.nth(0);
    const secondCell = bodyCells.nth(1);
    const firstCellId = await focusTableCellEnd(page, firstCell);
    await page.keyboard.insertText(` CELL_ONE_${runId}`);
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.insertText("두 번째 줄");
    await expect.poll(() => selectedTableCellId(page)).toBe(firstCellId);

    await page.keyboard.press("Tab");
    const secondCellId = await secondCell.getAttribute("data-table-cell-id");
    if (!secondCellId) throw new Error("The adjacent table cell identity was missing.");
    await expect.poll(() => selectedTableCellId(page)).toBe(secondCellId);

    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Input.imeSetComposition", {
        text: "한",
        selectionStart: 1,
        selectionEnd: 1,
      });
      await cdp.send("Input.imeSetComposition", {
        text: "한글",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await cdp.send("Input.insertText", { text: "한글" });
    } finally {
      await cdp.detach();
    }
    await page.keyboard.insertText(` IME_${runId}`);
    await expect(secondCell).toContainText(`한글 IME_${runId}`);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => selectedTableCellId(page)).toBe(firstCellId);

    const addRow = page.getByRole("button", { name: "아래에 행 추가", exact: true });
    await addRow.scrollIntoViewIfNeeded();
    await addRow.click();
    await expect(table.getByRole("row")).toHaveCount(4);
    const addedRowCell = table.getByRole("row").last().getByRole("cell").first();
    await focusTableCellEnd(page, addedRowCell);
    await page.keyboard.insertText(` ADDED_ROW_${runId}`);
    await expect(addedRowCell).toContainText(`ADDED_ROW_${runId}`);
    await waitForDraftState(page, "dirty");

    phase = "commit once and verify exact persisted content after reload";
    await commitCurrentDraft(page);
    const committed = await readCollaborationState(page, document.id);
    expect(committed).toMatchObject({
      hasUncommittedChanges: false,
      committedDraftVersion: committed.draftVersion,
    });

    await page.reload();
    await expect(page.getByRole("textbox", { name: "문서 이름" })).toHaveValue(document.title, {
      timeout: 30_000,
    });
    const reloadedEditor = activeRichEditor(page);
    await expect(reloadedEditor).toContainText(firstBulkMarker, { timeout: 45_000 });
    await expect(reloadedEditor).toContainText(lastBulkMarker, { timeout: 45_000 });
    await expect.poll(() => reloadedEditor.evaluate((element, markerPrefix) => (
      element.textContent?.split(markerPrefix).length
        ? element.textContent.split(markerPrefix).length - 1
        : 0
    ), `WS-BULK-${runId}-`), { timeout: 45_000 }).toBe(LARGE_BLOCK_COUNT);

    const reloadedTable = reloadedEditor.getByRole("table").last();
    await expect(reloadedTable.getByRole("row")).toHaveCount(4);
    await expect(reloadedTable).toContainText(`CELL_ONE_${runId}`);
    await expect(reloadedTable).toContainText("두 번째 줄");
    await expect(reloadedTable).toContainText(`한글 IME_${runId}`);
    await expect(reloadedTable).toContainText(`ADDED_ROW_${runId}`);
    await waitForDraftState(page, "clean");

    phase = "repeat caret-only table navigation after reload without dirtying the draft";
    const cleanAfterReload = await readCollaborationState(page, document.id);
    const reloadedFirstCell = reloadedTable.getByRole("cell").first();
    await focusTableCellEnd(page, reloadedFirstCell);
    for (const key of ["Home", "End", "ArrowLeft", "ArrowRight", "Shift+ArrowLeft", "Shift+ArrowRight"]) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(1_200);
    await waitForDraftState(page, "clean");
    expect(await readCollaborationState(page, document.id)).toEqual(cleanAfterReload);
    await browserErrors.assertClean();
  } catch (error) {
    await testInfo.attach("editor-websocket-stress-reproduction", {
      body: Buffer.from(JSON.stringify({
        browser: testInfo.project.name,
        collaborationSockets: [...collaborationSockets],
        failedPhase: phase,
        largeBlockCount: LARGE_BLOCK_COUNT,
        reproduction: [
          "Create a document through the authenticated workspace UI.",
          "Move/select only the caret and compare collaboration draft metadata.",
          "Paste and cut hundreds of newline-delimited blocks with native clipboard shortcuts.",
          "Undo the full cut with Ctrl+Z, insert a 3x3 table, navigate with Tab/Shift+Tab, and use Korean IME composition.",
          "Add a row, save one canonical revision, reload, and verify exact persisted content.",
          "Move/select the caret in the reloaded table and confirm the draft remains clean.",
        ],
      }, null, 2)),
      contentType: "application/json",
    });
    throw error;
  }
});
