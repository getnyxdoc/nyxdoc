import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnvConfig } from "@next/env";
import sharp from "sharp";

loadEnvConfig(process.cwd());

async function main() {
  const [{ sqlite }, { getMediaRoot }, { createWorkspaceToken }] = await Promise.all([
    import("../src/lib/db/client"),
    import("../src/lib/config"),
    import("../src/lib/tokens/service"),
  ]);
  const membership = sqlite
    .prepare(
      `SELECT wm.workspace_id, wm.user_id
       FROM workspace_members wm
       ORDER BY wm.created_at ASC LIMIT 1`,
    )
    .get() as { workspace_id: string; user_id: string } | undefined;
  assert(membership, "A local workspace is required. Sign in once before this test.");

  const createdToken = createWorkspaceToken(sqlite, {
    workspaceId: membership.workspace_id,
    userId: membership.user_id,
    name: "MCP HTTP test",
    role: "admin",
  });
  const baseUrl = process.env.NYXDOC_TEST_BASE_URL || "http://127.0.0.1:3100";
  const endpoint = new URL("/mcp", baseUrl);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${createdToken.token}` } },
  });
  const client = new Client({ name: "nyxdoc-http-test", version: "1.0.0" });
  let createdDocumentId: string | undefined;
  let uploadedMedia: { id: string; storageKey: string } | undefined;
  let adminRequestId: string | undefined;

  try {
    const rawInitialize = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createdToken.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "nyxdoc-raw-http-test", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (rawInitialize.status !== 200) {
      throw new Error(`Raw initialize failed (${rawInitialize.status}): ${await rawInitialize.text()}`);
    }
    const rawBody = (await rawInitialize.json()) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(rawBody.result?.serverInfo?.name, "nyxdoc");

    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    for (const requiredTool of [
      "list_agent_workspaces",
      "get_capabilities",
      "get_schema",
      "get_working_document",
      "get_document_outline",
      "get_document_markdown",
      "patch_document_markdown",
      "create_image_upload",
      "create_document",
      "capture_handoff",
      "patch_document",
      "commit_document",
      "search_documents",
      "list_my_tasks",
      "restore_revision",
    ]) {
      assert(toolNames.has(requiredTool), `Missing MCP tool: ${requiredTool}`);
    }
    assert(Buffer.byteLength(JSON.stringify(tools.tools), "utf8") < 80_000);

    const capabilityResult = await client.callTool({ name: "get_capabilities", arguments: {} });
    const capabilityContent = capabilityResult.structuredContent as {
      capabilities: { protocolVersion: string; profile: string };
    };
    assert.equal(capabilityContent.capabilities.protocolVersion, "5.0.0");
    assert.equal(capabilityContent.capabilities.profile, "summary");
    assert(!JSON.stringify(capabilityContent).includes("jsonSchema"));
    assert(Buffer.byteLength(JSON.stringify(capabilityContent), "utf8") < 10_000);
    const workspaceContext = await client.callTool({
      name: "get_workspace_context",
      arguments: {},
    });
    const managementContext = workspaceContext.structuredContent as {
      agent: { id: string; allowedActions: string[] };
    };
    assert(managementContext.agent.allowedActions.includes("admin_requests.create"));
    assert(!managementContext.agent.allowedActions.includes("admin_requests.review"));
    const adminProposalArguments = {
      requestId: randomUUID(),
      reason: "MCP 관리 요청의 사람 승인 경계를 확인합니다.",
      actionType: "agent.update",
      payload: {
        agentId: managementContext.agent.id,
        status: "active",
      },
    };
    const adminProposal = await client.callTool({
      name: "propose_admin_action",
      arguments: adminProposalArguments,
    });
    assert.equal(adminProposal.isError, undefined);
    const adminProposalContent = adminProposal.structuredContent as {
      request: { id: string; status: string };
      executed: boolean;
      requiresHumanApproval: boolean;
    };
    adminRequestId = adminProposalContent.request.id;
    assert.equal(adminProposalContent.request.status, "pending");
    assert.equal(adminProposalContent.executed, false);
    assert.equal(adminProposalContent.requiresHumanApproval, true);
    const adminProposalReplay = await client.callTool({
      name: "propose_admin_action",
      arguments: adminProposalArguments,
    });
    assert.deepEqual(adminProposalReplay.structuredContent, adminProposal.structuredContent);
    const createRequestId = `mcp-http-create-${randomUUID()}`;
    const createArguments = {
      requestId: createRequestId,
      title: `MCP HTTP test ${Date.now()}`,
      summary: "실제 Streamable HTTP 경로를 확인했습니다.",
      content: {
        schemaVersion: 2,
        blocks: [
          { id: "http-title", type: "h1", children: [{ text: "MCP HTTP test" }] },
          { id: "http-body", type: "p", children: [{ text: "이 문서는 테스트 후 제거됩니다." }] },
          { id: "http-list", type: "p", listStyleType: "disc", indent: 2, children: [{ text: "중첩 목록도 전송됩니다." }] },
          {
            id: "http-table",
            type: "table",
            children: [
              {
                id: "http-row-1",
                type: "tr",
                children: [
                  { id: "http-head-1", type: "th", children: [{ id: "http-head-p-1", type: "p", children: [{ text: "경로" }] }] },
                  { id: "http-head-2", type: "th", children: [{ id: "http-head-p-2", type: "p", children: [{ text: "상태" }] }] },
                ],
              },
              {
                id: "http-row-2",
                type: "tr",
                children: [
                  { id: "http-cell-1", type: "td", children: [{ id: "http-cell-p-1", type: "p", children: [{ text: "MCP" }] }] },
                  { id: "http-cell-2", type: "td", children: [{ id: "http-cell-p-2", type: "p", children: [{ text: "정상" }] }] },
                ],
              },
            ],
          },
        ],
      },
    };
    const result = await client.callTool({
      name: "create_document",
      arguments: createArguments,
    });
    assert.equal(result.isError, undefined);
    const createContent = result.structuredContent as {
      responseMode: string;
      contentDigest: string;
      document: { id: string; content: { schemaVersion: number; blockCount: number } };
    };
    assert.equal(createContent.responseMode, "summary");
    assert.equal(createContent.document.content.blockCount, 4);
    assert(!JSON.stringify(createContent).includes('"blocks"'));
    createdDocumentId = createContent.document.id;
    const createReplay = await client.callTool({ name: "create_document", arguments: createArguments });
    assert.deepEqual(createReplay.structuredContent, result.structuredContent);
    const read = await client.callTool({
      name: "get_document",
      arguments: { documentId: createdDocumentId },
    });
    const document = (read.structuredContent as {
      document: { revisionNumber: number; content: { blocks: Array<Record<string, unknown>> } };
    }).document;
    assert.equal(document.revisionNumber, 1);
    assert.deepEqual(document.content.blocks[2], {
      id: "http-list",
      type: "p",
      listStyleType: "disc",
      indent: 2,
      children: [{ text: "중첩 목록도 전송됩니다." }],
    });
    assert.equal(document.content.blocks[3].type, "table");

    const png = await sharp(randomBytes(12), {
      raw: { width: 2, height: 2, channels: 3 },
    }).png().toBuffer();
    const imageUploadTicket = await client.callTool({
      name: "create_image_upload",
      arguments: {
        documentId: createdDocumentId,
        filename: "agent-protocol-smoke.png",
        mimeType: "image/png",
        byteSize: png.byteLength,
        sha256: createHash("sha256").update(png).digest("hex"),
        alt: "Agent protocol smoke image",
      },
    });
    assert.equal(imageUploadTicket.isError, undefined);
    const uploadRequest = imageUploadTicket.structuredContent as {
      upload: {
        method: string;
        url: string;
        headers: Record<string, string>;
        singleUse: boolean;
      };
    };
    assert.equal(uploadRequest.upload.method, "PUT");
    assert.equal(uploadRequest.upload.singleUse, true);
    const uploadUrl = internalTestUrl(uploadRequest.upload.url, baseUrl);
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: uploadRequest.upload.headers,
      body: Uint8Array.from(png),
    });
    if (uploadResponse.status !== 201) {
      throw new Error(`Media upload failed (${uploadResponse.status}): ${await uploadResponse.text()}`);
    }
    const uploaded = (await uploadResponse.json()) as {
      media: { id: string; url: string; mimeType: string };
      imageBlock: Record<string, unknown>;
    };
    assert.equal(uploaded.media.mimeType, "image/png");
    assert.deepEqual(uploaded.imageBlock, {
      id: uploaded.imageBlock.id,
      type: "img",
      mediaId: uploaded.media.id,
      url: uploaded.media.url,
      alt: "Agent protocol smoke image",
      name: "agent-protocol-smoke.png",
      children: [{ text: "" }],
    });
    const replayUpload = await fetch(uploadUrl, {
      method: "PUT",
      headers: uploadRequest.upload.headers,
      body: Uint8Array.from(png),
    });
    assert.equal(replayUpload.status, 409);
    const mediaRow = sqlite.prepare("SELECT storage_key FROM media_assets WHERE id = ?")
      .get(uploaded.media.id) as { storage_key: string };
    uploadedMedia = { id: uploaded.media.id, storageKey: mediaRow.storage_key };

    const patchArguments = {
      documentId: createdDocumentId,
      expectedDraftVersion: 0,
      requestId: `mcp-http-patch-${randomUUID()}`,
      operations: [{
        op: "insert_after",
        anchorBlockId: "http-table",
        blocks: [
          uploaded.imageBlock,
          { type: "p", children: [{ text: "canonical nodeType smoke marker" }] },
        ],
      }],
    };
    const patched = await client.callTool({ name: "patch_document", arguments: patchArguments });
    assert.equal(patched.isError, undefined);
    const patchedContent = patched.structuredContent as {
      responseMode: string;
      workingDocument: { draftVersion: number; hasUncommittedChanges: boolean };
    };
    assert.equal(patchedContent.responseMode, "summary");
    assert.equal(patchedContent.workingDocument.draftVersion, 1);
    assert.equal(patchedContent.workingDocument.hasUncommittedChanges, true);
    assert(!JSON.stringify(patchedContent).includes('"blocks"'));
    const patchReplay = await client.callTool({ name: "patch_document", arguments: patchArguments });
    assert.deepEqual(patchReplay.structuredContent, patched.structuredContent);

    const reusedRequest = await client.callTool({
      name: "patch_document",
      arguments: {
        ...patchArguments,
        operations: [{
          op: "replace_block",
          blockId: "http-body",
          block: { type: "p", children: [{ text: "같은 requestId의 다른 요청" }] },
        }],
      },
    });
    assert.equal(reusedRequest.isError, true);

    const committed = await client.callTool({
      name: "commit_document",
      arguments: {
        documentId: createdDocumentId,
        expectedDraftVersion: 1,
        requestId: `mcp-http-commit-${randomUUID()}`,
        summary: "멱등 patch와 이미지 참조를 검증했습니다.",
      },
    });
    assert.equal(committed.isError, undefined);
    assert.equal(
      (committed.structuredContent as { document: { revisionNumber: number } }).document.revisionNumber,
      2,
    );

    const stalePatch = await client.callTool({
      name: "patch_document",
      arguments: {
        documentId: createdDocumentId,
        expectedDraftVersion: 0,
        requestId: `mcp-http-stale-${randomUUID()}`,
        operations: [{
          op: "replace_block",
          blockId: "http-body",
          block: { type: "p", children: [{ text: "stale update" }] },
        }],
      },
    });
    assert.equal(stalePatch.isError, true);

    const searched = await client.callTool({
      name: "search_documents",
      arguments: { query: "canonical nodeType smoke marker" },
    });
    expectSearchResult(searched.structuredContent, createdDocumentId);

    const mediaResponse = await fetch(internalTestUrl(uploaded.media.url, baseUrl), {
      headers: { Authorization: `Bearer ${createdToken.token}` },
    });
    assert.equal(mediaResponse.status, 200);
    assert.equal(mediaResponse.headers.get("content-type"), "image/png");
    assert((await mediaResponse.arrayBuffer()).byteLength > 8);

    console.log("MCP HTTP smoke passed: compact protocol 4.7 responses, one-time raw image upload, explicit commit, retry replay, conflicts, and search anchors.");
  } finally {
    await client.close().catch(() => undefined);
    if (createdDocumentId) sqlite.prepare("DELETE FROM documents WHERE id = ?").run(createdDocumentId);
    if (uploadedMedia) {
      sqlite.prepare("DELETE FROM media_assets WHERE id = ?").run(uploadedMedia.id);
      await rm(path.join(getMediaRoot(), uploadedMedia.storageKey), { force: true });
    }
    if (adminRequestId) {
      sqlite.prepare("DELETE FROM workspace_admin_action_requests WHERE id = ?").run(adminRequestId);
    }
    sqlite.prepare("DELETE FROM workspace_agents WHERE id = ?").run(createdToken.summary.agentId);
  }
}

function internalTestUrl(rawUrl: string, baseUrl: string) {
  const publicUrl = new URL(rawUrl, baseUrl);
  return new URL(`${publicUrl.pathname}${publicUrl.search}`, baseUrl);
}

function expectSearchResult(value: unknown, documentId: string) {
  const result = value as {
    results?: Array<{ documentId?: string; matches?: Array<{ nodeType?: string }> }>;
  };
  const document = result.results?.find((candidate) => candidate.documentId === documentId);
  assert(document);
  assert(document.matches?.some((match) => match.nodeType === "p"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
