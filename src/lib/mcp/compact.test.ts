import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createNyxdocMcpServer } from "@/lib/mcp/server";
import { createCollaborationCommands, createStoredCollaborationDocumentProvider } from "@/lib/collaboration/commands";
import { createWorkspaceToken, authenticateApiToken } from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture(readOnly = false) {
  const db = createTestDatabase();
  const { user, workspace } = createTestUser(db);
  const credential = createWorkspaceToken(db, {
    workspaceId: workspace.id, userId: user.id, name: "compact-test", role: readOnly ? "viewer" : "admin",
    scopes: readOnly ? ["documents:read"] : ["documents:read", "documents:write", "documents:commit", "changes:read", "revisions:restore"],
  });
  const identity = authenticateApiToken(db, `Bearer ${credential.token}`);
  const collaboration = createCollaborationCommands({ database: db, provider: createStoredCollaborationDocumentProvider(db) });
  const clients: Client[] = [];
  const servers: ReturnType<typeof createNyxdocMcpServer>[] = [];
  cleanup.push(async () => {
    for (const client of clients) await client.close();
    for (const server of servers) await server.close();
    db.close();
  });
  async function connect(profile: "compact" | "full") {
    const server = createNyxdocMcpServer(db, identity, collaboration, profile);
    servers.push(server);
    const client = new Client({ name: "compact-test", version: "1" });
    clients.push(client);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    return client;
  }
  const client = await connect("compact");
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  return { client, connect, call, workspace, db };
}

describe("compact MCP", () => {
  it("keeps initial definitions below 5KB while preserving every native schema and annotation on demand", async () => {
    const { client, connect, call } = await fixture();
    const full = await connect("full");
    const compactTools = (await client.listTools()).tools;
    const nativeTools = (await full.listTools()).tools;
    expect(compactTools.map(t => t.name)).toEqual(["nyxdoc_discover", "nyxdoc_read", "nyxdoc_write", "nyxdoc_destructive"]);
    const footprint = Buffer.byteLength(JSON.stringify(compactTools) + client.getInstructions());
    const fullFootprint = Buffer.byteLength(JSON.stringify(nativeTools) + full.getInstructions());
    expect(footprint).toBeLessThan(5000);
    expect(footprint / fullFootprint).toBeLessThan(0.07);
    for (const tool of nativeTools) {
      const detail = (await call("nyxdoc_discover", { operation: tool.name })).structuredContent!;
      expect(detail.inputSchema).toEqual(tool.inputSchema);
      expect(detail.annotations).toEqual(tool.annotations);
      expect(detail.workflow).toBeInstanceOf(Array);
    }
    const initial = (await call("nyxdoc_discover")).structuredContent!;
    expect(initial.total).toBe(nativeTools.length);
    expect(initial.operations).toHaveLength(5);
    expect(JSON.stringify(initial)).not.toContain("inputSchema");
    const next = (await call("nyxdoc_discover", { offset: 5 })).structuredContent!;
    expect(next.operations).not.toEqual(initial.operations);
  });

  it("validates routing and nested arguments before any write", async () => {
    const { call, db } = await fixture();
    const before = db.prepare("SELECT COUNT(*) AS n FROM documents").get();
    for (const operation of ["create_document_from_markdown", "trash_document"]) {
      expect((await call("nyxdoc_read", { operation })).structuredContent?.code).toBe("WRONG_TOOL");
    }
    expect((await call("nyxdoc_write", { operation: "trash_document" })).structuredContent?.code).toBe("WRONG_TOOL");
    expect((await call("nyxdoc_write", { operation: "create_document_from_markdown", args: { title: "test", markdown: "body" } })).structuredContent?.code).toBe("INVALID_INPUT");
    for (const operation of ["__proto__", "constructor", "nyxdoc_write", "not_a_tool"]) {
      expect((await call("nyxdoc_write", { operation })).structuredContent?.code).toBe("UNKNOWN_OPERATION");
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual(before);
  });

  it("preserves create idempotency and rejects a changed retry", async () => {
    const { call, db } = await fixture();
    const before = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
    const args = { requestId: randomUUID(), title: "Compact test", markdown: "A body." };
    const first = await call("nyxdoc_write", { operation: "create_document_from_markdown", args });
    expect(first.isError).not.toBe(true);
    const replay = await call("nyxdoc_write", { operation: "create_document_from_markdown", args });
    expect(replay.isError).not.toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toMatchObject({ n: before.n + 1 });
    const conflict = await call("nyxdoc_write", { operation: "create_document_from_markdown", args: { ...args, markdown: "Changed" } });
    expect(conflict.structuredContent?.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("does not bypass credential permissions or workspace membership", async () => {
    const { call, db } = await fixture(true);
    const unrelated = createTestUser(db);
    const before = db.prepare("SELECT COUNT(*) AS n FROM documents").get();
    const denied = await call("nyxdoc_write", { operation: "create_document_from_markdown", args: { requestId: randomUUID(), title: "Denied", markdown: "Body" } });
    expect(denied.isError).toBe(true);
    const deniedRead = await call("nyxdoc_read", { operation: "list_documents", args: { workspaceId: unrelated.workspace.id } });
    expect(deniedRead.isError).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual(before);
  });

  it("keeps writes in the shared draft until an explicit commit and rejects stale versions", async () => {
    const { call } = await fixture();
    const created = (await call("nyxdoc_write", { operation: "create_document_from_markdown", args: { requestId: randomUUID(), title: "Draft test", markdown: "Original body." } })).structuredContent!;
    const documentId = (created.document as { id: string }).id;
    const working = (await call("nyxdoc_read", { operation: "get_working_document", args: { documentId } })).structuredContent!;
    const update = { requestId: randomUUID(), documentId, expectedDraftVersion: working.draftVersion, markdown: "Changed body." };
    const modified = await call("nyxdoc_write", { operation: "update_document_from_markdown", args: update });
    expect(modified.isError).not.toBe(true);
    const canonical = (await call("nyxdoc_read", { operation: "get_document", args: { documentId } })).structuredContent!;
    expect(JSON.stringify(canonical)).toContain("Original body.");
    const stale = await call("nyxdoc_write", { operation: "update_document_from_markdown", args: { ...update, requestId: randomUUID(), markdown: "Stale change." } });
    expect(stale.structuredContent?.code).toBe("DRAFT_CONFLICT");
    const commit = await call("nyxdoc_write", { operation: "commit_document", args: { documentId, requestId: randomUUID(), expectedDraftVersion: modified.structuredContent!.draftVersion } });
    expect(commit.isError).not.toBe(true);
    const saved = (await call("nyxdoc_read", { operation: "get_document", args: { documentId } })).structuredContent!;
    expect(JSON.stringify(saved)).toContain("Changed body.");
  });
});
