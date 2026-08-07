import { expect, test, type Page } from "@playwright/test";

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

const historicalRevision = {
  id: "revision-1",
  number: 1,
  summary: "첫 문서 생성",
  actorType: "agent",
  actorLabel: "Codex",
  source: "mcp",
  createdAt: "2026-07-14T00:00:00.000Z",
  content: {
    schemaVersion: 2,
    blocks: [
      { id: "revision-1-title", type: "h1", children: [{ text: "과거 본문" }] },
      { id: "revision-1-body", type: "p", children: [{ text: "리비전 1의 내용입니다." }] },
    ],
  },
};

test("renders an agent-authored raw URL as the public page title and opens it from readers and editors", async ({ context, page }) => {
  let previewAvailable = true;
  await context.route("https://learn.chatgpt.com/docs/build-skills", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Build skills fixture</title>",
    });
  });
  await page.route("**/api/link-preview", async (route) => {
    expect(route.request().headers()["x-nyxdoc-workspace-id"]).toBe("workspace-e2e");
    expect(route.request().postDataJSON()).toEqual({
      documentId: "document-e2e",
      url: "https://learn.chatgpt.com/docs/build-skills",
    });
    await route.fulfill({
      status: previewAvailable ? 200 : 400,
      contentType: "application/json",
      body: JSON.stringify(previewAvailable
        ? {
            title: "Build skills | ChatGPT Learn",
            url: "https://learn.chatgpt.com/docs/build-skills",
          }
        : {
            error: "링크에서 제목을 확인하지 못했습니다.",
            code: "FETCH_FAILED",
          }),
    });
  });

  await page.goto("/dev/workspace-e2e?fixture=agent-link-reader");
  const titledLink = page.getByRole("link", { name: "Build skills | ChatGPT Learn" });
  await expect(titledLink).toHaveAttribute(
    "href",
    "https://learn.chatgpt.com/docs/build-skills",
  );
  await expect(titledLink).toHaveAttribute("target", "_blank");
  await expect(titledLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    titledLink.getByText("Build skills | ChatGPT Learn", { exact: true }),
  ).toBeVisible();
  const readerPopupPromise = page.waitForEvent("popup");
  await titledLink.click();
  const readerPopup = await readerPopupPromise;
  await expect(readerPopup).toHaveURL("https://learn.chatgpt.com/docs/build-skills");
  await readerPopup.close();

  previewAvailable = false;
  await page.reload();
  const fallbackLink = page.getByRole("link", {
    name: "https://learn.chatgpt.com/docs/build-skills",
  });
  await expect(fallbackLink).toHaveAttribute("target", "_blank");
  await expect(fallbackLink).toContainText("https://learn.chatgpt.com/docs/build-skills");

  previewAvailable = true;
  await page.goto("/dev/workspace-e2e?fixture=agent-link-editor");
  const editorLink = page.getByRole("link", { name: "Build skills | ChatGPT Learn" });
  await expect(editorLink).toHaveAttribute(
    "href",
    "https://learn.chatgpt.com/docs/build-skills",
  );
  await expect(editorLink).toHaveAttribute("target", "_blank");
  const editorPopupPromise = page.waitForEvent("popup");
  await editorLink.click();
  const editorPopup = await editorPopupPromise;
  await expect(editorPopup).toHaveURL("https://learn.chatgpt.com/docs/build-skills");
  await editorPopup.close();

  const modifiedPopupPromise = page.waitForEvent("popup");
  await editorLink.click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  const modifiedPopup = await modifiedPopupPromise;
  await expect(modifiedPopup).toHaveURL("https://learn.chatgpt.com/docs/build-skills");
  await modifiedPopup.close();

  const editor = page.locator('[data-slate-editor="true"]');
  await editor.click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  const content = page.getByTestId("agent-link-content");
  await expect(content).toContainText("https://learn.chatgpt.com/docs/build-skills");
  await expect.poll(async () => (await content.textContent())?.includes("autoTitle") ?? false, {
    timeout: 2_200,
  }).toBe(false);
});

test("previews an old revision without mutation and loads it only into the shared draft", async ({ page }) => {
  let previewReads = 0;
  let restoreWrites = 0;
  let restoreBody: unknown;

  await page.route("**/api/documents/document-e2e/revisions/revision-1", async (route) => {
    previewReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revision: historicalRevision }),
    });
  });
  await page.route("**/api/documents/document-e2e/revisions/revision-1/restore", async (route) => {
    restoreWrites += 1;
    restoreBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        roomName: "nyxdoc:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:g2",
        workingDocument: {
          documentId: "document-e2e",
          baseRevisionNumber: 2,
          draftVersion: 1,
          hasUncommittedChanges: true,
        },
      }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  const history = page.getByRole("button", { name: /변경 기록.*리비전 2/ });
  await history.click();
  await page.getByRole("button", { name: "리비전 1 보기" }).click();

  const preview = page.getByRole("dialog", { name: "리비전 1 미리보기" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("과거 본문", { exact: true })).toBeVisible();
  await expect(preview.getByText(/현재 문서는 리비전 2입니다/)).toBeVisible();
  expect(previewReads).toBe(1);
  expect(restoreWrites).toBe(0);

  await preview.getByRole("button", { name: "리비전 미리보기 닫기" }).click();
  await expect(preview).toBeHidden();
  expect(restoreWrites).toBe(0);

  const historyPanel = page.getByRole("complementary", { name: "변경 기록" });
  await expect(historyPanel).toBeVisible();
  await history.click();
  await expect(historyPanel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(historyPanel).toBeVisible();

  await page.getByRole("button", { name: "리비전 1 보기" }).click();
  await expect(preview).toBeVisible();
  expect(previewReads).toBe(2);
  expect(restoreWrites).toBe(0);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("공유 초안으로 불러올까요");
    expect(dialog.message()).toContain("현재 정본과 기존 리비전은 바뀌지 않으며");
    expect(dialog.message()).toContain("Ctrl+S 또는 ‘저장’");
    await dialog.accept();
  });
  await preview.getByRole("button", { name: "이 버전을 공유 초안으로 불러오기" }).click();

  await expect(preview).toBeHidden();
  await expect(historyPanel).toBeVisible();
  expect(restoreWrites).toBe(1);
  expect(restoreBody).toEqual({
    baseRevision: 2,
    expectedDraftVersion: 0,
    expectedGeneration: 1,
  });
  await expect(page.getByText("리비전 2", { exact: true })).toBeVisible();

  await historyPanel.getByRole("button", { name: "변경 기록 닫기" }).click();
  await expect(historyPanel).toBeHidden();
});

test("keeps the editor always open and resizes the document tree beside it", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("nyxdoc:workspace-sidebar-width");
  });
  await page.goto("/dev/workspace-e2e");

  const separator = page.getByRole("separator", { name: "문서 목록 너비 조절" });
  await expect(separator).toBeVisible();
  await expect(separator).toHaveAttribute("aria-valuenow", "248");
  await expect(page.getByRole("toolbar", { name: "문서 서식" })).toBeVisible();
  const title = page.getByRole("textbox", { name: "문서 이름" });
  await expect(title).toBeVisible();
  await expect(title).toHaveJSProperty("tagName", "TEXTAREA");
  await expect(title.locator("xpath=ancestor::article")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "편집", exact: true })).toHaveCount(0);

  await title.fill("본문에서 고치는 문서 제목");
  await title.press("Enter");
  await expect(page.getByRole("textbox", { name: "리비전 동작 검증 공유 초안" })).toBeFocused();
  await expect(page.locator("header").first()).toContainText("본문에서 고치는 문서 제목");

  await separator.focus();
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "264");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("nyxdoc:workspace-sidebar-width"))).toBe("264");
});

test("keeps document context in settings and manages general link access separately", async ({ page }) => {
  const methods: string[] = [];
  await page.route("**/api/documents/document-e2e/share", async (route) => {
    const method = route.request().method();
    methods.push(method);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        share: {
          enabled: method === "POST",
          urlPath: "/s/public-share-token-e2e",
          createdAt: "2026-07-20T00:00:00.000Z",
          updatedAt: "2026-07-20T00:00:00.000Z",
        },
      }),
    });
  });
  await page.route("**/api/documents/document-e2e/access", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access: [{
          userId: "user-e2e",
          name: "Revision E2E",
          email: "revision-e2e@example.com",
          role: "owner",
          source: "workspace",
          grantedAt: null,
        }],
      }),
    });
  });
  await page.route("**/api/documents/document-e2e/access/candidates?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ candidates: [] }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  await expect(page.getByRole("link", { name: "계정 설정" })).toHaveAttribute(
    "href",
    "/settings/account?workspace=workspace-e2e&document=document-e2e",
  );
  await expect(page.getByRole("link", { name: "PDF" })).toHaveAttribute(
    "href",
    "/print?workspace=workspace-e2e&document=document-e2e&autoprint=1",
  );

  await page.getByRole("button", { name: "공유" }).click();
  const dialog = page.getByRole("dialog", { name: /리비전 동작 검증.*공유/ });
  await expect(dialog.getByText("제한됨", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "링크 공개" }).click();
  await expect(dialog.getByText("링크가 있는 모든 사용자", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/\/s\/public-share-token-e2e/)).toBeVisible();
  await dialog.getByRole("button", { name: "제한됨으로 변경" }).click();
  await expect(dialog.getByText("제한됨", { exact: true })).toBeVisible();
  expect(methods).toEqual(["GET", "POST", "DELETE"]);
});

test("shares one document with a named user as viewer or editor", async ({ page }) => {
  const accessWrites: Array<{ userId: string; role: string }> = [];
  let grantedRole: "viewer" | "editor" | null = null;
  await page.route("**/api/documents/document-e2e/share", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        share: {
          enabled: false,
          urlPath: null,
          createdAt: null,
          updatedAt: null,
        },
      }),
    });
  });
  await page.route("**/api/documents/document-e2e/access", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { userId: string; role: "viewer" | "editor" };
      accessWrites.push(body);
      grantedRole = body.role;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entry: {
            userId: body.userId,
            name: "Recipient",
            email: "recipient@example.com",
            role: body.role,
            source: "document_grant",
            grantedAt: "2026-07-20T00:00:00.000Z",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access: [{
          userId: "user-e2e",
          name: "Revision E2E",
          email: "revision-e2e@example.com",
          role: "owner",
          source: "workspace",
          grantedAt: null,
        }],
      }),
    });
  });
  await page.route("**/api/documents/document-e2e/access/candidates?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [{
          userId: "recipient-e2e",
          name: "Recipient",
          email: "recipient@example.com",
        }],
      }),
    });
  });
  await page.route("**/api/documents/document-e2e/access/recipient-e2e", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    grantedRole = null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revoked: true }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: "공유" }).click();
  const dialog = page.getByRole("dialog", { name: /리비전 동작 검증.*공유/ });
  const search = dialog.getByRole("textbox", { name: "이름 또는 이메일로 사용자 찾기" });
  await search.fill("recipient");
  await dialog.getByRole("button", { name: /Recipient.*recipient@example\.com/ }).click();
  await dialog.getByRole("combobox", { name: "새 사용자의 문서 권한" }).selectOption("editor");
  await dialog.getByRole("button", { name: "공유", exact: true }).click();

  const recipientRole = dialog.getByRole("combobox", { name: "Recipient 문서 권한" });
  await expect(recipientRole).toHaveValue("editor");
  expect(grantedRole).toBe("editor");
  await recipientRole.selectOption("viewer");
  await expect(recipientRole).toHaveValue("viewer");
  expect(grantedRole).toBe("viewer");
  expect(accessWrites).toEqual([
    { userId: "recipient-e2e", role: "editor" },
    { userId: "recipient-e2e", role: "viewer" },
  ]);

  const recipientCard = dialog.locator("article").filter({ hasText: "recipient@example.com" });
  await recipientCard.getByRole("button", { name: "삭제" }).click();
  await expect(recipientRole).toHaveCount(0);
  expect(grantedRole).toBeNull();
});

test("keeps the collaborative caret stable while parent status rerenders", async ({ page }) => {
  await page.goto("/dev/workspace-e2e");
  const editor = page.getByRole("textbox", { name: "리비전 동작 검증 공유 초안" });
  await editor.click();
  await page.keyboard.type("ABCDEFGHIJ", { delay: 15 });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("X", { delay: 15 });

  await expect(editor).toContainText("ABCDEFGHXIJ");
  await expect(editor).toBeFocused();
  await expect.poll(() => page.evaluate(() => {
    const selection = document.getSelection();
    return selection?.isCollapsed === true && selection.rangeCount === 1;
  })).toBe(true);
});

test("does not mutate a collaborative draft when a person only reads or moves the caret", async ({ page }) => {
  await page.route("**/api/link-preview", async (route) => {
    const request = route.request().postDataJSON() as { url: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: request.url.includes("example.com")
          ? "Agent link example"
          : "Build skills | ChatGPT Learn",
        url: request.url,
      }),
    });
  });
  await page.goto("/dev/collaboration-e2e");
  await expect(page.getByTestId("collaboration-ready")).toHaveText("ready");
  await expect(page.getByRole("link", { name: "Build skills | ChatGPT Learn" })).toBeVisible();
  const updates = page.getByTestId("collaboration-ydoc-update-count");
  const baseline = Number(await updates.textContent());

  const editor = page.getByRole("textbox", { name: "협업 선택 테스트" });
  await editor.click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.waitForTimeout(2_000);

  await expect(updates).toHaveText(String(baseline));

  await page.getByTestId("collaboration-remote-link").evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(page.getByRole("link", { name: "Agent link example" })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(updates).toHaveText(String(baseline + 1));
});

test("keeps the collaborative caret after Enter in first and later blocks", async ({ page }) => {
  await page.goto("/dev/collaboration-e2e");
  await expect(page.getByTestId("collaboration-ready")).toHaveText("ready");
  const editor = page.getByRole("textbox", { name: "협업 선택 테스트" });
  await expect(editor).toBeVisible();
  const initialBlockCount = await editor.evaluate((element) => element.children.length);

  await editor.evaluate((element) => {
    const firstBlock = element.children.item(0);
    if (!firstBlock) throw new Error("첫 번째 문단을 찾지 못했습니다.");
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(firstBlock);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("Enter");

  await expect.poll(() => editor.evaluate((element) => element.children.length))
    .toBe(initialBlockCount + 1);
  await expect(page.getByTestId("collaboration-repair-count")).toHaveText("0");
  await expect.poll(() => editor.evaluate((element) => (
    element.children.item(1)?.getAttribute("data-nyxdoc-block-id") ?? ""
  ))).not.toBe("");

  const caretBlockIndex = await editor.evaluate((element) => {
    const selection = window.getSelection();
    let current = selection?.anchorNode instanceof Element
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    while (current?.parentElement && current.parentElement !== element) {
      current = current.parentElement;
    }
    return current ? Array.from(element.children).indexOf(current) : -1;
  });
  expect(caretBlockIndex).toBe(1);

  await page.keyboard.type("NEXT");
  await expect(editor.locator(":scope > *").nth(1)).toContainText("NEXT");

  await editor.evaluate((element) => {
    const laterBlock = element.children.item(2);
    if (!laterBlock) throw new Error("뒤쪽 문단을 찾지 못했습니다.");
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(laterBlock);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("Enter");
  await expect.poll(() => editor.evaluate((element) => element.children.length))
    .toBe(initialBlockCount + 2);
  await expect(page.getByTestId("collaboration-repair-count")).toHaveText("0");

  const laterCaretBlockIndex = await editor.evaluate((element) => {
    const selection = window.getSelection();
    let current = selection?.anchorNode instanceof Element
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    while (current?.parentElement && current.parentElement !== element) {
      current = current.parentElement;
    }
    return current ? Array.from(element.children).indexOf(current) : -1;
  });
  expect(laterCaretBlockIndex).toBe(3);

  await page.keyboard.type("LATER");
  await expect(editor.locator(":scope > *").nth(3)).toContainText("LATER");
});

test("keeps large collaborative cut and paste responsive and undoable", async ({ context, page }) => {
  test.setTimeout(180_000);
  await context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: "http://localhost:3100" },
  );
  await page.goto("/dev/collaboration-e2e");
  await expect(page.getByTestId("collaboration-ready")).toHaveText("ready");
  await page.getByTestId("collaboration-load-performance-document").evaluate((element) => {
    (element as HTMLButtonElement).click();
  });

  const editor = page.getByRole("textbox", { name: "협업 선택 테스트" });
  await expect(editor).toContainText("PERF-BLOCK-0945", { timeout: 120_000 });
  await editor.click();
  await page.keyboard.press("Control+A");

  const cutStartedAt = Date.now();
  await page.keyboard.press("Control+X");
  await expect(editor).not.toContainText("PERF-BLOCK-0945", { timeout: 120_000 });
  const cutElapsedMs = Date.now() - cutStartedAt;
  expect(cutElapsedMs).toBeLessThan(2_500);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("PERF-BLOCK-0945");

  await page.keyboard.press("Control+Z");
  await expect(editor).toContainText("PERF-BLOCK-0945", { timeout: 120_000 });
  await page.keyboard.press("Control+Y");
  await expect(editor).not.toContainText("PERF-BLOCK-0945", { timeout: 120_000 });

  const pasteStartedAt = Date.now();
  await page.keyboard.press("Control+V");
  await expect(editor).toContainText("PERF-BLOCK-0945", { timeout: 120_000 });
  const pasteElapsedMs = Date.now() - pasteStartedAt;
  expect(pasteElapsedMs).toBeLessThan(2_500);

  await page.keyboard.press("Control+Z");
  await expect(editor).not.toContainText("PERF-BLOCK-0945", { timeout: 120_000 });
  await expect(page.getByTestId("collaboration-repair-count")).toHaveText("0");

  const externalPasteElapsedMs = await editor.evaluate((element) => {
    element.focus();
    document.execCommand("selectAll");
    const rows = Array.from({ length: 945 }, (_, index) => (
      `EXTERNAL-PERF-${String(index + 1).padStart(4, "0")} `
      + "외부 문서 대량 붙여넣기 성능 측정 문장입니다. ".repeat(5)
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
  });
  expect(externalPasteElapsedMs).toBeLessThan(2_500);
  await expect(editor).toContainText("EXTERNAL-PERF-0945", { timeout: 120_000 });
  await expect(editor.locator("strong").first()).toContainText("EXTERNAL-PERF-0001");
  await page.keyboard.press("Control+Z");
  await expect(editor).not.toContainText("EXTERNAL-PERF-0945", { timeout: 120_000 });

  await page.getByTestId("collaboration-load-performance-document").evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(editor).toContainText("PERF-BLOCK-0945", { timeout: 120_000 });
  await editor.evaluate((element) => {
    const blocks = element.querySelectorAll('[data-slate-node="element"]');
    const first = blocks[0];
    const last = blocks[599];
    if (!first || !last) throw new Error("Expected at least 600 document blocks");
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const partialCutStartedAt = Date.now();
  await page.keyboard.press("Control+X");
  await expect(editor).not.toContainText("PERF-BLOCK-0600", { timeout: 120_000 });
  await expect(editor).toContainText("PERF-BLOCK-0601", { timeout: 120_000 });
  expect(Date.now() - partialCutStartedAt).toBeLessThan(2_500);
  await page.keyboard.press("Control+Z");
  await expect(editor).toContainText("PERF-BLOCK-0600", { timeout: 120_000 });
});

test("keeps the collaborative table caret while coalescing parent rerenders", async ({ page }) => {
  await page.goto("/dev/collaboration-e2e");
  await expect(page.getByTestId("collaboration-ready")).toHaveText("ready");
  const editor = page.getByRole("textbox", { name: "협업 선택 테스트" });
  await expect(editor.getByRole("table")).toBeVisible();

  const targetCells = [
    "collaboration-e2e-cell-1-1",
    "collaboration-e2e-cell-2-3",
    "collaboration-e2e-cell-3-2",
    "collaboration-e2e-cell-4-4",
  ];
  for (const [index, cellId] of targetCells.entries()) {
    await focusTableCellEnd(page, cellId);
    await page.keyboard.insertText(` 한글${index}ABC`);
    await expect.poll(() => selectedTableCellId(page)).toBe(cellId);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText("Z");
    await expect.poll(() => selectedTableCellId(page)).toBe(cellId);
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(`다음줄${index}`);
    await expect.poll(() => selectedTableCellId(page)).toBe(cellId);
    await expect(editor).toBeFocused();
  }

  await expect.poll(async () => Number(
    await page.getByTestId("collaboration-change-count").textContent(),
  )).toBeGreaterThanOrEqual(1);
  expect(Number(
    await page.getByTestId("collaboration-change-count").textContent(),
  )).toBeLessThan(20);
  await expect(page.getByTestId("collaboration-repair-count")).toHaveText("0");
});

test("moves between collaborative table cells only for explicit Tab navigation", async ({ page }) => {
  await page.goto("/dev/collaboration-e2e");
  await expect(page.getByTestId("collaboration-ready")).toHaveText("ready");
  const firstCell = "collaboration-e2e-cell-2-1";
  const nextCell = "collaboration-e2e-cell-2-2";
  await focusTableCellEnd(page, firstCell);

  const deterministicActions = [
    "insert", "left", "insert", "right", "backspace", "insert",
    "enter", "insert", "left", "right", "insert", "backspace",
  ] as const;
  for (let round = 0; round < 5; round += 1) {
    for (const action of deterministicActions) {
      if (action === "insert") await page.keyboard.insertText(String(round));
      if (action === "left") await page.keyboard.press("ArrowLeft");
      if (action === "right") await page.keyboard.press("ArrowRight");
      if (action === "backspace") await page.keyboard.press("Backspace");
      if (action === "enter") await page.keyboard.press("Shift+Enter");
      await expect.poll(() => selectedTableCellId(page)).toBe(firstCell);
    }
  }

  await page.keyboard.press("Tab");
  await expect.poll(() => selectedTableCellId(page)).toBe(nextCell);
  await page.keyboard.insertText("TAB_TARGET");
  await expect(page.locator(`[data-table-cell-id="${nextCell}"]`)).toContainText("TAB_TARGET");
});

test("keeps the collaborative table caret through a Korean IME composition", async ({ context, page }) => {
  await page.goto("/dev/collaboration-e2e");
  await expect(page.getByTestId("collaboration-ready")).toHaveText("ready");
  const cellId = "collaboration-e2e-cell-4-1";
  await focusTableCellEnd(page, cellId);

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

  await expect(page.locator(`[data-table-cell-id="${cellId}"]`)).toContainText("한글");
  await expect.poll(() => selectedTableCellId(page)).toBe(cellId);
  await page.keyboard.insertText(" 입력 계속");
  await expect.poll(() => selectedTableCellId(page)).toBe(cellId);
  await expect(page.getByTestId("collaboration-repair-count")).toHaveText("0");
});

test("keeps the collaborative table caret when an agent-style document replacement arrives", async ({ page }) => {
  await page.goto("/dev/collaboration-e2e");
  await expect(page.getByTestId("collaboration-ready")).toHaveText("ready");
  const cellId = "collaboration-e2e-cell-3-3";
  await focusTableCellEnd(page, cellId);
  await page.keyboard.insertText(" LOCAL_EDIT");
  await expect.poll(() => selectedTableCellId(page)).toBe(cellId);

  await page.getByTestId("collaboration-remote-replace").evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(page.getByRole("textbox", { name: "협업 선택 테스트" }))
    .toContainText("표 다음 문단 · 원격 갱신");
  await expect.poll(() => selectedTableCellId(page)).toBe(cellId);
  await page.keyboard.insertText(" AFTER_REMOTE");
  await expect(page.locator(`[data-table-cell-id="${cellId}"]`))
    .toContainText("AFTER_REMOTE");
});

test("records a content-free bug code from the global document menu", async ({ page }) => {
  let requestBody: Record<string, unknown> | null = null;
  await page.route("**/api/bug-reports", async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        report: {
          code: "BUG-20260730-E2E000000001",
          createdAt: "2026-07-30T12:00:00.000Z",
          expiresAt: "2026-08-29T12:00:00.000Z",
        },
      }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  const editor = page.getByRole("textbox", { name: "리비전 동작 검증 공유 초안" });
  await editor.click();
  await page.keyboard.insertText("NEVER_STORE_THIS_SENTINEL");
  await page.getByRole("button", { name: "버그 기록", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "문제 기록" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("어떤 문제가 있었나요?").selectOption("editor_caret");
  await dialog.getByLabel(/어떤 현상이었나요/).fill("표에서 예상하지 못한 위치로 이동했습니다.");
  await dialog.getByRole("button", { name: "버그 기록", exact: true }).click();

  await expect(dialog.getByText(/BUG-20260730-E2E000000001/)).toBeVisible();
  expect(requestBody).not.toBeNull();
  expect(requestBody).toMatchObject({
    documentId: "document-e2e",
    trigger: "manual",
    category: "editor_caret",
    reasonCode: "manual_report",
  });
  const serialized = JSON.stringify(requestBody);
  expect(serialized).not.toContain("NEVER_STORE_THIS_SENTINEL");
  expect(serialized).not.toContain("userAgent");
  expect(serialized).not.toContain("requestBody");
  expect(serialized).not.toContain("http://");
  expect(serialized).not.toContain("https://");
});

test("uploads only explicitly selected bug report images as multipart bytes", async ({ page }) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  let requestContentType = "";
  let requestBody: Buffer | null = null;
  await page.route("**/api/bug-reports", async (route) => {
    requestContentType = route.request().headers()["content-type"] ?? "";
    requestBody = route.request().postDataBuffer();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        report: {
          code: "BUG-20260805-E2E000000002",
          createdAt: "2026-08-05T12:00:00.000Z",
          expiresAt: "2026-09-04T12:00:00.000Z",
        },
      }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: "버그 기록", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "문제 기록" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "save-error.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(dialog.getByAltText("save-error.png")).toBeVisible();
  await dialog.getByRole("button", { name: "버그 기록", exact: true }).click();

  await expect(dialog.getByText(/BUG-20260805-E2E000000002/)).toBeVisible();
  expect(requestContentType).toContain("multipart/form-data; boundary=");
  expect(Buffer.isBuffer(requestBody)).toBe(true);
  const submittedBody = requestBody as unknown as Buffer;
  expect(submittedBody.indexOf(png)).toBeGreaterThanOrEqual(0);
  expect(submittedBody.toString("utf8")).not.toContain("data:image");
});

test("keeps the top document menu on one line and drag-scrolls it when space is narrow", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.addInitScript(() => {
    window.localStorage.setItem("nyxdoc:workspace-sidebar-width", "360");
  });
  await page.goto("/dev/workspace-e2e");

  const menu = page.getByRole("group", { name: "문서 메뉴" });
  await expect(menu).toBeVisible();
  await expect(menu.locator('select[aria-label="문서 위치"]')).toHaveCount(0);
  const before = await menu.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    scrollLeft: element.scrollLeft,
    whiteSpace: getComputedStyle(element).whiteSpace,
    childHeights: Array.from(element.children).map(
      (child) => child.getBoundingClientRect().height,
    ),
    childFlexShrink: Array.from(element.children).map(
      (child) => getComputedStyle(child).flexShrink,
    ),
  }));
  expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);
  expect(before.scrollLeft).toBe(0);
  expect(before.whiteSpace).toBe("nowrap");
  expect(before.childHeights.every((height) => height <= 42)).toBe(true);
  expect(before.childFlexShrink.every((value) => value === "0")).toBe(true);

  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 170, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => menu.evaluate((element) => element.scrollLeft)).toBeGreaterThan(80);
  await expect(page.getByRole("dialog", { name: "새 문서 만들기" })).toHaveCount(0);

  const history = page.getByRole("button", { name: /변경 기록.*리비전 2/ });
  await history.click();
  const historyPanel = page.getByRole("complementary", { name: "변경 기록" });
  await expect(historyPanel).toBeVisible();
  await expect(historyPanel.getByText("리비전 동작 검증", { exact: true })).toBeVisible();
  const panelOverflow = await historyPanel.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(panelOverflow.scrollWidth).toBeLessThanOrEqual(panelOverflow.clientWidth);
  await historyPanel.getByRole("button", { name: "변경 기록 닫기" }).click();
  await expect(historyPanel).toBeHidden();
});

test("creates a document task from a one-line request and keeps agent execution details structured", async ({ page }) => {
  let createBody: Record<string, unknown> | null = null;
  const createdTask = {
    id: "task-created-e2e",
    workspaceId: "workspace-e2e",
    title: "배포 절차의 빠진 단계를 보강해줘",
    description: "",
    acceptanceCriteria: "",
    attachments: [],
    status: "ready",
    priority: "normal",
    progress: 0,
    targetDocumentId: "document-e2e",
    targetDocumentTitle: "리비전 동작 검증",
    targetDocumentPath: [{ id: "document-e2e", title: "리비전 동작 검증" }],
    assignedAgentId: "00000000-0000-4000-8000-0000000000a1",
    assignedAgentDisplayName: "Admin Agent",
    assignedAgentAvatarMediaId: null,
    requiresReview: true,
    blocker: null,
    resultSummary: null,
    resultDocumentId: null,
    resultDocumentTitle: null,
    resultRevisionId: null,
    resultRevisionNumber: null,
    createdBy: { type: "human", id: "user-e2e", label: "Revision E2E" },
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: "2026-07-19T01:00:00.000Z",
    updatedAt: "2026-07-19T01:00:00.000Z",
    version: 1,
  };
  const uploadedMediaIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  let uploadIndex = 0;
  await page.route("**/api/media", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    const mediaId = uploadedMediaIds[uploadIndex++];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        media: {
          id: mediaId,
          url: `/api/media/${mediaId}`,
          mimeType: "image/png",
          byteSize: 24,
          createdAt: "2026-07-20T00:00:00.000Z",
          originalFilename: `todo-${uploadIndex}.png`,
        },
      }),
    });
  });
  await page.route("**/api/media/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });

  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ task: createdTask }),
    });
  });
  await page.route("**/api/tasks?limit=200", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tasks: [createdTask], total: 1, nextOffset: null }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  await expect(page.getByRole("button", { name: "Agent To-do 1개" })).toBeVisible();
  await page.getByRole("button", { name: "Agent To-do 빠르게 추가" }).click();

  const dialog = page.getByRole("dialog", { name: "Agent To-do" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "새 Agent To-do" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "To-do", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "진행 중", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "확인 필요", exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "담당 에이전트" }))
    .toHaveValue("00000000-0000-4000-8000-0000000000a1");
  await expect(dialog.getByRole("combobox", { name: "담당 에이전트" }))
    .toContainText("Admin Agent · 사용자 지정 권한");

  await dialog.getByRole("button", { name: "대상 문서 선택" }).click();
  const documentTree = dialog.getByRole("tree", { name: "대상 문서 선택 트리" });
  await expect(documentTree).toBeVisible();
  await expect(documentTree.getByRole("treeitem", { name: /워크스페이스 전체 · 새 문서 작성/ }))
    .toBeVisible();
  await documentTree.getByRole("button", {
    name: "탐색 상태 검증 문서 01 하위 문서 펼치기",
  }).click();
  await expect(documentTree.getByRole("button", { name: /탐색 상태 검증 문서 02/ }))
    .toBeVisible();
  await page.keyboard.press("Escape");

  await dialog.getByRole("textbox", { name: "무엇을 해두면 좋을까요?" })
    .fill("배포 절차의 빠진 단계를 보강해줘");
  const description = dialog.getByPlaceholder("배경이나 지켜야 할 방향을 적어주세요.");
  const acceptance = dialog.getByPlaceholder("어떤 상태가 되면 완료인지 적어주세요.");
  for (const target of [description, acceptance]) {
    await target.evaluate((element) => {
      const bytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      ]);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "todo-clipboard.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
    });
  }
  await expect(dialog.getByText("todo-1.png")).toBeVisible();
  await expect(dialog.getByText("todo-2.png")).toBeVisible();
  await dialog.getByRole("button", { name: "작업 추가" }).click();

  await expect.poll(() => createBody).toMatchObject({
    title: "배포 절차의 빠진 단계를 보강해줘",
    targetDocumentId: "document-e2e",
    assignedAgentId: "00000000-0000-4000-8000-0000000000a1",
    requiresReview: true,
    attachments: [
      {
        mediaId: uploadedMediaIds[0],
        field: "description",
      },
      {
        mediaId: uploadedMediaIds[1],
        field: "acceptance_criteria",
      },
    ],
  });
  await expect(dialog.getByRole("textbox", { name: "작업 제목" }))
    .toHaveValue("배포 절차의 빠진 단계를 보강해줘");
  await expect(dialog.getByRole("combobox", { name: "담당 에이전트" }))
    .toHaveValue("00000000-0000-4000-8000-0000000000a1");
  await expect(dialog.getByText("To-do", { exact: true }).first()).toBeVisible();
});

test("keeps document tree width, expansion, and scroll across a document shell remount", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    window.localStorage.setItem("nyxdoc:workspace-sidebar-width", "360");
  });
  await page.goto("/dev/workspace-e2e?active=document-navigation-48");
  await page.evaluate(() => {
    window.sessionStorage.removeItem(
      "nyxdoc:document-tree:user-e2e:workspace-e2e:workspace:scroll-top",
    );
  });
  await page.reload();

  const separator = page.getByRole("separator", { name: "문서 목록 너비 조절" });
  const tree = page.getByRole("navigation", { name: "문서 트리" }).first();
  const parentToggle = page.getByRole("button", { name: "탐색 상태 검증 문서 01 펼치기" });
  await expect(separator).toHaveAttribute("aria-valuenow", "360");
  await parentToggle.click();
  await expect(page.getByRole("button", { name: "탐색 상태 검증 문서 01 접기" }))
    .toHaveAttribute("aria-expanded", "true");

  const beforeReload = await tree.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return {
      scrollTop: element.scrollTop,
      maximum: element.scrollHeight - element.clientHeight,
    };
  });
  expect(beforeReload.scrollTop).toBeGreaterThan(100);
  await expect.poll(() => page.evaluate(() =>
    Number(window.sessionStorage.getItem(
      "nyxdoc:document-tree:user-e2e:workspace-e2e:workspace:scroll-top",
    )),
  )).toBe(beforeReload.scrollTop);

  await page.reload();

  await expect(separator).toHaveAttribute("aria-valuenow", "360");
  await expect(page.getByRole("button", { name: "탐색 상태 검증 문서 01 접기" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(
    Math.max(0, beforeReload.maximum - 2),
  );
});

test("moves a document branch inside another document from the tree", async ({ page }) => {
  let moveBody: unknown = null;
  const targetDocument = {
    id: "document-navigation-01",
    title: "탐색 상태 검증 문서 01",
    slug: "navigation-1",
    status: "active",
    parentDocumentId: null,
    treeOrder: 100,
    revisionId: "revision-navigation-1",
    revisionNumber: 1,
    documentType: "test",
    workflowStatus: "draft",
    tags: [],
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T01:00:00.000Z",
  };
  const movedDocument = {
    ...targetDocument,
    id: "document-navigation-06",
    title: "탐색 상태 검증 문서 06",
    slug: "navigation-6",
    parentDocumentId: targetDocument.id,
    treeOrder: 600,
    revisionId: "revision-navigation-6-moved",
    revisionNumber: 2,
  };
  await page.route("**/api/documents/document-navigation-06/reorder", async (route) => {
    moveBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        documentId: movedDocument.id,
        parentDocumentId: targetDocument.id,
        targetDocumentId: targetDocument.id,
        position: "inside",
        treeOrder: movedDocument.treeOrder,
        orderedDocumentIds: [movedDocument.id],
        eventCursor: 21,
        unchanged: false,
        documents: [targetDocument, movedDocument],
      }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  const tree = page.getByRole("navigation", { name: "문서 트리" }).first();
  const source = tree.locator('[data-document-id="document-navigation-06"]');
  const target = tree.locator('[data-document-id="document-navigation-01"]');
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  const sourcePoint = {
    x: (sourceBox?.x ?? 0) + Math.min(120, Math.max(20, (sourceBox?.width ?? 200) / 2)),
    y: (sourceBox?.y ?? 0) + (sourceBox?.height ?? 38) / 2,
  };
  const targetPoint = {
    x: (targetBox?.x ?? 0) + Math.min(120, Math.max(20, (targetBox?.width ?? 200) / 2)),
    y: (targetBox?.y ?? 0) + (targetBox?.height ?? 38) / 2,
  };
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x + 10, sourcePoint.y, { steps: 4 });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
  await page.mouse.up();

  await expect.poll(() => moveBody).toEqual({
    targetDocumentId: "document-navigation-01",
    position: "inside",
  });
  await expect(page.getByRole("button", { name: "탐색 상태 검증 문서 01 접기" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByText("탐색 상태 검증 문서 06", { exact: true })).toBeVisible();
  const [targetIndent, sourceIndent] = await Promise.all([
    target.evaluate((element) => Number.parseFloat((element as HTMLElement).style.paddingLeft)),
    source.evaluate((element) => Number.parseFloat((element as HTMLElement).style.paddingLeft)),
  ]);
  expect(sourceIndent).toBeGreaterThan(targetIndent);
});

test("lets a user collapse the active document path and only reveals a newly active path", async ({ page }) => {
  await page.goto("/dev/workspace-e2e?active=document-navigation-02");

  const collapse = page.getByRole("button", { name: "탐색 상태 검증 문서 01 접기" });
  const tree = page.getByRole("navigation", { name: "문서 트리" }).first();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByText("탐색 상태 검증 문서 02", { exact: true })).toBeVisible();
  await collapse.click();
  const expand = page.getByRole("button", { name: "탐색 상태 검증 문서 01 펼치기" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(tree.getByText("탐색 상태 검증 문서 02", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "탐색 상태 검증 문서 01 펼치기" }))
    .toHaveAttribute("aria-expanded", "false");

  await page.goto("/dev/workspace-e2e?active=document-navigation-03");
  await expect(page.getByRole("button", { name: "탐색 상태 검증 문서 01 접기" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByText("탐색 상태 검증 문서 03", { exact: true })).toBeVisible();
});

test("reveals and highlights a directly linked document even when its old tree path was collapsed", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nyxdoc:workspace-navigation:user-e2e:workspace-e2e",
      JSON.stringify({
        expandedDocumentIds: [],
        lastActiveDocumentId: "document-e2e",
        updatedAt: "2099-01-01T00:00:00.000Z",
      }),
    );
  });

  await page.goto("/dev/workspace-e2e?active=document-navigation-02");

  await expect(page.getByRole("button", { name: "탐색 상태 검증 문서 01 접기" }))
    .toHaveAttribute("aria-expanded", "true");
  const activeDocument = page
    .getByRole("navigation", { name: "문서 트리" })
    .first()
    .locator('[aria-current="page"]');
  await expect(activeDocument).toBeVisible();
  await expect(activeDocument).toContainText("탐색 상태 검증 문서 02");
  await expect(activeDocument).toHaveAttribute("aria-current", "page");
});

test("adds agent-created documents to the open tree without reloading the workspace", async ({ page }) => {
  let documentListReads = 0;
  const initialDocument = {
    id: "document-e2e",
    title: "현재 문서",
    slug: "current-document",
    status: "active",
    parentDocumentId: null,
    treeOrder: 100,
    revisionId: "revision-2",
    revisionNumber: 2,
    documentType: "test",
    workflowStatus: "draft",
    tags: [],
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T01:00:00.000Z",
  };
  const agentDocument = {
    ...initialDocument,
    id: "agent-created-document-e2e",
    title: "에이전트가 만든 새 문서 묶음",
    slug: "agent-created-document",
    treeOrder: 400,
    revisionId: "agent-created-revision-e2e",
    revisionNumber: 1,
    updatedAt: "2026-07-21T01:00:00.000Z",
  };
  const openParent = {
    ...initialDocument,
    id: "open-parent-e2e",
    title: "사용자가 펼친 문서",
    slug: "open-parent",
    treeOrder: 200,
  };
  const openChild = {
    ...initialDocument,
    id: "open-child-e2e",
    title: "펼친 문서의 하위 문서",
    slug: "open-child",
    parentDocumentId: openParent.id,
    treeOrder: 100,
  };
  const closedParent = {
    ...initialDocument,
    id: "closed-parent-e2e",
    title: "사용자가 닫아둔 문서",
    slug: "closed-parent",
    treeOrder: 300,
  };
  const closedChild = {
    ...initialDocument,
    id: "closed-child-e2e",
    title: "닫힌 문서의 하위 문서",
    slug: "closed-child",
    parentDocumentId: closedParent.id,
    treeOrder: 100,
  };
  const agentChild = {
    ...initialDocument,
    id: "agent-created-child-e2e",
    title: "에이전트가 만든 하위 문서",
    slug: "agent-created-child",
    parentDocumentId: agentDocument.id,
    treeOrder: 100,
    revisionId: "agent-created-child-revision-e2e",
    updatedAt: "2026-07-21T01:00:00.000Z",
  };
  const initialDocuments = [
    initialDocument,
    openParent,
    openChild,
    closedParent,
    closedChild,
  ];

  await page.addInitScript(() => {
    type Listener = EventListenerOrEventListenerObject;
    const sources: FakeEventSource[] = [];
    class FakeEventSource {
      private readonly listeners = new Map<string, Set<Listener>>();

      constructor() {
        sources.push(this);
        queueMicrotask(() => this.emit("ready", { cursor: 0 }));
      }

      addEventListener(type: string, listener: Listener) {
        const current = this.listeners.get(type) ?? new Set<Listener>();
        current.add(listener);
        this.listeners.set(type, current);
      }

      removeEventListener(type: string, listener: Listener) {
        this.listeners.get(type)?.delete(listener);
      }

      close() {
        this.listeners.clear();
      }

      emit(type: string, data: unknown) {
        const event = new MessageEvent(type, { data: JSON.stringify(data) });
        for (const listener of this.listeners.get(type) ?? []) {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        }
      }
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: FakeEventSource,
    });
    (window as typeof window & { __emitNyxdocEvent?: (type: string, data: unknown) => void })
      .__emitNyxdocEvent = (type, data) => {
        for (const source of sources) source.emit(type, data);
      };
  });
  await page.route("**/api/documents", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    documentListReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        documents: documentListReads === 1
          ? initialDocuments
          : [...initialDocuments, agentDocument, agentChild],
      }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  await expect.poll(() => documentListReads).toBe(1);
  await page.getByRole("button", { name: "사용자가 펼친 문서 펼치기" }).click();
  await expect(page.getByRole("link", { name: "펼친 문서의 하위 문서" })).toBeVisible();
  await expect(page.getByRole("link", { name: "닫힌 문서의 하위 문서" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "에이전트가 만든 새 문서 묶음" })).toHaveCount(0);
  await page.evaluate(() => {
    (window as typeof window & { __workspaceStayedOpen?: boolean }).__workspaceStayedOpen = true;
  });

  await page.evaluate(() => {
    (window as typeof window & { __emitNyxdocEvent?: (type: string, data: unknown) => void })
      .__emitNyxdocEvent?.("document-change", {
        cursor: 1,
        id: "agent-created-event-e2e",
        documentId: "agent-created-document-e2e",
        documentTitle: "에이전트가 만든 새 문서 묶음",
        revisionId: "agent-created-revision-e2e",
        revisionNumber: 1,
        eventType: "created",
        actorType: "agent",
        actorLabel: "Codex",
        actorPrincipalId: "agent-e2e",
        actorAvatarMediaId: null,
        source: "mcp",
        summary: "에이전트가 문서를 만들었습니다.",
        createdAt: "2026-07-21T01:00:00.000Z",
      });
  });

  await expect(page.getByRole("link", { name: "에이전트가 만든 새 문서 묶음" })).toBeVisible();
  await expect(page.getByRole("link", { name: "펼친 문서의 하위 문서" })).toBeVisible();
  await expect(page.getByRole("link", { name: "닫힌 문서의 하위 문서" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "에이전트가 만든 하위 문서" })).toHaveCount(0);
  expect(documentListReads).toBe(2);
  await expect(page.getByRole("article", { name: "리비전 동작 검증 본문" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __workspaceStayedOpen?: boolean }).__workspaceStayedOpen
  ))).toBe(true);
});

test("shows only deleted workspaces in the account-wide scrollable trash", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 320 });
  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: /휴지통/ }).click();

  const trash = page.getByRole("dialog", { name: "통합 휴지통" });
  await expect(trash).toBeVisible();
  await expect(trash.getByText("삭제된 운영 문서", { exact: true })).toBeVisible();
  await expect(trash.getByText("Revision E2E Workspace", { exact: true }).first()).toBeVisible();
  const workspaceSection = trash.getByRole("region", { name: "삭제된 워크스페이스" });
  await expect(workspaceSection.getByText("Archived E2E Workspace", { exact: true })).toBeVisible();
  await expect(workspaceSection.getByText("Revision E2E Workspace", { exact: true })).toHaveCount(0);
  await expect(workspaceSection.getByRole("button", { name: "휴지통으로 이동" })).toHaveCount(0);

  const scrollRegion = trash.getByRole("region", { name: "통합 휴지통 목록" });
  await expect.poll(() => scrollRegion.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))).toMatchObject({
    clientHeight: expect.any(Number),
    scrollHeight: expect.any(Number),
  });
  const overflow = await scrollRegion.evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
  expect(overflow).toBeGreaterThan(0);
  await scrollRegion.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const deletedWorkspace = trash.locator("article").filter({
    hasText: "Archived E2E Workspace",
  });
  await deletedWorkspace.getByRole("button", { name: "영구 삭제" }).click();
  const purge = page.getByRole("dialog", { name: "워크스페이스를 영구 삭제할까요?" });
  await expect(purge.getByText(/전체 데이터와 미디어 백업을 먼저 만든 뒤 삭제/)).toBeVisible();
  await expect(purge.getByRole("button", { name: "백업 후 영구 삭제" })).toBeDisabled();
});

test("saves a new document without a title as 제목 없는 문서", async ({ page }) => {
  let createRequest: Record<string, unknown> | null = null;
  await page.route("**/api/documents", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createRequest = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ unchanged: false }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: "최상위 문서 만들기" }).first().click();

  const editor = page.getByRole("dialog", { name: "새 문서 만들기" });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "문서 이름" })).toHaveValue("");
  const save = editor.getByRole("button", { name: /저장/ });
  await expect(save).toBeEnabled();
  await save.click();

  await expect.poll(() => createRequest?.title).toBe("제목 없는 문서");
  await expect(editor).toBeHidden();
});
