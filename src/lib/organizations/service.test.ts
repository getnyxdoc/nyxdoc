import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
  createOrganizationAgent,
  listOrganizationAgents,
  listWorkspaceAgentMemberships,
} from "@/lib/agents/service";
import { getHumanWorkspacePrincipal } from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
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

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

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
      role: "editor",
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
      role: "editor",
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
      role: "editor",
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
      role: "viewer",
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
      role: "editor",
    });

    expect(assignment).toMatchObject({
      workspaceId: workspace.id,
      agentId: agent.id,
      role: "editor",
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
      role: "viewer",
    });
    createAgentCredential(database, {
      userId: owner.user.id,
      agentId: agent.id,
      name: "Private network key",
      defaultWorkspaceId: workspace.id,
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
      role: "editor",
    });
    const credential = createAgentCredential(database, {
      userId: administrator.user.id,
      agentId: personalAgent.id,
      name: "Administrator key",
      defaultWorkspaceId: workspace.id,
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
