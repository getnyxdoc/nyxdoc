import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import { runAppMigrations } from "@/lib/db/migrations";
import {
  archiveDocument,
  createDocument,
  restoreTrashedDocument,
} from "@/lib/documents/service";
import type { DocumentActor } from "@/lib/documents/types";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";
import {
  revokeDocumentHumanGrant,
  setDocumentHumanGrant,
} from "@/lib/sharing/access";
import {
  disableDocumentPublicShare,
  enableDocumentPublicShare,
} from "@/lib/sharing/service";
import { createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];
const directories: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function createConcurrentTestDatabases() {
  const directory = mkdtempSync(path.join(tmpdir(), "nyxdoc-human-auth-race-"));
  directories.push(directory);
  const databasePath = path.join(directory, "nyxdoc.db");
  const primary = openDatabase(databasePath);
  primary.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 1,
      image TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  runAppMigrations(primary);
  const concurrent = openDatabase(databasePath);
  databases.push(primary, concurrent);
  return { primary, concurrent };
}

function addWorkspaceEditor(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
) {
  database.prepare(
    `INSERT INTO workspace_members
     (id, workspace_id, user_id, role, access_role, created_at)
     VALUES (?, ?, ?, 'member', 'editor', ?)`,
  ).run(randomUUID(), workspaceId, userId, new Date().toISOString());
}

function setWorkspaceAccessRole(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
  role: "editor" | "viewer",
) {
  database.prepare(
    `UPDATE workspace_members
     SET access_role = ?
     WHERE workspace_id = ? AND user_id = ?`,
  ).run(role, workspaceId, userId);
}

function actor(user: { id: string; name: string }): DocumentActor {
  return {
    type: "human",
    userId: user.id,
    principalId: user.id,
    label: user.name,
    source: "web",
  };
}

function content(text: string): NyxdocDocumentV2 {
  return {
    schemaVersion: 2,
    blocks: [{ id: `block-${text}`, type: "p", children: [{ text }] }],
  };
}

describe("human document mutation authorization races", () => {
  it("does not create or disable a public token after share permission is revoked", () => {
    const { primary, concurrent } = createConcurrentTestDatabases();
    const owner = createTestUser(primary, { name: "Owner" });
    const editor = createTestUser(primary, { name: "Editor" });
    addWorkspaceEditor(primary, owner.workspace.id, editor.user.id);
    const document = primary.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at LIMIT 1",
    ).get(owner.workspace.id) as { id: string };

    requireHumanWorkspacePermission(
      primary,
      owner.workspace.id,
      editor.user.id,
      "documents.share",
    );
    setWorkspaceAccessRole(concurrent, owner.workspace.id, editor.user.id, "viewer");

    expect(() => enableDocumentPublicShare(primary, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      userId: editor.user.id,
      actorLabel: editor.user.name,
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(primary.prepare(
      "SELECT COUNT(*) AS count FROM document_public_shares WHERE document_id = ?",
    ).get(document.id)).toEqual({ count: 0 });
    expect(primary.prepare(
      `SELECT COUNT(*) AS count FROM workspace_audit_events
       WHERE workspace_id = ? AND action = 'document.public_share.created'`,
    ).get(owner.workspace.id)).toEqual({ count: 0 });

    setWorkspaceAccessRole(concurrent, owner.workspace.id, editor.user.id, "editor");
    const share = enableDocumentPublicShare(primary, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      userId: editor.user.id,
      actorLabel: editor.user.name,
    });
    expect(share.enabled).toBe(true);

    requireHumanWorkspacePermission(
      primary,
      owner.workspace.id,
      editor.user.id,
      "documents.share",
    );
    setWorkspaceAccessRole(concurrent, owner.workspace.id, editor.user.id, "viewer");
    expect(() => disableDocumentPublicShare(primary, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      userId: editor.user.id,
      actorLabel: editor.user.name,
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(primary.prepare(
      "SELECT enabled FROM document_public_shares WHERE id = ?",
    ).get(share.id)).toEqual({ enabled: 1 });
  });

  it("does not create or revoke a user grant after share permission is revoked", () => {
    const { primary, concurrent } = createConcurrentTestDatabases();
    const owner = createTestUser(primary, { name: "Owner" });
    const editor = createTestUser(primary, { name: "Editor" });
    const recipient = createTestUser(primary, { name: "Recipient" });
    addWorkspaceEditor(primary, owner.workspace.id, editor.user.id);
    const document = primary.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at LIMIT 1",
    ).get(owner.workspace.id) as { id: string };

    requireHumanWorkspacePermission(
      primary,
      owner.workspace.id,
      editor.user.id,
      "documents.share",
    );
    setWorkspaceAccessRole(concurrent, owner.workspace.id, editor.user.id, "viewer");

    expect(() => setDocumentHumanGrant(primary, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      recipientUserId: recipient.user.id,
      role: "editor",
      actorUserId: editor.user.id,
      actorLabel: editor.user.name,
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(primary.prepare(
      "SELECT COUNT(*) AS count FROM document_human_grants WHERE document_id = ?",
    ).get(document.id)).toEqual({ count: 0 });
    expect(primary.prepare(
      `SELECT COUNT(*) AS count FROM workspace_audit_events
       WHERE workspace_id = ? AND action = 'document.human_grant.created'`,
    ).get(owner.workspace.id)).toEqual({ count: 0 });

    setWorkspaceAccessRole(concurrent, owner.workspace.id, editor.user.id, "editor");
    setDocumentHumanGrant(primary, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      recipientUserId: recipient.user.id,
      role: "editor",
      actorUserId: editor.user.id,
      actorLabel: editor.user.name,
    });
    requireHumanWorkspacePermission(
      primary,
      owner.workspace.id,
      editor.user.id,
      "documents.share",
    );
    setWorkspaceAccessRole(concurrent, owner.workspace.id, editor.user.id, "viewer");
    expect(() => revokeDocumentHumanGrant(primary, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      recipientUserId: recipient.user.id,
      actorUserId: editor.user.id,
      actorLabel: editor.user.name,
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(primary.prepare(
      `SELECT role FROM document_human_grants
       WHERE document_id = ? AND user_id = ?`,
    ).get(document.id, recipient.user.id)).toEqual({ role: "editor" });
  });

  it("does not restore a trashed tree after restore permission is revoked", () => {
    const { primary, concurrent } = createConcurrentTestDatabases();
    const owner = createTestUser(primary, { name: "Owner" });
    const editor = createTestUser(primary, { name: "Editor" });
    addWorkspaceEditor(primary, owner.workspace.id, editor.user.id);
    const ownerActor = actor(owner.user);
    const root = createDocument(primary, owner.workspace.id, ownerActor, {
      title: "Trashed root",
      content: content("root"),
    }).document;
    const child = createDocument(primary, owner.workspace.id, ownerActor, {
      title: "Trashed child",
      parentDocumentId: root.id,
      content: content("child"),
    }).document;
    archiveDocument(primary, owner.workspace.id, ownerActor, root.id, {
      baseRevision: root.revisionNumber,
    });

    requireHumanWorkspacePermission(
      primary,
      owner.workspace.id,
      editor.user.id,
      "documents.restore",
    );
    setWorkspaceAccessRole(concurrent, owner.workspace.id, editor.user.id, "viewer");

    expect(() => restoreTrashedDocument(
      primary,
      owner.workspace.id,
      actor(editor.user),
      root.id,
    )).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(primary.prepare(
      `SELECT id, lifecycle_state
       FROM documents
       WHERE id IN (?, ?)
       ORDER BY id`,
    ).all(root.id, child.id)).toEqual(
      [root.id, child.id]
        .sort()
        .map((id) => ({ id, lifecycle_state: "trashed" })),
    );
    expect(primary.prepare(
      "SELECT COUNT(*) AS count FROM document_trash_batches WHERE root_document_id = ?",
    ).get(root.id)).toEqual({ count: 1 });
    expect(primary.prepare(
      `SELECT COUNT(*) AS count FROM workspace_audit_events
       WHERE workspace_id = ? AND action = 'document_trash.restored'`,
    ).get(owner.workspace.id)).toEqual({ count: 0 });

    setWorkspaceAccessRole(concurrent, owner.workspace.id, editor.user.id, "editor");
    expect(restoreTrashedDocument(
      primary,
      owner.workspace.id,
      actor(editor.user),
      root.id,
    )).toMatchObject({
      rootDocumentId: root.id,
      documentCount: 2,
    });
  });
});
