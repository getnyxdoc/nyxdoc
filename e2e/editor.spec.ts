import { expect, test, type Locator, type Page } from "@playwright/test";

async function editorJson(page: Page) {
  const raw = await page.locator("details").filter({ hasText: "현재 Nyxdoc JSON 보기" }).locator("pre").textContent();
  if (!raw) throw new Error("Editor Lab JSON을 찾지 못했습니다.");
  return JSON.parse(raw) as {
    schemaVersion: number;
    blocks: Array<Record<string, unknown>>;
  };
}

async function editorBlock(page: Page, id: string) {
  const document = await editorJson(page);
  const block = document.blocks.find((candidate) => candidate.id === id);
  if (!block) throw new Error(`Editor Lab 블록을 찾지 못했습니다: ${id}`);
  return block;
}

function allNodeIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allNodeIds);
  if (!value || typeof value !== "object") return [];
  const node = value as { children?: unknown; id?: unknown };
  return [
    ...(typeof node.id === "string" ? [node.id] : []),
    ...allNodeIds(node.children),
  ];
}

async function selectFromStart(page: Page, block: Locator, characterCount: number) {
  await block.click({ position: { x: 18, y: 14 } });
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let index = 0; index < characterCount; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.up("Shift");
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString().length ?? 0))
    .toBe(characterCount);
}

async function focusDocumentEnd(page: Page, editor: Locator) {
  await editor.locator('[data-nyxdoc-block-id="lab-after-table"]').click({
    position: { x: 8, y: 8 },
  });
  await page.keyboard.press("End");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/dev/editor-e2e");
  await expect(page.getByTestId("editor-ready")).toHaveText("ready");
  await expect(page.getByRole("textbox", { name: "문서 본문" })).toBeVisible();
});

test("keeps the caret in the new block after Enter at the first block end", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
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
});

test("keeps the formatting toolbar on one line and drag-scrolls it on a portrait screen", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 960 });
  const toolbar = page.getByRole("toolbar", { name: "문서 서식" });
  await expect(toolbar).toBeVisible();

  const initialMetrics = await toolbar.evaluate((element) => {
    const style = getComputedStyle(element);
    const groups = Array.from(element.children) as HTMLElement[];
    return {
      clientWidth: element.clientWidth,
      cursor: style.cursor,
      flexWrap: style.flexWrap,
      overflowX: style.overflowX,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
      shrinkingGroups: groups.filter((group) => getComputedStyle(group).flexShrink !== "0").length,
    };
  });
  expect(initialMetrics.scrollWidth).toBeGreaterThan(initialMetrics.clientWidth);
  expect(initialMetrics.scrollLeft).toBe(0);
  expect(initialMetrics.cursor).toBe("grab");
  expect(initialMetrics.flexWrap).toBe("nowrap");
  expect(initialMetrics.overflowX).toBe("auto");
  expect(initialMetrics.shrinkingGroups).toBe(0);

  const bold = page.getByRole("button", { name: "굵게" });
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  const boldBox = await bold.boundingBox();
  if (!boldBox) throw new Error("서식 도구막대의 드래그 시작점을 찾지 못했습니다.");

  await page.mouse.move(
    boldBox.x + boldBox.width / 2,
    boldBox.y + boldBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    Math.max(8, boldBox.x - 190),
    boldBox.y + boldBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();

  await expect.poll(async () => toolbar.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(100);
  await expect(bold).toHaveAttribute("aria-pressed", "false");

  await toolbar.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await page.getByRole("button", { name: "키보드 단축키" }).click();
  await expect(page.getByRole("dialog", { name: "키보드 단축키" })).toBeVisible();
});

test("submits the active document with Ctrl+S instead of opening browser save", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await expect(page.getByTestId("save-shortcut-count")).toHaveText("0");

  await page.keyboard.press("Control+s");

  await expect(page.getByTestId("save-shortcut-count")).toHaveText("1");
});

test("preserves multiline input and applies paragraph and inline formatting", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  const paragraphs = editor.locator('p[data-slate-node="element"]');

  const multiline = paragraphs.nth(1);
  await multiline.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("browser regression line");

  const fontParagraph = paragraphs.nth(2);
  await fontParagraph.selectText();
  await page.waitForTimeout(50);
  await page.getByRole("combobox", { name: "글자 크기" }).selectOption("32px");

  const intro = paragraphs.nth(0);
  await selectFromStart(page, intro, 4);
  await page.getByRole("button", { name: "가운데 정렬" }).click();

  await expect.poll(async () => editorJson(page)).toMatchObject({
    schemaVersion: 2,
    blocks: expect.arrayContaining([
      expect.objectContaining({
        id: "lab-multiline",
        children: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("\nbrowser regression line") }),
        ]),
      }),
      expect.objectContaining({
        id: "lab-font-size",
        children: expect.arrayContaining([
          expect.objectContaining({ fontSize: "32px" }),
        ]),
      }),
      expect.objectContaining({ id: "lab-intro", align: "center" }),
    ]),
  });
});

test("keeps stable node IDs unique when Enter splits a paragraph", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  const paragraph = editor.locator('[data-nyxdoc-block-id="lab-multiline"]');
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("new split paragraph");

  await expect.poll(async () => {
    const document = await editorJson(page);
    return document.blocks.filter((block) => JSON.stringify(block).includes("new split paragraph"));
  }).toHaveLength(1);

  const document = await editorJson(page);
  const ids = allNodeIds(document.blocks);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter((id) => id === "lab-multiline")).toHaveLength(1);
});

test("applies inline marks, colors, and block types while preserving the block id", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  const paragraph = editor.locator('p[data-slate-node="element"]').nth(2);
  await paragraph.selectText();
  await page.waitForTimeout(50);

  for (const label of ["굵게", "기울임", "밑줄", "취소선", "인라인 코드"]) {
    await page.getByRole("button", { name: label }).click();
  }
  await page.getByLabel("글자색").fill("#2255aa");
  await page.getByLabel("배경색").fill("#fff0a8");
  await page.getByRole("combobox", { name: "문단 유형" }).selectOption("h2");

  await expect.poll(async () => editorBlock(page, "lab-font-size")).toMatchObject({
    id: "lab-font-size",
    type: "h2",
    children: expect.arrayContaining([
      expect.objectContaining({
        backgroundColor: "#fff0a8",
        bold: true,
        code: true,
        color: "#2255aa",
        italic: true,
        strikethrough: true,
        underline: true,
      }),
    ]),
  });

  await page.getByRole("combobox", { name: "문단 유형" }).selectOption("h6");
  await expect.poll(async () => editorBlock(page, "lab-font-size")).toMatchObject({
    id: "lab-font-size",
    type: "h6",
  });
});

test("creates, edits, and removes links without changing their visible text", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  const intro = editor.locator('p[data-slate-node="element"]').nth(0);
  await selectFromStart(page, intro, 4);

  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "링크 주소" }).fill("nyxdoc.com/guide");
  await page.getByRole("button", { name: "적용" }).click();

  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain(
    '"url":"https://nyxdoc.com/guide"',
  );
  await expect(page.getByRole("link", { name: "한 문서" })).toHaveAttribute(
    "href",
    "https://nyxdoc.com/guide",
  );

  await page.getByRole("link", { name: "한 문서" }).selectText();
  await page.waitForTimeout(50);
  await page.getByRole("button", { name: "링크 추가 또는 편집" }).click();
  await page.getByRole("textbox", { name: "링크 주소" }).fill("https://nyxdoc.com/updated");
  await page.getByRole("button", { name: "적용" }).click();
  await expect(page.getByRole("link", { name: "한 문서" })).toHaveAttribute(
    "href",
    "https://nyxdoc.com/updated",
  );

  await page.getByRole("button", { name: "링크 해제" }).click();
  await expect(page.getByRole("link", { name: "한 문서" })).toHaveCount(0);
  await expect.poll(async () => JSON.stringify(await editorJson(page))).not.toContain('"type":"a"');
});

test("inserts friendly internal document links with stable document identity", async ({ context, page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  const intro = editor.locator('p[data-slate-node="element"]').nth(0);
  await selectFromStart(page, intro, 4);

  await page.keyboard.press("Control+k");
  await page.getByRole("tab", { name: "내부 문서" }).click();
  await page.getByRole("textbox", { name: "내부 문서 검색" }).fill("운영");
  await page.getByRole("button", { name: /운영 안내/ }).click();
  await page.getByRole("button", { name: "적용" }).click();

  const reference = editor.locator('[data-nyxdoc-document-id="internal-guide-e2e"]');
  await expect(reference).toHaveText("운영 안내");
  await expect(reference).toHaveAttribute(
    "href",
    "/app?document=internal-guide-e2e&workspace=workspace-e2e",
  );
  await expect(reference).toHaveAttribute("target", "_blank");
  await context.route(
    "**/app?document=internal-guide-e2e&workspace=workspace-e2e",
    async (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Internal document fixture</title>",
    }),
  );
  const popupPromise = page.waitForEvent("popup");
  await reference.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/app\?document=internal-guide-e2e&workspace=workspace-e2e$/);
  await popup.close();
  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain(
    '"type":"doc_ref","documentId":"internal-guide-e2e"',
  );
});

test("uses a fetched page title when an external link has no display text", async ({ page }) => {
  await page.route("**/api/link-preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Nyxdoc 외부 가이드",
        url: "https://example.com/final-guide",
      }),
    });
  });
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  const emptyParagraph = editor.locator('p[data-slate-node="element"]').last();
  await emptyParagraph.click();

  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "링크 주소" }).fill("https://example.com/guide");
  await page.getByRole("button", { name: "적용" }).click();

  await expect(editor.getByRole("link", { name: "Nyxdoc 외부 가이드" })).toHaveAttribute(
    "href",
    "https://example.com/final-guide",
  );
});

test("auto-links a typed URL, replaces it with the page title, and Backspace restores the URL", async ({ page }) => {
  await page.route("**/api/link-preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "NAVER",
        url: "https://naver.com/",
      }),
    });
  });
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await focusDocumentEnd(page, editor);
  await page.keyboard.type("https://naver.com");
  await page.keyboard.press("Space");

  const titledLink = editor.getByRole("link", { name: "NAVER" });
  await expect(titledLink).toHaveAttribute("href", "https://naver.com/");
  await expect(page.getByText("AST v2 유효", { exact: true })).toBeVisible();
  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain(
    '"autoTitle":true',
  );

  await titledLink.evaluate((element) => {
    const parent = element.parentNode;
    const siblingIndex = parent ? Array.from(parent.childNodes).indexOf(element) : -1;
    if (!parent || siblingIndex < 0) {
      throw new Error("자동 링크 뒤의 커서 위치를 찾지 못했습니다.");
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(parent, siblingIndex + 1);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("Backspace");

  await expect(editor.getByRole("link", { name: "NAVER" })).toHaveCount(0);
  await expect(editor).toContainText("https://naver.com/");
});

test("auto-links a pasted URL and replaces it with the fetched page title", async ({ context, page }) => {
  await page.route("**/api/link-preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "NAVER",
        url: "https://naver.com/",
      }),
    });
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:3100",
  });
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await focusDocumentEnd(page, editor);
  await page.evaluate(() => navigator.clipboard.writeText("https://naver.com"));
  await page.keyboard.press("Control+v");

  await expect(editor.getByRole("link", { name: "NAVER" })).toHaveAttribute(
    "href",
    "https://naver.com/",
  );
});

test("turns a Nyxdoc document URL into an internal document reference", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await focusDocumentEnd(page, editor);
  await page.keyboard.type(
    "http://localhost:3100/app?workspace=workspace-e2e&document=internal-guide-e2e",
  );
  await page.keyboard.press("Space");

  const reference = editor.locator('[data-nyxdoc-document-id="internal-guide-e2e"]');
  await expect(reference).toHaveText("운영 안내");
  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain(
    '"sourceUrl":"http://localhost:3100/app?workspace=workspace-e2e&document=internal-guide-e2e"',
  );
});

test("supports Notion-compatible inline, block, list, duplicate, and move shortcuts", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  const multiline = editor.locator('p[data-slate-node="element"]').nth(1);
  await multiline.selectText();
  await page.waitForTimeout(50);

  for (const shortcut of [
    "Control+b",
    "Control+i",
    "Control+u",
    "Control+Shift+s",
    "Control+e",
  ]) {
    await page.keyboard.press(shortcut);
  }

  await expect.poll(async () => editorBlock(page, "lab-multiline")).toMatchObject({
    children: expect.arrayContaining([
      expect.objectContaining({
        bold: true,
        code: true,
        italic: true,
        strikethrough: true,
        underline: true,
      }),
    ]),
  });

  await focusDocumentEnd(page, editor);
  await page.keyboard.type("shortcut block");
  await expect.poll(async () => editorBlock(page, "lab-after-table")).toMatchObject({
    children: [{ text: "shortcut block" }],
    type: "p",
  });
  await page.keyboard.press("Control+Shift+Digit1");
  await expect.poll(async () => editorBlock(page, "lab-after-table")).toMatchObject({ type: "h1" });

  await page.keyboard.press("Control+Shift+Digit2");
  await expect.poll(async () => editorBlock(page, "lab-after-table")).toMatchObject({ type: "h2" });

  await page.keyboard.press("Control+Shift+Digit3");
  await expect.poll(async () => editorBlock(page, "lab-after-table")).toMatchObject({ type: "h3" });

  await page.keyboard.press("Control+Shift+Digit0");
  await page.keyboard.press("Control+Shift+Digit5");
  await expect.poll(async () => editorBlock(page, "lab-after-table")).toMatchObject({
    listStyleType: "disc",
    type: "p",
  });

  await page.keyboard.press("Control+Shift+Digit6");
  await expect.poll(async () => editorBlock(page, "lab-after-table")).toMatchObject({
    listStyleType: "decimal",
    type: "p",
  });

  await page.keyboard.press("Control+Shift+Digit4");
  await page.keyboard.press("Control+Enter");
  await expect.poll(async () => editorBlock(page, "lab-after-table")).toMatchObject({
    checked: true,
    indent: 1,
    listStyleType: "todo",
    type: "p",
  });

  await page.keyboard.press("Control+d");
  await expect.poll(async () => {
    const document = await editorJson(page);
    return document.blocks.filter((block) => JSON.stringify(block).includes("shortcut block"));
  }).toHaveLength(2);

  const beforeMove = await editorJson(page);
  const beforeIds = beforeMove.blocks
    .filter((block) => JSON.stringify(block).includes("shortcut block"))
    .map((block) => block.id);
  expect(new Set(beforeIds).size).toBe(2);

  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect.poll(async () => {
    const document = await editorJson(page);
    return document.blocks
      .filter((block) => JSON.stringify(block).includes("shortcut block"))
      .map((block) => block.id);
  }).toEqual([...beforeIds].reverse());

  await page.keyboard.press("Control+z");
  await expect.poll(async () => {
    const document = await editorJson(page);
    return document.blocks
      .filter((block) => JSON.stringify(block).includes("shortcut block"))
      .map((block) => block.id);
  }).toEqual(beforeIds);

  await page.keyboard.press("Control+y");
  await expect.poll(async () => {
    const document = await editorJson(page);
    return document.blocks
      .filter((block) => JSON.stringify(block).includes("shortcut block"))
      .map((block) => block.id);
  }).toEqual([...beforeIds].reverse());
});

test("shows only the Notion-friendly shortcuts Nyxdoc actually supports", async ({ page }) => {
  await page.getByRole("button", { name: "키보드 단축키" }).click();
  const dialog = page.getByRole("dialog", { name: "키보드 단축키" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Ctrl/⌘ S", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Ctrl/⌘ D", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Ctrl+Shift / ⌘⌥ + 0…3", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Ctrl/⌘ Alt 8", { exact: true })).toBeVisible();
  await expect(dialog.getByText("```", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/댓글·토글처럼/)).toBeVisible();
  await dialog.getByRole("button", { name: "단축키 도움말 닫기" }).click();
  await expect(dialog).toBeHidden();
});

test("keeps Markdown quote and list shortcuts flat and schema-valid", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await focusDocumentEnd(page, editor);
  await page.keyboard.type('" ');
  await page.keyboard.type("flat quote");

  await expect.poll(async () => editorBlock(page, "lab-after-table")).toMatchObject({
    type: "blockquote",
    children: [{ text: "flat quote" }],
  });

  await page.keyboard.press("Enter");
  await page.keyboard.type("+ ");
  await page.keyboard.type("plus bullet");
  await expect.poll(async () => {
    const document = await editorJson(page);
    return document.blocks.find((block) => JSON.stringify(block).includes("plus bullet"));
  }).toMatchObject({
    indent: 1,
    listStyleType: "disc",
    type: "p",
  });

  await expect(page.getByText("AST v2 유효", { exact: true })).toBeVisible();
});

test("supports list continuation and nesting", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await focusDocumentEnd(page, editor);
  await page.keyboard.type("- ");
  await page.keyboard.type("first browser list");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second browser list");
  await page.keyboard.press("Tab");

  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain('"text":"first browser list"');
  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain('"text":"second browser list"');
  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain('"indent":2');
});

test("opens and applies slash commands from an empty paragraph", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await focusDocumentEnd(page, editor);
  await page.keyboard.type("/");
  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain('"type":"slash_input"');
  await page.getByRole("combobox", { name: "슬래시 명령 검색" }).fill("구분선");
  await page.getByRole("option", { name: /구분선/ }).click();

  await expect.poll(async () => (
    JSON.stringify(await editorJson(page)).match(/"type":"hr"/g) ?? []
  ).length).toBe(1);
});

test("inserts and edits a schema-valid code block", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await focusDocumentEnd(page, editor);
  await page.getByRole("button", { name: "코드 블록 삽입" }).click();
  const codeBlock = editor.locator('pre[data-slate-node="element"]').last();
  await expect(codeBlock).toBeVisible();
  await codeBlock.click();
  await page.keyboard.type("const browserTest = true;");

  await expect.poll(async () => {
    const document = await editorJson(page);
    return document.blocks.find((block) => block.type === "code_block");
  }).toMatchObject({
    type: "code_block",
    children: [expect.objectContaining({
      type: "code_line",
      children: [{ text: "const browserTest = true;" }],
    })],
  });
  await expect(page.getByText("AST v2 유효", { exact: true })).toBeVisible();
});

test("uploads pasted images as multipart files and stores only an internal media link", async ({ page }) => {
  const mediaId = "11111111-2222-4333-8444-555555555555";
  let uploadContentType = "";
  let uploadBody: Buffer | null = null;
  await page.route("**/api/media", async (route) => {
    const request = route.request();
    uploadContentType = request.headers()["content-type"] ?? "";
    uploadBody = request.postDataBuffer();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        media: {
          id: mediaId,
          url: `/api/media/${mediaId}`,
          mimeType: "image/png",
          byteSize: 24,
          createdAt: "2026-07-13T00:00:00.000Z",
          originalFilename: "clipboard.png",
        },
      }),
    });
  });

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await focusDocumentEnd(page, editor);
  await editor.evaluate((element) => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ]);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "clipboard.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });

  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain(`"mediaId":"${mediaId}"`);
  const serialized = JSON.stringify(await editorJson(page));
  expect(serialized).toContain(`"url":"/api/media/${mediaId}"`);
  expect(serialized).not.toContain("data:image");
  expect(uploadContentType).toContain("multipart/form-data; boundary=");
  const capturedBody = uploadBody as Buffer | null;
  if (!capturedBody) throw new Error("이미지 업로드 요청 본문을 받지 못했습니다.");
  expect(capturedBody.includes(Buffer.from("clipboard.png"))).toBe(true);
  expect(capturedBody.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
});

test("selects table cells and supports add, delete, merge, split, and undo", async ({ page }) => {
  const table = page.getByRole("table");
  const firstCell = page.getByRole("cell", { name: "여러 셀 선택", exact: true });
  const secondCell = page.getByRole("cell", { name: "셀을 드래그", exact: true });
  const firstBox = await firstCell.boundingBox();
  const secondBox = await secondCell.boundingBox();
  if (!firstBox || !secondBox) throw new Error("표 셀 위치를 계산하지 못했습니다.");

  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect(page.locator('[data-table-cell-selected="true"]')).toHaveCount(2);
  await expect(page.getByRole("button", { name: "선택 셀 병합" })).toBeEnabled();
  await page.getByRole("button", { name: "선택 셀 병합" }).click();
  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain('"colSpan":2');

  await page.getByRole("button", { name: "셀 나누기" }).click();
  await expect.poll(async () => JSON.stringify(await editorJson(page))).not.toContain('"colSpan":2');

  await page.getByRole("cell", { name: "Ctrl+C / Ctrl+V", exact: true }).click();
  await expect(page.getByRole("button", { name: "아래에 행 추가" })).toBeEnabled();
  await page.getByRole("button", { name: "아래에 행 추가" }).click();
  await expect(table.getByRole("row")).toHaveCount(4);
  await page.getByRole("button", { name: "선택한 행 삭제" }).click();
  await expect(table.getByRole("row")).toHaveCount(3);

  await page.getByRole("button", { name: "오른쪽에 열 추가" }).click();
  await expect(table.getByRole("row").first().getByRole("columnheader")).toHaveCount(4);
  await page.getByRole("button", { name: "선택한 열 삭제" }).click();
  await expect(table.getByRole("row").first().getByRole("columnheader")).toHaveCount(3);

  await page.getByRole("button", { name: "표 전체 삭제" }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByRole("button", { name: "실행 취소" }).click();
  await expect(page.getByRole("table")).toHaveCount(1);
  await page.getByRole("button", { name: "다시 실행" }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
});
