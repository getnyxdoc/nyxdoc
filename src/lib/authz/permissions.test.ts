import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { listWorkspaceAuditEvents } from "@/lib/authz/audit";
import {
  agentRoleAllows,
  getHumanDocumentPrincipal,
  getHumanWorkspacePrincipal,
  humanDocumentPrincipalAllows,
  humanRoleAllows,
  recordWorkspaceAuditEvent,
  requireHumanDocumentPermission,
  requireHumanWorkspacePermission,
} from "@/lib/authz/permissions";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("workspace RBAC", () => {
  it("maps legacy members to editors while preserving owners", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database);
    const member = createTestUser(database);
    database.prepare(
      `INSERT INTO workspace_members
       (id, workspace_id, user_id, role, access_role, created_at)
       VALUES (?, ?, ?, 'member', NULL, ?)`,
    ).run(randomUUID(), owner.workspace.id, member.user.id, new Date().toISOString());

    expect(getHumanWorkspacePrincipal(database, owner.workspace.id, owner.user.id)?.role).toBe("owner");
    expect(getHumanWorkspacePrincipal(database, owner.workspace.id, member.user.id)?.role).toBe("editor");
    expect(requireHumanWorkspacePermission(
      database,
      owner.workspace.id,
      member.user.id,
      "documents.update",
    ).role).toBe("editor");
    expect(() => requireHumanWorkspacePermission(
      database,
      owner.workspace.id,
      member.user.id,
      "credentials.manage",
    )).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("keeps management authority human-controlled", () => {
    expect(humanRoleAllows("owner", "backups.manage")).toBe(true);
    expect(humanRoleAllows("admin", "credentials.manage")).toBe(true);
    expect(agentRoleAllows("admin", "documents.update")).toBe(true);
    expect(agentRoleAllows("admin", "documents.trash")).toBe(true);
    expect(agentRoleAllows("admin", "admin_requests.create")).toBe(true);
    expect(agentRoleAllows("admin", "admin_requests.review")).toBe(false);
    expect(agentRoleAllows("admin", "credentials.manage")).toBe(false);
    expect(agentRoleAllows("admin", "agents.manage")).toBe(false);
    expect(agentRoleAllows("editor", "documents.trash_own")).toBe(true);
    expect(agentRoleAllows("editor", "documents.trash")).toBe(false);
    expect(agentRoleAllows("viewer", "documents.update")).toBe(false);
  });

  it("treats a trashed workspace as an access boundary even for its owner", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    database.prepare(
      "UPDATE workspaces SET lifecycle_state = 'trashed', trashed_at = ?, purge_after = ? WHERE id = ?",
    ).run(
      "2026-07-18T00:00:00.000Z",
      "2026-08-17T00:00:00.000Z",
      workspace.id,
    );

    expect(getHumanWorkspacePrincipal(database, workspace.id, user.id)).toBeNull();
    expect(() => requireHumanWorkspacePermission(
      database,
      workspace.id,
      user.id,
      "documents.read",
    )).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("allows a verified recipient to edit only the directly shared document", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database, { name: "Owner" });
    const recipient = createTestUser(database, { name: "Recipient" });
    const document = database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at LIMIT 1",
    ).get(owner.workspace.id) as { id: string };
    database.prepare(
      `INSERT INTO document_human_grants
       (id, workspace_id, document_id, user_id, role, created_by_user_id,
        created_by_label, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'editor', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      owner.workspace.id,
      document.id,
      recipient.user.id,
      owner.user.id,
      owner.user.name,
      "2026-07-20T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
    );

    expect(getHumanWorkspacePrincipal(
      database,
      owner.workspace.id,
      recipient.user.id,
    )).toBeNull();
    const principal = requireHumanDocumentPermission(
      database,
      owner.workspace.id,
      document.id,
      recipient.user.id,
      "documents.update",
    );
    expect(principal).toMatchObject({ role: "editor", source: "document_grant" });
    expect(humanDocumentPrincipalAllows(principal, "documents.commit")).toBe(true);
    expect(humanDocumentPrincipalAllows(principal, "documents.share")).toBe(false);
    expect(() => requireHumanDocumentPermission(
      database,
      owner.workspace.id,
      document.id,
      recipient.user.id,
      "documents.trash",
    )).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    database.prepare("UPDATE user SET emailVerified = 0 WHERE id = ?")
      .run(recipient.user.id);
    expect(getHumanDocumentPrincipal(
      database,
      owner.workspace.id,
      document.id,
      recipient.user.id,
    )).toBeNull();
  });

  it("paginates and filters immutable workspace audit events", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    recordWorkspaceAuditEvent(database, {
      workspaceId: workspace.id,
      action: "agent.created",
      actorType: "human",
      actorUserId: user.id,
      actorLabel: user.name,
      targetType: "agent",
      targetId: "agent-1",
      metadata: { role: "editor" },
    });
    recordWorkspaceAuditEvent(database, {
      workspaceId: workspace.id,
      action: "assignment.created",
      actorType: "agent",
      actorAgentId: "agent-1",
      actorLabel: "Gameroom",
      targetType: "assignment",
    });

    const filtered = listWorkspaceAuditEvents(database, workspace.id, {
      actionPrefix: "agent.",
      actorType: "human",
      limit: 10,
    });
    expect(filtered.events).toEqual([
      expect.objectContaining({
        action: "agent.created",
        actorType: "human",
        metadata: { role: "editor" },
      }),
    ]);
  });
});
