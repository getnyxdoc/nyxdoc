import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import {
  ApiTokenError,
  authenticateApiToken,
  createWorkspaceToken,
  requireTokenScope,
  requireTokenDocumentAccess,
  resolveTokenCreateParent,
  rotateWorkspaceAgentCredential,
  tokenCanAccessDocument,
  updateWorkspaceConnectionPermissions,
  updateWorkspaceAgent,
  revokeWorkspaceToken,
} from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("workspace API tokens", () => {
  it("returns the secret once, stores only a hash, authenticates, and revokes", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const created = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Codex",
    });
    expect(created.token).toMatch(/^nyx_live_[A-Za-z0-9_-]{40,}$/);

    const stored = database
      .prepare("SELECT token_hash, token_prefix FROM workspace_api_tokens WHERE id = ?")
      .get(created.summary.id) as { token_hash: string; token_prefix: string };
    expect(stored.token_hash).not.toContain(created.token);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.token.startsWith(stored.token_prefix)).toBe(true);

    expect(authenticateApiToken(database, `Bearer ${created.token}`)).toMatchObject({
      id: created.summary.id,
      agentId: created.summary.agentId,
      workspaceId: workspace.id,
      userId: user.id,
      name: "Codex",
    });
    revokeWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      tokenId: created.summary.id,
    });
    expect(() => authenticateApiToken(database, `Bearer ${created.token}`)).toThrowError(
      ApiTokenError,
    );
  });

  it("intersects credential scopes with the stable agent role", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const created = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Role bounded agent",
    });
    database.prepare("UPDATE workspace_agents SET role = 'viewer' WHERE id = ?")
      .run(created.summary.agentId);

    const identity = authenticateApiToken(database, `Bearer ${created.token}`);
    expect(identity.role).toBe("viewer");
    expect(() => requireTokenScope(identity, "documents:read")).not.toThrow();
    expect(() => requireTokenScope(identity, "documents:write"))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("rejects an otherwise valid credential when its workspace is trashed", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const created = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Workspace-bound agent",
    });
    database.prepare(
      "UPDATE workspaces SET lifecycle_state = 'trashed', trashed_at = ?, purge_after = ? WHERE id = ?",
    ).run(
      "2026-07-18T00:00:00.000Z",
      "2026-08-17T00:00:00.000Z",
      workspace.id,
    );

    expect(() => authenticateApiToken(database, `Bearer ${created.token}`))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("rotates credentials without changing the agent identity", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const created = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "gameroom-main",
    });
    const updated = updateWorkspaceAgent(database, {
      workspaceId: workspace.id,
      userId: user.id,
      agentId: created.summary.agentId,
      displayName: "Gameroom",
      role: "admin",
    });
    const rotated = rotateWorkspaceAgentCredential(database, {
      workspaceId: workspace.id,
      userId: user.id,
      agentId: created.summary.agentId,
    });

    expect(updated).toMatchObject({ displayName: "Gameroom", role: "admin" });
    expect(rotated.summary.agentId).toBe(created.summary.agentId);
    expect(rotated.summary.id).not.toBe(created.summary.id);
    expect(() => authenticateApiToken(database, `Bearer ${created.token}`)).toThrowError(ApiTokenError);
    expect(authenticateApiToken(database, `Bearer ${rotated.token}`)).toMatchObject({
      agentId: created.summary.agentId,
      name: "Gameroom",
      role: "admin",
    });
    expect(database.prepare(
      "SELECT action FROM workspace_audit_events WHERE workspace_id = ? ORDER BY cursor",
    ).all(workspace.id)).toEqual([
      { action: "agent.created" },
      { action: "agent.updated" },
      { action: "credential.rotated" },
    ]);
  });

  it("updates an existing key's role, scopes, and document boundary atomically", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const rootDocumentId = (database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1",
    ).get(workspace.id) as { id: string }).id;
    const created = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Editable connection",
      role: "viewer",
    });

    const updated = updateWorkspaceConnectionPermissions(database, {
      workspaceId: workspace.id,
      userId: user.id,
      tokenId: created.summary.id,
      role: "editor",
      scopes: ["documents:read", "documents:write", "documents:commit", "changes:read", "revisions:restore"],
      rootDocumentId,
    });
    expect(updated).toMatchObject({
      id: created.summary.id,
      agentId: created.summary.agentId,
      role: "editor",
      rootDocumentId,
    });
    expect(updated.scopes).toContain("revisions:restore");

    const identity = authenticateApiToken(database, `Bearer ${created.token}`);
    expect(identity).toMatchObject({
      id: created.summary.id,
      role: "editor",
      rootDocumentId,
    });
    expect(() => requireTokenScope(identity, "documents:write")).not.toThrow();
    expect(() => requireTokenScope(identity, "revisions:restore")).not.toThrow();
    expect(database.prepare(
      "SELECT action FROM workspace_audit_events WHERE workspace_id = ? ORDER BY cursor DESC LIMIT 1",
    ).get(workspace.id)).toEqual({ action: "connection.permissions_updated" });
  });

  it("limits a connection to one document subtree and keeps restore permission explicit", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const documents = database
      .prepare("SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at ASC")
      .all(workspace.id) as Array<{ id: string }>;
    const rootDocumentId = documents[0].id;
    const outsideDocumentId = createDocument(database, workspace.id, {
      type: "human",
      userId: user.id,
      label: user.name,
      source: "web",
    }, {
      title: "Outside document",
      content: {
        schemaVersion: 2,
        blocks: [{ id: randomUUID(), type: "p", children: [{ text: "Outside" }] }],
      },
    }).document.id;
    const childDocumentId = randomUUID();
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO documents
       (id, workspace_id, title, slug, status, current_revision_id, created_by_user_id,
        created_at, updated_at, parent_document_id, tree_order, content_schema_version,
        document_type, workflow_status, tags_json)
       VALUES (?, ?, '하위 문서', ?, 'active', NULL, ?, ?, ?, ?, 100, 1, NULL, 'draft', '[]')`,
    ).run(childDocumentId, workspace.id, `child-${childDocumentId}`, user.id, now, now, rootDocumentId);

    const created = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Scoped agent",
      rootDocumentId,
      scopes: ["documents:read", "documents:write", "changes:read"],
    });
    const identity = authenticateApiToken(database, `Bearer ${created.token}`);
    expect(identity.rootDocumentId).toBe(rootDocumentId);
    expect(identity.scopes).not.toContain("revisions:restore");
    expect(tokenCanAccessDocument(database, identity, childDocumentId)).toBe(true);
    expect(tokenCanAccessDocument(database, identity, outsideDocumentId)).toBe(false);
    expect(() => requireTokenDocumentAccess(database, identity, outsideDocumentId)).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(resolveTokenCreateParent(database, identity, null)).toBe(rootDocumentId);

    database.prepare("UPDATE documents SET status = 'archived' WHERE id = ?").run(childDocumentId);
    expect(tokenCanAccessDocument(database, identity, childDocumentId)).toBe(false);
    expect(tokenCanAccessDocument(database, identity, childDocumentId, true)).toBe(true);
  });
});
