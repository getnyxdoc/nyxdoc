import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, type Page } from "@playwright/test";
import {
  activeRichEditor,
  appendMarker,
  authenticateHardeningOwner,
  commitCurrentDraft,
  createTopLevelDocument,
  installBrowserErrorGuard,
  waitForDraftState,
} from "./helpers";

type JsonRecord = Record<string, unknown>;

type WorkingDocument = {
  documentId: string;
  draftVersion: number;
  committedDraftVersion: number;
  baseRevisionNumber: number;
  hasUncommittedChanges: boolean;
  content: {
    blocks: Array<{ id?: string; children?: Array<{ text?: string }> }>;
  };
};

type McpWorkingResult = {
  workingDocument: WorkingDocument;
};

type McpDocumentResult = {
  document: {
    id: string;
    revisionNumber: number;
    content: unknown;
  };
};

type McpWorkspaceResult = {
  workspaces: Array<{
    id: string;
    accessProfile: string;
    effectivePermissions: string[];
    rootDocumentId: string | null;
  }>;
};

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

function documentTextOccurrences(value: string | null, marker: string) {
  return value?.split(marker).length ? value.split(marker).length - 1 : 0;
}

async function expectMarkerExactlyOnce(page: Page, marker: string) {
  await expect.poll(
    async () => documentTextOccurrences(await activeRichEditor(page).textContent(), marker),
    { timeout: 30_000 },
  ).toBe(1);
}

async function configureAgentConnection(
  page: Page,
  input: {
    agentName: string;
    documentTitle: string;
    profile: "reader" | "writer";
    credential: "new" | "existing";
    credentialName?: string;
  },
) {
  const dialog = page.getByRole("dialog", { name: /에 에이전트 연결$/ });
  await expect(dialog).toBeVisible();
  await dialog.getByText(input.agentName, { exact: true }).click();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();

  const access = dialog.getByRole("radio", {
    name: input.profile === "writer" ? /문서 작업/ : /읽기/,
  });
  await access.locator("xpath=ancestor::label[1]").click();
  await expect(access).toBeChecked();
  const scope = dialog.getByRole("button", { name: "새 에이전트가 접근할 문서 범위" });
  await scope.click();
  const document = dialog.getByRole("treeitem").filter({ hasText: input.documentTitle }).last();
  await expect(document).toBeVisible();
  await document.click();
  await expect(scope).toContainText(input.documentTitle);
  await dialog.getByRole("button", { name: "다음", exact: true }).click();

  if (input.credential === "new") {
    await expect(dialog.getByText("새 연결 키 만들기", { exact: true })).toBeVisible();
    const credentialName = input.credentialName;
    if (!credentialName) throw new Error("A name is required when issuing an agent credential.");
    await dialog.getByRole("textbox", { name: "키 이름" }).fill(credentialName);
  } else if (input.credentialName) {
    const credential = dialog.getByText(input.credentialName, { exact: true });
    await expect(credential).toBeVisible();
    await credential.locator("xpath=ancestor::label[1]").click();
    await expect(credential.locator("xpath=ancestor::label[1]").locator("input[type=radio]"))
      .toBeChecked();
  }

  const response = apiResponse(page, "POST", /^\/api\/workspace-agents\/connect$/);
  await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();
  return response;
}

async function connectMcp(endpoint: URL, token: string, workspaceId: string, label: string) {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Nyxdoc-Workspace-Id": workspaceId,
      },
    },
  });
  const client = new Client({ name: `nyxdoc-hardening-${label}`, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function closeMcpClient(client: Client) {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    void client.close().catch(() => undefined).finally(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function readWorkingDocument(client: Client, documentId: string) {
  const result = await client.callTool({
    name: "get_working_document",
    arguments: { documentId },
  });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as McpWorkingResult;
}

async function invokeMcpGateway(
  endpoint: URL,
  token: string,
  workspaceId: string,
  request: { name: string; arguments: JsonRecord },
) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
      "X-Nyxdoc-Workspace-Id": workspaceId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: request,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    body: await response.json() as JsonRecord,
  };
}

async function expectMcpToolForbidden(
  client: Client,
  request: { name: string; arguments: JsonRecord },
) {
  const result = await client.callTool(request);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: "FORBIDDEN" });
}

test("two authenticated tabs converge one shared draft and commit exactly one canonical revision", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const firstTabErrors = installBrowserErrorGuard(page, "collaboration-first-tab");
  await authenticateHardeningOwner(page);

  const runId = `${testInfo.project.name}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const document = await createTopLevelDocument(
    page,
    `Concurrent draft ${runId}`,
    `Shared baseline ${runId}`,
  );
  const secondTab = await context.newPage();
  const secondTabErrors = installBrowserErrorGuard(secondTab, "collaboration-second-tab");
  await secondTab.goto(document.href);
  await expect(secondTab.getByRole("textbox", { name: "문서 이름" })).toHaveValue(document.title, {
    timeout: 30_000,
  });
  await expect(activeRichEditor(secondTab)).toBeVisible();
  await waitForDraftState(secondTab, "clean");

  const firstMarker = `TAB_ONE_${runId}`;
  const secondMarker = `TAB_TWO_${runId}`;
  await Promise.all([
    appendMarker(page, firstMarker),
    appendMarker(secondTab, secondMarker),
  ]);

  for (const tab of [page, secondTab]) {
    await expectMarkerExactlyOnce(tab, firstMarker);
    await expectMarkerExactlyOnce(tab, secondMarker);
  }

  // The first tab saves as soon as both CRDT peers have converged. A second
  // canonical revision here would surface as an extra history entry below.
  await commitCurrentDraft(page);
  await waitForDraftState(secondTab, "clean");

  await Promise.all([page.reload(), secondTab.reload()]);
  for (const tab of [page, secondTab]) {
    await expect(tab.getByRole("textbox", { name: "문서 이름" })).toHaveValue(document.title, {
      timeout: 30_000,
    });
    await expectMarkerExactlyOnce(tab, firstMarker);
    await expectMarkerExactlyOnce(tab, secondMarker);
    await waitForDraftState(tab, "clean");
  }

  await page.getByRole("button", { name: /변경 기록/ }).click();
  const history = page.locator("#document-history-panel");
  await expect(history).toBeVisible();
  await expect(history.locator("article")).toHaveCount(2);
  await expect(history.locator("article").filter({ has: page.getByText("2", { exact: true }) }))
    .toHaveCount(1);

  await firstTabErrors.assertClean();
  await secondTabErrors.assertClean();
});

test("a revoked agent MCP session cannot mutate and a new reader session regains only reader scope", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const browserErrors = installBrowserErrorGuard(page, "agent-revocation");
  await authenticateHardeningOwner(page);

  const runId = `${testInfo.project.name}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const document = await createTopLevelDocument(
    page,
    `Agent revocation ${runId}`,
    `Agent boundary baseline ${runId}`,
  );
  const workspaceSelector = page.getByRole("combobox", { name: "워크스페이스 선택" }).first();
  const workspaceId = await workspaceSelector.inputValue();
  expect(workspaceId).not.toBe("");

  const agentName = `revocation-agent-${runId}`;
  const credentialName = `${agentName}-key`;
  await page.goto(`/settings/agents?workspace=${encodeURIComponent(workspaceId)}`);
  await page.getByLabel("새 에이전트 이름").fill(agentName);
  const createAgent = apiResponse(page, "POST", /^\/api\/account\/agents$/);
  await page.getByRole("button", { name: "에이전트 등록", exact: true }).click();
  expect((await createAgent).status()).toBe(201);
  await expect(agentCard(page, agentName)).toBeVisible();

  await page.goto(`/settings/workspace?workspace=${encodeURIComponent(workspaceId)}&connectAgent=1`);
  const firstConnection = await configureAgentConnection(page, {
    agentName,
    documentTitle: document.title,
    profile: "writer",
    credential: "new",
    credentialName,
  });
  const firstConnectionBody = await firstConnection.json() as {
    token?: string | null;
    membership?: { accessProfile?: string; rootDocumentId?: string | null };
  };
  expect(firstConnection.status(), JSON.stringify(firstConnectionBody)).toBe(201);
  expect(firstConnectionBody).toMatchObject({
    token: expect.stringMatching(/^nyx_live_/),
    membership: { accessProfile: "writer", rootDocumentId: document.id },
  });
  const token = firstConnectionBody.token;
  if (!token) throw new Error("The newly issued agent credential was not returned once.");

  let completed = page.getByRole("dialog", { name: "연결이 준비됐습니다." });
  await expect(completed).toBeVisible();
  await completed.getByRole("button", { name: "완료", exact: true }).click();
  await expect(completed).toBeHidden();
  await expect(agentCard(page, agentName)).toBeVisible();

  const endpoint = new URL("/mcp", page.url());
  const writerClient = await connectMcp(endpoint, token, workspaceId, `writer-${runId}`);
  const deniedMarker = `REVOKED_MUTATION_${runId}`;
  try {
    const capabilityResult = await writerClient.callTool({
      name: "get_capabilities",
      arguments: {},
    });
    expect(capabilityResult.isError).not.toBe(true);
    const initialWorking = await readWorkingDocument(writerClient, document.id);
    expect(initialWorking.workingDocument).toMatchObject({
      documentId: document.id,
      hasUncommittedChanges: false,
    });
    const anchorBlockId = initialWorking.workingDocument.content.blocks[0]?.id;
    expect(anchorBlockId).toEqual(expect.any(String));
    const originalDraftVersion = initialWorking.workingDocument.draftVersion;
    const originalRevision = initialWorking.workingDocument.baseRevisionNumber;

    // The workspace owner removes the grant through the real permission UI.
    const connectedCard = agentCard(page, agentName);
    await connectedCard.getByRole("button", { name: "권한 설정", exact: true }).click();
    const permissionDialog = page.getByRole("dialog", { name: new RegExp(`${agentName}.*`) });
    await expect(permissionDialog).toBeVisible();
    page.once("dialog", async (confirmation) => confirmation.accept());
    const removeGrant = apiResponse(page, "PATCH", /^\/api\/workspace-agents\/[^/]+$/);
    await permissionDialog.getByRole("button", { name: "접근 제거", exact: true }).click();
    expect((await removeGrant).status()).toBe(200);
    await expect(connectedCard).toBeHidden();

    const deniedPatch = {
      name: "patch_document",
      arguments: {
        documentId: document.id,
        expectedDraftVersion: originalDraftVersion,
        requestId: `revoked-patch-${runId}`,
        operations: [{
          op: "insert_after",
          anchorBlockId,
          blocks: [{
            id: `revoked-block-${runId}`,
            type: "p",
            children: [{ text: deniedMarker }],
          }],
        }],
      },
    };
    const deniedCommit = {
      name: "commit_document",
      arguments: {
        documentId: document.id,
        expectedDraftVersion: originalDraftVersion,
        requestId: `revoked-commit-${runId}`,
        summary: "This must never be committed after revocation.",
      },
    };
    // Streamable HTTP is intentionally stateless in this deployment. Keep the
    // initialized writer client open, then send each operation using its same
    // issued credential: live grant validation must reject both before tool
    // dispatch, with a bounded HTTP response rather than a stale-session write.
    for (const deniedRequest of [deniedPatch, deniedCommit]) {
      const deniedResponse = await invokeMcpGateway(
        endpoint,
        token,
        workspaceId,
        deniedRequest,
      );
      expect(deniedResponse.status).toBe(401);
      expect(deniedResponse.body).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32001 },
        id: null,
      });
    }

    // Restoring the same credential through the UI deliberately grants only
    // reader scope. It creates a fresh MCP client, not an implicit revival of
    // the revoked writer session.
    await page.getByRole("button", { name: "에이전트 연결", exact: true }).click();
    const restoredConnection = await configureAgentConnection(page, {
      agentName,
      documentTitle: document.title,
      profile: "reader",
      credential: "existing",
      credentialName,
    });
    const restoredConnectionBody = await restoredConnection.json() as {
      token?: string | null;
      membership?: { accessProfile?: string; rootDocumentId?: string | null };
    };
    expect(restoredConnection.status(), JSON.stringify(restoredConnectionBody)).toBe(201);
    expect(restoredConnectionBody).toMatchObject({
      token: null,
      membership: { accessProfile: "reader", rootDocumentId: document.id },
    });
    completed = page.getByRole("dialog", { name: "연결이 준비됐습니다." });
    await expect(completed).toBeVisible();
    await completed.getByRole("button", { name: "완료", exact: true }).click();

    const readerClient = await connectMcp(endpoint, token, workspaceId, `reader-${runId}`);
    try {
      const workspaceResult = await readerClient.callTool({
        name: "list_agent_workspaces",
        arguments: {},
      });
      expect(workspaceResult.isError).not.toBe(true);
      const workspace = (workspaceResult.structuredContent as McpWorkspaceResult).workspaces;
      expect(workspace).toEqual([expect.objectContaining({
        id: workspaceId,
        accessProfile: "reader",
        rootDocumentId: document.id,
      })]);
      expect(workspace[0]?.effectivePermissions).toContain("documents.read");
      expect(workspace[0]?.effectivePermissions).not.toContain("documents.update");
      expect(workspace[0]?.effectivePermissions).not.toContain("documents.commit");

      const recoveredWorking = await readWorkingDocument(readerClient, document.id);
      expect(recoveredWorking.workingDocument).toMatchObject({
        draftVersion: originalDraftVersion,
        committedDraftVersion: initialWorking.workingDocument.committedDraftVersion,
        baseRevisionNumber: originalRevision,
        hasUncommittedChanges: false,
      });
      expect(JSON.stringify(recoveredWorking.workingDocument.content)).not.toContain(deniedMarker);

      const recoveredDocument = await readerClient.callTool({
        name: "get_document",
        arguments: { documentId: document.id },
      });
      expect(recoveredDocument.isError).not.toBe(true);
      expect((recoveredDocument.structuredContent as McpDocumentResult).document).toMatchObject({
        id: document.id,
        revisionNumber: originalRevision,
      });
      expect(JSON.stringify((recoveredDocument.structuredContent as McpDocumentResult).document.content))
        .not.toContain(deniedMarker);

      await expectMcpToolForbidden(readerClient, deniedPatch);
      await expectMcpToolForbidden(readerClient, deniedCommit);
    } finally {
      await closeMcpClient(readerClient);
    }
  } finally {
    await closeMcpClient(writerClient);
  }

  await browserErrors.assertClean();
});
