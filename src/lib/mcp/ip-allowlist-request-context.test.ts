import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCollaborationCommands,
  createStoredCollaborationDocumentProvider,
} from "@/lib/collaboration/commands";
import type { NyxDatabase } from "@/lib/db/client";
import { createNyxdocMcpServer } from "@/lib/mcp/server";
import {
  authenticateApiToken,
  createWorkspaceToken,
} from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("MCP IP-allowlisted request context", () => {
  it("keeps the verified IP through draft write and commit reauthentication", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "IP bounded MCP agent",
      role: "admin",
      scopes: [
        "documents:read",
        "documents:write",
        "documents:commit",
        "changes:read",
      ],
    });
    database.prepare(
      "UPDATE agent_credentials SET ip_allowlist_json = ? WHERE id = ?",
    ).run(JSON.stringify(["203.0.113.0/24"]), token.summary.id);

    expect(() => authenticateApiToken(database, `Bearer ${token.token}`, {
      workspaceId: workspace.id,
      clientIp: "198.51.100.20",
    })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));

    const identity = authenticateApiToken(database, `Bearer ${token.token}`, {
      workspaceId: workspace.id,
      clientIp: "203.0.113.42",
    });
    const collaboration = createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    });
    const server = createNyxdocMcpServer(database, identity, collaboration);
    const client = new Client({ name: "ip-context-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const created = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "ip-context-create-001",
          title: "IP context",
          content: {
            schemaVersion: 2,
            blocks: [{ id: "ip-context-body", type: "p", children: [{ text: "one" }] }],
          },
        },
      });
      expect(created.isError).not.toBe(true);
      const documentId = (created.structuredContent as { document: { id: string } }).document.id;

      const updated = await client.callTool({
        name: "update_document",
        arguments: {
          documentId,
          expectedDraftVersion: 0,
          requestId: "ip-context-update-001",
          content: {
            schemaVersion: 2,
            blocks: [{ id: "ip-context-body", type: "p", children: [{ text: "two" }] }],
          },
        },
      });
      expect(updated.isError).not.toBe(true);
      expect(updated.structuredContent).toMatchObject({
        draftVersion: 1,
        hasUncommittedChanges: true,
      });

      const committed = await client.callTool({
        name: "commit_document",
        arguments: {
          documentId,
          expectedDraftVersion: 1,
          requestId: "ip-context-commit-001",
          summary: "Commit from an allowed IP",
        },
      });
      expect(committed.isError).not.toBe(true);
      expect(committed.structuredContent).toMatchObject({
        draftVersion: 1,
        hasUncommittedChanges: false,
        document: { id: documentId, revisionNumber: 2 },
      });

      // The original identity is not an authorization lease. A later policy
      // change must be observed at the transaction boundary.
      database.prepare(
        "UPDATE agent_credentials SET ip_allowlist_json = ? WHERE id = ?",
      ).run(JSON.stringify(["198.51.100.0/24"]), token.summary.id);
      const deniedAfterPolicyChange = await client.callTool({
        name: "update_document",
        arguments: {
          documentId,
          expectedDraftVersion: 1,
          requestId: "ip-context-update-denied-001",
          content: {
            schemaVersion: 2,
            blocks: [{ id: "ip-context-body", type: "p", children: [{ text: "three" }] }],
          },
        },
      });
      expect(deniedAfterPolicyChange.isError).toBe(true);
      expect(deniedAfterPolicyChange.structuredContent).toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
