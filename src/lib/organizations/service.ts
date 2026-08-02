import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { HumanWorkspaceRole } from "@/lib/authz/permissions";
import { getAuthBaseUrl } from "@/lib/config";
import type { NyxDatabase } from "@/lib/db/client";

export type OrganizationRole = "owner" | "admin" | "member";
export type OrganizationPermission =
  | "organization.read"
  | "organization.update"
  | "organization.trash"
  | "members.read"
  | "members.manage"
  | "teams.read"
  | "teams.manage"
  | "workspaces.read"
  | "workspaces.manage"
  | "agents.read"
  | "agents.manage"
  | "audit.read";

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  role: OrganizationRole;
  lifecycleState: "active" | "trashed";
  trashedAt: string | null;
  purgeAfter: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationMemberSummary = {
  id: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: OrganizationRole;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationInvitationSummary = {
  id: string;
  email: string | null;
  role: Exclude<OrganizationRole, "owner">;
  prefix: string;
  status: "active" | "accepted" | "expired" | "revoked";
  createdByLabel: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};

export type TeamMemberSummary = Pick<
  OrganizationMemberSummary,
  "userId" | "name" | "email" | "image" | "role"
> & { joinedAt: string };

export type TeamSummary = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string;
  members: TeamMemberSummary[];
  createdAt: string;
  updatedAt: string;
};

export type OrganizationWorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  lifecycleState: "active" | "trashed";
  directMemberCount: number;
  teamGrantCount: number;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationWorkspaceGrant = {
  id: string;
  workspaceId: string;
  teamId: string;
  teamName: string;
  role: Exclude<HumanWorkspaceRole, "owner">;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationWorkspaceMemberGrant = {
  id: string;
  workspaceId: string;
  userId: string;
  memberName: string;
  memberEmail: string;
  memberImage: string | null;
  role: Exclude<HumanWorkspaceRole, "owner">;
  createdAt: string;
};

export type OrganizationAuditEvent = {
  cursor: number;
  id: string;
  action: string;
  outcome: "succeeded" | "denied" | "failed";
  actorLabel: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type OrganizationView = {
  organization: OrganizationSummary;
  members: OrganizationMemberSummary[];
  invitations: OrganizationInvitationSummary[];
  teams: TeamSummary[];
  workspaces: OrganizationWorkspaceSummary[];
  workspaceGrants: OrganizationWorkspaceGrant[];
  workspaceMemberGrants: OrganizationWorkspaceMemberGrant[];
  auditEvents: OrganizationAuditEvent[];
  permissions: {
    canUpdate: boolean;
    canTrash: boolean;
    canManageMembers: boolean;
    canManageTeams: boolean;
    canManageWorkspaces: boolean;
    canManageAgents: boolean;
    canReadAudit: boolean;
  };
};

export class OrganizationServiceError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "OrganizationServiceError";
  }
}

const ROLE_PERMISSIONS: Record<OrganizationRole, ReadonlySet<OrganizationPermission>> = {
  owner: new Set<OrganizationPermission>([
    "organization.read",
    "organization.update",
    "organization.trash",
    "members.read",
    "members.manage",
    "teams.read",
    "teams.manage",
    "workspaces.read",
    "workspaces.manage",
    "agents.read",
    "agents.manage",
    "audit.read",
  ]),
  admin: new Set<OrganizationPermission>([
    "organization.read",
    "organization.update",
    "members.read",
    "members.manage",
    "teams.read",
    "teams.manage",
    "workspaces.read",
    "workspaces.manage",
    "agents.read",
    "agents.manage",
    "audit.read",
  ]),
  member: new Set<OrganizationPermission>([
    "organization.read",
    "members.read",
    "teams.read",
    "workspaces.read",
    "agents.read",
  ]),
};

export function organizationRoleAllows(
  role: OrganizationRole,
  permission: OrganizationPermission,
) {
  return ROLE_PERMISSIONS[role].has(permission);
}

function normalizeName(value: string, label: string, max = 120) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max) {
    throw new OrganizationServiceError(
      "INVALID_INPUT",
      `${label}은 1자 이상 ${max}자 이하여야 합니다.`,
    );
  }
  return normalized;
}

function normalizeIcon(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!normalized) return null;
  if (Array.from(normalized).length > 8) {
    throw new OrganizationServiceError("INVALID_INPUT", "조직 아이콘은 8자 이하여야 합니다.");
  }
  return normalized;
}

function normalizeEmail(value: string | null | undefined) {
  if (value === null || value === undefined || !value.trim()) return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new OrganizationServiceError("INVALID_INPUT", "초대할 이메일 주소를 확인해주세요.");
  }
  return email;
}

function slugBase(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "organization";
}

function uniqueOrganizationSlug(database: NyxDatabase, name: string) {
  const base = slugBase(name);
  let slug = `${base}-${randomUUID().slice(0, 8)}`;
  while (database.prepare("SELECT 1 FROM organizations WHERE slug = ?").get(slug)) {
    slug = `${base}-${randomUUID().slice(0, 8)}`;
  }
  return slug;
}

function uniqueTeamSlug(database: NyxDatabase, organizationId: string, name: string) {
  const base = slugBase(name);
  let slug = base;
  let suffix = 2;
  while (database.prepare(
    "SELECT 1 FROM teams WHERE organization_id = ? AND slug = ?",
  ).get(organizationId, slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function organizationFromRow(row: {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  role: OrganizationRole;
  lifecycle_state: "active" | "trashed";
  trashed_at: string | null;
  purge_after: string | null;
  created_at: string;
  updated_at: string;
}): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    role: row.role,
    lifecycleState: row.lifecycle_state,
    trashedAt: row.trashed_at,
    purgeAfter: row.purge_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listUserOrganizations(
  database: NyxDatabase,
  userId: string,
  options: { includeTrashed?: boolean } = {},
): OrganizationSummary[] {
  const lifecycle = options.includeTrashed ? "" : "AND organization.lifecycle_state = 'active'";
  return (database.prepare(
    `SELECT organization.id, organization.name, organization.slug, organization.icon,
            member.role, organization.lifecycle_state, organization.trashed_at,
            organization.purge_after, organization.created_at, organization.updated_at
     FROM organizations organization
     JOIN organization_members member ON member.organization_id = organization.id
     WHERE member.user_id = ? ${lifecycle}
     ORDER BY organization.lifecycle_state, organization.name COLLATE NOCASE, organization.id`,
  ).all(userId) as Parameters<typeof organizationFromRow>[0][]).map(organizationFromRow);
}

export function getOrganizationRole(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
  options: { includeTrashed?: boolean } = {},
): OrganizationRole | null {
  const lifecycle = options.includeTrashed ? "" : "AND organization.lifecycle_state = 'active'";
  const row = database.prepare(
    `SELECT member.role
     FROM organization_members member
     JOIN organizations organization ON organization.id = member.organization_id
     WHERE member.organization_id = ? AND member.user_id = ? ${lifecycle}`,
  ).get(organizationId, userId) as { role: OrganizationRole } | undefined;
  return row?.role ?? null;
}

export function requireOrganizationPermission(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
  permission: OrganizationPermission,
  options: { includeTrashed?: boolean } = {},
) {
  const role = getOrganizationRole(database, organizationId, userId, options);
  if (!role) throw new OrganizationServiceError("NOT_FOUND", "조직을 찾을 수 없습니다.");
  if (!organizationRoleAllows(role, permission)) {
    throw new OrganizationServiceError("FORBIDDEN", "이 조직 작업을 수행할 권한이 없습니다.");
  }
  return role;
}

export function recordOrganizationAuditEvent(
  database: NyxDatabase,
  input: {
    organizationId: string;
    action: string;
    outcome?: "succeeded" | "denied" | "failed";
    actorType?: "human" | "system";
    actorUserId?: string | null;
    actorLabel: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  },
) {
  database.prepare(
    `INSERT INTO organization_audit_events
     (id, organization_id, action, outcome, actor_type, actor_user_id,
      actor_label, target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.organizationId,
    input.action,
    input.outcome ?? "succeeded",
    input.actorType ?? "human",
    input.actorUserId ?? null,
    input.actorLabel,
    input.targetType,
    input.targetId ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.createdAt ?? new Date().toISOString(),
  );
}

export function createOrganization(
  database: NyxDatabase,
  input: { userId: string; actorLabel: string; name: string; icon?: string | null },
) {
  const name = normalizeName(input.name, "조직 이름");
  const icon = normalizeIcon(input.icon) ?? null;
  const id = randomUUID();
  const now = new Date().toISOString();
  return database.transaction(() => {
    database.prepare(
      `INSERT INTO organizations
       (id, name, slug, icon, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, uniqueOrganizationSlug(database, name), icon, input.userId, now, now);
    database.prepare(
      `INSERT INTO organization_members
       (id, organization_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', ?, ?)`,
    ).run(randomUUID(), id, input.userId, now, now);
    recordOrganizationAuditEvent(database, {
      organizationId: id,
      action: "organization.created",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "organization",
      targetId: id,
      metadata: { name, icon },
      createdAt: now,
    });
    return listUserOrganizations(database, input.userId).find((item) => item.id === id)!;
  }).immediate();
}

export function updateOrganization(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    name?: string;
    icon?: string | null;
  },
) {
  requireOrganizationPermission(
    database,
    input.organizationId,
    input.userId,
    "organization.update",
  );
  const current = database.prepare(
    "SELECT name, icon FROM organizations WHERE id = ? AND lifecycle_state = 'active'",
  ).get(input.organizationId) as { name: string; icon: string | null } | undefined;
  if (!current) throw new OrganizationServiceError("NOT_FOUND", "조직을 찾을 수 없습니다.");
  const name = input.name === undefined ? current.name : normalizeName(input.name, "조직 이름");
  const icon = input.icon === undefined ? current.icon : normalizeIcon(input.icon) ?? null;
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      "UPDATE organizations SET name = ?, icon = ?, updated_at = ? WHERE id = ?",
    ).run(name, icon, now, input.organizationId);
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.updated",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "organization",
      targetId: input.organizationId,
      metadata: { before: current, after: { name, icon } },
      createdAt: now,
    });
  }).immediate();
  return listUserOrganizations(database, input.userId).find(
    (item) => item.id === input.organizationId,
  )!;
}

function organizationLifecycleRow(database: NyxDatabase, organizationId: string) {
  return database.prepare(
    `SELECT id, name, slug, icon, lifecycle_state, trash_retention_days,
            trashed_at, purge_after, created_at, updated_at
     FROM organizations WHERE id = ?`,
  ).get(organizationId) as {
    id: string;
    name: string;
    slug: string;
    icon: string | null;
    lifecycle_state: "active" | "trashed";
    trash_retention_days: number;
    trashed_at: string | null;
    purge_after: string | null;
    created_at: string;
    updated_at: string;
  } | undefined;
}

export function trashOrganization(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    confirmationName: string;
    now?: string;
  },
) {
  const role = requireOrganizationPermission(
    database,
    input.organizationId,
    input.userId,
    "organization.trash",
  );
  if (role !== "owner") {
    throw new OrganizationServiceError("FORBIDDEN", "조직 소유자만 조직을 삭제할 수 있습니다.");
  }
  const organization = organizationLifecycleRow(database, input.organizationId);
  if (!organization || organization.lifecycle_state !== "active") {
    throw new OrganizationServiceError("NOT_FOUND", "조직을 찾을 수 없습니다.");
  }
  if (organization.name !== input.confirmationName.trim()) {
    throw new OrganizationServiceError("INVALID_INPUT", "조직 이름을 정확히 입력해주세요.");
  }
  const now = input.now ?? new Date().toISOString();
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new OrganizationServiceError("INVALID_INPUT", "삭제 시각을 확인해주세요.");
  }
  const purgeAfter = new Date(
    timestamp + Number(organization.trash_retention_days) * 24 * 60 * 60 * 1_000,
  ).toISOString();
  database.transaction(() => {
    const result = database.prepare(
      `UPDATE organizations
       SET lifecycle_state = 'trashed', trashed_at = ?, purge_after = ?,
           trashed_by_user_id = ?, trashed_by_label = ?, updated_at = ?
       WHERE id = ? AND lifecycle_state = 'active'`,
    ).run(now, purgeAfter, input.userId, input.actorLabel, now, input.organizationId);
    if (result.changes !== 1) {
      throw new OrganizationServiceError(
        "CONFLICT",
        "조직 상태가 바뀌었습니다. 새로고침 후 다시 시도해주세요.",
      );
    }
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.trashed",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "organization",
      targetId: input.organizationId,
      metadata: { name: organization.name, purgeAfter },
      createdAt: now,
    });
  }).immediate();
  return { ...organization, lifecycleState: "trashed" as const, trashedAt: now, purgeAfter };
}

export function restoreOrganization(
  database: NyxDatabase,
  input: { organizationId: string; userId: string; actorLabel: string },
) {
  const role = requireOrganizationPermission(
    database,
    input.organizationId,
    input.userId,
    "organization.trash",
    { includeTrashed: true },
  );
  if (role !== "owner") {
    throw new OrganizationServiceError("FORBIDDEN", "조직 소유자만 조직을 복구할 수 있습니다.");
  }
  const organization = organizationLifecycleRow(database, input.organizationId);
  if (!organization || organization.lifecycle_state !== "trashed") {
    throw new OrganizationServiceError("NOT_FOUND", "휴지통 조직을 찾을 수 없습니다.");
  }
  const now = new Date().toISOString();
  database.transaction(() => {
    const result = database.prepare(
      `UPDATE organizations
       SET lifecycle_state = 'active', trashed_at = NULL, purge_after = NULL,
           trashed_by_user_id = NULL, trashed_by_label = NULL, updated_at = ?
       WHERE id = ? AND lifecycle_state = 'trashed'`,
    ).run(now, input.organizationId);
    if (result.changes !== 1) {
      throw new OrganizationServiceError(
        "CONFLICT",
        "조직 상태가 바뀌었습니다. 새로고침 후 다시 시도해주세요.",
      );
    }
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.restored",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "organization",
      targetId: input.organizationId,
      metadata: { name: organization.name, trashedAt: organization.trashed_at },
      createdAt: now,
    });
  }).immediate();
  return listUserOrganizations(database, input.userId).find(
    (item) => item.id === input.organizationId,
  )!;
}

export function listOrganizationMembers(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
) {
  requireOrganizationPermission(database, organizationId, userId, "members.read");
  return (database.prepare(
    `SELECT member.id, member.user_id, account.name, account.email, account.image,
            member.role, member.created_at, member.updated_at
     FROM organization_members member
     JOIN user account ON account.id = member.user_id
     WHERE member.organization_id = ?
     ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
              account.name COLLATE NOCASE, account.email COLLATE NOCASE`,
  ).all(organizationId) as Array<{
    id: string;
    user_id: string;
    name: string;
    email: string;
    image: string | null;
    role: OrganizationRole;
    created_at: string;
    updated_at: string;
  }>).map((row) => ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    image: row.image,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies OrganizationMemberSummary));
}

function assertCanChangeMember(
  database: NyxDatabase,
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
  nextRole?: OrganizationRole,
) {
  const actorRole = requireOrganizationPermission(
    database,
    organizationId,
    actorUserId,
    "members.manage",
  );
  const target = database.prepare(
    "SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?",
  ).get(organizationId, targetUserId) as { role: OrganizationRole } | undefined;
  if (!target) throw new OrganizationServiceError("NOT_FOUND", "조직 멤버를 찾을 수 없습니다.");
  if (
    actorRole !== "owner"
    && (target.role !== "member" || (nextRole !== undefined && nextRole !== "member"))
  ) {
    throw new OrganizationServiceError(
      "FORBIDDEN",
      "조직 관리자는 일반 멤버만 변경할 수 있습니다.",
    );
  }
  if (target.role === "owner" && nextRole !== "owner") {
    const owners = database.prepare(
      "SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = ? AND role = 'owner'",
    ).get(organizationId) as { count: number };
    if (Number(owners.count) <= 1) {
      throw new OrganizationServiceError("CONFLICT", "조직에는 소유자가 한 명 이상 필요합니다.");
    }
  }
  return { actorRole, targetRole: target.role };
}

export function updateOrganizationMemberRole(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    targetUserId: string;
    role: OrganizationRole;
    actorLabel: string;
  },
) {
  const current = assertCanChangeMember(
    database,
    input.organizationId,
    input.userId,
    input.targetUserId,
    input.role,
  );
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE organization_members SET role = ?, updated_at = ?
       WHERE organization_id = ? AND user_id = ?`,
    ).run(input.role, now, input.organizationId, input.targetUserId);
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.member_role_updated",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "user",
      targetId: input.targetUserId,
      metadata: { before: current.targetRole, after: input.role },
      createdAt: now,
    });
  }).immediate();
  return listOrganizationMembers(database, input.organizationId, input.userId).find(
    (member) => member.userId === input.targetUserId,
  )!;
}

export function removeOrganizationMember(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    targetUserId: string;
    actorLabel: string;
  },
) {
  const current = assertCanChangeMember(
    database,
    input.organizationId,
    input.userId,
    input.targetUserId,
  );
  const now = new Date().toISOString();
  database.transaction(() => {
    const revokedPersonalAgentApprovals = database.prepare(
      `UPDATE organization_agent_approvals
       SET revoked_at = ?
       WHERE organization_id = ? AND revoked_at IS NULL
         AND agent_id IN (
           SELECT agent_id FROM agent_ownership
           WHERE owner_type = 'personal' AND owner_user_id = ?
         )`,
    ).run(now, input.organizationId, input.targetUserId);
    const disabledPersonalAgentMemberships = database.prepare(
      `UPDATE workspace_agents
       SET status = 'disabled', updated_at = ?
       WHERE status = 'active'
         AND workspace_id IN (
           SELECT workspace_id FROM workspace_ownership
           WHERE owner_type = 'organization' AND organization_id = ?
         )
         AND agent_identity_id IN (
           SELECT agent_id FROM agent_ownership
           WHERE owner_type = 'personal' AND owner_user_id = ?
         )`,
    ).run(now, input.organizationId, input.targetUserId);
    database.prepare(
      "DELETE FROM team_members WHERE organization_id = ? AND user_id = ?",
    ).run(input.organizationId, input.targetUserId);
    database.prepare(
      `DELETE FROM workspace_members
       WHERE user_id = ? AND workspace_id IN (
         SELECT workspace_id FROM workspace_ownership
         WHERE owner_type = 'organization' AND organization_id = ?
       )`,
    ).run(input.targetUserId, input.organizationId);
    database.prepare(
      `DELETE FROM document_human_grants
       WHERE user_id = ? AND workspace_id IN (
         SELECT workspace_id FROM workspace_ownership
         WHERE owner_type = 'organization' AND organization_id = ?
       )`,
    ).run(input.targetUserId, input.organizationId);
    database.prepare(
      "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?",
    ).run(input.organizationId, input.targetUserId);
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.member_removed",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "user",
      targetId: input.targetUserId,
      metadata: {
        previousRole: current.targetRole,
        revokedPersonalAgentApprovalCount: revokedPersonalAgentApprovals.changes,
        disabledPersonalAgentMembershipCount: disabledPersonalAgentMemberships.changes,
      },
      createdAt: now,
    });
  }).immediate();
}

function invitationStatus(row: {
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}): OrganizationInvitationSummary["status"] {
  if (row.revoked_at) return "revoked";
  if (row.accepted_at) return "accepted";
  if (Date.parse(row.expires_at) <= Date.now()) return "expired";
  return "active";
}

export function listOrganizationInvitations(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
) {
  requireOrganizationPermission(database, organizationId, userId, "members.manage");
  return (database.prepare(
    `SELECT id, email, role, token_prefix, created_by_label, created_at,
            expires_at, accepted_at, revoked_at
     FROM organization_invitations
     WHERE organization_id = ?
     ORDER BY created_at DESC`,
  ).all(organizationId) as Array<{
    id: string;
    email: string | null;
    role: "admin" | "member";
    token_prefix: string;
    created_by_label: string;
    created_at: string;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  }>).map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    prefix: row.token_prefix,
    status: invitationStatus(row),
    createdByLabel: row.created_by_label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  } satisfies OrganizationInvitationSummary));
}

export function createOrganizationInvitation(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    email?: string | null;
    role: "admin" | "member";
    expiresInDays?: number;
  },
) {
  const actorRole = requireOrganizationPermission(
    database,
    input.organizationId,
    input.userId,
    "members.manage",
  );
  if (actorRole !== "owner" && input.role === "admin") {
    throw new OrganizationServiceError("FORBIDDEN", "조직 소유자만 관리자를 초대할 수 있습니다.");
  }
  const email = normalizeEmail(input.email);
  if (email) {
    const existing = database.prepare(
      `SELECT 1 FROM organization_members member
       JOIN user account ON account.id = member.user_id
       WHERE member.organization_id = ? AND lower(account.email) = ?`,
    ).get(input.organizationId, email);
    if (existing) throw new OrganizationServiceError("CONFLICT", "이미 조직에 참여한 사용자입니다.");
  }
  const expiresInDays = input.expiresInDays ?? 7;
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
    throw new OrganizationServiceError("INVALID_INPUT", "초대 유효기간은 1일 이상 30일 이하여야 합니다.");
  }
  const rawToken = `nyx_org_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1_000);
  database.transaction(() => {
    if (email) {
      database.prepare(
        `UPDATE organization_invitations SET revoked_at = ?
         WHERE organization_id = ? AND email = ?
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      ).run(now.toISOString(), input.organizationId, email, now.toISOString());
    }
    database.prepare(
      `INSERT INTO organization_invitations
       (id, organization_id, email, role, token_prefix, token_hash,
        created_by_user_id, created_by_label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.organizationId,
      email,
      input.role,
      rawToken.slice(0, 16),
      hash,
      input.userId,
      input.actorLabel,
      now.toISOString(),
      expiresAt.toISOString(),
    );
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.invitation_created",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "invitation",
      targetId: id,
      metadata: { email, role: input.role, expiresAt: expiresAt.toISOString() },
      createdAt: now.toISOString(),
    });
  }).immediate();
  return {
    invitation: listOrganizationInvitations(database, input.organizationId, input.userId).find(
      (invitation) => invitation.id === id,
    )!,
    token: rawToken,
    url: `${getAuthBaseUrl().replace(/\/$/, "")}/organization-invite?invite=${encodeURIComponent(rawToken)}`,
  };
}

type ActiveInvitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string | null;
  role: "admin" | "member";
  expiresAt: string;
};

export function getActiveOrganizationInvitation(
  database: NyxDatabase,
  token: string,
): ActiveInvitation | null {
  if (!token.startsWith("nyx_org_") || token.length > 256) return null;
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const row = database.prepare(
    `SELECT invitation.id, invitation.organization_id, organization.name,
            invitation.email, invitation.role, invitation.expires_at
     FROM organization_invitations invitation
     JOIN organizations organization ON organization.id = invitation.organization_id
     WHERE invitation.token_hash = ?
       AND invitation.accepted_at IS NULL
       AND invitation.revoked_at IS NULL
       AND invitation.expires_at > ?
       AND organization.lifecycle_state = 'active'`,
  ).get(hash, new Date().toISOString()) as {
    id: string;
    organization_id: string;
    name: string;
    email: string | null;
    role: "admin" | "member";
    expires_at: string;
  } | undefined;
  return row ? {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.name,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
  } : null;
}

export function validateOrganizationInvitation(
  database: NyxDatabase,
  email: string,
  token: string,
) {
  const invitation = getActiveOrganizationInvitation(database, token);
  if (!invitation) return null;
  const normalized = email.trim().toLowerCase();
  return !invitation.email || invitation.email === normalized ? invitation : null;
}

export function acceptOrganizationInvitation(
  database: NyxDatabase,
  input: { token: string; user: { id: string; name: string; email: string } },
) {
  const invitation = validateOrganizationInvitation(database, input.user.email, input.token);
  if (!invitation) {
    throw new OrganizationServiceError("NOT_FOUND", "유효한 조직 초대를 찾을 수 없습니다.");
  }
  const now = new Date().toISOString();
  return database.transaction(() => {
    const existing = database.prepare(
      "SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?",
    ).get(invitation.organizationId, input.user.id) as { role: OrganizationRole } | undefined;
    if (!existing) {
      database.prepare(
        `INSERT INTO organization_members
         (id, organization_id, user_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        invitation.organizationId,
        input.user.id,
        invitation.role,
        now,
        now,
      );
    }
    const accepted = database.prepare(
      `UPDATE organization_invitations
       SET accepted_at = ?, accepted_by_user_id = ?
       WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    ).run(now, input.user.id, invitation.id, now);
    if (accepted.changes !== 1) {
      throw new OrganizationServiceError("CONFLICT", "이 초대는 이미 사용되었거나 만료되었습니다.");
    }
    recordOrganizationAuditEvent(database, {
      organizationId: invitation.organizationId,
      action: "organization.invitation_accepted",
      actorUserId: input.user.id,
      actorLabel: input.user.name,
      targetType: "user",
      targetId: input.user.id,
      metadata: { invitationId: invitation.id, role: existing?.role ?? invitation.role },
      createdAt: now,
    });
    return {
      organizationId: invitation.organizationId,
      organizationName: invitation.organizationName,
      role: existing?.role ?? invitation.role,
    };
  }).immediate();
}

export function revokeOrganizationInvitation(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    invitationId: string;
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "members.manage");
  const now = new Date().toISOString();
  database.transaction(() => {
    const result = database.prepare(
      `UPDATE organization_invitations SET revoked_at = ?
       WHERE id = ? AND organization_id = ?
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    ).run(now, input.invitationId, input.organizationId, now);
    if (result.changes !== 1) {
      throw new OrganizationServiceError("NOT_FOUND", "사용 가능한 조직 초대를 찾을 수 없습니다.");
    }
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.invitation_revoked",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "invitation",
      targetId: input.invitationId,
      createdAt: now,
    });
  }).immediate();
}

export function listOrganizationTeams(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
) {
  requireOrganizationPermission(database, organizationId, userId, "teams.read");
  const teams = database.prepare(
    `SELECT id, organization_id, name, slug, description, created_at, updated_at
     FROM teams WHERE organization_id = ?
     ORDER BY name COLLATE NOCASE, created_at`,
  ).all(organizationId) as Array<{
    id: string;
    organization_id: string;
    name: string;
    slug: string;
    description: string;
    created_at: string;
    updated_at: string;
  }>;
  const members = database.prepare(
    `SELECT team_member.team_id, team_member.user_id, account.name, account.email,
            account.image, organization_member.role, team_member.created_at
     FROM team_members team_member
     JOIN user account ON account.id = team_member.user_id
     JOIN organization_members organization_member
       ON organization_member.organization_id = team_member.organization_id
      AND organization_member.user_id = team_member.user_id
     WHERE team_member.organization_id = ?
     ORDER BY account.name COLLATE NOCASE, account.email COLLATE NOCASE`,
  ).all(organizationId) as Array<{
    team_id: string;
    user_id: string;
    name: string;
    email: string;
    image: string | null;
    role: OrganizationRole;
    created_at: string;
  }>;
  return teams.map((team) => ({
    id: team.id,
    organizationId: team.organization_id,
    name: team.name,
    slug: team.slug,
    description: team.description,
    members: members.filter((member) => member.team_id === team.id).map((member) => ({
      userId: member.user_id,
      name: member.name,
      email: member.email,
      image: member.image,
      role: member.role,
      joinedAt: member.created_at,
    })),
    createdAt: team.created_at,
    updatedAt: team.updated_at,
  } satisfies TeamSummary));
}

export function createOrganizationTeam(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    name: string;
    description?: string;
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "teams.manage");
  const name = normalizeName(input.name, "팀 이름", 80);
  const description = (input.description ?? "").trim().slice(0, 500);
  const now = new Date().toISOString();
  const id = randomUUID();
  database.transaction(() => {
    database.prepare(
      `INSERT INTO teams
       (id, organization_id, name, slug, description, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.organizationId,
      name,
      uniqueTeamSlug(database, input.organizationId, name),
      description,
      input.userId,
      now,
      now,
    );
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.team_created",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "team",
      targetId: id,
      metadata: { name },
      createdAt: now,
    });
  }).immediate();
  return listOrganizationTeams(database, input.organizationId, input.userId).find(
    (team) => team.id === id,
  )!;
}

function requireTeam(
  database: NyxDatabase,
  organizationId: string,
  teamId: string,
) {
  const team = database.prepare(
    "SELECT id, name, description FROM teams WHERE id = ? AND organization_id = ?",
  ).get(teamId, organizationId) as { id: string; name: string; description: string } | undefined;
  if (!team) throw new OrganizationServiceError("NOT_FOUND", "팀을 찾을 수 없습니다.");
  return team;
}

export function updateOrganizationTeam(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    teamId: string;
    name: string;
    description?: string;
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "teams.manage");
  const current = requireTeam(database, input.organizationId, input.teamId);
  const name = normalizeName(input.name, "팀 이름", 80);
  const description = (input.description ?? "").trim().slice(0, 500);
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE teams SET name = ?, description = ?, updated_at = ?
       WHERE id = ? AND organization_id = ?`,
    ).run(name, description, now, input.teamId, input.organizationId);
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.team_updated",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "team",
      targetId: input.teamId,
      metadata: { before: current, after: { name, description } },
      createdAt: now,
    });
  }).immediate();
  return listOrganizationTeams(database, input.organizationId, input.userId).find(
    (team) => team.id === input.teamId,
  )!;
}

export function deleteOrganizationTeam(
  database: NyxDatabase,
  input: { organizationId: string; userId: string; actorLabel: string; teamId: string },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "teams.manage");
  const current = requireTeam(database, input.organizationId, input.teamId);
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      "DELETE FROM teams WHERE id = ? AND organization_id = ?",
    ).run(input.teamId, input.organizationId);
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.team_deleted",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "team",
      targetId: input.teamId,
      metadata: { name: current.name },
      createdAt: now,
    });
  }).immediate();
}

export function addOrganizationTeamMember(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    teamId: string;
    targetUserId: string;
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "teams.manage");
  requireTeam(database, input.organizationId, input.teamId);
  const member = database.prepare(
    "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?",
  ).get(input.organizationId, input.targetUserId);
  if (!member) throw new OrganizationServiceError("INVALID_INPUT", "조직 멤버만 팀에 추가할 수 있습니다.");
  const now = new Date().toISOString();
  database.transaction(() => {
    const result = database.prepare(
      `INSERT INTO team_members
       (id, organization_id, team_id, user_id, added_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_id, user_id) DO NOTHING`,
    ).run(
      randomUUID(),
      input.organizationId,
      input.teamId,
      input.targetUserId,
      input.userId,
      now,
    );
    if (result.changes !== 1) {
      throw new OrganizationServiceError("CONFLICT", "이미 이 팀에 포함된 멤버입니다.");
    }
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.team_member_added",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "team",
      targetId: input.teamId,
      metadata: { userId: input.targetUserId },
      createdAt: now,
    });
  }).immediate();
  return listOrganizationTeams(database, input.organizationId, input.userId).find(
    (team) => team.id === input.teamId,
  )!;
}

export function removeOrganizationTeamMember(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    teamId: string;
    targetUserId: string;
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "teams.manage");
  requireTeam(database, input.organizationId, input.teamId);
  const now = new Date().toISOString();
  database.transaction(() => {
    const result = database.prepare(
      `DELETE FROM team_members
       WHERE organization_id = ? AND team_id = ? AND user_id = ?`,
    ).run(input.organizationId, input.teamId, input.targetUserId);
    if (result.changes !== 1) {
      throw new OrganizationServiceError("NOT_FOUND", "팀 멤버를 찾을 수 없습니다.");
    }
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.team_member_removed",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "team",
      targetId: input.teamId,
      metadata: { userId: input.targetUserId },
      createdAt: now,
    });
  }).immediate();
}

export function listOrganizationWorkspaces(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
) {
  requireOrganizationPermission(database, organizationId, userId, "workspaces.read");
  return (database.prepare(
    `SELECT workspace.id, workspace.name, workspace.slug, workspace.lifecycle_state,
            workspace.created_at, workspace.updated_at,
            (SELECT COUNT(*) FROM workspace_members member
             WHERE member.workspace_id = workspace.id) AS direct_member_count,
            (SELECT COUNT(*) FROM workspace_team_grants grant_entry
             WHERE grant_entry.workspace_id = workspace.id) AS team_grant_count
     FROM workspace_ownership ownership
     JOIN workspaces workspace ON workspace.id = ownership.workspace_id
     WHERE ownership.owner_type = 'organization' AND ownership.organization_id = ?
     ORDER BY workspace.lifecycle_state, workspace.name COLLATE NOCASE, workspace.id`,
  ).all(organizationId) as Array<{
    id: string;
    name: string;
    slug: string;
    lifecycle_state: "active" | "trashed";
    direct_member_count: number;
    team_grant_count: number;
    created_at: string;
    updated_at: string;
  }>).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    lifecycleState: row.lifecycle_state,
    directMemberCount: Number(row.direct_member_count),
    teamGrantCount: Number(row.team_grant_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies OrganizationWorkspaceSummary));
}

export function listOrganizationWorkspaceGrants(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
) {
  requireOrganizationPermission(database, organizationId, userId, "workspaces.read");
  return (database.prepare(
    `SELECT grant_entry.id, grant_entry.workspace_id, grant_entry.team_id,
            team.name AS team_name, grant_entry.access_role,
            grant_entry.created_at, grant_entry.updated_at
     FROM workspace_team_grants grant_entry
     JOIN teams team ON team.id = grant_entry.team_id
     WHERE grant_entry.organization_id = ?
     ORDER BY grant_entry.workspace_id, team.name COLLATE NOCASE`,
  ).all(organizationId) as Array<{
    id: string;
    workspace_id: string;
    team_id: string;
    team_name: string;
    access_role: "admin" | "editor" | "viewer";
    created_at: string;
    updated_at: string;
  }>).map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    teamName: row.team_name,
    role: row.access_role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies OrganizationWorkspaceGrant));
}

export function listOrganizationWorkspaceMemberGrants(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
) {
  requireOrganizationPermission(database, organizationId, userId, "workspaces.read");
  return (database.prepare(
    `SELECT member.id, member.workspace_id, member.user_id, member.access_role,
            account.name AS member_name, account.email AS member_email,
            account.image AS member_image, member.created_at
     FROM workspace_members member
     JOIN user account ON account.id = member.user_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = member.workspace_id
     WHERE ownership.owner_type = 'organization'
       AND ownership.organization_id = ?
       AND member.access_role IN ('admin', 'editor', 'viewer')
     ORDER BY member.workspace_id, account.name COLLATE NOCASE, account.email COLLATE NOCASE`,
  ).all(organizationId) as Array<{
    id: string;
    workspace_id: string;
    user_id: string;
    access_role: "admin" | "editor" | "viewer";
    member_name: string;
    member_email: string;
    member_image: string | null;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    memberName: row.member_name,
    memberEmail: row.member_email,
    memberImage: row.member_image,
    role: row.access_role,
    createdAt: row.created_at,
  } satisfies OrganizationWorkspaceMemberGrant));
}

function requireOrganizationWorkspace(
  database: NyxDatabase,
  organizationId: string,
  workspaceId: string,
) {
  const row = database.prepare(
    `SELECT workspace.id, workspace.name
     FROM workspace_ownership ownership
     JOIN workspaces workspace ON workspace.id = ownership.workspace_id
     WHERE ownership.workspace_id = ?
       AND ownership.owner_type = 'organization'
       AND ownership.organization_id = ?`,
  ).get(workspaceId, organizationId) as { id: string; name: string } | undefined;
  if (!row) throw new OrganizationServiceError("NOT_FOUND", "조직 워크스페이스를 찾을 수 없습니다.");
  return row;
}

export function upsertOrganizationWorkspaceTeamGrant(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    workspaceId: string;
    teamId: string;
    role: "admin" | "editor" | "viewer";
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "workspaces.manage");
  requireOrganizationWorkspace(database, input.organizationId, input.workspaceId);
  requireTeam(database, input.organizationId, input.teamId);
  const current = database.prepare(
    `SELECT id, access_role FROM workspace_team_grants
     WHERE workspace_id = ? AND team_id = ?`,
  ).get(input.workspaceId, input.teamId) as { id: string; access_role: string } | undefined;
  const id = current?.id ?? randomUUID();
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `INSERT INTO workspace_team_grants
       (id, organization_id, workspace_id, team_id, access_role,
        granted_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, team_id) DO UPDATE SET
         access_role = excluded.access_role,
         granted_by_user_id = excluded.granted_by_user_id,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      input.organizationId,
      input.workspaceId,
      input.teamId,
      input.role,
      input.userId,
      now,
      now,
    );
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: current ? "organization.team_workspace_role_updated" : "organization.team_workspace_assigned",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "workspace",
      targetId: input.workspaceId,
      metadata: { teamId: input.teamId, before: current?.access_role ?? null, after: input.role },
      createdAt: now,
    });
  }).immediate();
  return listOrganizationWorkspaceGrants(database, input.organizationId, input.userId).find(
    (grant) => grant.workspaceId === input.workspaceId && grant.teamId === input.teamId,
  )!;
}

export function removeOrganizationWorkspaceTeamGrant(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    workspaceId: string;
    teamId: string;
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "workspaces.manage");
  requireOrganizationWorkspace(database, input.organizationId, input.workspaceId);
  const now = new Date().toISOString();
  database.transaction(() => {
    const result = database.prepare(
      `DELETE FROM workspace_team_grants
       WHERE organization_id = ? AND workspace_id = ? AND team_id = ?`,
    ).run(input.organizationId, input.workspaceId, input.teamId);
    if (result.changes !== 1) {
      throw new OrganizationServiceError("NOT_FOUND", "팀 워크스페이스 권한을 찾을 수 없습니다.");
    }
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.team_workspace_unassigned",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "workspace",
      targetId: input.workspaceId,
      metadata: { teamId: input.teamId },
      createdAt: now,
    });
  }).immediate();
}

export function upsertOrganizationWorkspaceMemberGrant(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    workspaceId: string;
    targetUserId: string;
    role: "admin" | "editor" | "viewer";
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "workspaces.manage");
  requireOrganizationWorkspace(database, input.organizationId, input.workspaceId);
  const member = database.prepare(
    "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?",
  ).get(input.organizationId, input.targetUserId);
  if (!member) throw new OrganizationServiceError("INVALID_INPUT", "조직 멤버만 워크스페이스에 배정할 수 있습니다.");
  const current = database.prepare(
    "SELECT id, access_role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
  ).get(input.workspaceId, input.targetUserId) as { id: string; access_role: string | null } | undefined;
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `INSERT INTO workspace_members
       (id, workspace_id, user_id, role, access_role, created_at)
       VALUES (?, ?, ?, 'member', ?, ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET
         role = 'member', access_role = excluded.access_role`,
    ).run(randomUUID(), input.workspaceId, input.targetUserId, input.role, now);
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: current ? "organization.member_workspace_role_updated" : "organization.member_workspace_assigned",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "workspace",
      targetId: input.workspaceId,
      metadata: { userId: input.targetUserId, before: current?.access_role ?? null, after: input.role },
      createdAt: now,
    });
  }).immediate();
}

export function removeOrganizationWorkspaceMemberGrant(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    workspaceId: string;
    targetUserId: string;
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "workspaces.manage");
  requireOrganizationWorkspace(database, input.organizationId, input.workspaceId);
  const now = new Date().toISOString();
  database.transaction(() => {
    const result = database.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role <> 'owner'",
    ).run(input.workspaceId, input.targetUserId);
    if (result.changes !== 1) {
      throw new OrganizationServiceError("NOT_FOUND", "직접 워크스페이스 권한을 찾을 수 없습니다.");
    }
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.member_workspace_unassigned",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "workspace",
      targetId: input.workspaceId,
      metadata: { userId: input.targetUserId },
      createdAt: now,
    });
  }).immediate();
}

export function listOrganizationAuditEvents(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
  limit = 100,
) {
  requireOrganizationPermission(database, organizationId, userId, "audit.read");
  const normalizedLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
  return (database.prepare(
    `SELECT cursor, id, action, outcome, actor_label, target_type,
            target_id, metadata_json, created_at
     FROM organization_audit_events
     WHERE organization_id = ?
     ORDER BY cursor DESC LIMIT ?`,
  ).all(organizationId, normalizedLimit) as Array<{
    cursor: number;
    id: string;
    action: string;
    outcome: "succeeded" | "denied" | "failed";
    actor_label: string;
    target_type: string;
    target_id: string | null;
    metadata_json: string;
    created_at: string;
  }>).map((row) => {
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed legacy metadata remains visible as an empty object.
    }
    return {
      cursor: Number(row.cursor),
      id: row.id,
      action: row.action,
      outcome: row.outcome,
      actorLabel: row.actor_label,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata,
      createdAt: row.created_at,
    } satisfies OrganizationAuditEvent;
  });
}

export function loadOrganizationView(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
): OrganizationView {
  const organization = listUserOrganizations(database, userId).find(
    (item) => item.id === organizationId,
  );
  if (!organization) throw new OrganizationServiceError("NOT_FOUND", "조직을 찾을 수 없습니다.");
  const permissions = {
    canUpdate: organizationRoleAllows(organization.role, "organization.update"),
    canTrash: organizationRoleAllows(organization.role, "organization.trash"),
    canManageMembers: organizationRoleAllows(organization.role, "members.manage"),
    canManageTeams: organizationRoleAllows(organization.role, "teams.manage"),
    canManageWorkspaces: organizationRoleAllows(organization.role, "workspaces.manage"),
    canManageAgents: organizationRoleAllows(organization.role, "agents.manage"),
    canReadAudit: organizationRoleAllows(organization.role, "audit.read"),
  };
  return {
    organization,
    members: listOrganizationMembers(database, organizationId, userId),
    invitations: permissions.canManageMembers
      ? listOrganizationInvitations(database, organizationId, userId)
      : [],
    teams: listOrganizationTeams(database, organizationId, userId),
    workspaces: listOrganizationWorkspaces(database, organizationId, userId),
    workspaceGrants: listOrganizationWorkspaceGrants(database, organizationId, userId),
    workspaceMemberGrants: listOrganizationWorkspaceMemberGrants(
      database,
      organizationId,
      userId,
    ),
    auditEvents: permissions.canReadAudit
      ? listOrganizationAuditEvents(database, organizationId, userId, 100)
      : [],
    permissions,
  };
}
