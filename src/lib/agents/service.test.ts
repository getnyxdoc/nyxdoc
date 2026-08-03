import { afterEach, describe, expect, it } from "vitest";
import {
  assignAgentToWorkspace,
  connectAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
  deleteAccountAgent,
  listAccountAgents,
  purgeAccountAgent,
  purgeExpiredAccountAgents,
  restoreAccountAgent,
  rotateAgentCredential,
  updateAccountAgent,
  updateAgentCredential,
  updateAgentWorkspaceMembership,
} from "@/lib/agents/service";
import type { NyxDatabase } from "@/lib/db/client";
import {
  ApiTokenError,
  authenticateApiToken,
  requireTokenScope,
} from "@/lib/tokens/service";
import { createWorkspace } from "@/lib/workspaces/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("global agents and workspace memberships", () => {
  it("connects a new agent, workspace role, document scope, and credential atomically", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);

    const connected = connectAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agent: { mode: "new", displayName: "Nyxdoc Builder" },
      accessProfile: "writer",
      rootDocumentId: null,
      credential: {
        mode: "new",
        name: "Nyxdoc Builder key",
        restrictToWorkspace: false,
      },
    });

    expect(connected).toMatchObject({
      agent: { displayName: "Nyxdoc Builder", status: "active" },
      membership: {
        workspaceId: workspace.id,
        accessProfile: "writer",
        rootDocumentId: null,
      },
      credential: {
        name: "Nyxdoc Builder key",
        defaultWorkspaceId: workspace.id,
        workspaceIds: [workspace.id],
      },
    });
    expect(connected.token).toMatch(/^nyx_live_/);
    expect(connected.credential!.scopes).toEqual([
      "documents:read",
      "documents:write",
      "documents:commit",
      "changes:read",
    ]);
    expect(authenticateApiToken(database, `Bearer ${connected.token}`)).toMatchObject({
      globalAgentId: connected.agent.id,
      workspaceId: workspace.id,
      accessProfile: "writer",
      capabilities: expect.arrayContaining(["documents.read", "documents.update", "documents.commit"]),
    });
  });

  it("binds an existing credential to a new grant without changing its scopes", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace: first } = createTestUser(database);
    const second = createWorkspace(database, user, "Second");
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Shared Agent" });
    assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: first.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Shared key",
      scopes: ["documents:read", "documents:write", "documents:commit", "changes:read"],
      defaultWorkspaceId: first.id,
      workspaceAllowlist: [first.id],
    });

    const connected = connectAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: second.id,
      agent: { mode: "existing", agentId: agent.id },
      accessProfile: "writer",
      rootDocumentId: null,
      credential: { mode: "existing", credentialId: created.credential.id },
    });

    expect(connected.token).toBeNull();
    expect(connected.credential!.workspaceIds).toEqual([first.id, second.id]);
    expect(connected.credential!.scopes).toEqual(created.credential.scopes);
    expect(authenticateApiToken(database, `Bearer ${created.token}`, {
      workspaceId: second.id,
    })).toMatchObject({
      globalAgentId: agent.id,
      workspaceId: second.id,
      accessProfile: "writer",
    });
  });

  it("preserves every active credential binding when rotating a key", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace: first } = createTestUser(database);
    const second = createWorkspace(database, user, "Threads");
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Shared Agent" });
    assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: first.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Shared key",
      defaultWorkspaceId: first.id,
      workspaceAllowlist: [first.id],
    });

    connectAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: second.id,
      agent: { mode: "existing", agentId: agent.id },
      accessProfile: "writer",
      rootDocumentId: null,
      credential: { mode: "existing", credentialId: created.credential.id },
    });

    // The legacy allowlist remains stale after an existing key is bound to a
    // second grant. Rotation must use the binding table instead.
    expect(database.prepare(
      "SELECT workspace_allowlist_json FROM agent_credentials WHERE id = ?",
    ).get(created.credential.id)).toEqual({ workspace_allowlist_json: JSON.stringify([first.id]) });

    const rotated = rotateAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      credentialId: created.credential.id,
    });

    expect(rotated.credential.workspaceIds.sort()).toEqual([first.id, second.id].sort());
    expect(authenticateApiToken(database, `Bearer ${rotated.token}`, {
      workspaceId: first.id,
    }).workspaceId).toBe(first.id);
    expect(authenticateApiToken(database, `Bearer ${rotated.token}`, {
      workspaceId: second.id,
    }).workspaceId).toBe(second.id);
  });

  it("reuses a legacy write credential as an editor credential", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace: first } = createTestUser(database);
    const second = createWorkspace(database, user, "Threads");
    const agent = createAccountAgent(database, { userId: user.id, displayName: "gameroom" });
    assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: first.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Legacy gameroom key",
      scopes: ["documents:read", "documents:write", "documents:commit", "changes:read"],
      defaultWorkspaceId: first.id,
      workspaceAllowlist: [first.id],
    });
    database.prepare("UPDATE agent_credentials SET scopes_json = ? WHERE id = ?").run(
      JSON.stringify(["documents:read", "documents:write", "changes:read"]),
      created.credential.id,
    );

    const listedCredential = listAccountAgents(database, user.id)[0]?.credentials[0];
    expect(listedCredential?.scopes).toContain("documents:commit");

    const connected = connectAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: second.id,
      agent: { mode: "existing", agentId: agent.id },
      accessProfile: "writer",
      rootDocumentId: null,
      credential: { mode: "existing", credentialId: created.credential.id },
    });

    expect(connected.token).toBeNull();
    expect(connected.credential!.id).toBe(created.credential.id);
    expect(connected.membership).toMatchObject({
      workspaceId: second.id,
      accessProfile: "writer",
    });
    expect(authenticateApiToken(database, `Bearer ${created.token}`, {
      workspaceId: second.id,
    }).workspaceId).toBe(second.id);
  });

  it("saves a workspace grant without a credential and leaves the agent unable to connect", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);

    const connected = connectAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agent: { mode: "new", displayName: "Offline Agent" },
      accessProfile: "drafter",
      rootDocumentId: null,
      credential: { mode: "later" },
    });

    expect(connected).toMatchObject({
      membership: { accessProfile: "drafter", workspaceId: workspace.id },
      credential: null,
      binding: null,
      token: null,
    });
    expect(connected.agent.credentials).toEqual([]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agent_credential_grant_bindings WHERE grant_id = ? AND status = 'active'",
    ).get(connected.membership.membershipId)).toEqual({ count: 0 });
  });

  it("rolls back a newly created identity when a later connection step fails", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);

    expect(() => connectAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agent: { mode: "new", displayName: "Rolled Back Agent" },
      accessProfile: "writer",
      rootDocumentId: "00000000-0000-4000-8000-000000000099",
      credential: {
        mode: "new",
        name: "Rolled Back key",
        restrictToWorkspace: false,
      },
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(listAccountAgents(database, user.id)).toEqual([]);
  });

  it("uses one credential across multiple workspaces while intersecting key, membership, and IP policies", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace: first } = createTestUser(database);
    const second = createWorkspace(database, user, "Gameroom");
    const agent = createAccountAgent(database, { userId: user.id, displayName: "gameroom-main" });
    const firstMembership = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: first.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const secondMembership = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: second.id,
      agentId: agent.id,
      accessProfile: "reader",
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Home agent key",
      scopes: ["documents:read", "documents:write", "documents:commit", "changes:read"],
      defaultWorkspaceId: first.id,
      ipAllowlist: ["203.0.113.0/24"],
      workspaceAllowlist: [first.id, second.id],
    });
    const credentialAudits = database.prepare(
      `SELECT workspace_id, metadata_json FROM workspace_audit_events
       WHERE action = 'credential.global_created' ORDER BY workspace_id`,
    ).all() as Array<{ workspace_id: string; metadata_json: string }>;
    expect(credentialAudits.map((row) => row.workspace_id).sort()).toEqual([first.id, second.id].sort());
    expect(credentialAudits.every((row) => !row.metadata_json.includes(created.token))).toBe(true);

    const firstIdentity = authenticateApiToken(database, `Bearer ${created.token}`, {
      clientIp: "203.0.113.77",
    });
    expect(firstIdentity).toMatchObject({
      globalAgentId: agent.id,
      agentId: firstMembership.membershipId,
      workspaceId: first.id,
      accessProfile: "writer",
      capabilities: expect.arrayContaining(["documents.update", "documents.commit"]),
    });
    expect(() => requireTokenScope(firstIdentity, "documents:commit")).not.toThrow();

    const secondIdentity = authenticateApiToken(database, `Bearer ${created.token}`, {
      workspaceId: second.id,
      clientIp: "203.0.113.78",
    });
    expect(secondIdentity).toMatchObject({
      globalAgentId: agent.id,
      agentId: secondMembership.membershipId,
      workspaceId: second.id,
      accessProfile: "reader",
      capabilities: expect.not.arrayContaining(["documents.update", "documents.commit"]),
    });
    expect(() => requireTokenScope(secondIdentity, "documents:write"))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => authenticateApiToken(database, `Bearer ${created.token}`, {
      clientIp: "198.51.100.10",
    })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));

    const updatedCredential = updateAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      credentialId: created.credential.id,
      name: created.credential.name,
      scopes: created.credential.scopes,
      defaultWorkspaceId: second.id,
      workspaceAllowlist: [second.id],
      ipAllowlist: ["203.0.113.0/24"],
      expiresAt: null,
    });
    expect(updatedCredential.workspaceIds).toEqual([second.id]);
    expect(authenticateApiToken(database, `Bearer ${created.token}`, {
      clientIp: "203.0.113.88",
    }).workspaceId).toBe(second.id);
    expect(() => authenticateApiToken(database, `Bearer ${created.token}`, {
      workspaceId: first.id,
      clientIp: "203.0.113.88",
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("keeps global deactivation separate from per-workspace reactivation", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Nyx" });
    const membership = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const created = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Nyx key",
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });

    updateAccountAgent(database, { userId: user.id, agentId: agent.id, status: "disabled" });
    expect(() => authenticateApiToken(database, `Bearer ${created.token}`)).toThrowError(ApiTokenError);
    updateAccountAgent(database, { userId: user.id, agentId: agent.id, status: "active" });
    expect(listAccountAgents(database, user.id)[0].memberships[0].status).toBe("disabled");
    expect(() => authenticateApiToken(database, `Bearer ${created.token}`)).toThrowError(ApiTokenError);

    updateAgentWorkspaceMembership(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "custom",
      capabilities: ["workspace.read", "agents.read", "documents.read", "documents.update", "revisions.read", "changes.read"],
      rootDocumentId: null,
      status: "active",
    });
    const identity = authenticateApiToken(database, `Bearer ${created.token}`);
    expect(identity.agentId).toBe(membership.membershipId);
    expect(() => requireTokenScope(identity, "documents:commit"))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("revokes access immediately, restores only identity, and keeps a historical tombstone after purge", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Gameroom" });
    const membership = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const firstCredential = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Gameroom key",
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    const deletedAt = "2026-07-17T00:00:00.000Z";

    const deleted = deleteAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
      now: deletedAt,
    });
    expect(deleted).toMatchObject({
      id: agent.id,
      status: "disabled",
      deletedAt,
      purgeAfter: "2026-08-16T00:00:00.000Z",
      purgedAt: null,
    });
    expect(deleted.credentials[0].revokedAt).toBe(deletedAt);
    expect(deleted.memberships[0].status).toBe("disabled");
    expect(() => authenticateApiToken(database, `Bearer ${firstCredential.token}`))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));

    const restored = restoreAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
      now: "2026-07-20T00:00:00.000Z",
    });
    expect(restored).toMatchObject({
      status: "active",
      deletedAt: null,
      purgeAfter: null,
      purgedAt: null,
    });
    expect(restored.credentials[0].revokedAt).toBe(deletedAt);
    expect(restored.memberships[0].status).toBe("disabled");
    expect(() => authenticateApiToken(database, `Bearer ${firstCredential.token}`))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));

    updateAgentWorkspaceMembership(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
      rootDocumentId: null,
      status: "active",
    });
    const replacement = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Replacement key",
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    expect(authenticateApiToken(database, `Bearer ${replacement.token}`)).toMatchObject({
      globalAgentId: agent.id,
      agentId: membership.membershipId,
    });

    deleteAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
      now: "2026-07-21T00:00:00.000Z",
    });
    expect(purgeExpiredAccountAgents(database, {
      now: "2026-08-19T23:59:59.999Z",
    })).toEqual([]);
    expect(purgeExpiredAccountAgents(database, {
      now: "2026-08-20T00:00:00.000Z",
    })).toEqual([agent.id]);

    const purged = listAccountAgents(database, user.id)[0];
    expect(purged).toMatchObject({
      id: agent.id,
      displayName: "Gameroom",
      purgedAt: "2026-08-20T00:00:00.000Z",
      credentials: [],
    });
    expect(purged.memberships[0]).toMatchObject({
      membershipId: membership.membershipId,
      workspaceId: workspace.id,
      status: "disabled",
    });
    expect(() => restoreAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
      now: "2026-08-20T00:00:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("permanently purges a deleted agent before the retention deadline after exact confirmation", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const agent = createAccountAgent(database, { userId: user.id, displayName: "Gameroom Main" });
    const membership = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Gameroom key",
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    deleteAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
      now: "2026-07-18T00:00:00.000Z",
    });

    expect(() => purgeAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
      confirmationName: "다른 이름",
      backupGenerationId: "backup-before-agent-purge",
      now: "2026-07-18T00:05:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => purgeAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
      confirmationName: "Gameroom Main",
      backupGenerationId: " ",
      now: "2026-07-18T00:05:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const purged = purgeAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
      confirmationName: "Gameroom Main",
      backupGenerationId: "backup-before-agent-purge",
      actorLabel: user.name,
      now: "2026-07-18T00:05:00.000Z",
    });
    expect(purged).toMatchObject({
      id: agent.id,
      displayName: "Gameroom Main",
      purgedAt: "2026-07-18T00:05:00.000Z",
      purgeAfter: null,
      credentials: [],
    });
    expect(purged.memberships).toMatchObject([{
      membershipId: membership.membershipId,
      status: "disabled",
    }]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agent_credentials WHERE agent_id = ?",
    ).get(agent.id)).toEqual({ count: 0 });
    const audit = database.prepare(
      `SELECT actor_label, metadata_json
       FROM workspace_audit_events
       WHERE action = 'agent.global_purged' AND target_id = ?`,
    ).get(agent.id) as { actor_label: string; metadata_json: string };
    expect(audit.actor_label).toBe(user.name);
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      purgeMode: "manual",
      backupGenerationId: "backup-before-agent-purge",
      retainedTombstone: true,
      historicalAttributionRetained: true,
    });
    expect(() => restoreAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => purgeAccountAgent(database, {
      userId: user.id,
      agentId: agent.id,
      confirmationName: "Gameroom Main",
      backupGenerationId: "another-backup",
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });
});
