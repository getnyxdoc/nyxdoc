import { expect, test, type Locator } from "@playwright/test";

// Controlled API failures test browser recovery and input retention. These
// fixtures do not stand in for persistence or authenticated integration tests.
const historicalRevision = {
  id: "revision-1",
  number: 1,
  summary: "네트워크 복구 검증",
  actorType: "human",
  actorLabel: "Revision E2E",
  source: "web",
  createdAt: "2026-07-14T00:00:00.000Z",
  content: {
    schemaVersion: 2,
    blocks: [{ id: "recovery-body", type: "p", children: [{ text: "복원할 과거 본문" }] }],
  },
};

test("retains a new document after an interrupted save and permits retry", async ({ page }) => {
  const writes: Array<Record<string, unknown>> = [];
  await page.route("**/api/documents", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes.push(route.request().postDataJSON() as Record<string, unknown>);
    if (writes.length === 1) return route.abort("failed");
    await route.fulfill({ status: 201, json: { unchanged: false } });
  });

  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: "최상위 문서 만들기", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "새 문서 만들기", exact: true });
  const title = dialog.getByRole("textbox", { name: "문서 이름", exact: true });
  const body = dialog.getByRole("textbox", { name: "편집 중인 문서 본문", exact: true });
  await title.fill("중단 후에도 남는 문서");
  await body.click();
  await page.keyboard.insertText("작성한 본문을 다시 입력하지 않아도 됩니다.");
  const save = dialog.getByRole("button", { name: /저장/ });
  await save.click();
  await expect(dialog.getByText("문서를 저장하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(title).toHaveValue("중단 후에도 남는 문서");
  await expect(body).toContainText("작성한 본문을 다시 입력하지 않아도 됩니다.");
  await expect(save).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "문서로 돌아가기", exact: true })).toBeEnabled();

  await save.click();
  await expect(dialog).toBeHidden();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[1].title).toBe("중단 후에도 남는 문서");
  expect(JSON.stringify(writes[1].content)).toContain("작성한 본문을 다시 입력하지 않아도 됩니다.");
});

test("recovers a rename dialog after its initial document read fails", async ({ page }) => {
  let reads = 0;
  let renameBody: Record<string, unknown> | null = null;
  await page.route("**/api/documents/document-e2e", async (route) => {
    if (route.request().method() === "GET") {
      reads += 1;
      if (reads === 1) return route.abort("failed");
      await route.fulfill({ json: { workingDocument: { draftVersion: 0 } } });
      return;
    }
    renameBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { document: { id: "document-e2e" } } });
  });

  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: "리비전 동작 검증 메뉴", exact: true }).click();
  await page.getByRole("menuitem", { name: "문서 이름 변경", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "문서 이름 변경", exact: true });
  const title = dialog.getByRole("textbox", { name: "문서 이름", exact: true });
  const save = dialog.getByRole("button", { name: "이름 변경", exact: true });
  await title.fill("복구 후 변경한 이름");
  await save.click();
  await expect(dialog.getByText("문서 이름을 변경하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(title).toHaveValue("복구 후 변경한 이름");
  await expect(save).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeEnabled();

  await save.click();
  await expect(dialog).toBeHidden();
  expect(reads).toBe(2);
  expect(renameBody).toMatchObject({ title: "복구 후 변경한 이름", expectedDraftVersion: 0, baseRevision: 2 });
});

test("retries revision preview and shows restoration errors inside the preview", async ({ page }) => {
  let reads = 0;
  let restores = 0;
  await page.route("**/api/documents/document-e2e/revisions/revision-1", async (route) => {
    reads += 1;
    if (reads === 1) return route.abort("failed");
    await route.fulfill({ json: { revision: historicalRevision } });
  });
  await page.route("**/api/documents/document-e2e/revisions/revision-1/restore", async (route) => {
    restores += 1;
    if (restores === 1) return route.abort("failed");
    await route.fulfill({ json: { workingDocument: { draftVersion: 1, hasUncommittedChanges: true } } });
  });

  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: /변경 기록.*리비전 2/ }).click();
  const openPreview = page.getByRole("button", { name: "리비전 1 보기", exact: true });
  await openPreview.click();
  await expect(page.getByText("이 리비전을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  await expect(openPreview).toBeEnabled();
  await openPreview.click();
  const preview = page.getByRole("dialog", { name: "리비전 1 미리보기", exact: true });
  await expect(preview.getByText("복원할 과거 본문", { exact: true })).toBeVisible();
  const restore = preview.getByRole("button", { name: "이 버전을 공유 초안으로 불러오기", exact: true });
  page.once("dialog", (dialog) => dialog.accept());
  await restore.click();
  await expect(preview.getByRole("alert")).toHaveText("이 리비전을 복원하지 못했습니다.");
  await expect(restore).toBeEnabled();
  await expect(preview.getByRole("button", { name: "리비전 미리보기 닫기", exact: true })).toBeEnabled();

  page.once("dialog", (dialog) => dialog.accept());
  await restore.click();
  await expect(preview).toBeHidden();
  expect(reads).toBe(2);
  expect(restores).toBe(2);
});

test("keeps trash actions available after an interrupted document restore", async ({ page }) => {
  let restores = 0;
  await page.route("**/api/trash/document-trashed-e2e/restore", async (route) => {
    restores += 1;
    expect(route.request().headers()["x-nyxdoc-workspace-id"]).toBe("workspace-e2e");
    if (restores === 1) return route.abort("failed");
    await route.fulfill({ json: { restoredDocumentIds: ["document-trashed-e2e"] } });
  });

  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: /휴지통/ }).click();
  const trash = page.getByRole("dialog", { name: "통합 휴지통", exact: true });
  const row = trash.locator("article").filter({ hasText: "삭제된 운영 문서" });
  const restore = row.getByRole("button", { name: "복구", exact: true });
  await restore.click();
  await expect(trash.getByText("문서를 복구하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(restore).toBeEnabled();
  await expect(trash.getByRole("button", { name: "통합 휴지통 닫기", exact: true })).toBeEnabled();
  await restore.click();
  await expect(trash.getByText("문서를 복구하지 못했습니다.", { exact: true })).toHaveCount(0);
  await expect(restore).toBeEnabled();
  expect(restores).toBe(2);
});

test("traps rename keyboard focus and preserves the dialog while its request is pending", async ({ page }) => {
  let releaseRename!: () => void;
  const pendingRename = new Promise<void>((resolve) => { releaseRename = resolve; });
  await page.route("**/api/documents/document-e2e", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { workingDocument: { draftVersion: 0 } } });
    }
    await pendingRename;
    await route.abort("failed");
  });
  await page.goto("/dev/workspace-e2e");
  const trigger = page.getByRole("button", { name: "리비전 동작 검증 메뉴", exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: "문서 이름 변경", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "문서 이름 변경", exact: true });
  const title = dialog.getByRole("textbox", { name: "문서 이름", exact: true });
  const close = dialog.getByRole("button", { name: "닫기", exact: true });
  const save = dialog.getByRole("button", { name: "이름 변경", exact: true });
  await expect(title).toBeFocused();
  await title.fill("키보드 복구 확인");
  await save.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(save).toBeFocused();
  await save.click();
  await expect(close).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue("키보드 복구 확인");
  releaseRename();
  await expect(dialog.getByText("문서 이름을 변경하지 못했습니다.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("returns focus to revision history after keyboard dismissal", async ({ page }) => {
  await page.route("**/api/documents/document-e2e/revisions/revision-1", async (route) => {
    await route.fulfill({ json: { revision: historicalRevision } });
  });
  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: /변경 기록.*리비전 2/ }).click();
  const trigger = page.getByRole("button", { name: "리비전 1 보기", exact: true });
  await trigger.click();
  const preview = page.getByRole("dialog", { name: "리비전 1 미리보기", exact: true });
  const close = preview.getByRole("button", { name: "리비전 미리보기 닫기", exact: true });
  const restore = preview.getByRole("button", { name: "이 버전을 공유 초안으로 불러오기", exact: true });
  await expect(close).toBeFocused();
  await restore.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(restore).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("dismisses only the nested workspace confirmation and restores trash focus", async ({ page }) => {
  await page.goto("/dev/workspace-e2e");
  const trigger = page.getByRole("button", { name: /휴지통/ });
  await trigger.click();
  const trash = page.getByRole("dialog", { name: "통합 휴지통", exact: true });
  const close = trash.getByRole("button", { name: "통합 휴지통 닫기", exact: true });
  await expect(close).toBeFocused();
  await trash.getByRole("button", { name: "닫기", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  const purge = trash.locator("article").filter({ hasText: "Archived E2E Workspace" })
    .getByRole("button", { name: "영구 삭제", exact: true });
  await purge.click();
  const confirmation = page.getByRole("dialog", { name: "워크스페이스를 영구 삭제할까요?", exact: true });
  const name = confirmation.getByRole("textbox");
  await expect(name).toBeFocused();
  await name.fill("Archived E2E Workspace");
  await confirmation.getByRole("button", { name: "백업 후 영구 삭제", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(name).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(trash).toBeVisible();
  await expect(purge).toBeFocused();
  await purge.click();
  await expect(name).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(trash).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("keeps the document editor open while dismissing its nested shortcut help", async ({ page }) => {
  await page.goto("/dev/workspace-e2e");
  const trigger = page.getByRole("button", { name: "최상위 문서 만들기", exact: true }).first();
  await trigger.click();
  const editor = page.getByRole("dialog", { name: "새 문서 만들기", exact: true });
  const shortcuts = editor.getByRole("button", { name: "키보드 단축키", exact: true });
  await shortcuts.click();
  const help = page.getByRole("dialog", { name: "키보드 단축키", exact: true });
  const close = help.getByRole("button", { name: "단축키 도움말 닫기", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(editor).toBeVisible();
  await editor.getByRole("textbox", { name: "문서 이름", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("closes the editor link popup before its document dialog on Escape", async ({ page }) => {
  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: "최상위 문서 만들기", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "새 문서 만들기", exact: true });
  const body = editor.getByRole("textbox", { name: "편집 중인 문서 본문", exact: true });
  await body.click();
  await page.keyboard.insertText("링크 팝업 확인");
  await editor.getByRole("button", { name: "링크 추가 또는 편집", exact: true }).click();
  const url = editor.getByRole("textbox", { name: "링크 주소", exact: true });
  await expect(url).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(url).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(body).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
});

test("applies an editor link without submitting the enclosing new document", async ({ page }) => {
  let documentWrites = 0;
  await page.route("**/api/documents", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    documentWrites += 1;
    await route.fulfill({ status: 201, json: { unchanged: false } });
  });
  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: "최상위 문서 만들기", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "새 문서 만들기", exact: true });
  await editor.getByRole("textbox", { name: "문서 이름", exact: true }).fill("링크 작성 중인 문서");
  const body = editor.getByRole("textbox", { name: "편집 중인 문서 본문", exact: true });
  await body.click();
  await page.keyboard.insertText("참고: ");
  await editor.getByRole("button", { name: "링크 추가 또는 편집", exact: true }).click();
  await editor.getByRole("textbox", { name: "링크 주소", exact: true }).fill("https://example.com/guide");
  await editor.getByRole("textbox", { name: "표시할 제목", exact: true }).fill("검증 문서");
  await editor.getByRole("button", { name: "적용", exact: true }).click();
  expect(documentWrites).toBe(0);
  await expect(body.getByRole("link", { name: "검증 문서", exact: true })).toHaveAttribute("href", "https://example.com/guide");
  await expect(editor.getByRole("textbox", { name: "링크 주소", exact: true })).toBeHidden();
  await expect(editor).toBeVisible();
  expect(documentWrites).toBe(0);
});

async function expectInsideViewport(button: Locator, width: number) {
  await expect(button).toBeVisible();
  await expect.poll(async () => {
    const box = await button.boundingBox();
    return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 900);
  }).toBe(true);
}

for (const width of [390, 900, 1280]) {
  test(`keeps Save visible while the document menu scrolls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dev/workspace-e2e");
    const save = page.getByRole("button", { name: "저장", exact: true });
    const menu = page.getByRole("group", { name: "문서 메뉴", exact: true });
    await expectInsideViewport(save, width);
    await menu.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expectInsideViewport(save, width);
    await menu.evaluate((element) => { element.scrollLeft = 0; });
    await expectInsideViewport(save, width);
    await expect(save).toHaveAccessibleName("저장");
  });
}
