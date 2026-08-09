import { expect, type Locator, type Page } from "@playwright/test";

export type CreatedDocument = {
  href: string;
  id: string;
  title: string;
};

export type BrowserErrorGuard = {
  assertClean: () => Promise<void>;
};

export async function installConsoleErrorStackProbe(page: Page) {
  await page.addInitScript(() => {
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const message = args.map((value) => String(value)).join(" ");
      if (/Maximum update depth exceeded/i.test(message)) {
        original(...args, new Error("Maximum update depth call site").stack);
        return;
      }
      original(...args);
    };
  });
}

function expectedDevelopmentBrowserNoise(text: string) {
  return /(?:\/_next\/webpack-hmr|\[Fast Refresh\]|Target page, context or browser has been closed|Execution context was destroyed, most likely because of a navigation)/u.test(text);
}

export function installBrowserErrorGuard(page: Page, label: string): BrowserErrorGuard {
  const issues: string[] = [];
  const pendingDetails = new Set<Promise<void>>();

  page.on("console", (message) => {
    console.log(`[browser:${label}:${message.type()}] ${message.text()}`);
    if (message.type() !== "error" || expectedDevelopmentBrowserNoise(message.text())) return;

    const location = message.location();
    const issueIndex = issues.push(
      `[${label}:console] ${message.text()} (${location.url || page.url()}:${location.lineNumber}:${location.columnNumber})`,
    ) - 1;
    const detailPromise = Promise.all(message.args().map(async (argument) => {
      try {
        return await argument.evaluate((value) => {
          if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
          if (typeof value === "string") return value;
          return JSON.stringify(value);
        });
      } catch {
        return "<console argument unavailable after navigation>";
      }
    })).then((details) => {
      const usefulDetails = details.filter((detail) => detail && detail !== message.text());
      if (usefulDetails.length) issues[issueIndex] += `\n${usefulDetails.join("\n")}`;
    });
    pendingDetails.add(detailPromise);
    void detailPromise.finally(() => pendingDetails.delete(detailPromise));
  });
  page.on("pageerror", (error) => {
    const detail = error.stack || `${error.name}: ${error.message}`;
    console.log(`[browser:${label}:pageerror] ${detail}`);
    if (!expectedDevelopmentBrowserNoise(detail)) issues.push(`[${label}:pageerror] ${detail}`);
  });

  return {
    assertClean: async () => {
      await page.waitForTimeout(250).catch(() => undefined);
      await Promise.allSettled([...pendingDetails]);
      expect(issues, `unexpected browser errors on ${label}`).toEqual([]);
    },
  };
}

export function activeRichEditor(page: Page) {
  return page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
}

export function documentTree(page: Page) {
  return page.getByRole("navigation", { name: "문서 트리" }).first();
}

export function captureMaximumUpdateDepthErrors(page: Page) {
  const errors: string[] = [];
  const pattern = /Maximum update depth exceeded/i;
  page.on("console", (message) => {
    if (!pattern.test(message.text())) return;
    const location = message.location();
    errors.push([
      `console.${message.type()}: ${message.text()}`,
      location.url ? `at ${location.url}:${location.lineNumber}:${location.columnNumber}` : "",
    ].filter(Boolean).join("\n"));
  });
  page.on("pageerror", (error) => {
    if (pattern.test(error.message)) errors.push(error.stack || error.message);
  });
  return errors;
}

export async function authenticateHardeningOwner(page: Page) {
  const email = process.env.PLAYWRIGHT_EXISTING_EMAIL?.trim()
    || "hardening-owner@example.test";
  const password = process.env.PLAYWRIGHT_EXISTING_PASSWORD
    ?? "Hardening-browser-password-123!";

  await page.goto("/sign-up");
  const firstOwnerButton = page.getByRole("button", { name: "사이트 시작하기" });
  if (await firstOwnerButton.count()) {
    await page.locator("#name").fill("Editor Hardening");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await expect(firstOwnerButton).toBeEnabled();
    await firstOwnerButton.click();
  } else {
    await page.goto("/sign-in");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "워크스페이스 열기" }).click();
  }

  await expect(page).toHaveURL(/\/app(?:\?|$)/, { timeout: 30_000 });
  await expect(page.getByRole("combobox", { name: "워크스페이스 선택" }).first())
    .toBeVisible();
  await expect(page.getByRole("textbox", { name: "문서 이름" }))
    .toBeEnabled({ timeout: 30_000 });
  await expect(activeRichEditor(page)).toBeVisible();
}

export async function waitForDraftState(
  page: Page,
  state: "clean" | "dirty",
) {
  const label = state === "dirty" ? "초안 저장됨" : "리비전과 동일";
  await expect(page.getByText(label, { exact: true })).toHaveText(label, {
    timeout: 30_000,
  });
}

export async function createTopLevelDocument(
  page: Page,
  title: string,
  body: string,
): Promise<CreatedDocument> {
  await page.getByRole("button", { name: "최상위 문서 만들기" }).first().click();
  const dialog = page.getByRole("dialog", { name: "새 문서 만들기" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "문서 이름" }).fill(title);

  const editor = dialog.locator('[data-slate-editor="true"][contenteditable="true"]');
  await editor.click();
  await page.keyboard.insertText(body);
  await expect(editor).toContainText(body);

  const save = dialog.getByRole("button", { name: /저장/ });
  await expect(save).toBeEnabled();
  await save.click();

  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: "문서 이름" })).toHaveValue(title, {
    timeout: 30_000,
  });
  await waitForDraftState(page, "clean");

  const activeLink = page.locator('a[aria-current="page"]').filter({ hasText: title }).first();
  await expect(activeLink).toBeVisible();
  const href = await activeLink.getAttribute("href");
  const id = activeLink.locator("xpath=ancestor::*[@data-document-id][1]");
  const documentId = await id.getAttribute("data-document-id");
  if (!href || !documentId) throw new Error(`Created document identity was missing: ${title}`);
  return { href, id: documentId, title };
}

export async function navigateThroughTree(page: Page, document: CreatedDocument) {
  const link = documentTree(page).getByRole("link", { name: document.title, exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole("textbox", { name: "문서 이름" })).toHaveValue(
    document.title,
    { timeout: 30_000 },
  );
  await expect(activeRichEditor(page)).toBeVisible();
}

export async function appendMarker(page: Page, marker: string) {
  const editor = activeRichEditor(page);
  await editor.evaluate((element) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.insertText(` ${marker}`);
  await expect(editor).toContainText(marker);
  await waitForDraftState(page, "dirty");
}

function treeRow(tree: Locator, document: CreatedDocument) {
  return tree.locator(`[data-document-id="${document.id}"]`);
}

export async function dragDocumentInside(
  page: Page,
  sourceDocument: CreatedDocument,
  targetDocument: CreatedDocument,
) {
  const tree = documentTree(page);
  const source = treeRow(tree, sourceDocument);
  const target = treeRow(tree, targetDocument);
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Document tree drag coordinates were unavailable.");

  const reorderResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/documents/${sourceDocument.id}/reorder`)
  ));
  const sourcePoint = {
    x: sourceBox.x + Math.min(120, Math.max(20, sourceBox.width / 2)),
    y: sourceBox.y + sourceBox.height / 2,
  };
  const targetPoint = {
    x: targetBox.x + Math.min(120, Math.max(20, targetBox.width / 2)),
    y: targetBox.y + targetBox.height / 2,
  };
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x + 10, sourcePoint.y, { steps: 4 });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
  await page.mouse.up();

  const response = await reorderResponse;
  expect(response.ok()).toBe(true);
  await expect(tree.getByRole("button", { name: new RegExp(`${targetDocument.title}.*접기`) }))
    .toHaveAttribute("aria-expanded", "true");
  await expect(source).toBeVisible();

  await expect.poll(async () => {
    const [targetIndent, sourceIndent] = await Promise.all([
      target.evaluate((element) => Number.parseFloat((element as HTMLElement).style.paddingLeft)),
      source.evaluate((element) => Number.parseFloat((element as HTMLElement).style.paddingLeft)),
    ]);
    return sourceIndent - targetIndent;
  }).toBeGreaterThan(0);
}

export async function commitCurrentDraft(page: Page) {
  const saveToast = page.getByText("리비전으로 저장되었습니다.", { exact: true });
  if (await saveToast.isVisible()) await expect(saveToast).toBeHidden();

  const save = page.getByRole("button", { name: "저장", exact: true }).first();
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await waitForDraftState(page, "clean");
  await expect(saveToast).toBeVisible({ timeout: 30_000 });
}
