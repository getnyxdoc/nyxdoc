import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assignAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
  createOrganizationAgent,
  listOrganizationAgents,
  listWorkspaceAgentMemberships,
} from "@/lib/agents/service";
import { getHumanWorkspacePrincipal } from "@/lib/authz/permissions";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import { runAppMigrations } from "@/lib/db/migrations";
import {
  acceptOrganizationInvitation,
  addOrganizationTeamMember,
  createOrganization,
  createOrganizationInvitation,
  createOrganizationTeam,
  getActiveOrganizationInvitation,
  listOrganizationAuditEvents,
  listOrganizationMembers,
  listUserOrganizations,
  removeOrganizationMember,
  restoreOrganization,
  revokeOrganizationInvitation,
  trashOrganization,
  updateOrganizationMemberRole,
  upsertOrganizationWorkspaceMemberGrant,
  upsertOrganizationWorkspaceTeamGrant,
  validateOrganizationInvitation,
} from "@/lib/organizations/service";
import { authenticateApiToken } from "@/lib/tokens/service";
import {
  createWorkspace,
  listUserWorkspaces,
  resolveUserWorkspace,
} from "@/lib/workspaces/service";
import { setDocumentHumanGrant } from "@/lib/sharing/access";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];
const temporaryDatabaseDirectories: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (temporaryDatabaseDirectories.length > 0) {
    rmSync(temporaryDatabaseDirectories.pop()!, { recursive: true, force: true });
  }
});

function createSharedTestDatabases() {
  const directory = mkdtempSync(path.join(tmpdir(), "nyxdoc-organization-owner-race-"));
  temporaryDatabaseDirectories.push(directory);
  const databasePath = path.join(directory, "nyxdoc.db");
  const primary = openDatabase(databasePath);
  primary.exec(`
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
  runAppMigrations(primary);
  const contender = openDatabase(databasePath);
  // Make the second connection report a held immediate transaction straight
  // away. That lets this test deterministically exercise the same interleave
  // that would otherwise race across two application processes.
  contender.pragma("busy_timeout = 0");
  databases.push(primary, contender);
  return { primary, contender };
}

/**
 * Runs a mutation with a second connection changing state in the small window
 * immediately before the first connection acquires its write lock.  This is a
 * deterministic stand-in for two server processes receiving concurrent
 * requests; it catches pre-transaction authorization and stale audit reads.
 */
function withBeforeImmediateRace(
  database: NyxDatabase,
  beforeImmediate: () => void,
): NyxDatabase {
  const transaction = database.transaction.bind(database);
  let fired = false;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (work: Parameters<NyxDatabase["transaction"]>[0]) => {
        const runner = transaction(work);
        const run = <T>(invoke: () => T) => {
          if (!fired) {
            fired = true;
            beforeImmediate();
          }
          return invoke();
        };
        return {
          immediate: () => run(() => runner.immediate()),
          deferred: () => run(() => runner.deferred()),
          exclusive: () => run(() => runner.exclusive()),
        };
      };
    },
  }) as NyxDatabase;
}

function setupOrganization(database: NyxDatabase, name = "Junglan") {
  const owner = createTestUser(database, {
    name: "Owner",
    email: `owner-${randomUUID().slice(0, 8)}@example.com`,
  });
  const organization = createOrganization(database, {
    userId: owner.user.id,
    actorLabel: owner.user.name,
    name,
    icon: "J",
  });
  return { owner, organization };
}

function inviteAndAccept(
  database: NyxDatabase,
  input: {
    organizationId: string;
    owner: { id: string; name: string };
    invited: { id: string; name: string; email: string };
    role?: "admin" | "member";
  },
) {
  const created = createOrganizationInvitation(database, {
    organizationId: input.organizationId,
    userId: input.owner.id,
    actorLabel: input.owner.name,
    email: input.invited.email,
    role: input.role ?? "member",
  });
  return acceptOrganizationInvitation(database, {
    token: created.token,
    user: input.invited,
  });
}

describe("organization, team, and namespace boundaries", () => {
  it("creates an organization with one owner without changing the personal namespace", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);

    expect(organization).toMatchObject({
      name: "Junglan",
      icon: "J",
      role: "owner",
      lifecycleState: "active",
    });
    expect(listOrganizationMembers(database, organization.id, owner.user.id)).toEqual([
      expect.objectContaining({
        userId: owner.user.id,
        email: owner.user.email,
        role: "owner",
      }),
    ]);
    expect(listUserOrganizations(database, owner.user.id)).toEqual([
      expect.objectContaining({ id: organization.id, role: "owner" }),
    ]);
    expect(listUserWorkspaces(database, owner.user.id)).toEqual([
      expect.objectContaining({
        id: owner.workspace.id,
        owner: { type: "personal", id: owner.user.id, name: owner.user.name, icon: null },
      }),
    ]);
  });

  it("does not grant document access from organization membership alone", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const workspace = createWorkspace(database, owner.user, "Operations", "en", {
      organizationId: organization.id,
    });
    const invited = createTestUser(database, {
      name: "Member",
      email: "member@example.com",
    });
    inviteAndAccept(database, {
      organizationId: organization.id,
      owner: owner.user,
      invited: invited.user,
    });

    expect(listUserOrganizations(database, invited.user.id)).toEqual([
      expect.objectContaining({ id: organization.id, role: "member" }),
    ]);
    expect(getHumanWorkspacePrincipal(database, workspace.id, invited.user.id)).toBeNull();
    expect(listUserWorkspaces(database, invited.user.id).map((item) => item.id))
      .not.toContain(workspace.id);
    expect(() => resolveUserWorkspace(database, invited.user, { selector: workspace.id }))
      .toThrowError("워크스페이스를 찾을 수 없습니다.");
  });

  it("uses the highest explicit direct or team workspace role", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const workspace = createWorkspace(database, owner.user, "Product", "en", {
      organizationId: organization.id,
    });
    const invited = createTestUser(database, {
      name: "Designer",
      email: "designer@example.com",
    });
    inviteAndAccept(database, {
      organizationId: organization.id,
      owner: owner.user,
      invited: invited.user,
    });
    const team = createOrganizationTeam(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Product Team",
    });
    addOrganizationTeamMember(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      teamId: team.id,
      targetUserId: invited.user.id,
    });
    upsertOrganizationWorkspaceMemberGrant(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      workspaceId: workspace.id,
      targetUserId: invited.user.id,
      role: "viewer",
    });
    upsertOrganizationWorkspaceTeamGrant(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      workspaceId: workspace.id,
      teamId: team.id,
      role: "editor",
    });

    expect(getHumanWorkspacePrincipal(database, workspace.id, invited.user.id)).toEqual({
      type: "human",
      workspaceId: workspace.id,
      userId: invited.user.id,
      role: "editor",
      accessSource: "team",
    });
    expect(listUserWorkspaces(database, invited.user.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: workspace.id,
        role: "editor",
        accessSource: "team",
        owner: expect.objectContaining({ type: "organization", id: organization.id }),
      }),
    ]));

    upsertOrganizationWorkspaceMemberGrant(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      workspaceId: workspace.id,
      targetUserId: invited.user.id,
      role: "admin",
    });
    expect(getHumanWorkspacePrincipal(database, workspace.id, invited.user.id)).toMatchObject({
      role: "admin",
      accessSource: "membership",
    });
  });

  it("rolls back organization mutations when their audit record cannot be written", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const invited = createTestUser(database, {
      name: "Audited member",
      email: "audited-member@example.com",
    });
    inviteAndAccept(database, {
      organizationId: organization.id,
      owner: owner.user,
      invited: invited.user,
    });
    const team = createOrganizationTeam(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Atomic audit team",
    });
    database.exec(`
      CREATE TRIGGER reject_team_member_audit
      BEFORE INSERT ON organization_audit_events
      WHEN NEW.action = 'organization.team_member_added'
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END;
    `);

    expect(() => addOrganizationTeamMember(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      teamId: team.id,
      targetUserId: invited.user.id,
    })).toThrowError("forced audit failure");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM team_members WHERE team_id = ? AND user_id = ?",
    ).get(team.id, invited.user.id)).toEqual({ count: 0 });
  });

  it("enforces one-time, email-bound, revocable invitations", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const invited = createTestUser(database, {
      name: "Invitee",
      email: "invitee@example.com",
    });
    const wrongUser = createTestUser(database, {
      name: "Wrong",
      email: "wrong@example.com",
    });
    const created = createOrganizationInvitation(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      email: invited.user.email.toUpperCase(),
      role: "member",
    });

    expect(validateOrganizationInvitation(database, wrongUser.user.email, created.token)).toBeNull();
    expect(validateOrganizationInvitation(database, invited.user.email, created.token)).toMatchObject({
      organizationId: organization.id,
      email: invited.user.email,
    });
    expect(acceptOrganizationInvitation(database, {
      token: created.token,
      user: invited.user,
    })).toMatchObject({ organizationId: organization.id, role: "member" });
    expect(getActiveOrganizationInvitation(database, created.token)).toBeNull();
    expect(() => acceptOrganizationInvitation(database, {
      token: created.token,
      user: invited.user,
    })).toThrowError("유효한 조직 초대를 찾을 수 없습니다.");

    const revoked = createOrganizationInvitation(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      role: "member",
    });
    revokeOrganizationInvitation(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      invitationId: revoked.invitation.id,
    });
    expect(getActiveOrganizationInvitation(database, revoked.token)).toBeNull();
  });

  it("keeps at least one owner and prevents admins from promoting owners", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const admin = createTestUser(database, {
      name: "Admin",
      email: "admin@example.com",
    });
    inviteAndAccept(database, {
      organizationId: organization.id,
      owner: owner.user,
      invited: admin.user,
      role: "admin",
    });
    const member = createTestUser(database, {
      name: "Member",
      email: "role-member@example.com",
    });
    inviteAndAccept(database, {
      organizationId: organization.id,
      owner: owner.user,
      invited: member.user,
    });

    expect(() => updateOrganizationMemberRole(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      targetUserId: owner.user.id,
      actorLabel: owner.user.name,
      role: "member",
    })).toThrowError("조직에는 소유자가 한 명 이상 필요합니다.");
    expect(() => updateOrganizationMemberRole(database, {
      organizationId: organization.id,
      userId: admin.user.id,
      targetUserId: admin.user.id,
      actorLabel: admin.user.name,
      role: "owner",
    })).toThrowError("조직 관리자는 일반 멤버만 변경할 수 있습니다.");
    expect(() => updateOrganizationMemberRole(database, {
      organizationId: organization.id,
      userId: admin.user.id,
      targetUserId: member.user.id,
      actorLabel: admin.user.name,
      role: "admin",
    })).toThrowError("조직 관리자는 일반 멤버만 변경할 수 있습니다.");
    expect(() => removeOrganizationMember(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      targetUserId: owner.user.id,
      actorLabel: owner.user.name,
    })).toThrowError("조직에는 소유자가 한 명 이상 필요합니다.");

    updateOrganizationMemberRole(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      targetUserId: admin.user.id,
      actorLabel: owner.user.name,
      role: "owner",
    });
    updateOrganizationMemberRole(database, {
      organizationId: organization.id,
      userId: admin.user.id,
      targetUserId: owner.user.id,
      actorLabel: admin.user.name,
      role: "member",
    });
    expect(listOrganizationMembers(database, organization.id, admin.user.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: admin.user.id, role: "owner" }),
        expect.objectContaining({ userId: owner.user.id, role: "member" }),
      ]));
  });

  it("serializes two database connections that try to demote each other's last co-owner", () => {
    const { primary, contender } = createSharedTestDatabases();
    const { owner: firstOwner, organization } = setupOrganization(primary, "Owner demotion race");
    const secondOwner = createTestUser(primary, {
      name: "Second owner",
      email: "second-owner-race@example.com",
    });
    inviteAndAccept(primary, {
      organizationId: organization.id,
      owner: firstOwner.user,
      invited: secondOwner.user,
      role: "admin",
    });
    updateOrganizationMemberRole(primary, {
      organizationId: organization.id,
      userId: firstOwner.user.id,
      targetUserId: secondOwner.user.id,
      actorLabel: firstOwner.user.name,
      role: "owner",
    });

    let contenderSucceeded = false;
    let contenderError: unknown;
    let interleaved = false;
    const originalPrepare = primary.prepare.bind(primary);
    vi.spyOn(primary, "prepare").mockImplementation(((source: string) => {
      const statement = originalPrepare(source);
      if (interleaved || !source.includes("SELECT COUNT(*) AS count FROM organization_members")) {
        return statement;
      }
      return new Proxy(statement, {
        get(target, property) {
          if (property === "get") {
            return (...args: unknown[]) => {
              // Read the stale count first. Before this fix, this was the gap
              // between the owner check and BEGIN IMMEDIATE.
              const result = target.get(...args);
              interleaved = true;
              try {
                updateOrganizationMemberRole(contender, {
                  organizationId: organization.id,
                  userId: secondOwner.user.id,
                  targetUserId: firstOwner.user.id,
                  actorLabel: secondOwner.user.name,
                  role: "member",
                });
                contenderSucceeded = true;
              } catch (error) {
                contenderError = error;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof primary.prepare);

    updateOrganizationMemberRole(primary, {
      organizationId: organization.id,
      userId: firstOwner.user.id,
      targetUserId: secondOwner.user.id,
      actorLabel: firstOwner.user.name,
      role: "member",
    });

    expect(interleaved).toBe(true);
    expect(contenderSucceeded).toBe(false);
    expect(String((contenderError as Error | undefined)?.message)).toMatch(/database is locked/i);
    expect(primary.prepare(
      "SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = ? AND role = 'owner'",
    ).get(organization.id)).toEqual({ count: 1 });
    expect(listOrganizationMembers(primary, organization.id, firstOwner.user.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: firstOwner.user.id, role: "owner" }),
        expect.objectContaining({ userId: secondOwner.user.id, role: "member" }),
      ]),
    );
    expect(() => updateOrganizationMemberRole(contender, {
      organizationId: organization.id,
      userId: secondOwner.user.id,
      targetUserId: firstOwner.user.id,
      actorLabel: secondOwner.user.name,
      role: "member",
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("serializes two database connections that try to remove each other's last co-owner", () => {
    const { primary, contender } = createSharedTestDatabases();
    const { owner: firstOwner, organization } = setupOrganization(primary, "Owner removal race");
    const secondOwner = createTestUser(primary, {
      name: "Second owner",
      email: "second-owner-removal-race@example.com",
    });
    inviteAndAccept(primary, {
      organizationId: organization.id,
      owner: firstOwner.user,
      invited: secondOwner.user,
      role: "admin",
    });
    updateOrganizationMemberRole(primary, {
      organizationId: organization.id,
      userId: firstOwner.user.id,
      targetUserId: secondOwner.user.id,
      actorLabel: firstOwner.user.name,
      role: "owner",
    });

    let contenderSucceeded = false;
    let contenderError: unknown;
    let interleaved = false;
    const originalPrepare = primary.prepare.bind(primary);
    vi.spyOn(primary, "prepare").mockImplementation(((source: string) => {
      const statement = originalPrepare(source);
      if (interleaved || !source.includes("SELECT COUNT(*) AS count FROM organization_members")) {
        return statement;
      }
      return new Proxy(statement, {
        get(target, property) {
          if (property === "get") {
            return (...args: unknown[]) => {
              const result = target.get(...args);
              interleaved = true;
              try {
                removeOrganizationMember(contender, {
                  organizationId: organization.id,
                  userId: secondOwner.user.id,
                  targetUserId: firstOwner.user.id,
                  actorLabel: secondOwner.user.name,
                });
                contenderSucceeded = true;
              } catch (error) {
                contenderError = error;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof primary.prepare);

    removeOrganizationMember(primary, {
      organizationId: organization.id,
      userId: firstOwner.user.id,
      targetUserId: secondOwner.user.id,
      actorLabel: firstOwner.user.name,
    });

    expect(interleaved).toBe(true);
    expect(contenderSucceeded).toBe(false);
    expect(String((contenderError as Error | undefined)?.message)).toMatch(/database is locked/i);
    expect(primary.prepare(
      "SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = ? AND role = 'owner'",
    ).get(organization.id)).toEqual({ count: 1 });
    expect(listOrganizationMembers(primary, organization.id, firstOwner.user.id)).toEqual([
      expect.objectContaining({ userId: firstOwner.user.id, role: "owner" }),
    ]);
    expect(() => removeOrganizationMember(contender, {
      organizationId: organization.id,
      userId: secondOwner.user.id,
      targetUserId: firstOwner.user.id,
      actorLabel: secondOwner.user.name,
    })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("rejects invitation, team, and workspace-grant writes when a manager loses access before BEGIN IMMEDIATE", () => {
    const { primary, contender } = createSharedTestDatabases();
    const { owner, organization } = setupOrganization(primary, "Manager authorization race");
    const manager = createTestUser(primary, {
      name: "Manager",
      email: "manager-authorization-race@example.com",
    });
    const target = createTestUser(primary, {
      name: "Target",
      email: "target-authorization-race@example.com",
    });
    inviteAndAccept(primary, {
      organizationId: organization.id,
      owner: owner.user,
      invited: manager.user,
      role: "admin",
    });
    inviteAndAccept(primary, {
      organizationId: organization.id,
      owner: owner.user,
      invited: target.user,
    });
    const workspace = createWorkspace(primary, owner.user, "Authorization workspace", "en", {
      organizationId: organization.id,
    });
    const team = createOrganizationTeam(primary, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Authorization team",
    });

    const demoteManager = () => {
      contender.prepare(
        `UPDATE organization_members SET role = 'member', updated_at = ?
         WHERE organization_id = ? AND user_id = ?`,
      ).run("2026-08-09T00:00:00.000Z", organization.id, manager.user.id);
    };
    const restoreManager = () => {
      primary.prepare(
        `UPDATE organization_members SET role = 'admin', updated_at = ?
         WHERE organization_id = ? AND user_id = ?`,
      ).run("2026-08-09T00:01:00.000Z", organization.id, manager.user.id);
    };

    expect(() => createOrganizationInvitation(withBeforeImmediateRace(primary, demoteManager), {
      organizationId: organization.id,
      userId: manager.user.id,
      actorLabel: manager.user.name,
      email: "blocked-invite@example.com",
      role: "member",
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(primary.prepare(
      "SELECT 1 FROM organization_invitations WHERE organization_id = ? AND email = ?",
    ).get(organization.id, "blocked-invite@example.com")).toBeUndefined();

    restoreManager();
    expect(() => addOrganizationTeamMember(withBeforeImmediateRace(primary, demoteManager), {
      organizationId: organization.id,
      userId: manager.user.id,
      actorLabel: manager.user.name,
      teamId: team.id,
      targetUserId: target.user.id,
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(primary.prepare(
      "SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?",
    ).get(team.id, target.user.id)).toBeUndefined();

    restoreManager();
    expect(() => upsertOrganizationWorkspaceMemberGrant(withBeforeImmediateRace(primary, demoteManager), {
      organizationId: organization.id,
      userId: manager.user.id,
      actorLabel: manager.user.name,
      workspaceId: workspace.id,
      targetUserId: target.user.id,
      role: "editor",
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(primary.prepare(
      "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).get(workspace.id, target.user.id)).toBeUndefined();

    expect(listOrganizationAuditEvents(primary, organization.id, owner.user.id, 100)
      .map((event) => event.action)).not.toEqual(expect.arrayContaining([
      "organization.invitation_created",
      "organization.team_member_added",
      "organization.member_workspace_assigned",
    ]));
  });

  it("reads the current workspace-grant state inside BEGIN IMMEDIATE before auditing", () => {
    const { primary, contender } = createSharedTestDatabases();
    const { owner, organization } = setupOrganization(primary, "Current grant audit race");
    const member = createTestUser(primary, {
      name: "Grant member",
      email: "grant-member-audit-race@example.com",
    });
    inviteAndAccept(primary, {
      organizationId: organization.id,
      owner: owner.user,
      invited: member.user,
    });
    const workspace = createWorkspace(primary, owner.user, "Current grant workspace", "en", {
      organizationId: organization.id,
    });
    const team = createOrganizationTeam(primary, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Current grant team",
    });
    upsertOrganizationWorkspaceMemberGrant(primary, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      workspaceId: workspace.id,
      targetUserId: member.user.id,
      role: "viewer",
    });
    upsertOrganizationWorkspaceTeamGrant(primary, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      workspaceId: workspace.id,
      teamId: team.id,
      role: "viewer",
    });

    const racedMemberDatabase = withBeforeImmediateRace(primary, () => {
      contender.prepare(
        "UPDATE workspace_members SET access_role = 'editor' WHERE workspace_id = ? AND user_id = ?",
      ).run(workspace.id, member.user.id);
    });
    upsertOrganizationWorkspaceMemberGrant(racedMemberDatabase, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      workspaceId: workspace.id,
      targetUserId: member.user.id,
      role: "admin",
    });

    const racedTeamDatabase = withBeforeImmediateRace(primary, () => {
      contender.prepare(
        "UPDATE workspace_team_grants SET access_role = 'editor' WHERE workspace_id = ? AND team_id = ?",
      ).run(workspace.id, team.id);
    });
    upsertOrganizationWorkspaceTeamGrant(racedTeamDatabase, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      workspaceId: workspace.id,
      teamId: team.id,
      role: "admin",
    });

    const events = listOrganizationAuditEvents(primary, organization.id, owner.user.id, 100);
    const memberEvent = events.find((event) => event.action === "organization.member_workspace_role_updated")!;
    const teamEvent = events.find((event) => event.action === "organization.team_workspace_role_updated")!;
    expect(memberEvent.metadata).toMatchObject({ userId: member.user.id, before: "editor", after: "admin" });
    expect(teamEvent.metadata).toMatchObject({ teamId: team.id, before: "editor", after: "admin" });
  });

  it("does not create an organization workspace or self-admin grant after the actor is demoted", () => {
    const { primary, contender } = createSharedTestDatabases();
    const { owner, organization } = setupOrganization(primary, "Workspace creation authorization race");
    const manager = createTestUser(primary, {
      name: "Workspace manager",
      email: "workspace-manager-race@example.com",
    });
    inviteAndAccept(primary, {
      organizationId: organization.id,
      owner: owner.user,
      invited: manager.user,
      role: "admin",
    });

    const racedDatabase = withBeforeImmediateRace(primary, () => {
      contender.prepare(
        `UPDATE organization_members SET role = 'member', updated_at = ?
         WHERE organization_id = ? AND user_id = ?`,
      ).run("2026-08-09T00:02:00.000Z", organization.id, manager.user.id);
    });
    expect(() => createWorkspace(racedDatabase, manager.user, "Blocked organization workspace", "en", {
      organizationId: organization.id,
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    expect(primary.prepare(
      "SELECT 1 FROM workspaces WHERE name = ?",
    ).get("Blocked organization workspace")).toBeUndefined();
    expect(listOrganizationAuditEvents(primary, organization.id, owner.user.id, 100)
      .map((event) => event.action)).not.toContain("organization.workspace_created");
  });

  it("rejects cross-organization team grants and agent assignments", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = setupOrganization(database, "First Org");
    const secondOrganization = createOrganization(database, {
      userId: first.owner.user.id,
      actorLabel: first.owner.user.name,
      name: "Second Org",
    });
    const firstWorkspace = createWorkspace(database, first.owner.user, "First Workspace", "en", {
      organizationId: first.organization.id,
    });
    const secondWorkspace = createWorkspace(database, first.owner.user, "Second Workspace", "en", {
      organizationId: secondOrganization.id,
    });
    const secondTeam = createOrganizationTeam(database, {
      organizationId: secondOrganization.id,
      userId: first.owner.user.id,
      actorLabel: first.owner.user.name,
      name: "Second Team",
    });
    const secondAgent = createOrganizationAgent(database, {
      organizationId: secondOrganization.id,
      userId: first.owner.user.id,
      actorLabel: first.owner.user.name,
      displayName: "Second Agent",
    });

    expect(() => upsertOrganizationWorkspaceTeamGrant(database, {
      organizationId: first.organization.id,
      userId: first.owner.user.id,
      actorLabel: first.owner.user.name,
      workspaceId: firstWorkspace.id,
      teamId: secondTeam.id,
      role: "editor",
    })).toThrowError("팀을 찾을 수 없습니다.");
    expect(() => assignAgentToWorkspace(database, {
      userId: first.owner.user.id,
      workspaceId: firstWorkspace.id,
      agentId: secondAgent.id,
      accessProfile: "writer",
    })).toThrowError("다른 조직이 소유한 에이전트는 할당할 수 없습니다.");
    expect(() => database.prepare(
      `INSERT INTO workspace_team_grants
       (id, organization_id, workspace_id, team_id, access_role,
        granted_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'viewer', ?, 'now', 'now')`,
    ).run(
      randomUUID(),
      secondOrganization.id,
      firstWorkspace.id,
      secondTeam.id,
      first.owner.user.id,
    )).toThrow(/one organization/);

    expect(assignAgentToWorkspace(database, {
      userId: first.owner.user.id,
      workspaceId: secondWorkspace.id,
      agentId: secondAgent.id,
      accessProfile: "writer",
    })).toMatchObject({ workspaceId: secondWorkspace.id, agentId: secondAgent.id });
  });

  it("blocks human and agent access while an organization is trashed and restores both", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const workspace = createWorkspace(database, owner.user, "Canonical", "en", {
      organizationId: organization.id,
    });
    const agent = createOrganizationAgent(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      displayName: "Canonical Agent",
    });
    assignAgentToWorkspace(database, {
      userId: owner.user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const credential = createAgentCredential(database, {
      userId: owner.user.id,
      agentId: agent.id,
      name: "Canonical key",
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    expect(authenticateApiToken(database, `Bearer ${credential.token}`)).toMatchObject({
      workspaceId: workspace.id,
      globalAgentId: agent.id,
    });

    trashOrganization(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      confirmationName: organization.name,
      now: "2026-07-22T00:00:00.000Z",
    });

    expect(getHumanWorkspacePrincipal(database, workspace.id, owner.user.id)).toBeNull();
    expect(listUserWorkspaces(database, owner.user.id).map((item) => item.id))
      .not.toContain(workspace.id);
    expect(() => authenticateApiToken(database, `Bearer ${credential.token}`))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    restoreOrganization(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
    });
    expect(getHumanWorkspacePrincipal(database, workspace.id, owner.user.id)).toMatchObject({
      role: "admin",
    });
    expect(authenticateApiToken(database, `Bearer ${credential.token}`)).toMatchObject({
      workspaceId: workspace.id,
      globalAgentId: agent.id,
    });
    expect(listOrganizationAuditEvents(database, organization.id, owner.user.id, 50)
      .map((event) => event.action)).toEqual(expect.arrayContaining([
      "organization.created",
      "organization.workspace_created",
      "organization.agent_created",
      "organization.trashed",
      "organization.restored",
    ]));
  });

  it("allows an organization administrator to approve their personal agent without crossing organizations", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const workspace = createWorkspace(database, owner.user, "BYOA", "en", {
      organizationId: organization.id,
    });
    const personalAgent = createAccountAgent(database, {
      userId: owner.user.id,
      displayName: "Personal Codex",
    });

    expect(assignAgentToWorkspace(database, {
      userId: owner.user.id,
      workspaceId: workspace.id,
      agentId: personalAgent.id,
      accessProfile: "reader",
    })).toMatchObject({ workspaceId: workspace.id, agentId: personalAgent.id });
    expect(database.prepare(
      `SELECT organization_id, agent_id, approved_by_user_id, revoked_at
       FROM organization_agent_approvals WHERE organization_id = ? AND agent_id = ?`,
    ).get(organization.id, personalAgent.id)).toEqual({
      organization_id: organization.id,
      agent_id: personalAgent.id,
      approved_by_user_id: owner.user.id,
      revoked_at: null,
    });
  });

  it("lets organization admins manage organization agents without granting document access", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const workspace = createWorkspace(database, owner.user, "Agent Operations", "en", {
      organizationId: organization.id,
    });
    const administrator = createTestUser(database, {
      name: "Organization Admin",
      email: "organization-admin@example.com",
    });
    inviteAndAccept(database, {
      organizationId: organization.id,
      owner: owner.user,
      invited: administrator.user,
      role: "admin",
    });
    expect(getHumanWorkspacePrincipal(database, workspace.id, administrator.user.id)).toBeNull();

    const agent = createOrganizationAgent(database, {
      organizationId: organization.id,
      userId: administrator.user.id,
      actorLabel: administrator.user.name,
      displayName: "Shared Organization Agent",
    });
    const assignment = assignAgentToWorkspace(database, {
      userId: administrator.user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });

    expect(assignment).toMatchObject({
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    expect(listWorkspaceAgentMemberships(database, workspace.id, administrator.user.id))
      .toEqual([expect.objectContaining({ membershipId: assignment.membershipId })]);
    expect(getHumanWorkspacePrincipal(database, workspace.id, administrator.user.id)).toBeNull();
  });

  it("shows organization agent identities to members without exposing credentials or assignments", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const workspace = createWorkspace(database, owner.user, "Private Agent Metadata", "en", {
      organizationId: organization.id,
    });
    const agent = createOrganizationAgent(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      displayName: "Directory Agent",
    });
    assignAgentToWorkspace(database, {
      userId: owner.user.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "reader",
    });
    createAgentCredential(database, {
      userId: owner.user.id,
      agentId: agent.id,
      name: "Private network key",
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
      ipAllowlist: ["203.0.113.0/24"],
    });
    const member = createTestUser(database, {
      name: "Directory Member",
      email: "directory-member@example.com",
    });
    inviteAndAccept(database, {
      organizationId: organization.id,
      owner: owner.user,
      invited: member.user,
    });

    expect(listOrganizationAgents(database, organization.id, member.user.id)).toEqual([
      expect.objectContaining({
        id: agent.id,
        displayName: "Directory Agent",
        credentials: [],
        memberships: [],
      }),
    ]);
  });

  it("revokes a removed member personal-agent approval and disables its organization assignments", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { owner, organization } = setupOrganization(database);
    const workspace = createWorkspace(database, owner.user, "Member BYOA", "en", {
      organizationId: organization.id,
    });
    const administrator = createTestUser(database, {
      name: "Agent Administrator",
      email: "agent-admin@example.com",
    });
    inviteAndAccept(database, {
      organizationId: organization.id,
      owner: owner.user,
      invited: administrator.user,
      role: "admin",
    });
    const document = database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at LIMIT 1",
    ).get(workspace.id) as { id: string };
    setDocumentHumanGrant(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      recipientUserId: administrator.user.id,
      role: "editor",
      actorUserId: owner.user.id,
      actorLabel: owner.user.name,
    });
    const personalAgent = createAccountAgent(database, {
      userId: administrator.user.id,
      displayName: "Administrator Codex",
    });
    assignAgentToWorkspace(database, {
      userId: administrator.user.id,
      workspaceId: workspace.id,
      agentId: personalAgent.id,
      accessProfile: "writer",
    });
    const credential = createAgentCredential(database, {
      userId: administrator.user.id,
      agentId: personalAgent.id,
      name: "Administrator key",
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    expect(authenticateApiToken(database, `Bearer ${credential.token}`)).toMatchObject({
      workspaceId: workspace.id,
      globalAgentId: personalAgent.id,
    });

    removeOrganizationMember(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      targetUserId: administrator.user.id,
      actorLabel: owner.user.name,
    });

    expect(database.prepare(
      `SELECT revoked_at FROM organization_agent_approvals
       WHERE organization_id = ? AND agent_id = ?`,
    ).get(organization.id, personalAgent.id)).toEqual({
      revoked_at: expect.any(String),
    });
    expect(database.prepare(
      `SELECT status FROM workspace_agents
       WHERE workspace_id = ? AND agent_identity_id = ?`,
    ).get(workspace.id, personalAgent.id)).toEqual({ status: "disabled" });
    expect(database.prepare(
      "SELECT 1 FROM document_human_grants WHERE document_id = ? AND user_id = ?",
    ).get(document.id, administrator.user.id)).toBeUndefined();
    expect(() => authenticateApiToken(database, `Bearer ${credential.token}`))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});
