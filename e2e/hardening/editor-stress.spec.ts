import { expect, test, type Page } from "@playwright/test";

const COLLABORATION_EDITOR_NAME = "협업 선택 테스트";
const RICH_BLOCK_COUNT = 600;

async function openCollaborationFixture(page: Page) {
  await page.goto("/dev/collaboration-e2e");
  await expect(page.getByTestId("collaboration-ready")).toHaveText("ready");
  const editor = page.getByRole("textbox", { name: COLLABORATION_EDITOR_NAME });
  await expect(editor).toBeVisible();
  return editor;
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

async function focusTableCellEnd(page: Page, cellId: string) {
  const cell = page.locator(`[data-table-cell-id="${cellId}"]`);
  await cell.click({ position: { x: 30, y: 24 } });
  await page.keyboard.press("End");
  await expect.poll(() => selectedTableCellId(page)).toBe(cellId);
}

test("keeps a 600-block rich-text paste and cut responsive, lossless, and undoable", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  const editor = await openCollaborationFixture(page);
  await context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: new URL(page.url()).origin },
  );

  const pasteDispatchMs = await editor.evaluate((element, blockCount) => {
    element.focus();
    document.execCommand("selectAll");
    const rows = Array.from({ length: blockCount }, (_, index) => (
      `HARDENING-RICH-${String(index + 1).padStart(4, "0")} `
      + "대용량 서식 붙여넣기와 잘라내기 회귀 문장입니다. ".repeat(4)
    ));
    const transfer = new DataTransfer();
    transfer.setData(
      "text/html",
      rows.map((row) => `<p><strong>${row}</strong></p>`).join(""),
    );
    transfer.setData("text/plain", rows.join("\n"));
    const startedAt = performance.now();
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
    return performance.now() - startedAt;
  }, RICH_BLOCK_COUNT);

  expect(pasteDispatchMs).toBeLessThan(2_500);
  await expect(editor).toContainText("HARDENING-RICH-0600", { timeout: 30_000 });
  await expect(editor.locator("strong").first()).toContainText("HARDENING-RICH-0001");
  await expect.poll(() => editor.evaluate((element) => (
    element.textContent?.match(/HARDENING-RICH-/g)?.length ?? 0
  ))).toBe(RICH_BLOCK_COUNT);

  await editor.click();
  await page.keyboard.press("Control+A");
  const cutStartedAt = Date.now();
  await page.keyboard.press("Control+X");
  await expect(editor).not.toContainText("HARDENING-RICH-0600", { timeout: 30_000 });
  expect(Date.now() - cutStartedAt).toBeLessThan(7_500);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("HARDENING-RICH-0600");

  await page.keyboard.press("Control+Z");
  await expect(editor).toContainText("HARDENING-RICH-0600", { timeout: 30_000 });
  await expect(editor.locator("strong").first()).toContainText("HARDENING-RICH-0001");
  await expect(page.getByTestId("collaboration-repair-count")).toHaveText("0");
});

test("does not emit a shared-document update for reading and caret movement alone", async ({ page }) => {
  const editor = await openCollaborationFixture(page);
  const updateCount = page.getByTestId("collaboration-ydoc-update-count");
  await page.waitForTimeout(800);
  const baselineUpdates = Number(await updateCount.textContent());
  const baselineText = await editor.textContent();

  await editor.click();
  for (const key of ["ArrowRight", "ArrowDown", "Home", "End", "ArrowLeft"]) {
    await page.keyboard.press(key);
  }
  await focusTableCellEnd(page, "collaboration-e2e-cell-3-2");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await page.locator('[data-nyxdoc-block-id="collaboration-e2e-after-table"]').click();
  await page.keyboard.press("Home");
  await page.waitForTimeout(1_200);

  await expect(updateCount).toHaveText(String(baselineUpdates));
  expect(await editor.textContent()).toBe(baselineText);
  await expect(page.getByTestId("collaboration-repair-count")).toHaveText("0");
});

test("keeps table navigation, Korean composition, and post-table content anchored", async ({
  context,
  page,
}) => {
  const editor = await openCollaborationFixture(page);
  await expect(editor.getByRole("table")).toBeVisible();

  const afterTable = page.locator(
    '[data-nyxdoc-block-id="collaboration-e2e-after-table"]',
  );
  await afterTable.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" · AFTER_TABLE_STABLE");
  await expect(afterTable).toContainText("AFTER_TABLE_STABLE");

  const firstCellId = "collaboration-e2e-cell-2-1";
  const nextCellId = "collaboration-e2e-cell-2-2";
  await focusTableCellEnd(page, firstCellId);
  await page.keyboard.insertText(" LOCAL_CELL");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("둘째줄");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => selectedTableCellId(page)).toBe(firstCellId);

  await page.keyboard.press("Tab");
  await expect.poll(() => selectedTableCellId(page)).toBe(nextCellId);

  const cdp = await context.newCDPSession(page);
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
  await cdp.detach();

  await page.keyboard.insertText(" 입력 계속");
  await expect(page.locator(`[data-table-cell-id="${nextCellId}"]`))
    .toContainText("한글 입력 계속");
  await expect.poll(() => selectedTableCellId(page)).toBe(nextCellId);
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => selectedTableCellId(page)).toBe(firstCellId);

  await expect(page.locator(`[data-table-cell-id="${firstCellId}"]`))
    .toContainText("LOCAL_CELL");
  await expect(afterTable).toContainText("AFTER_TABLE_STABLE");
  await expect(page.getByTestId("collaboration-repair-count")).toHaveText("0");
});

test("keeps the narrow toolbar on one line and horizontally interactive", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dev/editor-e2e");
  await expect(page.getByTestId("editor-ready")).toHaveText("ready");

  const toolbar = page.getByRole("toolbar", { name: "문서 서식" });
  await expect(toolbar).toBeVisible();
  const initialMetrics = await toolbar.evaluate((element) => ({
    clientWidth: element.clientWidth,
    flexWrap: getComputedStyle(element).flexWrap,
    overflowX: getComputedStyle(element).overflowX,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
    touchAction: getComputedStyle(element).touchAction,
    shrinkingChildren: Array.from(element.children).filter(
      (child) => getComputedStyle(child).flexShrink !== "0",
    ).length,
  }));
  expect(initialMetrics.scrollWidth).toBeGreaterThan(initialMetrics.clientWidth);
  expect(initialMetrics.scrollLeft).toBe(0);
  expect(initialMetrics.flexWrap).toBe("nowrap");
  expect(initialMetrics.overflowX).toBe("auto");
  expect(initialMetrics.touchAction).toContain("pan-x");
  expect(initialMetrics.shrinkingChildren).toBe(0);

  const bold = page.getByRole("button", { name: "굵게" });
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  const boldBox = await bold.boundingBox();
  if (!boldBox) throw new Error("The visible toolbar drag handle was unavailable.");
  await page.mouse.move(boldBox.x + boldBox.width / 2, boldBox.y + boldBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    Math.max(8, boldBox.x - 170),
    boldBox.y + boldBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();

  await expect.poll(() => toolbar.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(60);
  await expect(bold).toHaveAttribute("aria-pressed", "false");

  await toolbar.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const shortcuts = page.getByRole("button", { name: "키보드 단축키" });
  await expect(shortcuts).toBeInViewport();
  await shortcuts.click();
  await expect(page.getByRole("dialog", { name: "키보드 단축키" })).toBeVisible();
});
