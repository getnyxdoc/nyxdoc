import { expect, test, type Page } from "@playwright/test";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

async function dispatchTouchDrag(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
  finish: "end" | "cancel",
) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y }],
    });
    for (let step = 1; step <= 10; step += 1) {
      const ratio = step / 10;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{
          x: start.x + (end.x - start.x) * ratio,
          y: start.y + (end.y - start.y) * ratio,
        }],
      });
    }
    await page.evaluate(() => {
      document.documentElement.dataset.testDraggingBeforeFinish = document
        .querySelector<HTMLElement>('[data-dragging="true"]')
        ?.dataset.documentId ?? "";
      const dropTarget = document.querySelector<HTMLElement>("[data-drop-position]");
      document.documentElement.dataset.testDropBeforeFinish = JSON.stringify({
        documentId: dropTarget?.dataset.documentId ?? "",
        position: dropTarget?.dataset.dropPosition ?? "",
      });
    });
    await session.send("Input.dispatchTouchEvent", {
      type: finish === "cancel" ? "touchCancel" : "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

test("keeps rows scrollable while a captured touch handle can move a child to the root", async ({ page }) => {
  const reorderBodies: unknown[] = [];
  await page.route("**/api/documents/document-navigation-02/reorder", async (route) => {
    reorderBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        documentId: "document-navigation-02",
        parentDocumentId: null,
        targetDocumentId: "document-navigation-01",
        position: "after",
        treeOrder: 300,
        orderedDocumentIds: ["document-navigation-01", "document-navigation-02"],
        eventCursor: 22,
        unchanged: false,
        documents: [{
          id: "document-navigation-01",
          title: "탐색 상태 검증 문서 01",
          slug: "navigation-1",
          status: "active",
          parentDocumentId: null,
          treeOrder: 200,
          revisionId: "revision-navigation-1",
          revisionNumber: 1,
          documentType: "test",
          workflowStatus: "draft",
          tags: [],
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T01:00:00.000Z",
        }, {
          id: "document-navigation-02",
          title: "탐색 상태 검증 문서 02",
          slug: "navigation-2",
          status: "active",
          parentDocumentId: null,
          treeOrder: 300,
          revisionId: "revision-navigation-2-moved",
          revisionNumber: 2,
          documentType: "test",
          workflowStatus: "draft",
          tags: [],
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T01:00:00.000Z",
        }],
      }),
    });
  });

  await page.goto("/dev/workspace-e2e?active=document-navigation-02");
  const tree = page.getByRole("navigation", { name: "문서 트리" }).first();
  const sourceRow = tree.locator('[data-document-id="document-navigation-02"]');
  const targetRow = tree.locator('[data-document-id="document-navigation-01"]');
  const handle = sourceRow.locator("[data-document-tree-drag-handle]");
  const sourceLink = sourceRow.getByRole("link", {
    name: "탐색 상태 검증 문서 02",
    exact: true,
  });
  await sourceRow.scrollIntoViewIfNeeded();
  await expect(sourceRow).toBeInViewport();
  await expect(targetRow).toBeInViewport();
  await expect(handle).toBeVisible();
  await expect.poll(() => handle.evaluate((element) => getComputedStyle(element).touchAction))
    .toBe("none");
  await expect.poll(() => sourceLink.evaluate((element) => getComputedStyle(element).touchAction))
    .not.toBe("none");

  const [handleBox, targetBox] = await Promise.all([handle.boundingBox(), targetRow.boundingBox()]);
  if (!handleBox || !targetBox) throw new Error("Touch tree drag coordinates were unavailable.");
  const start = {
    x: handleBox.x + handleBox.width / 2,
    y: handleBox.y + handleBox.height / 2,
  };
  const end = {
    x: targetBox.x + Math.min(120, targetBox.width / 2),
    y: targetBox.y + targetBox.height * 0.86,
  };

  // A browser cancellation must fully restore the tree before another drag.
  await page.evaluate(() => {
    document.addEventListener("pointerdown", (event) => {
      document.documentElement.dataset.testPointerStart = JSON.stringify({
        button: event.button,
        isPrimary: event.isPrimary,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
      });
    }, { capture: true, once: true });
    document.addEventListener("gotpointercapture", (event) => {
      document.documentElement.dataset.testCapturedPointerType = (event as PointerEvent).pointerType;
    }, { capture: true, once: true });
  });
  await dispatchTouchDrag(page, start, end, "cancel");
  expect(JSON.parse(await page.locator("html").getAttribute("data-test-pointer-start") ?? "{}"))
    .toEqual(expect.objectContaining({
      button: 0,
      isPrimary: true,
      pointerType: "touch",
    }));
  await expect(page.locator("html")).toHaveAttribute("data-test-captured-pointer-type", "touch");
  expect(await page.locator("html").getAttribute("data-test-dragging-before-finish"))
    .toBe("document-navigation-02");
  expect(await page.locator("html").getAttribute("data-test-drop-before-finish"))
    .toBe(JSON.stringify({ documentId: "document-navigation-01", position: "after" }));
  await expect.poll(() => reorderBodies.length).toBe(0);
  await expect(sourceRow).not.toHaveAttribute("data-dragging", "true");

  await dispatchTouchDrag(page, start, end, "end");
  await expect.poll(() => reorderBodies).toEqual([{
    requestId: expect.stringMatching(/^tree-reorder-/),
    targetDocumentId: "document-navigation-01",
    position: "after",
  }]);
});

test("focuses the document menu and lets keyboard users move a child out one level", async ({ page }) => {
  const reorderBodies: unknown[] = [];
  await page.route("**/api/documents/document-navigation-02/reorder", async (route) => {
    reorderBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        documentId: "document-navigation-02",
        parentDocumentId: null,
        targetDocumentId: "document-navigation-01",
        position: "after",
        treeOrder: 300,
        orderedDocumentIds: ["document-navigation-01", "document-navigation-02"],
        eventCursor: 23,
        unchanged: false,
        documents: [{
          id: "document-navigation-01",
          title: "탐색 상태 검증 문서 01",
          slug: "navigation-1",
          status: "active",
          parentDocumentId: null,
          treeOrder: 200,
          revisionId: "revision-navigation-1",
          revisionNumber: 1,
          documentType: "test",
          workflowStatus: "draft",
          tags: [],
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T01:00:00.000Z",
        }, {
          id: "document-navigation-02",
          title: "탐색 상태 검증 문서 02",
          slug: "navigation-2",
          status: "active",
          parentDocumentId: null,
          treeOrder: 300,
          revisionId: "revision-navigation-2-moved",
          revisionNumber: 2,
          documentType: "test",
          workflowStatus: "draft",
          tags: [],
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T01:00:00.000Z",
        }],
      }),
    });
  });

  await page.goto("/dev/workspace-e2e?active=document-navigation-02");
  const tree = page.getByRole("navigation", { name: "문서 트리" }).first();
  const sourceRow = tree.locator('[data-document-id="document-navigation-02"]');
  await sourceRow.scrollIntoViewIfNeeded();
  const menuTrigger = sourceRow.getByRole("button", {
    name: "탐색 상태 검증 문서 02 메뉴",
    exact: true,
  });

  await menuTrigger.focus();
  await page.keyboard.press("Enter");
  const moveDownItem = page.getByRole("menuitem", { name: "아래로 이동", exact: true });
  const moveOutItem = page.getByRole("menuitem", { name: "한 단계 밖으로 이동" });
  await expect(moveDownItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(moveOutItem).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(menuTrigger).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(moveDownItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(moveOutItem).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => reorderBodies).toEqual([{
    requestId: expect.stringMatching(/^tree-reorder-/),
    targetDocumentId: "document-navigation-01",
    position: "after",
  }]);
});
