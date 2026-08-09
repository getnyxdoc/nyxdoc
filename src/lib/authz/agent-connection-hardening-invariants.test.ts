import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
  updateAgentCredential,
  updateAgentWorkspaceMembership,
} from "@/lib/agents/service";
import {
  getActiveWorkspaceAgentGrant,
  workspaceAgentGrantCanAccessDocument,
} from "@/lib/agents/workspace-grant-boundary";
import {
  listAgentProfilePermissions,
  type AgentAccessProfile,
  type WorkspacePermission,
} from "@/lib/authz/permissions";
import { reviewAdminAction } from "@/lib/admin-requests/service";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import {
  McpOAuthError,
  provisionMcpOAuthGrant,
  resolveMcpOAuthIdentity,
  validateMcpOAuthGrantProvisioning,
} from "@/lib/mcp/oauth";
import { createNyxdocMcpServer } from "@/lib/mcp/server";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  ApiTokenError,
  authenticateApiToken,
  listApiTokenWorkspaceIdentities,
  requireTokenDocumentAccess,
  requireTokenPermission,
  tokenCanAccessDocument,
  type ApiTokenIdentity,
} from "@/lib/tokens/service";
import { createWorkspace } from "@/lib/workspaces/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function createPage(
  database: NyxDatabase,
  workspaceId: string,
  user: { id: string; name: string },
  title: string,
  parentDocumentId: string | null = null,
) {
  return createDocument(database, workspaceId, {
    type: "human",
    userId: user.id,
    label: user.name,
    source: "web",
  }, {
    title,
    parentDocumentId,
    content: {
      schemaVersion: 2,
      blocks: [{ id: randomUUID(), type: "p", children: [{ text: title }] }],
    },
  }).document.id;
}

async function connectMcp(database: NyxDatabase, identity: ApiTokenIdentity) {
  const server = createNyxdocMcpServer(database, identity);
  const client = new Client({ name: "auth-hardening-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function authenticationCode(
  database: NyxDatabase,
  token: string,
  workspaceId?: string,
) {
  try {
    authenticateApiToken(database, `Bearer ${token}`, { workspaceId });
    return null;
  } catch (error) {
    if (error instanceof ApiTokenError) return error.code;
    throw error;
  }
}

type AuthorizationFixture = ReturnType<typeof createAuthorizationFixture>;

function createAuthorizationFixture(input: {
  accessProfile?: AgentAccessProfile;
  capabilities?: WorkspacePermission[];
  rootDocumentId?: "root" | null;
} = {}) {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const foreignWorkspace = createWorkspace(database, user, "Foreign authorization workspace", "en");
  const rootDocumentId = createPage(database, workspace.id, user, "Authorization root");
  const childDocumentId = createPage(database, workspace.id, user, "Authorization child", rootDocumentId);
  const outsideDocumentId = createPage(database, workspace.id, user, "Authorization sibling");
  const foreignDocumentId = createPage(database, foreignWorkspace.id, user, "Foreign document");
  const agent = createAccountAgent(database, {
    userId: user.id,
    displayName: "Authorization matrix agent",
  });
  const accessProfile = input.accessProfile ?? "custom";
  const grant = assignAgentToWorkspace(database, {
    userId: user.id,
    workspaceId: workspace.id,
    agentId: agent.id,
    accessProfile,
    capabilities: input.capabilities ?? (accessProfile === "custom"
      ? ["documents.read", "documents.update", "documents.commit"]
      : listAgentProfilePermissions(accessProfile)),
    rootDocumentId: input.rootDocumentId === "root" ? rootDocumentId : null,
  });
  const created = createAgentCredential(database, {
    userId: user.id,
    agentId: agent.id,
    name: "Authorization matrix key",
    scopes: ["documents:read", "documents:write", "documents:commit", "changes:read"],
    defaultWorkspaceId: workspace.id,
    workspaceAllowlist: [workspace.id],
  });
  return {
    database,
    user,
    workspace,
    foreignWorkspace,
    rootDocumentId,
    childDocumentId,
    outsideDocumentId,
    foreignDocumentId,
    agent,
    grant,
    credential: created.credential,
    token: created.token,
    bindingId: created.credential.bindings.find(
      (binding) => binding.grantId === grant.membershipId,
    )!.id,
  };
}

function coreReadDecision(fixture: AuthorizationFixture, documentId: string) {
  try {
    const identity = authenticateApiToken(fixture.database, `Bearer ${fixture.token}`, {
      workspaceId: fixture.workspace.id,
    });
    requireTokenPermission(identity, "documents:read", "documents.read");
    requireTokenDocumentAccess(fixture.database, identity, documentId);
    return true;
  } catch (error) {
    if (error instanceof ApiTokenError) return false;
    throw error;
  }
}

function restReadDecision(fixture: AuthorizationFixture, documentId: string) {
  try {
    const identity = authenticateRequestApiToken(fixture.database, new Request(
      `https://nyxdoc.test/api/v1/documents/${documentId}`,
      {
        headers: {
          authorization: `Bearer ${fixture.token}`,
          "x-nyxdoc-workspace-id": fixture.workspace.id,
        },
      },
    ));
    requireTokenPermission(identity, "documents:read", "documents.read");
    requireTokenDocumentAccess(fixture.database, identity, documentId);
    return true;
  } catch (error) {
    if (error instanceof ApiTokenError) return false;
    throw error;
  }
}

async function mcpReadDecision(fixture: AuthorizationFixture, documentId: string) {
  let identity: ApiTokenIdentity;
  try {
    identity = authenticateApiToken(fixture.database, `Bearer ${fixture.token}`, {
      workspaceId: fixture.workspace.id,
    });
  } catch (error) {
    if (error instanceof ApiTokenError) return false;
    throw error;
  }
  const mcp = await connectMcp(fixture.database, identity);
  try {
    const result = await mcp.client.callTool({
      name: "get_document",
      arguments: { documentId },
    });
    return result.isError !== true;
  } finally {
    await mcp.close();
  }
}

async function expectReadDecisionAcrossSurfaces(
  fixture: AuthorizationFixture,
  documentId: string,
  expected: boolean,
) {
  expect(coreReadDecision(fixture, documentId)).toBe(expected);
  expect(restReadDecision(fixture, documentId)).toBe(expected);
  expect(await mcpReadDecision(fixture, documentId)).toBe(expected);
}

const lifecycleAuthorizationScenarios: Array<{
  name: string;
  allowed: boolean;
  mutate: (fixture: AuthorizationFixture) => void;
}> = [
  { name: "all canonical layers active", allowed: true, mutate: () => undefined },
  {
    name: "global identity disabled",
    allowed: false,
    mutate: ({ database, agent }) => {
      database.prepare("UPDATE agents SET status = 'disabled' WHERE id = ?").run(agent.id);
    },
  },
  {
    name: "global identity deletion-tombstoned despite stale active status",
    allowed: false,
    mutate: ({ database, agent }) => {
      database.prepare("UPDATE agents SET deleted_at = ? WHERE id = ?")
        .run("2026-08-09T00:00:00.000Z", agent.id);
    },
  },
  {
    name: "global identity purge-tombstoned despite stale active status",
    allowed: false,
    mutate: ({ database, agent }) => {
      database.prepare("UPDATE agents SET purged_at = ? WHERE id = ?")
        .run("2026-08-09T00:00:00.000Z", agent.id);
    },
  },
  {
    name: "credential revoked",
    allowed: false,
    mutate: ({ database, credential }) => {
      database.prepare("UPDATE agent_credentials SET revoked_at = ? WHERE id = ?")
        .run("2026-08-09T00:00:00.000Z", credential.id);
    },
  },
  {
    name: "credential expired",
    allowed: false,
    mutate: ({ database, credential }) => {
      database.prepare("UPDATE agent_credentials SET expires_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", credential.id);
    },
  },
  {
    name: "credential-to-grant binding revoked",
    allowed: false,
    mutate: ({ database, bindingId }) => {
      database.prepare(
        "UPDATE agent_credential_grant_bindings SET status = 'revoked', revoked_at = ? WHERE id = ?",
      ).run("2026-08-09T00:00:00.000Z", bindingId);
    },
  },
  {
    name: "workspace grant disabled",
    allowed: false,
    mutate: ({ database, grant }) => {
      database.prepare("UPDATE workspace_agents SET status = 'disabled' WHERE id = ?")
        .run(grant.membershipId);
    },
  },
  {
    name: "workspace grant revoked",
    allowed: false,
    mutate: ({ database, grant }) => {
      database.prepare("UPDATE workspace_agents SET revoked_at = ? WHERE id = ?")
        .run("2026-08-09T00:00:00.000Z", grant.membershipId);
    },
  },
  {
    name: "workspace trashed",
    allowed: false,
    mutate: ({ database, workspace }) => {
      database.prepare("UPDATE workspaces SET lifecycle_state = 'trashed' WHERE id = ?")
        .run(workspace.id);
    },
  },
];

describe("authorization and agent connection hardening invariants", () => {
  it("rejects a credential binding to a different global agent at the database boundary", () => {
    const fixture = createAuthorizationFixture();
    const otherAgent = createAccountAgent(fixture.database, {
      userId: fixture.user.id,
      displayName: "Different authorization agent",
    });
    const otherGrant = assignAgentToWorkspace(fixture.database, {
      userId: fixture.user.id,
      workspaceId: fixture.workspace.id,
      agentId: otherAgent.id,
      accessProfile: "reader",
      rootDocumentId: null,
    });

    expect(() => fixture.database.prepare(
      "UPDATE agent_credential_grant_bindings SET grant_id = ? WHERE id = ?",
    ).run(otherGrant.membershipId, fixture.bindingId))
      .toThrowError(/credential binding must belong to the same agent grant/);
  });

  it.each(lifecycleAuthorizationScenarios)(
    "keeps core, REST, and MCP lifecycle decisions aligned: $name",
    async (scenario) => {
      const fixture = createAuthorizationFixture();
      scenario.mutate(fixture);
      await expectReadDecisionAcrossSurfaces(
        fixture,
        fixture.rootDocumentId,
        scenario.allowed,
      );
    },
  );

  it("keeps document-tree and tenant boundaries identical across core, REST, and MCP", async () => {
    const scoped = createAuthorizationFixture({ rootDocumentId: "root" });
    for (const [documentId, expected] of [
      [scoped.rootDocumentId, true],
      [scoped.childDocumentId, true],
      [scoped.outsideDocumentId, false],
      [scoped.foreignDocumentId, false],
    ] as const) {
      await expectReadDecisionAcrossSurfaces(scoped, documentId, expected);
    }

    const workspaceWide = createAuthorizationFixture();
    await expectReadDecisionAcrossSurfaces(
      workspaceWide,
      workspaceWide.foreignDocumentId,
      false,
    );
  });

  it.each([
    { profile: "reader", read: true, update: false, commit: false },
    { profile: "drafter", read: true, update: true, commit: false },
    { profile: "writer", read: true, update: true, commit: true },
  ] as const)(
    "intersects broad credential scopes with the $profile grant capability set",
    ({ profile, read, update, commit }) => {
      const fixture = createAuthorizationFixture({ accessProfile: profile });
      const identity = authenticateApiToken(fixture.database, `Bearer ${fixture.token}`);
      for (const [scope, permission, expected] of [
        ["documents:read", "documents.read", read],
        ["documents:write", "documents.update", update],
        ["documents:commit", "documents.commit", commit],
      ] as const) {
        const decision = () => requireTokenPermission(identity, scope, permission);
        if (expected) expect(decision).not.toThrow();
        else expect(decision).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
      }
    },
  );

  it("denies empty credential scopes and grant capabilities by default", () => {
    const fixture = createAuthorizationFixture();
    fixture.database.prepare("UPDATE agent_credentials SET scopes_json = '[]' WHERE id = ?")
      .run(fixture.credential.id);
    fixture.database.prepare("UPDATE workspace_agents SET capabilities_json = '[]' WHERE id = ?")
      .run(fixture.grant.membershipId);
    const identity = authenticateApiToken(fixture.database, `Bearer ${fixture.token}`);

    expect(identity.scopes).toEqual([]);
    expect(identity.capabilities).toEqual([]);
    expect(() => requireTokenPermission(identity, "documents:read", "documents.read"))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it.each(lifecycleAuthorizationScenarios.filter((scenario) => !scenario.allowed))(
    "does not retain a cached workspace or document projection after $name",
    (scenario) => {
      const fixture = createAuthorizationFixture();
      const identity = authenticateApiToken(fixture.database, `Bearer ${fixture.token}`);
      scenario.mutate(fixture);

      expect(listApiTokenWorkspaceIdentities(fixture.database, identity)).toEqual([]);
      expect(tokenCanAccessDocument(
        fixture.database,
        identity,
        fixture.rootDocumentId,
      )).toBe(false);
    },
  );

  it("re-reads a narrowed credential scope and document-tree grant instead of widening stale access", async () => {
    const fixture = createAuthorizationFixture();
    const staleIdentity = authenticateApiToken(fixture.database, `Bearer ${fixture.token}`);
    expect(tokenCanAccessDocument(
      fixture.database,
      staleIdentity,
      fixture.outsideDocumentId,
    )).toBe(true);

    fixture.database.prepare(
      `UPDATE agent_credentials
       SET scopes_json = '["documents:read"]'
       WHERE id = ?`,
    ).run(fixture.credential.id);
    fixture.database.prepare(
      `UPDATE workspace_agents
       SET access_profile = 'reader', capabilities_json = '["documents.read"]',
           scope_mode = 'document_tree', root_document_id = ?, policy_version = policy_version + 1
       WHERE id = ?`,
    ).run(fixture.rootDocumentId, fixture.grant.membershipId);

    const [current] = listApiTokenWorkspaceIdentities(fixture.database, staleIdentity);
    expect(current?.identity).toMatchObject({
      scopes: ["documents:read"],
      capabilities: ["documents.read"],
      scopeMode: "document_tree",
      rootDocumentId: fixture.rootDocumentId,
    });
    expect(tokenCanAccessDocument(
      fixture.database,
      staleIdentity,
      fixture.rootDocumentId,
    )).toBe(true);
    expect(tokenCanAccessDocument(
      fixture.database,
      staleIdentity,
      fixture.outsideDocumentId,
    )).toBe(false);

    const mcp = await connectMcp(fixture.database, staleIdentity);
    try {
      expect((await mcp.client.callTool({
        name: "get_document",
        arguments: { documentId: fixture.rootDocumentId },
      })).isError).not.toBe(true);
      expect((await mcp.client.callTool({
        name: "get_document",
        arguments: { documentId: fixture.outsideDocumentId },
      })).isError).toBe(true);
      expect((await mcp.client.callTool({
        name: "create_document",
        arguments: {
          requestId: randomUUID(),
          workspaceId: fixture.workspace.id,
          title: "Denied after scope narrowing",
          content: {
            schemaVersion: 2,
            blocks: [{ id: randomUUID(), type: "p", children: [{ text: "Denied" }] }],
          },
        },
      })).isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it("intersects one global key with explicit per-workspace bindings, scopes, and capabilities", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace: primary } = createTestUser(database);
    const secondary = createWorkspace(database, user, "Secondary", "en");
    const unbound = createWorkspace(database, user, "Unbound", "en");
    const agent = createAccountAgent(database, {
      userId: user.id,
      displayName: "Shared authorization agent",
    });
    const primaryGrant = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: primary.id,
      agentId: agent.id,
      accessProfile: "custom",
      capabilities: ["documents.read", "documents.update"],
      rootDocumentId: null,
    });
    const secondaryGrant = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: secondary.id,
      agentId: agent.id,
      accessProfile: "reader",
      rootDocumentId: null,
    });
    assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: unbound.id,
      agentId: agent.id,
      accessProfile: "writer",
      rootDocumentId: null,
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Shared key",
      scopes: ["documents:read", "documents:write", "documents:commit", "changes:read"],
      defaultWorkspaceId: primary.id,
      workspaceAllowlist: [primary.id, secondary.id],
    });

    const primaryIdentity = authenticateApiToken(database, `Bearer ${created.token}`);
    const secondaryIdentity = authenticateApiToken(database, `Bearer ${created.token}`, {
      workspaceId: secondary.id,
    });
    expect(primaryIdentity).toMatchObject({
      id: created.credential.id,
      globalAgentId: agent.id,
      agentId: primaryGrant.membershipId,
      workspaceId: primary.id,
    });
    expect(secondaryIdentity).toMatchObject({
      id: created.credential.id,
      globalAgentId: agent.id,
      agentId: secondaryGrant.membershipId,
      workspaceId: secondary.id,
    });
    expect(primaryIdentity.agentId).not.toBe(secondaryIdentity.agentId);
    expect(() => requireTokenPermission(
      primaryIdentity,
      "documents:write",
      "documents.update",
    )).not.toThrow();
    expect(() => requireTokenPermission(
      primaryIdentity,
      "documents:write",
      "documents.create",
    )).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => requireTokenPermission(
      secondaryIdentity,
      "documents:write",
      "documents.update",
    )).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(authenticationCode(database, created.token, unbound.id)).toBe("FORBIDDEN");

    updateAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      credentialId: created.credential.id,
      name: created.credential.name,
      scopes: ["documents:read"],
      defaultWorkspaceId: primary.id,
      workspaceAllowlist: [primary.id, secondary.id],
      ipAllowlist: [],
      expiresAt: null,
    });
    const narrowed = authenticateApiToken(database, `Bearer ${created.token}`);
    expect(narrowed.capabilities).toContain("documents.update");
    expect(() => requireTokenPermission(
      narrowed,
      "documents:write",
      "documents.update",
    )).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(listApiTokenWorkspaceIdentities(database, narrowed).map((entry) => entry.workspace.id))
      .toEqual(expect.arrayContaining([primary.id, secondary.id]));
  });

  it("fails fresh authentication closed at every canonical inactive or revoked layer", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Lifecycle agent" });
    const grant = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
      rootDocumentId: null,
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Lifecycle key",
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    const bindingId = created.credential.bindings[0]!.id;
    const revokedAt = "2026-08-09T00:00:00.000Z";
    const barriers = [
      {
        expected: "UNAUTHORIZED",
        block: () => database.prepare("UPDATE agents SET status = 'disabled' WHERE id = ?").run(agent.id),
        restore: () => database.prepare("UPDATE agents SET status = 'active' WHERE id = ?").run(agent.id),
      },
      {
        expected: "UNAUTHORIZED",
        block: () => database.prepare("UPDATE agent_credentials SET revoked_at = ? WHERE id = ?")
          .run(revokedAt, created.credential.id),
        restore: () => database.prepare("UPDATE agent_credentials SET revoked_at = NULL WHERE id = ?")
          .run(created.credential.id),
      },
      {
        expected: "FORBIDDEN",
        block: () => database.prepare(
          "UPDATE agent_credential_grant_bindings SET status = 'revoked', revoked_at = ? WHERE id = ?",
        ).run(revokedAt, bindingId),
        restore: () => database.prepare(
          "UPDATE agent_credential_grant_bindings SET status = 'active', revoked_at = NULL WHERE id = ?",
        ).run(bindingId),
      },
      {
        expected: "FORBIDDEN",
        block: () => database.prepare("UPDATE workspace_agents SET status = 'disabled' WHERE id = ?")
          .run(grant.membershipId),
        restore: () => database.prepare("UPDATE workspace_agents SET status = 'active' WHERE id = ?")
          .run(grant.membershipId),
      },
      {
        expected: "FORBIDDEN",
        block: () => database.prepare("UPDATE workspace_agents SET revoked_at = ? WHERE id = ?")
          .run(revokedAt, grant.membershipId),
        restore: () => database.prepare("UPDATE workspace_agents SET revoked_at = NULL WHERE id = ?")
          .run(grant.membershipId),
      },
      {
        expected: "FORBIDDEN",
        block: () => database.prepare("UPDATE workspaces SET lifecycle_state = 'trashed' WHERE id = ?")
          .run(workspace.id),
        restore: () => database.prepare("UPDATE workspaces SET lifecycle_state = 'active' WHERE id = ?")
          .run(workspace.id),
      },
    ] as const;

    for (const barrier of barriers) {
      barrier.block();
      expect(authenticationCode(database, created.token)).toBe(barrier.expected);
      barrier.restore();
      expect(authenticationCode(database, created.token)).toBeNull();
    }
  });

  it("rejects a deletion-tombstoned global identity even if its status bit is stale-active", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Tombstoned agent" });
    const grant = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "reader",
      rootDocumentId: null,
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Tombstoned key",
      scopes: ["documents:read"],
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    database.prepare(
      "UPDATE agents SET deleted_at = ?, purge_after = ? WHERE id = ?",
    ).run("2026-08-09T00:00:00.000Z", "2026-09-08T00:00:00.000Z", agent.id);

    expect(getActiveWorkspaceAgentGrant(database, workspace.id, grant.membershipId)).toBeNull();
    expect(() => authenticateApiToken(database, `Bearer ${created.token}`))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("makes REST and MCP enforce the same exact capability and document-subtree decisions", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const rootDocumentId = createPage(database, workspace.id, user, "Allowed root");
    const childDocumentId = createPage(database, workspace.id, user, "Allowed child", rootDocumentId);
    const outsideDocumentId = createPage(database, workspace.id, user, "Outside sibling");
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Subtree agent" });
    assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "custom",
      capabilities: ["documents.read", "documents.update"],
      rootDocumentId,
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Subtree key",
      scopes: ["documents:read", "documents:write"],
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    const restIdentity = authenticateRequestApiToken(database, new Request(
      `https://nyxdoc.test/api/v1/documents/${childDocumentId}`,
      {
        headers: {
          authorization: `Bearer ${created.token}`,
          "x-nyxdoc-workspace-id": workspace.id,
        },
      },
    ));
    expect(() => {
      requireTokenPermission(restIdentity, "documents:read", "documents.read");
      requireTokenDocumentAccess(database, restIdentity, childDocumentId);
    }).not.toThrow();
    expect(() => requireTokenDocumentAccess(database, restIdentity, outsideDocumentId))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => requireTokenPermission(restIdentity, "documents:write", "documents.create"))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    const mcp = await connectMcp(database, restIdentity);
    try {
      expect((await mcp.client.callTool({
        name: "get_document",
        arguments: { documentId: childDocumentId },
      })).isError).not.toBe(true);
      expect((await mcp.client.callTool({
        name: "get_document",
        arguments: { documentId: outsideDocumentId },
      })).isError).toBe(true);
      expect((await mcp.client.callTool({
        name: "create_document",
        arguments: {
          requestId: randomUUID(),
          workspaceId: workspace.id,
          parentDocumentId: rootDocumentId,
          title: "Capability-denied child",
          content: {
            schemaVersion: 2,
            blocks: [{ id: randomUUID(), type: "p", children: [{ text: "Denied" }] }],
          },
        },
      })).isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it("keeps workspace-wide document predicates inside their tenant boundary", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const foreignWorkspace = createWorkspace(database, user, "Foreign boundary", "en");
    const foreignDocumentId = (database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at LIMIT 1",
    ).get(foreignWorkspace.id) as { id: string }).id;
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Workspace agent" });
    const grant = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "reader",
      rootDocumentId: null,
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Workspace key",
      scopes: ["documents:read"],
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    const identity = authenticateApiToken(database, `Bearer ${created.token}`);
    const boundary = getActiveWorkspaceAgentGrant(database, workspace.id, grant.membershipId)!;

    expect(workspaceAgentGrantCanAccessDocument(database, boundary, foreignDocumentId)).toBe(false);
    expect.soft(tokenCanAccessDocument(database, identity, foreignDocumentId)).toBe(false);
    expect.soft(() => requireTokenDocumentAccess(database, identity, foreignDocumentId))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("binds OAuth to the signed-in user's selected agent and workspaces, then intersects token scopes", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database, { name: "OAuth owner" });
    const secondary = createWorkspace(database, owner.user, "OAuth secondary", "en");
    const outsider = createTestUser(database, { name: "OAuth outsider" });
    const agent = createAccountAgent(database, {
      userId: owner.user.id,
      displayName: "Reusable OAuth agent",
    });
    const outsiderAgent = createAccountAgent(database, {
      userId: outsider.user.id,
      displayName: "Outsider agent",
    });
    const inactiveAgent = createAccountAgent(database, {
      userId: owner.user.id,
      displayName: "Inactive OAuth agent",
    });
    database.prepare("UPDATE agents SET status = 'disabled' WHERE id = ?").run(inactiveAgent.id);
    const baseInput = {
      userId: owner.user.id,
      clientId: "hardening-oauth-client",
      clientName: "Hardening OAuth client",
      requestedScopes: "openid profile documents:read documents:write documents:commit changes:read",
      workspaceIds: [owner.workspace.id, secondary.id],
      accessProfile: "writer" as const,
      agent: { mode: "existing" as const, agentId: agent.id },
    };

    expect(() => validateMcpOAuthGrantProvisioning(database, {
      ...baseInput,
      workspaceIds: [outsider.workspace.id],
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => validateMcpOAuthGrantProvisioning(database, {
      ...baseInput,
      agent: { mode: "existing", agentId: outsiderAgent.id },
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => validateMcpOAuthGrantProvisioning(database, {
      ...baseInput,
      agent: { mode: "existing", agentId: inactiveAgent.id },
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    const grant = provisionMcpOAuthGrant(database, baseInput);
    const defaultIdentity = resolveMcpOAuthIdentity(database, {
      userId: owner.user.id,
      clientId: baseInput.clientId,
      tokenScopes: "openid profile documents:read",
    });
    const secondaryIdentity = resolveMcpOAuthIdentity(database, {
      userId: owner.user.id,
      clientId: baseInput.clientId,
      tokenScopes: "documents:read",
      workspaceId: secondary.id,
    });
    expect(defaultIdentity).toMatchObject({
      id: grant.credentialId,
      globalAgentId: agent.id,
      workspaceId: owner.workspace.id,
      scopes: ["documents:read"],
    });
    expect(secondaryIdentity).toMatchObject({
      id: grant.credentialId,
      globalAgentId: agent.id,
      workspaceId: secondary.id,
      scopes: ["documents:read"],
    });
    expect(defaultIdentity.agentId).not.toBe(secondaryIdentity.agentId);
    expect(() => requireTokenPermission(
      defaultIdentity,
      "documents:write",
      "documents.update",
    )).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    database.prepare(
      "UPDATE mcp_oauth_grants SET status = 'revoked', revoked_at = ? WHERE id = ?",
    ).run("2026-08-09T00:00:00.000Z", grant.id);
    expect(() => resolveMcpOAuthIdentity(database, {
      userId: owner.user.id,
      clientId: baseInput.clientId,
      tokenScopes: "documents:read",
    })).toThrowError(McpOAuthError);
  });

  it("allows an agent to request management but never to receive direct management authority", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const originalName = workspace.name;
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Request-only agent" });
    const membership = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "custom",
      capabilities: ["admin_requests.create"],
      rootDocumentId: null,
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Request-only key",
      scopes: ["documents:read"],
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    const identity = authenticateApiToken(database, `Bearer ${created.token}`);
    const requestId = randomUUID();
    const requestedName = "Human-approved name";
    const mcp = await connectMcp(database, identity);
    try {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("propose_admin_action");
      expect(tools.tools.map((tool) => tool.name)).not.toContain("review_admin_action");
      const proposed = await mcp.client.callTool({
        name: "propose_admin_action",
        arguments: {
          workspaceId: workspace.id,
          requestId,
          reason: "A person must approve this change",
          actionType: "workspace.update",
          payload: { name: requestedName },
        },
      });
      expect(proposed.isError).not.toBe(true);
      const pending = database.prepare(
        `SELECT id, status FROM workspace_admin_action_requests
         WHERE workspace_id = ? AND request_id = ?`,
      ).get(workspace.id, requestId) as { id: string; status: string };
      expect(pending.status).toBe("pending");
      expect(database.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspace.id))
        .toEqual({ name: originalName });
      expect(() => requireTokenPermission(identity, "documents:read", "workspace.update"))
        .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
      expect(() => updateAgentWorkspaceMembership(database, {
        userId: user.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        accessProfile: "custom",
        capabilities: ["admin_requests.create", "workspace.update"],
        rootDocumentId: null,
      })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

      const reviewed = reviewAdminAction(database, workspace.id, user, pending.id, {
        decision: "approve",
      });
      expect(reviewed.request.status).toBe("executed");
      expect(database.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspace.id))
        .toEqual({ name: requestedName });
      expect(identity.agentId).toBe(membership.membershipId);
    } finally {
      await mcp.close();
    }
  });
});
