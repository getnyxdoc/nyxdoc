import { expect, test } from "@playwright/test";

function isCollaborationWebSocket(rawUrl: string) {
  const path = new URL(rawUrl).pathname;
  const expectedPath = process.env.PLAYWRIGHT_COLLABORATION_PATH?.trim();
  return expectedPath ? path === expectedPath : !path.startsWith("/_next/");
}

test("qualifies real sign-up, session, collaboration, commit, and reload boundaries", async ({ context, page }) => {
  const websocketUrls = new Set<string>();
  page.on("console", (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.log(`[browser:pageerror] ${error.message}`));
  page.on("websocket", (socket) => {
    websocketUrls.add(socket.url());
    socket.on("close", () => console.log(`[browser:websocket-close] ${socket.url()}`));
    socket.on("socketerror", (error) => console.log(`[browser:websocket-error] ${socket.url()} ${error}`));
  });

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marker = `release-collaboration-${runId}`;
  const existingEmail = process.env.PLAYWRIGHT_EXISTING_EMAIL?.trim();
  const password = process.env.PLAYWRIGHT_EXISTING_PASSWORD
    ?? "Release-qualification-password-123!";

  await page.goto(existingEmail ? "/sign-in" : "/sign-up");
  if (!existingEmail) {
    await page.locator("#name").fill("Release Qualification");
  }
  await page.locator("#email").fill(existingEmail ?? `release-${runId}@example.test`);
  await page.locator("#password").fill(password);
  await page.getByRole("button", {
    name: existingEmail ? "워크스페이스 열기" : "사이트 시작하기",
  }).click();

  await expect(page).toHaveURL(/\/app(?:\?|$)/, { timeout: 30_000 });
  await expect(page.getByRole("combobox", { name: "워크스페이스 선택" }).first()).toBeVisible();

  const title = page.getByRole("textbox", { name: "문서 이름" });
  await expect(title).toBeVisible();
  await expect(title).toBeEnabled({ timeout: 30_000 });

  const editor = page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await expect.poll(
    () => [...websocketUrls].some(isCollaborationWebSocket),
    { message: "the real app must open its collaboration WebSocket" },
  ).toBe(true);

  const activeDocumentHref = await page.locator('a[aria-current="page"]').first().getAttribute("href");
  expect(activeDocumentHref).toMatch(/^\/app\?workspace=[^&]+&document=[^&]+$/);

  const observer = await context.newPage();
  const observerWebsocketUrls = new Set<string>();
  observer.on("websocket", (socket) => observerWebsocketUrls.add(socket.url()));
  await observer.goto(activeDocumentHref!);

  const observerTitle = observer.getByRole("textbox", { name: "문서 이름" });
  await expect(observerTitle).toBeEnabled({ timeout: 30_000 });
  const observerEditor = observer.locator('[data-slate-editor="true"][contenteditable="true"]').first();
  await expect(observerEditor).toBeVisible();
  await expect.poll(
    () => [...observerWebsocketUrls].some(isCollaborationWebSocket),
    { message: "the observing browser must join the same collaboration room" },
  ).toBe(true);

  await editor.evaluate((element) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type(marker);

  await expect(observerEditor).toContainText(marker, { timeout: 30_000 });
  await expect(page.getByText("초안 저장됨", { exact: true })).toHaveText("초안 저장됨", {
    timeout: 30_000,
  });

  const save = page.getByRole("button", { name: "저장", exact: true }).first();
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByText("리비전으로 저장되었습니다.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("리비전과 동일", { exact: true })).toHaveText("리비전과 동일", {
    timeout: 30_000,
  });

  await observer.reload();
  await expect(observer.getByRole("textbox", { name: "문서 이름" })).toBeEnabled({ timeout: 30_000 });
  const reloadedEditor = observer.locator('[data-slate-editor="true"][contenteditable="true"]').first();
  await expect(reloadedEditor).toContainText(marker, { timeout: 30_000 });
  await expect(observer.getByText("리비전과 동일", { exact: true })).toHaveText("리비전과 동일", {
    timeout: 30_000,
  });
});
