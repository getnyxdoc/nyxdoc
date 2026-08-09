import { afterEach, describe, expect, it } from "vitest";
import { requireCurrentCollaborationAuthorization } from "@/lib/collaboration/authorization";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import {
  authenticateApiToken,
  createWorkspaceToken,
  tokenDocumentActor,
} from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const credential = createWorkspaceToken(database, {
    workspaceId: workspace.id,
    userId: user.id,
    name: "Boundary agent",
    role: "admin",
    scopes: ["documents:read", "documents:write", "documents:commit", "revisions:restore"],
  });
  const identity = authenticateApiToken(database, `Bearer ${credential.token}`);
  const document = createDocument(
    database,
    workspace.id,
    tokenDocumentActor(identity, "mcp"),
    {
      requestId: "collaboration-auth-document-001",
      title: "Authorization boundary",
      content: {
        schemaVersion: 2,
        blocks: [{ id: "body", type: "p", children: [{ text: "body" }] }],
      },
    },
  ).document;
  return {
    database,
    user,
    workspace,
    identity,
    document,
    actor: { ...tokenDocumentActor(identity, "mcp") },
  };
}

describe("current collaboration authorization", () => {
  it("rejects an agent immediately after its grant loses update capability", () => {
    const value = fixture();
    requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      value.actor,
      "draft.update",
    );

    value.database.prepare(
      "UPDATE workspace_agents SET access_profile = 'reader', capabilities_json = ? WHERE id = ?",
    ).run(JSON.stringify(["documents.read"]), value.identity.agentId);

    expect(() => requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      value.actor,
      "draft.update",
    )).toThrowError(DocumentServiceError);
  });

  it("requires the current commit scope and capability at the inner boundary", () => {
    const value = fixture();
    value.database.prepare(
      "UPDATE workspace_agents SET access_profile = 'custom', capabilities_json = ? WHERE id = ?",
    ).run(
      JSON.stringify(["documents.read", "documents.update"]),
      value.identity.agentId,
    );

    requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      value.actor,
      "draft.update",
    );
    expect(() => requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      value.actor,
      "canonical.commit",
    )).toThrowError(DocumentServiceError);
  });

  it("requires the current revision restore capability before replacing a draft", () => {
    const value = fixture();
    requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      value.actor,
      "draft.restore",
    );

    value.database.prepare(
      "UPDATE workspace_agents SET access_profile = 'custom', capabilities_json = ? WHERE id = ?",
    ).run(
      JSON.stringify(["documents.read", "documents.update"]),
      value.identity.agentId,
    );

    expect(() => requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      value.actor,
      "draft.restore",
    )).toThrowError(DocumentServiceError);
  });

  it("does not regain broad credential scopes when an OAuth actor is reauthenticated", () => {
    const value = fixture();
    const oauthActor = {
      ...value.actor,
      scopeCeiling: Object.freeze(["documents:read"] as const),
    };

    expect(() => requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      oauthActor,
      "draft.update",
    )).toThrowError(DocumentServiceError);
  });

  it("reuses the connection client IP when reauthenticating an agent", () => {
    const value = fixture();
    value.database.prepare(
      "UPDATE agent_credentials SET ip_allowlist_json = ? WHERE id = ?",
    ).run(JSON.stringify(["127.0.0.1/32"]), value.identity.id);

    const allowedRequestActor = {
      ...value.actor,
      requestContext: Object.freeze({ clientIp: "127.0.0.1" }),
    };
    requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      allowedRequestActor,
      "draft.update",
    );
    requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      { ...value.actor, requestContext: Object.freeze({ clientIp: "203.0.113.10" }) },
      "draft.update",
      { clientIp: "127.0.0.1" },
    );
    expect(() => requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      allowedRequestActor,
      "draft.update",
      { clientIp: "203.0.113.10" },
    )).toThrowError(DocumentServiceError);
  });

  it("rejects a human immediately after document access is revoked", () => {
    const value = fixture();
    const actor = {
      type: "human" as const,
      userId: value.user.id,
      principalId: value.user.id,
      label: value.user.name,
      source: "web" as const,
    };
    requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      actor,
      "canonical.commit",
    );
    value.database.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).run(value.workspace.id, value.user.id);

    expect(() => requireCurrentCollaborationAuthorization(
      value.database,
      value.workspace.id,
      value.document.id,
      actor,
      "canonical.commit",
    )).toThrowError(DocumentServiceError);
  });
});
