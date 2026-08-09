import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assignAgentToWorkspace,
  bindAgentCredentialToGrant,
  connectAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
  createOrganizationAgent,
  deleteAccountAgent,
  listAccountAgents,
  purgeAccountAgent,
  purgeExpiredAccountAgents,
  revokeAgentCredential,
  restoreAccountAgent,
  rotateAgentCredential,
  updateAccountAgent,
  updateAgentCredential,
  updateAgentWorkspaceMembership,
} from "@/lib/agents/service";
import { listAgentProfilePermissions } from "@/lib/authz/permissions";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import { runAppMigrations } from "@/lib/db/migrations";
import { createOrganization } from "@/lib/organizations/service";
import {
  ApiTokenError,
  authenticateApiToken,
  listApiTokenWorkspaceIdentities,
  requireTokenScope,
} from "@/lib/tokens/service";
import { createWorkspace } from "@/lib/workspaces/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];
const temporaryPaths: string[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true });
});

function createFileTestDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "nyxdoc-agent-service-"));
  temporaryPaths.push(directory);
  const databasePath = path.join(directory, "nyxdoc.db");
  const database = openDatabase(databasePath);
  database.exec(`
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
  runAppMigrations(database);
  databases.push(database);
  return { database, databasePath };
}

function runBeforeNextImmediate(database: NyxDatabase, operation: () => void) {
  const originalTransaction = database.transaction.bind(database);
  let interlocked = false;
  const spy = vi.spyOn(database, "transaction").mockImplementation(
    ((transactionOperation: () => unknown) => {
      const runner = originalTransaction(transactionOperation);
      return Object.assign(
        () => runner(),
        {
          deferred: () => runner.deferred(),
          immediate: () => {
            if (!interlocked) {
              interlocked = true;
              operation();
            }
            return runner.immediate();
          },
          exclusive: () => runner.exclusive(),
        },
      );
    }) as unknown as typeof database.transaction,
  );
  return { spy, wasInterlocked: () => interlocked };
}

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
    expect(firstIdentity.requestContext).toEqual({ clientIp: "203.0.113.77" });
    expect(Object.isFrozen(firstIdentity.requestContext)).toBe(true);
    expect(() => requireTokenScope(firstIdentity, "documents:commit")).not.toThrow();
    expect(listApiTokenWorkspaceIdentities(database, firstIdentity)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({
            requestContext: { clientIp: "203.0.113.77" },
          }),
        }),
      ]),
    );

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

  it("rejects a credential binding when another connection revokes the key before the immediate transaction", () => {
    const { database, databasePath } = createFileTestDatabase();
    const { user, workspace: first } = createTestUser(database);
    const second = createWorkspace(database, user, "Concurrent binding workspace");
    const agent = createAccountAgent(database, {
      userId: user.id,
      displayName: "Concurrent binding agent",
    });
    assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: first.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const secondGrant = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: second.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const credential = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Concurrent binding key",
      defaultWorkspaceId: first.id,
      workspaceAllowlist: [first.id],
    });

    const concurrent = openDatabase(databasePath);
    const interlock = runBeforeNextImmediate(database, () => {
      revokeAgentCredential(concurrent, {
        userId: user.id,
        agentId: agent.id,
        credentialId: credential.credential.id,
      });
    });
    try {
      expect(() => bindAgentCredentialToGrant(database, {
        userId: user.id,
        agentId: agent.id,
        credentialId: credential.credential.id,
        grantId: secondGrant.membershipId,
      })).toThrowError(expect.objectContaining({ code: "CREDENTIAL_REVOKED" }));
      expect(interlock.wasInterlocked()).toBe(true);
    } finally {
      interlock.spy.mockRestore();
      concurrent.close();
    }

    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM agent_credential_grant_bindings
       WHERE credential_id = ? AND grant_id = ? AND status = 'active' AND revoked_at IS NULL`,
    ).get(credential.credential.id, secondGrant.membershipId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT revoked_at IS NOT NULL AS revoked FROM agent_credentials WHERE id = ?",
    ).get(credential.credential.id)).toEqual({ revoked: 1 });
  });

  it("rejects a workspace grant mutation when another connection removes the manager", () => {
    const { database, databasePath } = createFileTestDatabase();
    const owner = createTestUser(database, { name: "Concurrent organization owner" });
    const administrator = createTestUser(database, { name: "Concurrent organization administrator" });
    const organization = createOrganization(database, {
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Concurrent manager organization",
    });
    const memberAddedAt = "2026-08-09T01:00:00.000Z";
    database.prepare(
      `INSERT INTO organization_members
       (id, organization_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', ?, ?)`,
    ).run(
      randomUUID(),
      organization.id,
      administrator.user.id,
      memberAddedAt,
      memberAddedAt,
    );
    const workspace = createWorkspace(database, owner.user, "Concurrent manager workspace", "en", {
      organizationId: organization.id,
    });
    const agent = createOrganizationAgent(database, {
      organizationId: organization.id,
      userId: administrator.user.id,
      actorLabel: administrator.user.name,
      displayName: "Concurrent manager agent",
    });
    const grant = assignAgentToWorkspace(database, {
      userId: administrator.user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const before = database.prepare(
      `SELECT access_profile, capabilities_json, status, root_document_id, policy_version
       FROM workspace_agents WHERE id = ?`,
    ).get(grant.membershipId);

    const concurrent = openDatabase(databasePath);
    const interlock = runBeforeNextImmediate(database, () => {
      concurrent.prepare(
        "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?",
      ).run(organization.id, administrator.user.id);
    });
    try {
      expect(() => updateAgentWorkspaceMembership(database, {
        userId: administrator.user.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        accessProfile: "reader",
        rootDocumentId: null,
      })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(interlock.wasInterlocked()).toBe(true);
    } finally {
      interlock.spy.mockRestore();
      concurrent.close();
    }

    expect(database.prepare(
      `SELECT access_profile, capabilities_json, status, root_document_id, policy_version
       FROM workspace_agents WHERE id = ?`,
    ).get(grant.membershipId)).toEqual(before);
  });

  it("preserves a concurrently narrowed grant by deriving omitted fields inside the immediate transaction", () => {
    const { database, databasePath } = createFileTestDatabase();
    const { user, workspace } = createTestUser(database);
    const agent = createAccountAgent(database, {
      userId: user.id,
      displayName: "Concurrent grant agent",
    });
    const grant = assignAgentToWorkspace(database, {
      userId: user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const before = database.prepare(
      "SELECT policy_version FROM workspace_agents WHERE id = ?",
    ).get(grant.membershipId) as { policy_version: number };
    const readerCapabilities = listAgentProfilePermissions("reader");

    const concurrent = openDatabase(databasePath);
    const interlock = runBeforeNextImmediate(database, () => {
      concurrent.prepare(
        `UPDATE workspace_agents
         SET role = 'viewer', access_profile = 'reader', capabilities_json = ?,
             policy_version = policy_version + 1, updated_at = ?
         WHERE id = ?`,
      ).run(
        JSON.stringify(readerCapabilities),
        "2026-08-09T02:00:00.000Z",
        grant.membershipId,
      );
    });
    let updated;
    try {
      updated = updateAgentWorkspaceMembership(database, {
        userId: user.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        rootDocumentId: null,
      });
      expect(interlock.wasInterlocked()).toBe(true);
    } finally {
      interlock.spy.mockRestore();
      concurrent.close();
    }

    expect(updated).toMatchObject({
      accessProfile: "reader",
      capabilities: readerCapabilities,
      policyVersion: before.policy_version + 2,
    });
  });

  it("rechecks organization ownership in the final transaction when access is revoked after purge preflight", () => {
    const { database, databasePath } = createFileTestDatabase();
    const owner = createTestUser(database, { name: "Organization owner" });
    const administrator = createTestUser(database, { name: "Organization administrator" });
    const organization = createOrganization(database, {
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Purge interlock organization",
    });
    const memberAddedAt = "2026-08-09T00:00:00.000Z";
    database.prepare(
      `INSERT INTO organization_members
       (id, organization_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', ?, ?)`,
    ).run(
      randomUUID(),
      organization.id,
      administrator.user.id,
      memberAddedAt,
      memberAddedAt,
    );
    const workspace = createWorkspace(database, owner.user, "Purge interlock workspace", "en", {
      organizationId: organization.id,
    });
    const agent = createOrganizationAgent(database, {
      organizationId: organization.id,
      userId: administrator.user.id,
      actorLabel: administrator.user.name,
      displayName: "Purge interlock agent",
    });
    const membership = assignAgentToWorkspace(database, {
      userId: administrator.user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const credential = createAgentCredential(database, {
      userId: administrator.user.id,
      agentId: agent.id,
      name: "Purge interlock credential",
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    deleteAccountAgent(database, {
      userId: administrator.user.id,
      agentId: agent.id,
      now: "2026-08-09T00:01:00.000Z",
    });

    const beforeTombstone = database.prepare(
      `SELECT status, deleted_at, purge_after, purged_at
       FROM agents WHERE id = ?`,
    ).get(agent.id);
    const beforeCredentials = database.prepare(
      `SELECT id, revoked_at FROM agent_credentials
       WHERE agent_id = ? ORDER BY id`,
    ).all(agent.id);
    const beforeBindings = database.prepare(
      `SELECT credential_id, grant_id, revoked_at
       FROM agent_credential_grant_bindings
       WHERE credential_id = ? ORDER BY grant_id`,
    ).all(credential.credential.id);
    const beforeAuditCount = database.prepare(
      `SELECT COUNT(*) AS count FROM workspace_audit_events
       WHERE action = 'agent.global_purged' AND target_id = ?`,
    ).get(agent.id) as { count: number };

    const concurrent = openDatabase(databasePath);
    const originalTransaction = database.transaction.bind(database);
    let interlocked = false;
    const transactionSpy = vi.spyOn(database, "transaction").mockImplementation(
      ((operation: () => unknown) => {
        const runner = originalTransaction(operation);
        return Object.assign(
          () => runner(),
          {
            deferred: () => runner.deferred(),
            immediate: () => {
              if (!interlocked) {
                interlocked = true;
                concurrent.prepare(
                  "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?",
                ).run(organization.id, administrator.user.id);
              }
              return runner.immediate();
            },
            exclusive: () => runner.exclusive(),
          },
        );
      }) as unknown as typeof database.transaction,
    );

    try {
      expect(() => purgeAccountAgent(database, {
        userId: administrator.user.id,
        agentId: agent.id,
        confirmationName: "Purge interlock agent",
        backupGenerationId: "verified-backup-before-final-transaction",
        now: "2026-08-09T00:02:00.000Z",
      })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(interlocked).toBe(true);
    } finally {
      transactionSpy.mockRestore();
      concurrent.close();
    }

    expect(database.prepare(
      `SELECT status, deleted_at, purge_after, purged_at
       FROM agents WHERE id = ?`,
    ).get(agent.id)).toEqual(beforeTombstone);
    expect(database.prepare(
      `SELECT id, revoked_at FROM agent_credentials
       WHERE agent_id = ? ORDER BY id`,
    ).all(agent.id)).toEqual(beforeCredentials);
    expect(database.prepare(
      `SELECT credential_id, grant_id, revoked_at
       FROM agent_credential_grant_bindings
       WHERE credential_id = ? ORDER BY grant_id`,
    ).all(credential.credential.id)).toEqual(beforeBindings);
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM workspace_audit_events
       WHERE action = 'agent.global_purged' AND target_id = ?`,
    ).get(agent.id)).toEqual(beforeAuditCount);
    expect(database.prepare(
      "SELECT status FROM workspace_agents WHERE id = ?",
    ).get(membership.membershipId)).toEqual({ status: "disabled" });
  });

  it("does not create an organization agent after the actor loses organization access", () => {
    const { database, databasePath } = createFileTestDatabase();
    const owner = createTestUser(database, { name: "Organization owner" });
    const administrator = createTestUser(database, { name: "Organization administrator" });
    const organization = createOrganization(database, {
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Organization agent create interlock",
    });
    database.prepare(
      `INSERT INTO organization_members
       (id, organization_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', ?, ?)`,
    ).run(
      randomUUID(),
      organization.id,
      administrator.user.id,
      "2026-08-09T10:00:00.000Z",
      "2026-08-09T10:00:00.000Z",
    );

    const concurrent = openDatabase(databasePath);
    const interlock = runBeforeNextImmediate(database, () => {
      concurrent.prepare(
        "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?",
      ).run(organization.id, administrator.user.id);
    });
    try {
      expect(() => createOrganizationAgent(database, {
        organizationId: organization.id,
        userId: administrator.user.id,
        actorLabel: administrator.user.name,
        displayName: "Must not be created",
      })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(interlock.wasInterlocked()).toBe(true);
    } finally {
      interlock.spy.mockRestore();
      concurrent.close();
    }

    expect(database.prepare(
      `SELECT COUNT(*) AS count
       FROM agents agent JOIN agent_ownership ownership ON ownership.agent_id = agent.id
       WHERE ownership.organization_id = ?`,
    ).get(organization.id)).toEqual({ count: 0 });
  });

  it("serializes organization agent creation at the 250 active-agent limit", () => {
    const { database, databasePath } = createFileTestDatabase();
    const owner = createTestUser(database, { name: "Organization owner" });
    const organization = createOrganization(database, {
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Organization agent limit interlock",
    });
    const now = "2026-08-09T10:05:00.000Z";
    const seed = database.transaction(() => {
      for (let index = 0; index < 249; index += 1) {
        const id = randomUUID();
        database.prepare(
          `INSERT INTO agents
           (id, owner_user_id, display_name, avatar_media_id, status,
            created_by_user_id, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`,
        ).run(id, owner.user.id, `Seed agent ${index}`, owner.user.id, now, now);
        database.prepare(
          `INSERT INTO agent_ownership
           (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
           VALUES (?, 'organization', NULL, ?, ?, ?)`,
        ).run(id, organization.id, now, now);
      }
    });
    seed.immediate();

    const concurrent = openDatabase(databasePath);
    const interlock = runBeforeNextImmediate(database, () => {
      createOrganizationAgent(concurrent, {
        organizationId: organization.id,
        userId: owner.user.id,
        actorLabel: owner.user.name,
        displayName: "Concurrent 250th agent",
      });
    });
    try {
      expect(() => createOrganizationAgent(database, {
        organizationId: organization.id,
        userId: owner.user.id,
        actorLabel: owner.user.name,
        displayName: "Concurrent 251st agent",
      })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(interlock.wasInterlocked()).toBe(true);
    } finally {
      interlock.spy.mockRestore();
      concurrent.close();
    }

    expect(database.prepare(
      `SELECT COUNT(*) AS count
       FROM agents agent JOIN agent_ownership ownership ON ownership.agent_id = agent.id
       WHERE ownership.organization_id = ?
         AND agent.status = 'active' AND agent.deleted_at IS NULL`,
    ).get(organization.id)).toEqual({ count: 250 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM organization_audit_events
       WHERE organization_id = ? AND action = 'organization.agent_created'`,
    ).get(organization.id)).toEqual({ count: 1 });
  });

  it("does not update an organization agent after the actor loses organization access", () => {
    const { database, databasePath } = createFileTestDatabase();
    const owner = createTestUser(database, { name: "Organization owner" });
    const administrator = createTestUser(database, { name: "Organization administrator" });
    const organization = createOrganization(database, {
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Organization agent update interlock",
    });
    database.prepare(
      `INSERT INTO organization_members
       (id, organization_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', ?, ?)`,
    ).run(randomUUID(), organization.id, administrator.user.id, "2026-08-09T10:10:00.000Z", "2026-08-09T10:10:00.000Z");
    const agent = createOrganizationAgent(database, {
      organizationId: organization.id,
      userId: administrator.user.id,
      actorLabel: administrator.user.name,
      displayName: "Original name",
    });

    const concurrent = openDatabase(databasePath);
    const interlock = runBeforeNextImmediate(database, () => {
      concurrent.prepare(
        "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?",
      ).run(organization.id, administrator.user.id);
    });
    try {
      expect(() => updateAccountAgent(database, {
        userId: administrator.user.id,
        agentId: agent.id,
        displayName: "Must not be updated",
      })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(interlock.wasInterlocked()).toBe(true);
    } finally {
      interlock.spy.mockRestore();
      concurrent.close();
    }
    expect(database.prepare("SELECT display_name FROM agents WHERE id = ?").get(agent.id))
      .toEqual({ display_name: "Original name" });
  });

  it("allows exactly one concurrent organization-agent delete and records one audit event", () => {
    const { database, databasePath } = createFileTestDatabase();
    const owner = createTestUser(database, { name: "Organization owner" });
    const organization = createOrganization(database, {
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Organization agent delete interlock",
    });
    const agent = createOrganizationAgent(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      displayName: "Single delete agent",
    });

    const concurrent = openDatabase(databasePath);
    const interlock = runBeforeNextImmediate(database, () => {
      deleteAccountAgent(concurrent, {
        userId: owner.user.id,
        agentId: agent.id,
        now: "2026-08-09T10:20:00.000Z",
      });
    });
    try {
      expect(() => deleteAccountAgent(database, {
        userId: owner.user.id,
        agentId: agent.id,
        now: "2026-08-09T10:20:01.000Z",
      })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
      expect(interlock.wasInterlocked()).toBe(true);
    } finally {
      interlock.spy.mockRestore();
      concurrent.close();
    }
    expect(database.prepare(
      "SELECT status, deleted_at FROM agents WHERE id = ?",
    ).get(agent.id)).toEqual({ status: "disabled", deleted_at: "2026-08-09T10:20:00.000Z" });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM organization_audit_events
       WHERE organization_id = ? AND action = 'agent.global_deleted' AND target_id = ?`,
    ).get(organization.id, agent.id)).toEqual({ count: 1 });
  });

  it("does not restore an organization agent that a concurrent purge has tombstoned", () => {
    const { database, databasePath } = createFileTestDatabase();
    const owner = createTestUser(database, { name: "Organization owner" });
    const organization = createOrganization(database, {
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Organization agent restore interlock",
    });
    const agent = createOrganizationAgent(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      displayName: "Purged instead of restored",
    });
    deleteAccountAgent(database, {
      userId: owner.user.id,
      agentId: agent.id,
      now: "2026-08-09T10:30:00.000Z",
    });

    const concurrent = openDatabase(databasePath);
    const interlock = runBeforeNextImmediate(database, () => {
      purgeAccountAgent(concurrent, {
        userId: owner.user.id,
        agentId: agent.id,
        confirmationName: "Purged instead of restored",
        backupGenerationId: "verified-before-restore-race",
        now: "2026-08-09T10:31:00.000Z",
      });
    });
    try {
      expect(() => restoreAccountAgent(database, {
        userId: owner.user.id,
        agentId: agent.id,
        now: "2026-08-09T10:31:01.000Z",
      })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
      expect(interlock.wasInterlocked()).toBe(true);
    } finally {
      interlock.spy.mockRestore();
      concurrent.close();
    }
    expect(database.prepare(
      "SELECT status, deleted_at, purged_at FROM agents WHERE id = ?",
    ).get(agent.id)).toEqual({
      status: "disabled",
      deleted_at: "2026-08-09T10:30:00.000Z",
      purged_at: "2026-08-09T10:31:00.000Z",
    });
  });
});
