import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  AgentCredentialSummary,
  AgentWorkspaceMembershipSummary,
  ConnectAgentToWorkspaceInput,
  ConnectAgentToWorkspaceResult,
} from "../src/lib/agents/service";

const workspaceId = "settings-workspace-e2e";
const documentId = "00000000-0000-4000-8000-000000000006";
const agentId = "agent-test-unassigned-e2e";
const token = "nyx_live_navigation_test_only";
const wizardTitle = "James의 워크스페이스에 에이전트 연결";
const readyTitle = "연결이 준비됐습니다.";
type ConnectionRequest = Pick<ConnectAgentToWorkspaceInput, "agent" | "accessProfile" | "rootDocumentId" | "credential">;

function connectionResult(request: ConnectionRequest): ConnectAgentToWorkspaceResult {
  const createdAt = "2026-09-08T00:00:00.000Z";
  const membership: AgentWorkspaceMembershipSummary = {
    membershipId: "membership-navigation-e2e",
    agentId,
    workspaceId,
    workspaceName: "James의 워크스페이스",
    accessProfile: request.accessProfile ?? "writer",
    capabilities: ["workspace.read", "agents.read", "documents.read", "documents.create", "documents.update", "documents.commit"],
    scopeMode: "workspace",
    policyVersion: 1,
    revokedAt: null,
    status: "active",
    effectivePermissions: ["workspace.read", "agents.read", "documents.read", "documents.create", "documents.update", "documents.commit"],
    rootDocumentId: null,
    rootDocumentTitle: null,
    createdAt,
    updatedAt: createdAt,
  };
  const binding = {
    id: "binding-navigation-e2e",
    grantId: membership.membershipId,
    workspaceId,
    workspaceName: membership.workspaceName,
    status: "active" as const,
    createdAt,
    revokedAt: null,
  };
  const credential: AgentCredentialSummary | null = request.credential.mode === "later" ? null : {
    id: "credential-navigation-e2e",
    name: request.credential.mode === "new" ? request.credential.name : "test 연결 키",
    prefix: "nyx_live_navigation",
    scopes: ["documents:read", "documents:write", "documents:commit"],
    defaultWorkspaceId: workspaceId,
    workspaceIds: [workspaceId],
    ipAllowlist: [],
    lastUsedAt: null,
    lastUsedIp: null,
    expiresAt: null,
    revokedAt: null,
    createdAt,
    bindings: [binding],
  };
  return {
    agent: {
      id: agentId,
      displayName: "test",
      owner: { type: "personal", id: "settings-user-e2e", name: "James" },
      avatarMediaId: null,
      status: "active",
      deletedAt: null,
      purgeAfter: null,
      purgedAt: null,
      createdAt,
      updatedAt: createdAt,
      credentials: credential ? [credential] : [],
      memberships: [membership],
    },
    membership,
    credential,
    binding: credential ? binding : null,
    token: request.credential.mode === "new" ? token : null,
  };
}

async function mockConnection(
  page: Page,
  beforeRespond?: (request: ConnectionRequest) => Promise<void>,
) {
  const requests: ConnectionRequest[] = [];
  await page.route("**/api/workspace-agents/connect", async (route) => {
    const request = route.request().postDataJSON() as ConnectionRequest;
    requests.push(request);
    await beforeRespond?.(request);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(connectionResult(request)),
    });
  });
  return requests;
}

async function advanceToCredential(dialog: Locator) {
  await dialog.getByRole("radio", { name: /^test\s/ }).check();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /문서 작업/ })).toBeChecked();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /새 연결 키 만들기/ })).toBeChecked();
}

async function mockReturnDestination(page: Page, href: string) {
  const destination = new URL(href, "http://localhost");
  await page.route((url) => {
    const query = new URLSearchParams(url.search);
    query.delete("_rsc");
    return url.pathname === destination.pathname && query.toString() === destination.searchParams.toString();
  }, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Returned to source</title><main>Returned to source</main>",
    });
  });
}

test("carries the chosen agent and source document from assignment management into connection", async ({ page }) => {
  await page.goto(`/dev/settings-e2e?area=agents&document=${documentId}`);
  const agent = page.locator("#agent-identities").getByRole("article").filter({
    has: page.getByText("test", { exact: true }),
  });
  await agent.getByRole("button", { name: "배정·권한", exact: true }).click();
  const assignments = page.getByRole("dialog", { name: "test의 배정·권한" });
  const workspace = assignments.getByRole("article").filter({
    has: page.getByText("James의 워크스페이스", { exact: true }),
  });
  const href = await workspace.getByRole("link", { name: "연결 시작" }).getAttribute("href");
  expect(href).toBeTruthy();
  const connection = new URL(href!, page.url());
  expect(connection.pathname).toBe("/settings/agents");
  expect(connection.searchParams.get("workspace")).toBe(workspaceId);
  expect(connection.searchParams.get("connectAgent")).toBe("1");
  expect(connection.searchParams.get("agent")).toBe(agentId);
  expect(connection.searchParams.get("returnTo")).toBe(
    `/settings/agents?workspace=${workspaceId}&document=${documentId}#agent-identities`,
  );
});

test("preselects the requested available agent instead of the first available identity", async ({ page }) => {
  await page.goto(`/dev/settings-e2e?connectAgent=1&extraAgent=1&agent=${agentId}`);
  const dialog = page.getByRole("dialog", { name: wizardTitle });
  await expect(dialog.getByRole("radio", { name: /^another\s/ })).not.toBeChecked();
  await expect(dialog.getByRole("radio", { name: /^test\s/ })).toBeChecked();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "키 이름" })).toHaveValue("test 연결 키");
});

test("focuses the new connection step without disturbing entered data or focus during edits", async ({ page }) => {
  const requests = await mockConnection(page);
  await page.goto(`/dev/settings-e2e?area=workspace&connectAgent=1&agent=${agentId}`);
  const dialog = page.getByRole("dialog", { name: wizardTitle });
  const identityPrompt = dialog.getByRole("heading", { name: "누구를 이 워크스페이스에 연결할까요?", exact: true });
  const accessPrompt = dialog.getByRole("heading", { name: "이 워크스페이스에서 허용할 작업을 정해주세요.", exact: true });
  const credentialPrompt = dialog.getByRole("heading", { name: "외부 에이전트가 사용할 연결 키를 정해주세요.", exact: true });
  await expect(dialog.getByRole("button", { name: "에이전트 연결 닫기", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(accessPrompt).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("radio", { name: /문서 작업/ })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(dialog.getByRole("radio", { name: /문서 읽기/ })).toBeChecked();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(credentialPrompt).toBeFocused();

  const keyName = dialog.getByRole("textbox", { name: "키 이름", exact: true });
  await keyName.fill("단계를 왕복해도 유지할 키 이름");
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(keyName).toBeFocused();
  await dialog.getByRole("button", { name: "이전", exact: true }).click();
  await expect(accessPrompt).toBeFocused();
  await expect(dialog.getByRole("radio", { name: /문서 읽기/ })).toBeChecked();
  await dialog.getByRole("button", { name: "이전", exact: true }).click();
  await expect(identityPrompt).toBeFocused();
  await expect(dialog.getByRole("radio", { name: /^test\s/ })).toBeChecked();

  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(accessPrompt).toBeFocused();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(credentialPrompt).toBeFocused();
  await expect(keyName).toHaveValue("단계를 왕복해도 유지할 키 이름");
  await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
  const complete = page.getByRole("dialog", { name: readyTitle });
  await expect(complete.getByRole("heading", { name: readyTitle, exact: true })).toBeFocused();
  expect(requests[0]).toMatchObject({
    accessProfile: "reader",
    credential: { mode: "new", name: "단계를 왕복해도 유지할 키 이름" },
  });
});

const returnSources = [
  { name: "agent management", href: `/settings/agents?workspace=${workspaceId}&document=${documentId}#agent-identities` },
  { name: "the open document", href: `/app?workspace=${workspaceId}&document=${documentId}` },
];

for (const source of returnSources) {
  test(`returns to ${source.name} with its document context when connection is canceled`, async ({ page }) => {
    await mockReturnDestination(page, source.href);
    const params = new URLSearchParams({ connectAgent: "1", agent: agentId, returnTo: source.href });
    await page.goto(`/dev/settings-e2e?${params}`);
    const destination = new URL(source.href, page.url()).href;
    await page.getByRole("dialog", { name: wizardTitle }).getByRole("button", { name: "취소", exact: true }).click();
    await expect(page).toHaveURL(destination);
    await expect(page.getByText("Returned to source", { exact: true })).toBeVisible();
  });

  test(`returns to ${source.name} with its document context when connection is completed`, async ({ page }) => {
    const requests = await mockConnection(page);
    await mockReturnDestination(page, source.href);
    const params = new URLSearchParams({ connectAgent: "1", agent: agentId, returnTo: source.href });
    await page.goto(`/dev/settings-e2e?${params}`);
    const destination = new URL(source.href, page.url()).href;
    const dialog = page.getByRole("dialog", { name: wizardTitle });
    await advanceToCredential(dialog);
    await dialog.getByText("연결 키는 나중에 붙이기", { exact: true }).click();
    await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
    const complete = page.getByRole("dialog", { name: readyTitle });
    await expect(complete).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ agent: { mode: "existing", agentId }, credential: { mode: "later" } });
    await complete.getByRole("button", { name: "완료", exact: true }).click();
    await expect(page).toHaveURL(destination);
    await expect(page.getByText("Returned to source", { exact: true })).toBeVisible();
  });
}

test("keeps a manually opened connection on the same agent management page even with a document back-link after cancel and completion", async ({ page }) => {
  await mockConnection(page);
  await page.goto(`/dev/settings-e2e?area=agents&document=${documentId}&returnTo=%2Fapp%3Fworkspace%3Dsource#workspace-agents`);
  const settingsUrl = page.url();
  const trigger = page.getByRole("button", { name: "에이전트 연결", exact: true });
  await trigger.click();
  await page.getByRole("dialog", { name: wizardTitle }).getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(settingsUrl);

  await trigger.click();
  const dialog = page.getByRole("dialog", { name: wizardTitle });
  await advanceToCredential(dialog);
  await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
  await page.getByRole("dialog", { name: readyTitle }).getByRole("button", { name: "완료", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(settingsUrl);
  await expect(page.getByRole("heading", { name: "에이전트", exact: true })).toBeVisible();
});

for (const mode of ["new", "later"] as const) {
  test(`preserves the ${mode} key choice and custom name when revisiting identity and permissions`, async ({ page }) => {
    const requests = await mockConnection(page);
    await page.goto("/dev/settings-e2e?connectAgent=1");
    const dialog = page.getByRole("dialog", { name: wizardTitle });
    await advanceToCredential(dialog);
    await dialog.getByRole("textbox", { name: "키 이름" }).fill("내 문서 작업용 키");
    if (mode === "later") await dialog.getByText("연결 키는 나중에 붙이기", { exact: true }).click();

    await dialog.getByRole("button", { name: "이전", exact: true }).click();
    await dialog.getByRole("button", { name: "이전", exact: true }).click();
    await expect(dialog.getByRole("radio", { name: /^test\s/ })).toBeChecked();
    await dialog.getByRole("button", { name: "다음", exact: true }).click();
    await dialog.getByRole("button", { name: "다음", exact: true }).click();
    const choice = dialog.getByRole("radio", { name: mode === "later" ? /연결 키는 나중에 붙이기/ : /새 연결 키 만들기/ });
    await expect(choice).toBeChecked();

    await dialog.getByText("새 연결 키 만들기", { exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "키 이름" })).toHaveValue("내 문서 작업용 키");
    if (mode === "later") await dialog.getByText("연결 키는 나중에 붙이기", { exact: true }).click();
    await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
    await expect(page.getByRole("dialog", { name: readyTitle })).toBeVisible();
    expect(requests[0].credential).toEqual(mode === "later"
      ? { mode: "later" }
      : { mode: "new", name: "내 문서 작업용 키", restrictToWorkspace: true });
  });
}

test("contains keyboard focus and restores the opening button when Escape cancels", async ({ page }) => {
  await page.goto("/dev/settings-e2e?area=agents");
  const trigger = page.getByRole("button", { name: "에이전트 연결", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: wizardTitle });
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await dialog.getByRole("button", { name: "에이전트 연결 닫기", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  const focusAfterShiftTab = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300));
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement)), {
    message: `Focus must remain in the dialog; target after Shift+Tab: ${focusAfterShiftTab}`,
  }).toBe(true);
  await dialog.getByRole("button", { name: "다음", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Escape closes the document scope picker before cancelling the connection", async ({ page }) => {
  await page.goto("/dev/settings-e2e?area=agents");
  const trigger = page.getByRole("button", { name: "에이전트 연결", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: wizardTitle });
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  const scope = dialog.getByRole("button", { name: "새 에이전트가 접근할 문서 범위", exact: true });
  await scope.click();
  await expect(scope).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByRole("textbox", { name: "새 에이전트가 접근할 문서 범위 검색" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(scope).toHaveAttribute("aria-expanded", "false");
  await expect(scope).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("keeps pending requests and the one-time key open when Escape is pressed", async ({ page }) => {
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const requests = await mockConnection(page, () => responseGate);
  await page.goto("/dev/settings-e2e?connectAgent=1");
  const dialog = page.getByRole("dialog", { name: wizardTitle });
  await advanceToCredential(dialog);
  try {
    await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    await expect(dialog.getByRole("button", { name: "연결 중…", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    releaseResponse();
  }
  const complete = page.getByRole("dialog", { name: readyTitle });
  await expect(complete.getByText(token, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(complete.getByText(token, { exact: true })).toBeVisible();
  await complete.getByRole("button", { name: "완료", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("shows a recoverable clipboard error and allows copying the same connection again", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          attempts += 1;
          if (attempts === 1) throw new DOMException("Clipboard permission denied", "NotAllowedError");
        },
      },
    });
  });
  await mockConnection(page);
  await page.goto("/dev/settings-e2e?connectAgent=1");
  const dialog = page.getByRole("dialog", { name: wizardTitle });
  await advanceToCredential(dialog);
  await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
  const complete = page.getByRole("dialog", { name: readyTitle });
  const copy = complete.getByRole("button", { name: "연결 안내 복사", exact: true });
  await copy.click();
  await expect(complete.getByRole("alert")).toHaveText("복사하지 못했습니다. 안내를 펼쳐 직접 복사하세요.");
  await expect(complete.getByText(token, { exact: true })).toBeVisible();
  await copy.click();
  await expect(complete.getByRole("button", { name: "복사됨 · 에이전트 대화에 붙여넣으세요", exact: true })).toBeVisible();
  await expect(complete.getByRole("alert")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});


test("offers a clear CLI handoff and recovers when clipboard access is unavailable", async ({ page }) => {
  await mockConnection(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("clipboard unavailable"); } }, configurable: true });
  });
  await page.goto("/dev/settings-e2e?area=agents&connectAgent=1");
  const dialog = page.getByRole("dialog", { name: wizardTitle });
  await advanceToCredential(dialog);
  await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
  const ready = page.getByRole("dialog", { name: readyTitle });
  await ready.getByRole("radio", { name: /CLI \+ 스킬/ }).check();
  await ready.getByRole("button", { name: "연결 안내 복사", exact: true }).click();
  await expect(ready.getByRole("alert")).toContainText("직접 복사");
  const guide = ready.locator("pre").filter({ hasText: "NYXDOC_MCP_BEARER_TOKEN" });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("skills/nyxdoc/SKILL.md");
  await expect(guide).not.toContainText("Streamable HTTP 서버로 등록해");
  await expect(ready.getByRole("status")).toContainText("실제 연결은");
});
