import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { createDocument, listDocuments } from "@/lib/documents/service";
import {
  getWorkspaceNavigationPreference,
  saveWorkspaceNavigationPreference,
} from "@/lib/workspaces/navigation-preferences";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function createChild(database: NyxDatabase, user: { id: string; name: string; email: string }, workspaceId: string, parentDocumentId: string) {
  return createDocument(database, workspaceId, humanDocumentActor(user), {
    title: "Child document",
    parentDocumentId,
    content: {
      schemaVersion: 2,
      blocks: [{ id: crypto.randomUUID(), type: "p", children: [{ text: "Child" }] }],
    },
  }).document;
}

describe("workspace navigation preferences", () => {
  it("defaults to a collapsed tree and reveals only a newly active document path", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database);
    const root = listDocuments(database, owner.workspace.id)[0];
    const child = createChild(database, owner.user, owner.workspace.id, root.id);
    const documents = listDocuments(database, owner.workspace.id);

    expect(getWorkspaceNavigationPreference(database, {
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      documents,
      activeDocumentId: root.id,
    })).toMatchObject({
      expandedDocumentIds: [],
      lastActiveDocumentId: null,
      version: 0,
    });

    expect(getWorkspaceNavigationPreference(database, {
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      documents,
      activeDocumentId: child.id,
    }).expandedDocumentIds).toEqual([root.id]);
  });

  it("keeps expansion independent for each user and workspace and filters stale ids", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = createTestUser(database, { name: "First" });
    const second = createTestUser(database, { name: "Second" });
    database.prepare(
      `INSERT INTO workspace_members
       (id, workspace_id, user_id, role, created_at, access_role)
       VALUES (?, ?, ?, 'member', ?, 'viewer')`,
    ).run(crypto.randomUUID(), first.workspace.id, second.user.id, new Date().toISOString());
    const firstRoot = listDocuments(database, first.workspace.id)[0];
    const firstChild = createChild(database, first.user, first.workspace.id, firstRoot.id);
    const firstDocuments = listDocuments(database, first.workspace.id);
    const secondDocuments = listDocuments(database, second.workspace.id);

    saveWorkspaceNavigationPreference(database, {
      userId: first.user.id,
      workspaceId: first.workspace.id,
      documents: firstDocuments,
      expandedDocumentIds: [firstRoot.id, "missing-document", firstRoot.id],
      activeDocumentId: firstChild.id,
      expectedVersion: 0,
    });

    expect(getWorkspaceNavigationPreference(database, {
      userId: first.user.id,
      workspaceId: first.workspace.id,
      documents: firstDocuments,
      activeDocumentId: firstChild.id,
    })).toMatchObject({
      expandedDocumentIds: [firstRoot.id],
      version: 1,
    });
    expect(getWorkspaceNavigationPreference(database, {
      userId: first.user.id,
      workspaceId: first.workspace.id,
      documents: [firstRoot],
      activeDocumentId: firstRoot.id,
    })).toMatchObject({
      expandedDocumentIds: [firstRoot.id],
      lastActiveDocumentId: null,
      version: 1,
    });
    expect(getWorkspaceNavigationPreference(database, {
      userId: second.user.id,
      workspaceId: first.workspace.id,
      documents: firstDocuments,
      activeDocumentId: firstRoot.id,
    }).expandedDocumentIds).toEqual([]);
    expect(getWorkspaceNavigationPreference(database, {
      userId: first.user.id,
      workspaceId: second.workspace.id,
      documents: secondDocuments,
      activeDocumentId: secondDocuments[0].id,
    }).expandedDocumentIds).toEqual([]);
  });

  it("rejects a stale write instead of overwriting a newer session", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database);
    const root = listDocuments(database, owner.workspace.id)[0];
    const child = createChild(database, owner.user, owner.workspace.id, root.id);
    const documents = listDocuments(database, owner.workspace.id);

    const first = saveWorkspaceNavigationPreference(database, {
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      documents,
      expandedDocumentIds: [root.id],
      activeDocumentId: child.id,
      expectedVersion: 0,
    });
    expect(first.version).toBe(1);

    expect(() => saveWorkspaceNavigationPreference(database, {
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      documents,
      expandedDocumentIds: [],
      activeDocumentId: root.id,
      expectedVersion: 0,
    })).toThrow(/changed in another session/);

    expect(getWorkspaceNavigationPreference(database, {
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      documents,
      activeDocumentId: child.id,
    })).toMatchObject({
      expandedDocumentIds: [root.id],
      version: 1,
    });
  });
});
