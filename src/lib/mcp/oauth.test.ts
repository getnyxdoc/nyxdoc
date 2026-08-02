import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import {
  assignAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
} from "@/lib/agents/service";
import {
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
      role: "editor",
      agent: { mode: "new", displayName: "Codex OAuth" },
    });
    expect(firstGrant).toMatchObject({
      clientId: "codex-oauth-client",
      workspaceIds: [first.id],
      role: "editor",
      status: "active",
      scopes: [
        "documents:read",
        "documents:write",
        "documents:commit",
        "changes:read",
      ],
    });

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
      role: "editor",
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
      role: "admin",
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
      role: "admin",
      scopes: ["documents:read", "changes:read"],
    });

    const state = getMcpOAuthConsentState(database, {
      userId: user.id,
      clientId: firstGrant.clientId,
      requestedScopes,
    });
    expect(state.selectedWorkspaceIds).toEqual([first.id, second.id]);
    expect(state.role).toBe("editor");
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
      role: "viewer",
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
      role: "admin",
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
      role: "viewer",
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
      role: "admin",
    });
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
      role: "viewer",
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
      role: "editor",
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
      role: "viewer",
      agent: { mode: "existing", agentId: foreignAgent.id },
    })).toThrowError(McpOAuthError);
  });
});
