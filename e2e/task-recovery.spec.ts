import { expect, test, type Page } from "@playwright/test";

// UI contract tests with controlled API responses, not HTTP/DB integration.
const taskA = {
  id: "task-e2e-ready",
  workspaceId: "workspace-e2e",
  workspaceName: "Revision E2E Workspace",
  workspaceSlug: "revision-e2e",
  title: "작업 A",
  description: "A에만 속하는 설명",
  acceptanceCriteria: "A 완료 조건",
  attachments: [],
  status: "ready",
  priority: "normal",
  progress: 0,
  targetDocumentId: "document-e2e",
  targetDocumentTitle: "리비전 동작 검증",
  targetDocumentPath: [{ id: "document-e2e", title: "리비전 동작 검증" }],
  assignedAgentId: null,
  assignedAgentDisplayName: null,
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
const taskB = {
  ...taskA,
  id: "task-created-recovery-e2e",
  title: "작업 B",
  description: "B에만 속하는 설명",
  acceptanceCriteria: "B 완료 조건",
};

async function addTaskB(page: Page) {
  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: "Agent To-do 빠르게 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "Agent To-do", exact: true });
  await dialog.getByRole("textbox", { name: "무엇을 해두면 좋을까요?" }).fill(taskB.title);
  await dialog.getByRole("button", { name: "작업 추가", exact: true }).click();
  return dialog;
}

test("ignores an old task response after another task is selected", async ({ page }) => {
  let releaseTaskA: () => void = () => {};
  const taskAGate = new Promise<void>((resolve) => { releaseTaskA = resolve; });
  let requestedTaskA = false;
  let savedTaskB: Record<string, unknown> | null = null;
  await page.route("**/api/tasks", async (route) => {
    await route.fulfill({ status: 201, json: { task: taskB } });
  });
  await page.route("**/api/tasks?limit=200", async (route) => {
    await route.fulfill({ json: { tasks: [taskA, taskB] } });
  });
  await page.route(`**/api/tasks/${taskA.id}`, async (route) => {
    requestedTaskA = true;
    await taskAGate;
    await route.fulfill({ json: { task: taskA, events: [] } });
  });
  await page.route(`**/api/tasks/${taskB.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      savedTaskB = route.request().postDataJSON() as Record<string, unknown>;
    }
    await route.fulfill({ json: { task: { ...taskB, ...savedTaskB }, events: [] } });
  });

  const dialog = await addTaskB(page);
  await expect(dialog.getByRole("textbox", { name: "작업 제목", exact: true })).toHaveValue(taskB.title);
  await dialog.getByRole("button", { name: /^작업 A/ }).click();
  await expect.poll(() => requestedTaskA).toBe(true);
  await expect(dialog.getByText("작업을 불러오는 중…", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "변경 저장", exact: true })).toHaveCount(0);

  await dialog.getByRole("button", { name: /^작업 B/ }).click();
  const title = dialog.getByRole("textbox", { name: "작업 제목", exact: true });
  await expect(title).toHaveValue(taskB.title);
  await title.fill("B에서 입력한 수정");

  const oldResponse = page.waitForResponse((response) => response.url().endsWith(`/api/tasks/${taskA.id}`));
  releaseTaskA();
  await (await oldResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(title).toHaveValue("B에서 입력한 수정");
  await expect(dialog.getByRole("textbox", { name: "설명", exact: true })).toHaveValue(taskB.description);
  await dialog.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect.poll(() => savedTaskB).toMatchObject({
    expectedVersion: 1,
    title: "B에서 입력한 수정",
    description: taskB.description,
    acceptanceCriteria: taskB.acceptanceCriteria,
  });
});

test("keeps a successfully created task when refreshing the list fails", async ({ page }) => {
  let creates = 0;
  let refreshes = 0;
  await page.route("**/api/tasks", async (route) => {
    creates += 1;
    await route.fulfill({ status: 201, json: { task: taskB } });
  });
  await page.route("**/api/tasks?limit=200", async (route) => {
    refreshes += 1;
    await route.abort("failed");
  });

  const dialog = await addTaskB(page);
  await expect(dialog.getByRole("textbox", { name: "작업 제목", exact: true })).toHaveValue(taskB.title);
  await expect(dialog.getByText("작업은 추가됐지만 목록을 새로 불러오지 못했습니다. 다시 추가할 필요는 없습니다.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "작업 추가", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^작업 B/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Agent To-do 닫기", exact: true })).toBeEnabled();
  expect(creates).toBe(1);
  expect(refreshes).toBe(1);
});

test("refreshes agent changes each time the task panel opens", async ({ page }) => {
  let currentTasks = [{ ...taskA, status: "completed" }, taskB];
  let listReads = 0;
  await page.route("**/api/tasks?limit=200", async (route) => {
    listReads += 1;
    await route.fulfill({ json: { tasks: currentTasks } });
  });
  await page.route("**/api/tasks/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    await route.fulfill({ json: { task: currentTasks.find((task) => task.id === id), events: [] } });
  });

  await page.goto("/dev/workspace-e2e");
  const launcher = page.getByRole("button", { name: /Agent To-do \d+개/ });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "Agent To-do", exact: true });
  await expect(dialog.getByRole("textbox", { name: "작업 제목", exact: true })).toHaveValue(taskB.title);
  await expect(dialog.getByRole("button", { name: /^작업 A/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^작업 B/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Agent To-do 닫기", exact: true }).click();

  currentTasks = [{ ...taskA, status: "completed" }, { ...taskB, status: "completed" }];
  await launcher.click();
  await expect(dialog.getByText("이 상태의 To-do가 없습니다.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "작업 제목", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Agent To-do 닫기", exact: true }).click();
  await expect(page.getByRole("button", { name: "Agent To-do 0개", exact: true })).toBeVisible();
  expect(listReads).toBe(2);
});

test("ignores a previous panel list response after creating a task", async ({ page }) => {
  let releaseOldList: () => void = () => {};
  const oldListGate = new Promise<void>((resolve) => { releaseOldList = resolve; });
  let listReads = 0;
  await page.route("**/api/tasks?limit=200", async (route) => {
    listReads += 1;
    if (listReads === 1) {
      await oldListGate;
      await route.fulfill({ json: { tasks: [taskA] } });
      return;
    }
    await route.fulfill({ json: { tasks: [taskA, taskB] } });
  });
  await page.route("**/api/tasks", async (route) => {
    await route.fulfill({ status: 201, json: { task: taskB } });
  });

  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: /Agent To-do \d+개/ }).click();
  await expect.poll(() => listReads).toBe(1);
  const dialog = page.getByRole("dialog", { name: "Agent To-do", exact: true });
  await dialog.getByRole("button", { name: "새 Agent To-do", exact: true }).click();
  await dialog.getByRole("textbox", { name: "무엇을 해두면 좋을까요?" }).fill(taskB.title);
  await dialog.getByRole("button", { name: "작업 추가", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "작업 제목", exact: true })).toHaveValue(taskB.title);
  await expect.poll(() => listReads).toBe(2);

  const oldResponse = page.waitForResponse((response) => response.url().includes("/api/tasks?limit=200"));
  releaseOldList();
  await (await oldResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(dialog.getByRole("button", { name: /^작업 B/ })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "작업 제목", exact: true })).toHaveValue(taskB.title);
});

test("keeps task navigation inside the modal and restores each opening button on Escape", async ({ page }) => {
  await page.route("**/api/tasks?limit=200", (route) => route.fulfill({ json: { tasks: [taskA] } }));
  await page.route(`**/api/tasks/${taskA.id}`, (route) => route.fulfill({ json: { task: taskA, events: [] } }));
  await page.goto("/dev/workspace-e2e");
  const launcher = page.getByRole("button", { name: /Agent To-do \d+개/ });
  const quickAdd = page.getByRole("button", { name: "Agent To-do 빠르게 추가", exact: true });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "Agent To-do", exact: true });
  const close = dialog.getByRole("button", { name: "Agent To-do 닫기", exact: true });
  await expect(close).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "작업 제목", exact: true })).toHaveValue(taskA.title);
  const accessibility = await page.context().newCDPSession(page);
  await expect.poll(async () => {
    const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
    return nodes.filter((node) => !node.ignored
      && ["문서 이름", "Agent To-do 빠르게 추가"].includes(String(node.name?.value))).length;
  }).toBe(0);
  await accessibility.detach();

  const save = dialog.getByRole("button", { name: "변경 저장", exact: true });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(save).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();

  await quickAdd.click();
  const title = dialog.getByRole("textbox", { name: "무엇을 해두면 좋을까요?", exact: true });
  await expect(title).toBeFocused();
  await title.fill("키보드로 작성하는 요청");
  const add = dialog.getByRole("button", { name: "작업 추가", exact: true });
  await add.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(add).toBeFocused();
  const description = dialog.getByRole("textbox", { name: "설명", exact: true });
  await description.fill("입력한 설명\n두 번째 줄");
  await description.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(quickAdd).toBeFocused();
});

test("Escape closes the task document picker before closing the task modal", async ({ page }) => {
  await page.goto("/dev/workspace-e2e");
  const launcher = page.getByRole("button", { name: "Agent To-do 빠르게 추가", exact: true });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "Agent To-do", exact: true });
  const picker = dialog.getByRole("button", { name: "대상 문서 선택", exact: true });
  await picker.click();
  await expect(dialog.getByRole("textbox", { name: "대상 문서 선택 검색", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await expect(picker).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();
});

for (const operation of ["create", "upload"] as const) {
  test(`keeps the task modal open during a pending ${operation} and restores Escape after failure`, async ({ page }) => {
    let releaseRequest = () => {};
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    let requests = 0;
    await page.route(operation === "create" ? "**/api/tasks" : "**/api/media", async (route) => {
      requests += 1;
      await requestGate;
      await route.abort("failed");
    });
    await page.goto("/dev/workspace-e2e");
    const launcher = page.getByRole("button", { name: "Agent To-do 빠르게 추가", exact: true });
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "Agent To-do", exact: true });
    const title = dialog.getByRole("textbox", { name: "무엇을 해두면 좋을까요?", exact: true });
    const close = dialog.getByRole("button", { name: "Agent To-do 닫기", exact: true });
    await title.fill("요청 처리 중에도 유지할 내용");
    try {
      if (operation === "create") {
        await dialog.getByRole("button", { name: "작업 추가", exact: true }).click();
      } else {
        await dialog.locator('input[type="file"]').first().setInputFiles({
          name: "task-modal-upload.png",
          mimeType: "image/png",
          buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
        });
      }
      await expect.poll(() => requests).toBe(1);
      await expect(close).toBeDisabled();
      await title.press("Escape");
      await expect(dialog).toBeVisible();
      await page.mouse.click(1, 1);
      await expect(dialog).toBeVisible();
      await expect(title).toHaveValue("요청 처리 중에도 유지할 내용");
    } finally {
      releaseRequest();
    }
    await expect(close).toBeEnabled();
    await title.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(launcher).toBeFocused();
    expect(requests).toBe(1);
  });
}
