import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCollaborationCommands,
  createStoredCollaborationDocumentProvider,
} from "@/lib/collaboration/commands";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import { getDocumentWebUrl } from "@/lib/documents/web-url";
import { createNyxdocMcpServer } from "@/lib/mcp/server";
import {
  authenticateApiToken,
  createWorkspaceToken,
  type ApiTokenIdentity,
} from "@/lib/tokens/service";
import { createWorkspace } from "@/lib/workspaces/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];
const connections: Array<{
  client: Client;
  close: () => Promise<void>;
}> = [];

afterEach(async () => {
  while (connections.length) await connections.pop()?.close();
  while (databases.length) databases.pop()?.close();
});

function paragraph(id: string, text: string) {
  return {
    schemaVersion: 2 as const,
    blocks: [{ id, type: "p" as const, children: [{ text }] }],
  };
}

async function connectMcp(database: NyxDatabase, identity: ApiTokenIdentity) {
  const collaboration = createCollaborationCommands({
    database,
    provider: createStoredCollaborationDocumentProvider(database),
  });
  const server = createNyxdocMcpServer(database, identity, collaboration);
  const client = new Client({ name: "protocol-hardening-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connection = {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  connections.push(connection);
  return connection;
}

async function createProtocolFixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const token = createWorkspaceToken(database, {
    workspaceId: workspace.id,
    userId: user.id,
    name: "Protocol invariant agent",
    role: "admin",
    scopes: [
      "documents:read",
      "documents:write",
      "documents:commit",
      "changes:read",
      "revisions:restore",
    ],
  });
  const identity = authenticateApiToken(database, `Bearer ${token.token}`);
  const connection = await connectMcp(database, identity);
  return { database, user, workspace, identity, ...connection };
}

describe("MCP public protocol hardening invariants", () => {
  it("keeps discovery schemas and handler-side AST validation aligned", async () => {
    const { client } = await createProtocolFixture();
    const listed = await client.listTools();
    const capabilities = await client.callTool({
      name: "get_capabilities",
      arguments: { profile: "document" },
    });
    const documentSchema = await client.callTool({
      name: "get_schema",
      arguments: { name: "document_content" },
    });
    const patchSchema = await client.callTool({
      name: "get_schema",
      arguments: { name: "patch_operation" },
    });

    expect(capabilities.isError).not.toBe(true);
    expect(capabilities.structuredContent).toMatchObject({
      operation: "get_capabilities",
      capabilities: {
        protocolVersion: "5.0.0",
        concurrency: {
          expectedDraftVersionRequiredForAgents: true,
          astWritesWithStaleDraftVersionReturnConflict: true,
        },
        idempotency: { sameRequestReturnsOriginalResult: true },
        media: {
          uploadTool: "create_image_upload",
          documentStorage: "mediaId-and-internal-url-only",
          inlineBase64Allowed: false,
        },
        document: {
          humanFacingWebUrl: {
            field: "webUrl",
            absolute: true,
            generatedByServer: true,
          },
          titlePresentation: {
            field: "title",
            renderedSeparatelyFromBody: true,
            repeatTitleAsLeadingBodyHeading: false,
          },
        },
      },
    });
    expect(documentSchema.isError).not.toBe(true);
    expect(documentSchema.structuredContent).toMatchObject({
      operation: "get_schema",
      name: "document_content",
      protocolVersion: "5.0.0",
      schemaDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      jsonSchema: {
        description: expect.stringContaining("do not repeat it as a leading H1"),
      },
    });
    expect(JSON.stringify(documentSchema.structuredContent)).toContain("mediaId");
    expect(patchSchema.structuredContent).toMatchObject({
      operation: "get_schema",
      name: "patch_operation",
      protocolVersion: "5.0.0",
      schemaDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const expectedRequired = {
      create_document: ["content", "requestId", "title"],
      update_document: ["documentId", "expectedDraftVersion", "requestId"],
      patch_document: ["documentId", "expectedDraftVersion", "operations", "requestId"],
      commit_document: ["documentId", "expectedDraftVersion", "requestId"],
    } as const;
    for (const [name, required] of Object.entries(expectedRequired)) {
      const tool = listed.tools.find((entry) => entry.name === name);
      expect(tool, `${name} must be publicly registered`).toBeDefined();
      expect((tool?.inputSchema.required ?? []).toSorted()).toEqual([...required].toSorted());
    }

    const invalidAst = await client.callTool({
      name: "create_document",
      arguments: {
        requestId: "invalid-empty-ast-001",
        title: "Invalid empty AST",
        content: { schemaVersion: 2, blocks: [] },
      },
    });
    expect(invalidAst.isError).toBe(true);
    expect(invalidAst.structuredContent).toMatchObject({
      code: "INVALID_INPUT",
      errorSource: "runtime_validation",
      reason: "The tool input failed runtime validation.",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["blocks"] }),
      ]),
    });
  });

  it("enforces stale-write, replay, media, workspace, revocation, and webUrl contracts through real handlers", async () => {
    const { database, user, workspace, identity, client } = await createProtocolFixture();
    const created = await client.callTool({
      name: "create_document",
      arguments: {
        requestId: "protocol-document-create-001",
        title: "Protocol document",
        content: paragraph("protocol-seed", "Initial body"),
      },
    });
    expect(created.isError).not.toBe(true);
    const documentId = (created.structuredContent as {
      document: { id: string };
    }).document.id;
    const expectedWebUrl = getDocumentWebUrl(workspace.id, documentId);
    expect(created.structuredContent).toMatchObject({
      workspaceId: workspace.id,
      webUrl: expectedWebUrl,
      document: { id: documentId, webUrl: expectedWebUrl },
    });

    const missingMediaId = randomUUID();
    const badMedia = await client.callTool({
      name: "patch_document",
      arguments: {
        documentId,
        expectedDraftVersion: 0,
        requestId: "protocol-missing-media-001",
        operations: [{
          op: "replace_block",
          blockId: "protocol-seed",
          block: {
            type: "img",
            mediaId: missingMediaId,
            url: `/api/media/${missingMediaId}`,
            alt: "Missing media",
            children: [{ text: "" }],
          },
        }],
      },
    });
    expect(badMedia.isError).toBe(true);
    expect(badMedia.structuredContent).toMatchObject({
      code: "INVALID_INPUT",
      errorSource: "service",
      mediaId: missingMediaId,
    });
    expect((await client.callTool({
      name: "get_working_document",
      arguments: { documentId },
    })).structuredContent).toMatchObject({
      draftVersion: 0,
      webUrl: expectedWebUrl,
      workingDocument: {
        documentId,
        draftVersion: 0,
        webUrl: expectedWebUrl,
      },
    });

    const firstPatchArguments = {
      documentId,
      expectedDraftVersion: 0,
      requestId: "protocol-idempotent-patch-001",
      operations: [{
        op: "replace_block",
        blockId: "protocol-seed",
        block: { id: "protocol-seed", type: "p", children: [{ text: "First mutation" }] },
      }],
    };
    const firstPatch = await client.callTool({
      name: "patch_document",
      arguments: firstPatchArguments,
    });
    expect(firstPatch.isError).not.toBe(true);
    expect(firstPatch.structuredContent).toMatchObject({
      draftVersion: 1,
      receipt: {
        requestId: firstPatchArguments.requestId,
        draftVersion: 1,
      },
    });

    const secondPatch = await client.callTool({
      name: "patch_document",
      arguments: {
        documentId,
        expectedDraftVersion: 1,
        requestId: "protocol-second-patch-001",
        operations: [{
          op: "replace_block",
          blockId: "protocol-seed",
          block: { id: "protocol-seed", type: "p", children: [{ text: "Second mutation" }] },
        }],
      },
    });
    expect(secondPatch.structuredContent).toMatchObject({ draftVersion: 2 });

    const replay = await client.callTool({
      name: "patch_document",
      arguments: firstPatchArguments,
    });
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({
      replayed: true,
      draftVersion: 2,
      receiptDraftVersion: 1,
      currentDraftVersion: 2,
      receipt: {
        replayed: true,
        requestId: firstPatchArguments.requestId,
        draftVersion: 1,
        receiptDraftVersion: 1,
        currentDraftVersion: 2,
      },
    });

    const stale = await client.callTool({
      name: "patch_document",
      arguments: {
        documentId,
        expectedDraftVersion: 1,
        requestId: "protocol-stale-patch-001",
        operations: [{
          op: "replace_block",
          blockId: "protocol-seed",
          block: { id: "protocol-seed", type: "p", children: [{ text: "Stale mutation" }] },
        }],
      },
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({
      code: "DRAFT_CONFLICT",
      errorSource: "service",
      expectedDraftVersion: 1,
      currentDraftVersion: 2,
    });

    // The public schema promises that these are the only required commit
    // fields. Keep this exact payload as a regression for the former generic
    // INVALID_INPUT failure on otherwise valid commit requests.
    const commitArguments = {
      documentId,
      expectedDraftVersion: 2,
      requestId: "protocol-minimal-commit-001",
    };
    const committed = await client.callTool({
      name: "commit_document",
      arguments: commitArguments,
    });
    expect(committed.isError).not.toBe(true);
    expect(committed.structuredContent).toMatchObject({
      operation: "commit_document",
      draftVersion: 2,
      committedDraftVersion: 2,
      baseRevisionNumber: 2,
      hasUncommittedChanges: false,
      webUrl: expectedWebUrl,
      document: {
        id: documentId,
        revisionNumber: 2,
        webUrl: expectedWebUrl,
      },
      receipt: {
        operation: "commit_document",
        requestId: commitArguments.requestId,
        revisionNumber: 2,
        draftVersion: 2,
      },
    });
    const commitReplay = await client.callTool({
      name: "commit_document",
      arguments: commitArguments,
    });
    expect(commitReplay.isError).not.toBe(true);
    expect(commitReplay.structuredContent).toMatchObject({
      replayed: true,
      draftVersion: 2,
      receiptDraftVersion: 2,
      currentDraftVersion: 2,
      document: { revisionNumber: 2, webUrl: expectedWebUrl },
      receipt: {
        replayed: true,
        requestId: commitArguments.requestId,
        revisionNumber: 2,
        draftVersion: 2,
      },
    });
    const staleCommit = await client.callTool({
      name: "commit_document",
      arguments: {
        documentId,
        expectedDraftVersion: 1,
        requestId: "protocol-stale-commit-001",
      },
    });
    expect(staleCommit.isError).toBe(true);
    expect(staleCommit.structuredContent).toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
      errorSource: "service",
      expectedDraftVersion: 1,
      currentDraftVersion: 2,
    });

    const foreignWorkspace = createWorkspace(database, user, "Foreign protocol workspace", "en");
    const foreign = createDocument(database, foreignWorkspace.id, {
      type: "human",
      userId: user.id,
      label: user.name,
      source: "web",
    }, {
      title: "Foreign document",
      content: paragraph("foreign-seed", "Outside credential workspace"),
    }).document;
    const foreignRead = await client.callTool({
      name: "get_document",
      arguments: { documentId: foreign.id },
    });
    expect(foreignRead.isError).toBe(true);
    expect(foreignRead.structuredContent).toMatchObject({
      code: "NOT_FOUND",
      errorSource: "service",
    });
    expect(foreignRead.content).toEqual([
      { type: "text", text: "The document was not found." },
    ]);
    expect(JSON.stringify(foreignRead.structuredContent)).not.toContain(foreign.id);
    expect(JSON.stringify(foreignRead.structuredContent)).not.toContain(foreign.title);
    const foreignWrite = await client.callTool({
      name: "update_document",
      arguments: {
        documentId: foreign.id,
        expectedDraftVersion: 0,
        requestId: "protocol-foreign-write-001",
        title: "Must stay inaccessible",
      },
    });
    expect(foreignWrite.isError).toBe(true);
    expect(foreignWrite.structuredContent).toMatchObject({
      code: "NOT_FOUND",
      errorSource: "service",
    });

    database.prepare(
      "UPDATE agent_credentials SET revoked_at = ? WHERE id = ?",
    ).run("2026-08-09T00:00:00.000Z", identity.id);
    const afterRevocation = await client.callTool({
      name: "get_document",
      arguments: { documentId },
    });
    expect(afterRevocation.isError).toBe(true);
    expect(afterRevocation.structuredContent).toMatchObject({
      code: "NOT_FOUND",
      errorSource: "service",
    });
    expect(afterRevocation.content).toEqual([
      { type: "text", text: "The document was not found." },
    ]);
    const writeAfterRevocation = await client.callTool({
      name: "update_document",
      arguments: {
        documentId,
        expectedDraftVersion: 2,
        requestId: "protocol-revoked-write-001",
        title: "Must be denied after revocation",
      },
    });
    expect(writeAfterRevocation.isError).toBe(true);
    expect(writeAfterRevocation.structuredContent).toMatchObject({
      code: "NOT_FOUND",
      errorSource: "service",
    });
  });

  it("rejects a normalized duplicate page title as the leading H1 in AST and Markdown writes", async () => {
    const { database, user, workspace, client } = await createProtocolFixture();
    const listed = await client.listTools();
    const createTool = listed.tools.find((tool) => tool.name === "create_document");
    const schema = await client.callTool({
      name: "get_schema",
      arguments: { name: "document_content" },
    });

    expect(client.getInstructions()).toContain(
      "never repeat the same title as a leading H1 or other heading inside content or Markdown",
    );
    expect(createTool?.description).toContain("must not repeat that title as a leading heading");
    expect(JSON.stringify(createTool?.inputSchema)).toContain(
      "must not be repeated as the leading body heading",
    );
    expect(JSON.stringify(schema.structuredContent)).toContain(
      "do not repeat it as a leading H1 or other body heading",
    );

    const duplicateAstCreate = await client.callTool({
      name: "create_document",
      arguments: {
        requestId: "protocol-duplicate-ast-create-001",
        title: "Caf\u00e9 Guide",
        content: {
          schemaVersion: 2,
          blocks: [
            {
              id: "duplicate-ast-create-intro",
              type: "p",
              children: [{ text: "Intro before the first H1" }],
            },
            {
              id: "duplicate-ast-create-heading",
              type: "h1",
              children: [{ text: "  CAFE\u0301   GUIDE  " }],
            },
          ],
        },
      },
    });
    expect(duplicateAstCreate.isError).toBe(true);
    expect(duplicateAstCreate.structuredContent).toMatchObject({
      code: "INVALID_INPUT",
      errorSource: "service",
      rule: "title_not_repeated_as_leading_h1",
    });

    const duplicateMarkdownCreate = await client.callTool({
      name: "create_document_from_markdown",
      arguments: {
        requestId: "protocol-duplicate-md-create-001",
        title: "Release Notes",
        markdown: "#  RELEASE   NOTES\n\nBody",
      },
    });
    expect(duplicateMarkdownCreate.isError).toBe(true);
    expect(duplicateMarkdownCreate.structuredContent).toMatchObject({
      code: "INVALID_INPUT",
      errorSource: "service",
      rule: "title_not_repeated_as_leading_h1",
    });

    const created = await client.callTool({
      name: "create_document",
      arguments: {
        requestId: "protocol-duplicate-update-seed-001",
        title: "Caf\u00e9 Guide",
        content: paragraph("duplicate-update-seed", "Original body"),
      },
    });
    const documentId = (created.structuredContent as {
      document: { id: string };
    }).document.id;

    const duplicateAstUpdate = await client.callTool({
      name: "update_document",
      arguments: {
        documentId,
        expectedDraftVersion: 0,
        requestId: "protocol-duplicate-ast-update-001",
        content: {
          schemaVersion: 2,
          blocks: [{
            id: "duplicate-ast-update-heading",
            type: "h1",
            children: [{ text: "caf\u00e9\t guide" }],
          }],
        },
      },
    });
    expect(duplicateAstUpdate.isError).toBe(true);
    expect(duplicateAstUpdate.structuredContent).toMatchObject({
      code: "INVALID_INPUT",
      errorSource: "service",
      rule: "title_not_repeated_as_leading_h1",
    });

    const duplicateAstPatch = await client.callTool({
      name: "patch_document",
      arguments: {
        documentId,
        expectedDraftVersion: 0,
        requestId: "protocol-duplicate-ast-patch-001",
        operations: [{
          op: "replace_block",
          blockId: "duplicate-update-seed",
          block: {
            id: "duplicate-update-seed",
            type: "h1",
            children: [{ text: "  CAFE\u0301 GUIDE " }],
          },
        }],
      },
    });
    expect(duplicateAstPatch.isError).toBe(true);
    expect(duplicateAstPatch.structuredContent).toMatchObject({
      code: "INVALID_INPUT",
      errorSource: "service",
      rule: "title_not_repeated_as_leading_h1",
    });

    const duplicateMarkdownUpdate = await client.callTool({
      name: "update_document_from_markdown",
      arguments: {
        documentId,
        expectedDraftVersion: 0,
        requestId: "protocol-duplicate-md-update-001",
        markdown: "# CAFE\u0301   GUIDE\n\nReplacement body",
      },
    });
    expect(duplicateMarkdownUpdate.isError).toBe(true);
    expect(duplicateMarkdownUpdate.structuredContent).toMatchObject({
      code: "INVALID_INPUT",
      errorSource: "service",
      rule: "title_not_repeated_as_leading_h1",
    });

    const markdownPatchSeed = await client.callTool({
      name: "create_document",
      arguments: {
        requestId: "protocol-duplicate-section-seed-001",
        title: "Section Page Title",
        content: {
          schemaVersion: 2,
          blocks: [{
            id: "section-heading",
            type: "h1",
            children: [{ text: "Existing section" }],
          }, {
            id: "section-body",
            type: "p",
            children: [{ text: "Existing body" }],
          }],
        },
      },
    });
    const markdownPatchDocumentId = (markdownPatchSeed.structuredContent as {
      document: { id: string };
    }).document.id;
    const selectedSection = await client.callTool({
      name: "get_document_markdown",
      arguments: {
        documentId: markdownPatchDocumentId,
        sectionId: "section-heading",
        source: "working",
      },
    });
    const selectedSectionHash = (selectedSection.structuredContent as {
      selector: { sectionHash: string };
    }).selector.sectionHash;
    const duplicateMarkdownPatch = await client.callTool({
      name: "patch_document_markdown",
      arguments: {
        documentId: markdownPatchDocumentId,
        sectionId: "section-heading",
        expectedSectionHash: selectedSectionHash,
        expectedDraftVersion: 0,
        requestId: "protocol-duplicate-section-patch-001",
        markdown: "# SECTION PAGE TITLE\n\nReplacement body",
      },
    });
    expect(duplicateMarkdownPatch.isError).toBe(true);
    expect(duplicateMarkdownPatch.structuredContent).toMatchObject({
      code: "INVALID_INPUT",
      errorSource: "service",
      rule: "title_not_repeated_as_leading_h1",
    });

    const unchangedWorking = await client.callTool({
      name: "get_working_document",
      arguments: { documentId },
    });
    expect(unchangedWorking.structuredContent).toMatchObject({
      draftVersion: 0,
      workingDocument: {
        title: "Caf\u00e9 Guide",
        draftVersion: 0,
        content: paragraph("duplicate-update-seed", "Original body"),
      },
    });

    const titleOnlySeed = await client.callTool({
      name: "create_document",
      arguments: {
        requestId: "protocol-duplicate-title-only-seed-001",
        title: "Original title",
        content: {
          schemaVersion: 2,
          blocks: [{
            id: "future-title-heading",
            type: "h1",
            children: [{ text: "Future Title" }],
          }],
        },
      },
    });
    const titleOnlyDocumentId = (titleOnlySeed.structuredContent as {
      document: { id: string };
    }).document.id;
    const duplicateTitleOnlyUpdate = await client.callTool({
      name: "update_document",
      arguments: {
        documentId: titleOnlyDocumentId,
        expectedDraftVersion: 0,
        requestId: "protocol-duplicate-title-only-update-001",
        title: "  future   TITLE ",
      },
    });
    expect(duplicateTitleOnlyUpdate.isError).toBe(true);
    expect(duplicateTitleOnlyUpdate.structuredContent).toMatchObject({
      code: "INVALID_INPUT",
      errorSource: "service",
      rule: "title_not_repeated_as_leading_h1",
    });

    const legacyDuplicate = createDocument(database, workspace.id, {
      type: "human",
      userId: user.id,
      label: user.name,
      source: "web",
    }, {
      title: "Legacy duplicate title",
      content: {
        schemaVersion: 2,
        blocks: [{
          id: "legacy-duplicate-heading",
          type: "h1",
          children: [{ text: "Legacy duplicate title" }],
        }],
      },
    }).document;
    const legacyRead = await client.callTool({
      name: "get_document",
      arguments: { documentId: legacyDuplicate.id },
    });
    expect(legacyRead.isError).not.toBe(true);
    expect(legacyRead.structuredContent).toMatchObject({
      document: {
        id: legacyDuplicate.id,
        title: "Legacy duplicate title",
        revisionNumber: 1,
        content: {
          blocks: [{
            id: "legacy-duplicate-heading",
            type: "h1",
            children: [{ text: "Legacy duplicate title" }],
          }],
        },
      },
    });
  });
});
