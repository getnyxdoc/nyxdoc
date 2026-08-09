import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { updateAgentWorkspaceMembership } from "@/lib/agents/service";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import {
  createDocument,
  getChanges,
  listDocuments,
  reorderDocumentTree,
} from "@/lib/documents/service";
import type { DocumentActor } from "@/lib/documents/types";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import {
  authenticateAgentCredential,
  createWorkspaceToken,
  requireTokenPermission,
  tokenDocumentActor,
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

function siblingOrder(database: NyxDatabase, workspaceId: string, parentDocumentId: string) {
  return listDocuments(database, workspaceId)
    .filter((document) => document.parentDocumentId === parentDocumentId)
    .map((document) => [document.id, document.treeOrder]);
}

describe("document mutation application-consistency boundaries", () => {
  it("preserves a verified client IP for service reauthentication and ignores an unsigned actor IP", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "IP bounded creator",
    });
    database.prepare(
      "UPDATE agent_credentials SET ip_allowlist_json = ? WHERE id = ?",
    ).run(JSON.stringify(["203.0.113.0/24"]), token.summary.id);

    const identity = authenticateAgentCredential(database, token.summary.id, {
      workspaceId: workspace.id,
      clientIp: "203.0.113.77",
    });
    expect(identity.requestContext).toEqual({ clientIp: "203.0.113.77" });
    expect(Object.isFrozen(identity.requestContext)).toBe(true);

    const actor = tokenDocumentActor(identity, "api");
    expect(() => createDocument(database, workspace.id, actor, {
      requestId: "allowed-ip-create-001",
      title: "Allowed IP document",
      content: content("allowed"),
    })).not.toThrow();

    expect(() => authenticateAgentCredential(database, token.summary.id, {
      workspaceId: workspace.id,
      clientIp: "198.51.100.10",
    })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));

    const { requestContext: _verifiedContext, ...actorWithoutContext } = actor;
    expect(_verifiedContext).toBe(identity.requestContext);
    const unsignedIpActor = {
      ...actorWithoutContext,
      // Public callers must never be able to turn an arbitrary actor.clientIp
      // field into trusted request context.
      clientIp: "203.0.113.77",
    } as DocumentActor & { clientIp: string };
    expect(() => createDocument(database, workspace.id, unsignedIpActor, {
      requestId: "unsigned-ip-create-001",
      title: "Unsigned IP document",
      content: content("denied"),
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("rejects create after a route-authenticated agent loses documents.create", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Downgraded creator",
    });
    const staleIdentity = authenticateAgentCredential(database, token.summary.id, {
      workspaceId: workspace.id,
    });
    requireTokenPermission(staleIdentity, "documents:write", "documents.create");
    const staleActor = tokenDocumentActor(staleIdentity, "api");

    updateAgentWorkspaceMembership(database, {
      workspaceId: workspace.id,
      userId: user.id,
      agentId: staleIdentity.globalAgentId,
      accessProfile: "custom",
      capabilities: ["documents.read"],
      rootDocumentId: null,
    });
    const cursorBefore = getChanges(database, workspace.id, 0, 100).headCursor;

    expect(() => createDocument(database, workspace.id, staleActor, {
      requestId: "downgraded-create-race-001",
      title: "Must not be created",
      content: content("denied"),
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ? AND title = ?",
    ).get(workspace.id, "Must not be created")).toEqual({ count: 0 });
    expect(getChanges(database, workspace.id, cursorBefore, 100)).toMatchObject({
      headCursor: cursorBefore,
      events: [],
    });
  });

  it("rolls back a same-parent human reorder after the route precheck grant is downgraded", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database);
    const member = createTestUser(database);
    const ownerActor = {
      type: "human" as const,
      userId: owner.user.id,
      label: owner.user.name,
      source: "web" as const,
    };
    const parent = createDocument(database, owner.workspace.id, ownerActor, {
      title: "Human reorder parent",
      content: content("parent"),
    });
    const first = createDocument(database, owner.workspace.id, ownerActor, {
      title: "Human reorder first",
      parentDocumentId: parent.document.id,
      content: content("first"),
    });
    const second = createDocument(database, owner.workspace.id, ownerActor, {
      title: "Human reorder second",
      parentDocumentId: parent.document.id,
      content: content("second"),
    });
    database.prepare(
      `INSERT INTO workspace_members
       (id, workspace_id, user_id, role, access_role, created_at)
       VALUES (?, ?, ?, 'member', 'editor', ?)`,
    ).run(randomUUID(), owner.workspace.id, member.user.id, new Date().toISOString());
    requireHumanWorkspacePermission(
      database,
      owner.workspace.id,
      member.user.id,
      "documents.update",
    );
    database.prepare(
      "UPDATE workspace_members SET access_role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
    ).run(owner.workspace.id, member.user.id);
    const orderBefore = siblingOrder(database, owner.workspace.id, parent.document.id);
    const cursorBefore = getChanges(database, owner.workspace.id, 0, 100).headCursor;

    expect(() => reorderDocumentTree(database, owner.workspace.id, {
      type: "human",
      userId: member.user.id,
      label: member.user.name,
      source: "web",
    }, second.document.id, {
      targetDocumentId: first.document.id,
      position: "before",
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(siblingOrder(database, owner.workspace.id, parent.document.id)).toEqual(orderBefore);
    expect(getChanges(database, owner.workspace.id, cursorBefore, 100)).toMatchObject({
      headCursor: cursorBefore,
      events: [],
    });
  });

  it("rolls back a same-parent agent reorder after its capability is downgraded", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const human = {
      type: "human" as const,
      userId: user.id,
      label: user.name,
      source: "web" as const,
    };
    const parent = createDocument(database, workspace.id, human, {
      title: "Agent reorder parent",
      content: content("parent"),
    });
    const first = createDocument(database, workspace.id, human, {
      title: "Agent reorder first",
      parentDocumentId: parent.document.id,
      content: content("first"),
    });
    const second = createDocument(database, workspace.id, human, {
      title: "Agent reorder second",
      parentDocumentId: parent.document.id,
      content: content("second"),
    });
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Downgraded reordering agent",
    });
    const staleIdentity = authenticateAgentCredential(database, token.summary.id, {
      workspaceId: workspace.id,
    });
    requireTokenPermission(staleIdentity, "documents:write", "documents.update");
    const staleActor = tokenDocumentActor(staleIdentity, "api");
    updateAgentWorkspaceMembership(database, {
      workspaceId: workspace.id,
      userId: user.id,
      agentId: staleIdentity.globalAgentId,
      accessProfile: "custom",
      capabilities: ["documents.read"],
      rootDocumentId: null,
    });
    const orderBefore = siblingOrder(database, workspace.id, parent.document.id);
    const cursorBefore = getChanges(database, workspace.id, 0, 100).headCursor;

    expect(() => reorderDocumentTree(database, workspace.id, staleActor, second.document.id, {
      targetDocumentId: first.document.id,
      position: "before",
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(siblingOrder(database, workspace.id, parent.document.id)).toEqual(orderBefore);
    expect(getChanges(database, workspace.id, cursorBefore, 100)).toMatchObject({
      headCursor: cursorBefore,
      events: [],
    });
  });
});
