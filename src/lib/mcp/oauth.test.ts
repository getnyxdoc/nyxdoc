import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import {
  assignAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
} from "@/lib/agents/service";
import {
  completeMcpOAuthConsent,
  getMcpOAuthAuthorizationRequest,
  getMcpOAuthConsentState,
  McpOAuthError,
  provisionMcpOAuthGrant,
  resolveMcpOAuthIdentity,
} from "@/lib/mcp/oauth";
import { createWorkspace } from "@/lib/workspaces/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("MCP OAuth workspace grants", () => {
  it("does not mutate Nyxdoc authorization when provider consent fails", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);

    await expect(completeMcpOAuthConsent(database, {
      provisioning: {
        userId: user.id,
        clientId: "failing-provider-client",
        clientName: "Failing provider",
        requestedScopes: "documents:read changes:read",
        workspaceIds: [workspace.id],
        accessProfile: "reader",
        agent: { mode: "new", displayName: "Should not exist" },
      },
      providerConsent: async () => {
        throw new Error("provider consent failed");
      },
    })).rejects.toThrow("provider consent failed");

    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM mcp_oauth_grants",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agents",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agent_credentials",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workspace_agents",
    ).get()).toEqual({ count: 0 });
  });

  it("binds a consent code to its signed-in user, client, and scopes", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user } = createTestUser(database);
    database.prepare(
      `INSERT INTO verification
       (id, identifier, value, expiresAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "verification-oauth-test",
      "consent-code-test",
      JSON.stringify({
        userId: user.id,
        clientId: "codex-client",
        scope: ["openid", "documents:read"],
      }),
      new Date(Date.now() + 60_000).toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    expect(getMcpOAuthAuthorizationRequest(
      database,
      "consent-code-test",
      user.id,
    )).toEqual({
      userId: user.id,
      clientId: "codex-client",
      scopes: ["openid", "documents:read"],
    });
    expect(getMcpOAuthAuthorizationRequest(
      database,
      "consent-code-test",
      "different-user",
    )).toBeNull();
  });

  it("binds one OAuth client to a reusable global agent and explicit workspaces", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace: first } = createTestUser(database);
    const second = createWorkspace(database, user, "Second workspace");
    const requestedScopes = [
      "openid",
      "profile",
      "offline_access",
      "documents:read",
      "documents:write",
      "documents:commit",
      "changes:read",
    ].join(" ");

    const firstGrant = provisionMcpOAuthGrant(database, {
      userId: user.id,
      clientId: "codex-oauth-client",
      clientName: "Codex",
      requestedScopes,
      workspaceIds: [first.id],
      accessProfile: "writer",
      agent: { mode: "new", displayName: "Codex OAuth" },
    });
    expect(firstGrant).toMatchObject({
      clientId: "codex-oauth-client",
      workspaceIds: [first.id],
      accessProfile: "writer",
      status: "active",
      scopes: [
        "documents:read",
        "documents:write",
        "documents:commit",
        "changes:read",
      ],
    });
    expect(firstGrant).not.toHaveProperty("role");

    const identity = resolveMcpOAuthIdentity(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      tokenScopes: requestedScopes,
      workspaceId: first.id,
      clientIp: "127.0.0.1",
    });
    expect(identity).toMatchObject({
      globalAgentId: firstGrant.agentId,
      id: firstGrant.credentialId,
      workspaceId: first.id,
      scopes: firstGrant.scopes,
    });
    expect(() => resolveMcpOAuthIdentity(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      tokenScopes: requestedScopes,
      workspaceId: second.id,
    })).toThrow();

    const expandedGrant = provisionMcpOAuthGrant(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      clientName: "Codex",
      requestedScopes,
      workspaceIds: [first.id, second.id],
      accessProfile: "reader",
      agent: { mode: "existing", agentId: firstGrant.agentId },
    });
    expect(expandedGrant.agentId).toBe(firstGrant.agentId);
    expect(expandedGrant.credentialId).toBe(firstGrant.credentialId);
    expect(expandedGrant.workspaceIds).toEqual([first.id, second.id]);
    expect(resolveMcpOAuthIdentity(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      tokenScopes: "documents:read changes:read",
      workspaceId: second.id,
    })).toMatchObject({
      globalAgentId: firstGrant.agentId,
      workspaceId: second.id,
      scopes: ["documents:read", "changes:read"],
    });

    const state = getMcpOAuthConsentState(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      requestedScopes,
    });
    expect(state.selectedWorkspaceIds).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(state.workspaceAccess).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: first.id,
        accessProfile: "writer",
        effectiveCapabilities: expect.arrayContaining(["documents.read", "documents.commit"]),
      }),
      expect.objectContaining({
        workspaceId: second.id,
        accessProfile: "reader",
        effectiveCapabilities: expect.arrayContaining(["documents.read"]),
      }),
    ]));
    expect(state).not.toHaveProperty("role");
    expect(state.workspaces.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(state.initialAgent).toEqual({
      mode: "existing",
      agentId: firstGrant.agentId,
    });
    expect(state.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstGrant.agentId,
        displayName: "Codex OAuth",
        activeWorkspaceCount: 2,
        activeCredentialCount: 1,
      }),
    ]));

    database.prepare(
      `UPDATE mcp_oauth_grants
       SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), new Date().toISOString(), firstGrant.id);
    expect(() => resolveMcpOAuthIdentity(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      tokenScopes: "documents:read changes:read",
      workspaceId: first.id,
    })).toThrowError(McpOAuthError);
  });

  it("rejects a workspace the authorizing user cannot manage", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = createTestUser(database, { name: "First" });
    const second = createTestUser(database, { name: "Second" });

    expect(() => provisionMcpOAuthGrant(database, {
      userId: first.user.id,
      clientId: "untrusted-client",
      clientName: "Untrusted",
      requestedScopes: "documents:read changes:read",
      workspaceIds: [second.workspace.id],
      accessProfile: "reader",
      agent: { mode: "new", displayName: "Untrusted OAuth" },
    })).toThrowError(McpOAuthError);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM mcp_oauth_grants",
    ).get()).toEqual({ count: 0 });
  });

  it("uses an existing agent with a dedicated OAuth credential", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const agent = createAccountAgent(database, {
      userId: user.id,
      displayName: "Shared agent",
    });
    assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const manualCredential = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Manual connection",
      scopes: ["documents:read", "changes:read"],
      defaultWorkspaceId: null,
      workspaceAllowlist: [],
    });

    const grant = provisionMcpOAuthGrant(database, {
      userId: user.id,
      clientId: "existing-agent-client",
      clientName: "Existing Agent Client",
      requestedScopes: "documents:read changes:read",
      workspaceIds: [workspace.id],
      accessProfile: "reader",
      agent: { mode: "existing", agentId: agent.id },
    });

    expect(grant.agentId).toBe(agent.id);
    expect(grant.credentialId).not.toBe(manualCredential.credential.id);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agent_credentials WHERE agent_id = ? AND revoked_at IS NULL",
    ).get(agent.id)).toEqual({ count: 2 });
    expect(resolveMcpOAuthIdentity(database, {
      userId: user.id,
      clientId: grant.clientId,
      tokenScopes: "documents:read changes:read",
      workspaceId: workspace.id,
    })).toMatchObject({
      globalAgentId: agent.id,
      id: grant.credentialId,
    });
  });

  it("re-consent updates only explicit credential bindings and preserves existing workspace grants", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const second = createWorkspace(database, user, "Second workspace");
    const firstGrant = provisionMcpOAuthGrant(database, {
      userId: user.id,
      clientId: "re-consent-client",
      clientName: "Re-consent Client",
      requestedScopes: "documents:read changes:read",
      workspaceIds: [workspace.id],
      accessProfile: "writer",
      agent: { mode: "new", displayName: "Re-consent agent" },
    });
    const before = database.prepare(
      `SELECT role, access_profile, capabilities_json, root_document_id, policy_version
       FROM workspace_agents
       WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL`,
    ).get(workspace.id, firstGrant.agentId);

    provisionMcpOAuthGrant(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      clientName: "Re-consent Client",
      requestedScopes: "documents:read documents:write changes:read",
      workspaceIds: [second.id],
      accessProfile: "reader",
      agent: { mode: "existing", agentId: firstGrant.agentId },
    });

    expect(database.prepare(
      `SELECT role, access_profile, capabilities_json, root_document_id, policy_version
       FROM workspace_agents
       WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL`,
    ).get(workspace.id, firstGrant.agentId)).toEqual(before);
    expect(database.prepare(
      `SELECT access_profile, capabilities_json
       FROM workspace_agents
       WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL`,
    ).get(second.id, firstGrant.agentId)).toEqual({
      access_profile: "reader",
      capabilities_json: expect.stringContaining("documents.read"),
    });
    expect(database.prepare(
      `SELECT membership.workspace_id
       FROM agent_credential_grant_bindings binding
       JOIN workspace_agents membership ON membership.id = binding.grant_id
       WHERE binding.credential_id = ?
         AND binding.status = 'active' AND binding.revoked_at IS NULL
       ORDER BY membership.workspace_id`,
    ).all(firstGrant.credentialId)).toEqual([{ workspace_id: second.id }]);
    expect(getMcpOAuthConsentState(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      requestedScopes: "documents:read documents:write changes:read",
    }).workspaceAccess).toEqual([
      expect.objectContaining({
        workspaceId: second.id,
        accessProfile: "reader",
        effectiveCapabilities: expect.arrayContaining(["documents.read"]),
      }),
    ]);
  });

  it("revokes prior OAuth tokens and credentials when the selected agent changes", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    database.exec(`
      CREATE TABLE oauthAccessToken (
        id TEXT PRIMARY KEY,
        accessToken TEXT NOT NULL,
        refreshToken TEXT,
        accessTokenExpiresAt TEXT,
        refreshTokenExpiresAt TEXT,
        clientId TEXT NOT NULL,
        userId TEXT NOT NULL,
        scopes TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    const firstGrant = provisionMcpOAuthGrant(database, {
      userId: user.id,
      clientId: "switch-agent-client",
      clientName: "Switch Agent Client",
      requestedScopes: "documents:read changes:read",
      workspaceIds: [workspace.id],
      accessProfile: "reader",
      agent: { mode: "new", displayName: "First OAuth agent" },
    });
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO oauthAccessToken
       (id, accessToken, refreshToken, accessTokenExpiresAt,
        refreshTokenExpiresAt, clientId, userId, scopes, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "old-token",
      "old-access-token",
      "old-refresh-token",
      now,
      now,
      firstGrant.clientId,
      user.id,
      "documents:read changes:read",
      now,
      now,
    );
    const replacement = createAccountAgent(database, {
      userId: user.id,
      displayName: "Replacement agent",
    });

    const switchedGrant = provisionMcpOAuthGrant(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      clientName: "Switch Agent Client",
      requestedScopes: "documents:read changes:read",
      workspaceIds: [workspace.id],
      accessProfile: "writer",
      agent: { mode: "existing", agentId: replacement.id },
    });

    expect(switchedGrant.agentId).toBe(replacement.id);
    expect(switchedGrant.credentialId).not.toBe(firstGrant.credentialId);
    expect(database.prepare(
      "SELECT revoked_at FROM agent_credentials WHERE id = ?",
    ).get(firstGrant.credentialId)).toEqual({
      revoked_at: expect.any(String),
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM oauthAccessToken WHERE userId = ? AND clientId = ?",
    ).get(user.id, firstGrant.clientId)).toEqual({ count: 0 });
  });

  it("rejects an existing agent the authorizing user does not manage", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = createTestUser(database, { name: "First" });
    const second = createTestUser(database, { name: "Second" });
    const foreignAgent = createAccountAgent(database, {
      userId: second.user.id,
      displayName: "Foreign agent",
    });

    expect(() => provisionMcpOAuthGrant(database, {
      userId: first.user.id,
      clientId: "foreign-agent-client",
      clientName: "Foreign Agent Client",
      requestedScopes: "documents:read changes:read",
      workspaceIds: [first.workspace.id],
      accessProfile: "reader",
      agent: { mode: "existing", agentId: foreignAgent.id },
    })).toThrowError(McpOAuthError);
  });

  it("rejects access profiles outside the public OAuth contract", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);

    expect(() => provisionMcpOAuthGrant(database, {
      userId: user.id,
      clientId: "invalid-profile-client",
      clientName: "Invalid Profile Client",
      requestedScopes: "documents:read changes:read",
      workspaceIds: [workspace.id],
      accessProfile: "custom" as never,
      agent: { mode: "new", displayName: "Invalid OAuth agent" },
    })).toThrowError(McpOAuthError);
  });
});
