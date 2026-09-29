import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { authenticateHardeningOwner, installBrowserErrorGuard } from "./helpers";

type JsonObject = Record<string, unknown>;

function apiResponse(page: Page, method: string, path: RegExp) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === method && path.test(new URL(response.url()).pathname);
  });
}

function agentCard(page: Page, agentName: string) {
  return page.getByRole("article").filter({
    has: page.getByText(agentName, { exact: true }),
  }).first();
}

async function attachExchange(
  testInfo: TestInfo,
  name: string,
  request: JsonObject,
  response: JsonObject,
) {
  const safeResponse = { ...response };
  if ("token" in safeResponse) safeResponse.token = safeResponse.token ? "[REDACTED]" : null;
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify({ request, response: safeResponse }, null, 2), "utf8");
  await testInfo.attach(name, { path, contentType: "application/json" });
}

async function captureDialog(
  page: Page,
  dialog: Locator,
  testInfo: TestInfo,
  fileName: string,
) {
  const path = testInfo.outputPath(fileName);
  await dialog.screenshot({
    path,
    mask: [dialog.locator("code")],
  });
  await testInfo.attach(fileName, { path, contentType: "image/png" });
}

async function advanceIdentityAndAccess(
  dialog: Locator,
  agentName: string,
  documentTitle?: string,
) {
  await dialog.getByText(agentName, { exact: true }).click();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();

  const writer = dialog.getByRole("radio", { name: /문서 작업/ });
  await expect(writer).toBeChecked();

  if (documentTitle) {
    const scope = dialog.getByRole("button", {
      name: "새 에이전트가 접근할 문서 범위",
    });
    await scope.click();
    const document = dialog.getByRole("treeitem").filter({ hasText: documentTitle }).last();
    await expect(document).toBeVisible();
    await document.click();
    await expect(scope).toContainText(documentTitle);
  }

  await dialog.getByRole("button", { name: "다음", exact: true }).click();
}

test("qualifies new-key and existing-key workspace agent connection paths against the real backend", async ({ page }, testInfo) => {
  const browserErrors = installBrowserErrorGuard(page, "agent-connection");
  await authenticateHardeningOwner(page);

  const workspaceSelector = page.getByRole("combobox", { name: "워크스페이스 선택" }).first();
  const workspaceId = await workspaceSelector.inputValue();
  const workspaceName = (await workspaceSelector.locator("option:checked").textContent())?.trim();
  const documentTitle = await page.getByRole("textbox", { name: "문서 이름" }).inputValue();
  expect(workspaceId).not.toBe("");
  expect(workspaceName).toBeTruthy();
  expect(documentTitle).not.toBe("");

  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const agentName = `permission-flow-${suffix}`;
  const keyName = `${agentName}-key`;

  await page.goto(`/settings/agents?workspace=${encodeURIComponent(workspaceId)}`);
  await page.getByLabel("새 에이전트 이름").fill(agentName);
  const createAgentResponse = apiResponse(page, "POST", /^\/api\/account\/agents$/);
  await page.getByRole("button", { name: "에이전트 등록", exact: true }).click();
  const created = await createAgentResponse;
  expect(created.status(), await created.text()).toBe(201);
  await expect(agentCard(page, agentName)).toBeVisible();

  await page.goto(`/settings/agents?workspace=${encodeURIComponent(workspaceId)}&connectAgent=1`);
  let dialog = page.getByRole("dialog", { name: /에 에이전트 연결$/ });
  await expect(dialog).toBeVisible();
  await advanceIdentityAndAccess(dialog, agentName, documentTitle);

  // A newly registered identity has no credential. The safe path must make a
  // new key explicit instead of selecting an incompatible or phantom key.
  await expect(dialog.getByText("새 연결 키 만들기", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /nyx_live_/ })).toHaveCount(0);
  const keyNameInput = dialog.getByRole("textbox", { name: "키 이름" });
  await expect(keyNameInput).toBeVisible();
  await keyNameInput.fill(keyName);

  const firstConnectResponse = apiResponse(page, "POST", /^\/api\/workspace-agents\/connect$/);
  await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
  const firstConnect = await firstConnectResponse;
  const firstRequest = firstConnect.request().postDataJSON() as JsonObject;
  const firstBody = await firstConnect.json() as JsonObject;
  expect(firstConnect.status(), JSON.stringify(firstBody)).toBe(201);
  expect(firstBody.code).not.toBe("INVALID_INPUT");
  expect(firstRequest).toMatchObject({
    agent: { mode: "existing" },
    accessProfile: "writer",
    rootDocumentId: expect.any(String),
    credential: { mode: "new", name: keyName, restrictToWorkspace: true },
  });
  expect(firstBody).toMatchObject({
    token: expect.stringMatching(/^nyx_live_/),
    membership: {
      accessProfile: "writer",
      rootDocumentTitle: documentTitle,
      status: "active",
    },
    credential: { name: keyName },
  });
  await attachExchange(testInfo, "new-key-exchange.json", firstRequest, firstBody);

  dialog = page.getByRole("dialog", { name: "연결이 준비됐습니다." });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("입력한 값을 확인해주세요.", { exact: true })).toHaveCount(0);
  await captureDialog(page, dialog, testInfo, "new-key-complete.png");
  await dialog.getByRole("button", { name: "완료", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/connectAgent=1/);
  await page.reload();
  await expect(page.getByRole("dialog", { name: /에 에이전트 연결$/ })).toHaveCount(0);

  // Remove only the workspace grant. The global identity and credential stay
  // registered, making a reconnect the real existing-compatible-key path.
  const connectedCard = page.locator("#workspace-agents article").filter({ has: page.getByText(agentName, { exact: true }) });
  await connectedCard.getByRole("button", { name: "권한 설정", exact: true }).click();
  const permissionDialog = page.getByRole("dialog", {
    name: `${agentName} · ${workspaceName}`,
  });
  await expect(permissionDialog).toBeVisible();
  page.once("dialog", async (confirmation) => confirmation.accept());
  const disableResponse = apiResponse(page, "PATCH", /^\/api\/workspace-agents\/[^/]+$/);
  await permissionDialog.getByRole("button", { name: "접근 제거", exact: true }).click();
  const disabled = await disableResponse;
  expect(disabled.status(), await disabled.text()).toBe(200);
  await expect(permissionDialog).toBeHidden();
  await expect(connectedCard).toBeHidden();

  await page.getByRole("button", { name: "에이전트 연결", exact: true }).click();
  dialog = page.getByRole("dialog", { name: /에 에이전트 연결$/ });
  await expect(dialog).toBeVisible();
  await advanceIdentityAndAccess(dialog, agentName);

  const existingKey = dialog.getByText(keyName, { exact: true });
  await expect(existingKey).toBeVisible();
  // The radio is associated through its wrapping label; checking the input
  // directly avoids depending on the masked key prefix in its accessible name.
  await expect(existingKey.locator("xpath=ancestor::label[1]").locator("input[type=radio]")).toBeChecked();

  const secondConnectResponse = apiResponse(page, "POST", /^\/api\/workspace-agents\/connect$/);
  await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
  const secondConnect = await secondConnectResponse;
  const secondRequest = secondConnect.request().postDataJSON() as JsonObject;
  const secondBody = await secondConnect.json() as JsonObject;
  expect(secondConnect.status(), JSON.stringify(secondBody)).toBe(201);
  expect(secondBody.code).not.toBe("INVALID_INPUT");
  expect(secondRequest).toMatchObject({
    agent: { mode: "existing" },
    accessProfile: "writer",
    rootDocumentId: null,
    credential: { mode: "existing", credentialId: expect.any(String) },
  });
  expect(secondBody).toMatchObject({
    token: null,
    membership: {
      accessProfile: "writer",
      rootDocumentId: null,
      status: "active",
    },
    credential: { name: keyName },
  });
  await attachExchange(testInfo, "existing-key-exchange.json", secondRequest, secondBody);

  dialog = page.getByRole("dialog", { name: "연결이 준비됐습니다." });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("입력한 값을 확인해주세요.", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(new RegExp(`${keyName}.*계속 사용`))).toBeVisible();
  await captureDialog(page, dialog, testInfo, "existing-key-complete.png");
  await dialog.getByRole("button", { name: "완료", exact: true }).click();

  await expect(agentCard(page, agentName)).toContainText("문서 작업");
  await expect(agentCard(page, agentName)).toContainText("모든 문서");
  await browserErrors.assertClean();
});
