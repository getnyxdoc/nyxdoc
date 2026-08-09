import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { updateAgentWorkspaceMembership } from "@/lib/agents/service";
import type { NyxDatabase } from "@/lib/db/client";
import {
  createDocument,
  queryDocuments,
  searchDocumentContents,
} from "@/lib/documents/service";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import {
  authenticateApiToken,
  createWorkspaceToken,
  resolveTokenReadRoot,
} from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function content(text: string) {
  return parseNyxdocDocumentV2({
    schemaVersion: 2,
    blocks: [{ id: randomUUID(), type: "p", children: [{ text }] }],
  });
}

describe("token application-consistency boundaries", () => {
  it("reloads root B for list and search when a cached identity still projects root A", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const human = {
      type: "human" as const,
      userId: user.id,
      label: user.name,
      source: "web" as const,
    };
    const rootA = createDocument(database, workspace.id, human, {
      title: "Scope A needle",
      content: content("scope A needle"),
    });
    const childA = createDocument(database, workspace.id, human, {
      title: "Scope A child needle",
      parentDocumentId: rootA.document.id,
      content: content("scope A child needle"),
    });
    const rootB = createDocument(database, workspace.id, human, {
      title: "Scope B needle",
      content: content("scope B needle"),
    });
    const childB = createDocument(database, workspace.id, human, {
      title: "Scope B child needle",
      parentDocumentId: rootB.document.id,
      content: content("scope B child needle"),
    });
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Root-changing reader",
      rootDocumentId: rootA.document.id,
    });
    const staleIdentity = authenticateApiToken(database, `Bearer ${token.token}`);

    updateAgentWorkspaceMembership(database, {
      workspaceId: workspace.id,
      userId: user.id,
      agentId: staleIdentity.globalAgentId,
      accessProfile: staleIdentity.accessProfile,
      capabilities: staleIdentity.capabilities,
      rootDocumentId: rootB.document.id,
    });

    expect(staleIdentity.rootDocumentId).toBe(rootA.document.id);
    const currentRoot = resolveTokenReadRoot(database, staleIdentity);
    expect(currentRoot).toBe(rootB.document.id);
    expect(() => resolveTokenReadRoot(database, staleIdentity, rootA.document.id))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    const listedIds = queryDocuments(database, workspace.id, {
      withinDocumentId: currentRoot,
      limit: 100,
    }).documents.map((document) => document.id).sort();
    expect(listedIds).toEqual([rootB.document.id, childB.document.id].sort());
    expect(listedIds).not.toContain(rootA.document.id);
    expect(listedIds).not.toContain(childA.document.id);

    const searchedIds = searchDocumentContents(database, workspace.id, "needle", {
      withinDocumentId: currentRoot,
      limit: 20,
    }).map((document) => document.documentId).sort();
    expect(searchedIds).toEqual([rootB.document.id, childB.document.id].sort());
  });
});
