import { expect, test, type Page } from "@playwright/test";
import type { SavedView } from "../src/lib/collaboration/types";

const viewA: SavedView = {
  id: "saved-view-e2e-1",
  name: "검토할 문서",
  query: { sort: "updated_desc", limit: 100 },
  visibility: "workspace",
  createdBy: { type: "human", id: "saved-view-user-e2e" },
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const viewB = { ...viewA, id: "saved-view-e2e-2", name: "최근 수정한 문서" };

async function openViews(page: Page) {
  await page.goto("/dev/saved-views-e2e");
  await page.getByRole("button", { name: /^저장된 보기/ }).click();
  return page.getByRole("dialog", { name: "저장된 보기", exact: true });
}

test("removes previous results while a saved view loads and allows retry after a network failure", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route(`**/api/saved-views/${viewA.id}/run`, async (route) => {
    await route.fulfill({ json: { view: viewA, documents: [], total: 0 } });
  });
  let releaseFailure = () => {};
  const responseGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  let attempts = 0;
  await page.route(`**/api/saved-views/${viewB.id}/run`, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await responseGate;
      await route.abort("failed");
      return;
    }
    await route.fulfill({ json: { view: viewB, documents: [], total: 0 } });
  });

  const dialog = await openViews(page);
  await dialog.getByRole("button", { name: /^검토할 문서 공용$/ }).click();
  await expect(dialog.getByRole("heading", { name: viewA.name, exact: true })).toBeVisible();
  const runB = dialog.getByRole("button", { name: /^최근 수정한 문서 공용$/ });
  try {
    await runB.click();
    await expect.poll(() => attempts).toBe(1);
    await expect(dialog.getByRole("status")).toHaveText("문서를 불러오는 중…");
    await expect(dialog.getByRole("heading", { name: viewA.name, exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "새 보기", exact: true })).toBeDisabled();
  } finally {
    releaseFailure();
  }

  await expect(dialog.getByRole("alert")).toHaveText("저장된 보기를 실행하지 못했습니다.");
  await expect(dialog.getByRole("heading", { name: viewA.name, exact: true })).toHaveCount(0);
  await expect(runB).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "닫기", exact: true })).toBeEnabled();
  await runB.click();
  await expect(dialog.getByRole("heading", { name: viewB.name, exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test("preserves a new saved view's conditions after a failed save and runs it after retry", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const requests: Record<string, unknown>[] = [];
  const created = { ...viewA, id: "saved-view-created-e2e", name: "나의 검토 대기", visibility: "private" as const };
  await page.route("**/api/saved-views", async (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    if (requests.length === 1) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ status: 201, json: { view: created } });
  });
  await page.route(`**/api/saved-views/${created.id}/run`, async (route) => {
    await route.fulfill({ json: { view: created, documents: [], total: 0 } });
  });

  const dialog = await openViews(page);
  await dialog.getByRole("button", { name: "새 보기", exact: true }).click();
  const name = dialog.getByRole("textbox", { name: "보기 이름", exact: true });
  const prefix = dialog.getByRole("textbox", { name: "제목 시작", exact: true });
  const visibility = dialog.getByRole("combobox", { name: "공개 범위", exact: true });
  const submit = dialog.getByRole("button", { name: "보기 저장", exact: true });
  await name.fill(created.name);
  await prefix.fill("[검토]");
  await visibility.selectOption("private");
  await submit.click();

  await expect(dialog.getByRole("alert")).toHaveText("보기를 저장하지 못했습니다.");
  await expect(name).toHaveValue(created.name);
  await expect(prefix).toHaveValue("[검토]");
  await expect(visibility).toHaveValue("private");
  await expect(submit).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeEnabled();
  await submit.click();

  await expect(dialog.getByRole("heading", { name: created.name, exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(requests).toEqual(Array(2).fill({
    name: created.name,
    visibility: "private",
    query: { titlePrefix: "[검토]", sort: "updated_desc", limit: 100 },
  }));
  expect(pageErrors).toEqual([]);
});

test("keeps a saved view usable after delete fails and clears its results after a successful retry", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (confirmation) => confirmation.accept());
  await page.route(`**/api/saved-views/${viewA.id}/run`, async (route) => {
    await route.fulfill({ json: { view: viewA, documents: [], total: 0 } });
  });
  let deleteAttempts = 0;
  await page.route(`**/api/saved-views/${viewA.id}`, async (route) => {
    expect(route.request().method()).toBe("DELETE");
    deleteAttempts += 1;
    if (deleteAttempts === 1) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });

  const dialog = await openViews(page);
  await dialog.getByRole("button", { name: /^검토할 문서 공용$/ }).click();
  await expect(dialog.getByRole("heading", { name: viewA.name, exact: true })).toBeVisible();
  const remove = dialog.getByRole("button", { name: "검토할 문서 삭제", exact: true });
  await remove.click();
  await expect(dialog.getByRole("alert")).toHaveText("보기를 삭제하지 못했습니다.");
  await expect(dialog.getByRole("heading", { name: viewA.name, exact: true })).toBeVisible();
  await expect(remove).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "닫기", exact: true })).toBeEnabled();
  await remove.click();

  await expect(dialog.getByRole("heading", { name: viewA.name, exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(deleteAttempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test("contains saved-view keyboard focus, hides the background from accessibility, and restores the launcher on Escape", async ({ page }) => {
  const dialog = await openViews(page);
  const launcher = page.getByRole("button", { name: /^저장된 보기/ });
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  // Playwright's role selector still finds native inert elements. Read the
  // browser accessibility tree to verify what assistive technology receives.
  const accessibility = await page.context().newCDPSession(page);
  try {
    const tree = await accessibility.send("Accessibility.getFullAXTree") as {
      nodes: Array<{ ignored: boolean; role?: { value: string }; name?: { value: string } }>;
    };
    expect(tree.nodes.filter((node) => !node.ignored
      && node.role?.value === "button"
      && node.name?.value.startsWith("저장된 보기"))).toEqual([]);
  } finally {
    await accessibility.detach();
  }
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  await dialog.getByRole("button", { name: "닫기", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("button").last().focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();
});

test("prevents Escape and outside dismissal during saved-view requests and closes normally when they finish", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const created = { ...viewA, id: "saved-view-pending-e2e", name: "저장 완료를 기다리는 보기" };
  let releaseRun = () => {};
  let releaseSave = () => {};
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let runRequested = false;
  let saveRequested = false;
  await page.route(`**/api/saved-views/${viewA.id}/run`, async (route) => {
    runRequested = true;
    await runGate;
    await route.fulfill({ json: { view: viewA, documents: [], total: 0 } });
  });
  await page.route("**/api/saved-views", async (route) => {
    saveRequested = true;
    await saveGate;
    await route.fulfill({ status: 201, json: { view: created } });
  });
  await page.route(`**/api/saved-views/${created.id}/run`, async (route) => {
    await route.fulfill({ json: { view: created, documents: [], total: 0 } });
  });

  const dialog = await openViews(page);
  const launcher = page.getByRole("button", { name: /^저장된 보기/ });
  try {
    await dialog.getByRole("button", { name: /^검토할 문서 공용$/ }).click();
    await expect.poll(() => runRequested).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "닫기", exact: true })).toBeDisabled();
    releaseRun();
    await expect(dialog.getByRole("heading", { name: viewA.name, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(launcher).toBeFocused();

    await launcher.click();
    await dialog.getByRole("button", { name: "새 보기", exact: true }).click();
    await dialog.getByRole("textbox", { name: "보기 이름", exact: true }).fill(created.name);
    await dialog.getByRole("button", { name: "보기 저장", exact: true }).click();
    await expect.poll(() => saveRequested).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "닫기", exact: true })).toBeDisabled();
    releaseSave();
    await expect(dialog.getByRole("heading", { name: created.name, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(launcher).toBeFocused();
  } finally {
    releaseRun();
    releaseSave();
  }
});
