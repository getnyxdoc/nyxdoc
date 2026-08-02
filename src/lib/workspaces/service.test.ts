import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import {
  createWorkspace,
  listUserTrashedWorkspaces,
  listUserWorkspaces,
  purgeWorkspace,
  resolveUserWorkspace,
  restoreWorkspace,
  trashWorkspace,
} from "@/lib/workspaces/service";
import { setDocumentHumanGrant } from "@/lib/sharing/access";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("workspace service", () => {
  it("creates and explicitly resolves independent workspaces", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace: personal } = createTestUser(database);
    const gameroom = createWorkspace(database, user, "gameroom");

    expect(listUserWorkspaces(database, user.id).map((workspace) => workspace.id))
      .toEqual(expect.arrayContaining([personal.id, gameroom.id]));
    expect(resolveUserWorkspace(database, user, { selector: gameroom.id }).id).toBe(gameroom.id);
    expect(resolveUserWorkspace(database, user, { selector: gameroom.slug }).id).toBe(gameroom.id);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ? AND status = 'active'",
    ).get(gameroom.id)).toEqual({ count: 1 });
  });

  it("uses a stable document URL to infer the correct workspace even when a selector is stale", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace: personal } = createTestUser(database);
    const second = createWorkspace(database, user, "second");
    const document = database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? LIMIT 1",
    ).get(second.id) as { id: string };

    expect(resolveUserWorkspace(database, user, {
      documentId: document.id,
      selector: personal.id,
    }).id).toBe(second.id);
  });

  it("discovers a directly shared document without turning it into workspace membership", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database, {
      name: "Owner",
      email: "owner@example.com",
    });
    const recipient = createTestUser(database, {
      name: "Recipient",
      email: "recipient@example.com",
    });
    const document = database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? LIMIT 1",
    ).get(owner.workspace.id) as { id: string };
    setDocumentHumanGrant(database, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      recipientUserId: recipient.user.id,
      role: "viewer",
      actorUserId: owner.user.id,
      actorLabel: owner.user.name,
    });

    expect(listUserWorkspaces(database, recipient.user.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: owner.workspace.id,
        role: "viewer",
        accessSource: "document_grant",
      }),
    ]));
    expect(resolveUserWorkspace(database, recipient.user, {
      documentId: document.id,
    })).toMatchObject({
      id: owner.workspace.id,
      accessSource: "document_grant",
    });
    expect(database.prepare(
      "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).get(owner.workspace.id, recipient.user.id)).toBeUndefined();
    expect(() => resolveUserWorkspace(database, recipient.user, {
      selector: owner.workspace.id,
      membershipOnly: true,
    })).toThrowError("워크스페이스를 찾을 수 없습니다.");
  });

  it("trashes a workspace as an access boundary and restores the complete workspace", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user } = createTestUser(database);
    const gameroom = createWorkspace(database, user, "gameroom");
    const documentCount = database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
    ).get(gameroom.id);

    const result = trashWorkspace(database, {
      workspaceId: gameroom.id,
      userId: user.id,
      actorLabel: user.name,
      confirmationName: "gameroom",
    });

    expect(result.workspace.lifecycleState).toBe("trashed");
    expect(result.nextWorkspaceId).not.toBe(gameroom.id);
    expect(listUserWorkspaces(database, user.id).some((item) => item.id === gameroom.id)).toBe(false);
    expect(listUserTrashedWorkspaces(database, user.id)).toMatchObject([{
      id: gameroom.id,
      name: "gameroom",
      lifecycleState: "trashed",
    }]);
    expect(() => resolveUserWorkspace(database, user, { selector: gameroom.id }))
      .toThrowError("워크스페이스를 찾을 수 없습니다.");
    expect(resolveUserWorkspace(database, user, {
      selector: gameroom.id,
      fallbackOnMissingSelector: true,
    }).id).toBe(result.nextWorkspaceId);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
    ).get(gameroom.id)).toEqual(documentCount);

    const restored = restoreWorkspace(database, {
      workspaceId: gameroom.id,
      userId: user.id,
      actorLabel: user.name,
    });
    expect(restored.lifecycleState).toBe("active");
    expect(resolveUserWorkspace(database, user, { selector: gameroom.id }).id).toBe(gameroom.id);
    expect(listUserTrashedWorkspaces(database, user.id)).toEqual([]);
    expect(database.prepare(
      "SELECT action FROM workspace_audit_events WHERE workspace_id = ? ORDER BY cursor",
    ).all(gameroom.id)).toEqual([
      { action: "workspace.created" },
      { action: "workspace.trashed" },
      { action: "workspace.restored" },
    ]);
  });

  it("does not allow deleting the user's final active workspace", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);

    expect(() => trashWorkspace(database, {
      workspaceId: workspace.id,
      userId: user.id,
      actorLabel: user.name,
      confirmationName: workspace.name,
    })).toThrowError("마지막 워크스페이스는 삭제할 수 없습니다.");
  });

  it("permanently purges only a trashed workspace and preserves a backup tombstone", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user } = createTestUser(database);
    const workspace = createWorkspace(database, user, "temporary");
    trashWorkspace(database, {
      workspaceId: workspace.id,
      userId: user.id,
      actorLabel: user.name,
      confirmationName: workspace.name,
    });

    const purged = purgeWorkspace(database, {
      workspaceId: workspace.id,
      userId: user.id,
      actorLabel: user.name,
      confirmationName: workspace.name,
      backupGenerationId: "verified-backup-generation",
    });

    expect(purged).toMatchObject({
      id: workspace.id,
      lifecycleState: "purged",
      backupGenerationId: "verified-backup-generation",
      counts: { documents: 1, members: 1, media: 0 },
    });
    expect(database.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(workspace.id)).toBeUndefined();
    expect(database.prepare(
      `SELECT workspace_id, name_snapshot, backup_generation_id, document_count
       FROM workspace_purge_tombstones WHERE workspace_id = ?`,
    ).get(workspace.id)).toEqual({
      workspace_id: workspace.id,
      name_snapshot: workspace.name,
      backup_generation_id: "verified-backup-generation",
      document_count: 1,
    });
  });
});
