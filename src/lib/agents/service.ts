import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AGENT_NON_DELEGABLE_PERMISSIONS,
  WORKSPACE_PERMISSIONS,
  listAgentPrincipalPermissions,
  recordWorkspaceAuditEvent,
  requireHumanWorkspacePermission,
  type AgentWorkspaceRole,
  type WorkspacePermission,
} from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import {
  API_TOKEN_SCOPES,
  DEFAULT_API_TOKEN_SCOPES,
  type ApiTokenScope,
} from "@/lib/tokens/service";
import { IpAllowlistError, normalizeIpAllowlist } from "@/lib/security/ip-allowlist";
import {
  organizationRoleAllows,
  recordOrganizationAuditEvent,
  requireOrganizationPermission,
} from "@/lib/organizations/service";

export type AgentCredentialSummary = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  defaultWorkspaceId: string | null;
  workspaceAllowlist: string[];
  ipAllowlist: string[];
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type AgentWorkspaceMembershipSummary = {
  membershipId: string;
  agentId: string;
  workspaceId: string;
  workspaceName: string;
  role: AgentWorkspaceRole;
  status: "active" | "disabled";
  permissionAllow: WorkspacePermission[];
  permissionDeny: WorkspacePermission[];
  effectivePermissions: WorkspacePermission[];
  rootDocumentId: string | null;
  rootDocumentTitle: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccountAgentSummary = {
  id: string;
  displayName: string;
  avatarMediaId: string | null;
  status: "active" | "disabled";
  deletedAt: string | null;
  purgeAfter: string | null;
  purgedAt: string | null;
  createdAt: string;
  updatedAt: string;
  owner:
    | { type: "personal"; id: string; name: string }
    | { type: "organization"; id: string; name: string; icon: string | null };
  credentials: AgentCredentialSummary[];
  memberships: AgentWorkspaceMembershipSummary[];
};

export type ConnectAgentToWorkspaceInput = {
  userId: string;
  workspaceId: string;
  agent:
    | { mode: "existing"; agentId: string }
    | { mode: "new"; displayName: string };
  role: AgentWorkspaceRole;
  rootDocumentId: string | null;
  credential:
    | { mode: "existing"; credentialId: string }
    | { mode: "new"; name: string; restrictToWorkspace: boolean };
};

export type ConnectAgentToWorkspaceResult = {
  agent: AccountAgentSummary;
  membership: AgentWorkspaceMembershipSummary;
  credential: AgentCredentialSummary;
  token: string | null;
  expandedCredentialWorkspaceAllowlist: boolean;
};

export class AgentServiceError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "AgentServiceError";
  }
}

function parseJsonList<T extends string>(value: string, allowed?: readonly T[]) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter((item): item is T =>
      typeof item === "string" && (!allowed || allowed.includes(item as T)),
    )));
  } catch {
    return [];
  }
}

function normalizedName(value: string, label: string) {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) {
    throw new AgentServiceError("INVALID_INPUT", `${label}은 1자 이상 80자 이하여야 합니다.`);
  }
  return name;
}

function requireOwnedAgent(database: NyxDatabase, userId: string, agentId: string) {
  const row = database.prepare(
    `SELECT agent.id, agent.owner_user_id, agent.display_name, agent.avatar_media_id,
            agent.status, agent.deleted_at, agent.purge_after, agent.purged_at,
            agent.created_at, agent.updated_at, ownership.owner_type,
            ownership.organization_id
     FROM agents agent
     JOIN agent_ownership ownership ON ownership.agent_id = agent.id
     LEFT JOIN organization_members organization_member
       ON organization_member.organization_id = ownership.organization_id
      AND organization_member.user_id = ?
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     WHERE agent.id = ? AND (
       (ownership.owner_type = 'personal' AND ownership.owner_user_id = ?)
       OR
       (ownership.owner_type = 'organization'
        AND organization.lifecycle_state = 'active'
        AND organization_member.role IN ('owner', 'admin'))
     )`,
  ).get(userId, agentId, userId) as {
    id: string;
    owner_user_id: string;
    display_name: string;
    avatar_media_id: string | null;
    status: "active" | "disabled";
    deleted_at: string | null;
    purge_after: string | null;
    purged_at: string | null;
    created_at: string;
    updated_at: string;
    owner_type: "personal" | "organization";
    organization_id: string | null;
  } | undefined;
  if (!row) throw new AgentServiceError("NOT_FOUND", "에이전트를 찾을 수 없습니다.");
  return row;
}

function requireMutableAgent(
  agent: ReturnType<typeof requireOwnedAgent>,
  action = "수정",
) {
  if (agent.purged_at) {
    throw new AgentServiceError("CONFLICT", `영구 삭제된 에이전트는 ${action}할 수 없습니다.`);
  }
  if (agent.deleted_at) {
    throw new AgentServiceError("CONFLICT", `삭제된 에이전트는 복구한 뒤 ${action}해주세요.`);
  }
  return agent;
}

function recordGlobalAgentAudit(
  database: NyxDatabase,
  input: {
    agentId: string;
    userId?: string | null;
    actorType?: "human" | "system";
    actorLabel?: string;
    action: string;
    targetType: "agent" | "credential";
    targetId: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
  },
) {
  const organizationOwner = database.prepare(
    `SELECT organization_id
     FROM agent_ownership
     WHERE agent_id = ? AND owner_type = 'organization'`,
  ).get(input.agentId) as { organization_id: string } | undefined;
  if (organizationOwner) {
    recordOrganizationAuditEvent(database, {
      organizationId: organizationOwner.organization_id,
      action: input.action,
      actorType: input.actorType ?? "human",
      actorUserId: input.userId ?? null,
      actorLabel: input.actorLabel ?? "사용자",
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: { globalAgentId: input.agentId, ...input.metadata },
      createdAt: input.createdAt,
    });
  }
  const workspaces = database.prepare(
    "SELECT DISTINCT workspace_id FROM workspace_agents WHERE agent_identity_id = ?",
  ).all(input.agentId) as Array<{ workspace_id: string }>;
  for (const workspace of workspaces) {
    recordWorkspaceAuditEvent(database, {
      workspaceId: workspace.workspace_id,
      action: input.action,
      actorType: input.actorType ?? "human",
      actorUserId: input.userId ?? null,
      actorLabel: input.actorLabel ?? "사용자",
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: { globalAgentId: input.agentId, ...input.metadata },
      createdAt: input.createdAt,
    });
  }
}

function recordOrganizationWorkspaceAgentAudit(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    action: string;
    userId: string;
    agentId: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
  },
) {
  const ownership = database.prepare(
    `SELECT organization_id
     FROM workspace_ownership
     WHERE workspace_id = ? AND owner_type = 'organization'`,
  ).get(input.workspaceId) as { organization_id: string } | undefined;
  if (!ownership) return;
  const account = database.prepare("SELECT name FROM user WHERE id = ?")
    .get(input.userId) as { name: string } | undefined;
  recordOrganizationAuditEvent(database, {
    organizationId: ownership.organization_id,
    action: input.action,
    actorUserId: input.userId,
    actorLabel: account?.name ?? "사용자",
    targetType: "agent",
    targetId: input.agentId,
    metadata: { workspaceId: input.workspaceId, ...input.metadata },
    createdAt: input.createdAt,
  });
}

function membershipFromRow(row: {
  membership_id: string;
  agent_identity_id: string;
  workspace_id: string;
  workspace_name: string;
  role: AgentWorkspaceRole;
  status: "active" | "disabled";
  permission_allow_json: string;
  permission_deny_json: string;
  root_document_id: string | null;
  root_document_title: string | null;
  created_at: string;
  updated_at: string;
}): AgentWorkspaceMembershipSummary {
  const permissionAllow = parseJsonList(row.permission_allow_json, WORKSPACE_PERMISSIONS);
  const permissionDeny = parseJsonList(row.permission_deny_json, WORKSPACE_PERMISSIONS);
  return {
    membershipId: row.membership_id,
    agentId: row.agent_identity_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    role: row.role,
    status: row.status,
    permissionAllow,
    permissionDeny,
    effectivePermissions: listAgentPrincipalPermissions({ role: row.role, permissionAllow, permissionDeny }),
    rootDocumentId: row.root_document_id,
    rootDocumentTitle: row.root_document_title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function credentialFromRow(row: {
  id: string;
  name: string;
  token_prefix: string;
  scopes_json: string;
  default_workspace_id: string | null;
  workspace_allowlist_json: string;
  ip_allowlist_json: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}): AgentCredentialSummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    scopes: parseJsonList(row.scopes_json, API_TOKEN_SCOPES),
    defaultWorkspaceId: row.default_workspace_id,
    workspaceAllowlist: parseJsonList<string>(row.workspace_allowlist_json),
    ipAllowlist: parseJsonList<string>(row.ip_allowlist_json),
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function listMemberships(database: NyxDatabase, agentId: string) {
  return (database.prepare(
    `SELECT membership.id AS membership_id, membership.agent_identity_id,
            membership.workspace_id, workspace.name AS workspace_name,
            membership.role, membership.status, membership.permission_allow_json,
            membership.permission_deny_json, membership.root_document_id,
            document.title AS root_document_title,
            membership.created_at, membership.updated_at
     FROM workspace_agents membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN documents document ON document.id = membership.root_document_id
     WHERE membership.agent_identity_id = ? AND workspace.lifecycle_state = 'active'
       AND (ownership.owner_type = 'personal' OR organization.lifecycle_state = 'active')
     ORDER BY workspace.name, membership.created_at`,
  ).all(agentId) as Parameters<typeof membershipFromRow>[0][]).map(membershipFromRow);
}

function requireAgentWorkspaceAccess(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
  mode: "read" | "manage",
) {
  const ownership = database.prepare(
    `SELECT owner_type, organization_id
     FROM workspace_ownership WHERE workspace_id = ?`,
  ).get(workspaceId) as {
    owner_type: "personal" | "organization";
    organization_id: string | null;
  } | undefined;
  if (!ownership) throw new AgentServiceError("NOT_FOUND", "워크스페이스를 찾을 수 없습니다.");
  if (ownership.owner_type === "organization") {
    if (!ownership.organization_id) {
      throw new AgentServiceError("CONFLICT", "워크스페이스 조직 소유권이 올바르지 않습니다.");
    }
    requireOrganizationPermission(
      database,
      ownership.organization_id,
      userId,
      mode === "manage" ? "agents.manage" : "agents.read",
    );
    return;
  }
  requireHumanWorkspacePermission(
    database,
    workspaceId,
    userId,
    mode === "manage" ? "agents.manage" : "agents.read",
  );
}

function listCredentials(database: NyxDatabase, agentId: string, includeRevoked = true) {
  const where = includeRevoked ? "" : "AND revoked_at IS NULL";
  return (database.prepare(
    `SELECT id, name, token_prefix, scopes_json, default_workspace_id,
            workspace_allowlist_json, ip_allowlist_json, last_used_at,
            last_used_ip, expires_at, revoked_at, created_at
     FROM agent_credentials
     WHERE agent_id = ? ${where}
     ORDER BY created_at DESC`,
  ).all(agentId) as Parameters<typeof credentialFromRow>[0][]).map(credentialFromRow);
}

export function listAccountAgents(database: NyxDatabase, userId: string): AccountAgentSummary[] {
  const rows = database.prepare(
    `SELECT agent.id, agent.display_name, agent.avatar_media_id, agent.status,
            agent.deleted_at, agent.purge_after, agent.purged_at,
            agent.created_at, agent.updated_at,
            ownership.owner_type, ownership.owner_user_id,
            personal_owner.name AS personal_owner_name,
            ownership.organization_id, organization.name AS organization_name,
            organization.icon AS organization_icon
     FROM agents agent
     JOIN agent_ownership ownership ON ownership.agent_id = agent.id
     LEFT JOIN user personal_owner ON personal_owner.id = ownership.owner_user_id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN organization_members organization_member
       ON organization_member.organization_id = ownership.organization_id
      AND organization_member.user_id = ?
     WHERE (ownership.owner_type = 'personal' AND ownership.owner_user_id = ?)
        OR (ownership.owner_type = 'organization'
            AND organization.lifecycle_state = 'active'
            AND organization_member.role IN ('owner', 'admin'))
     ORDER BY
       CASE
         WHEN agent.purged_at IS NOT NULL THEN 3
         WHEN agent.deleted_at IS NOT NULL THEN 2
         WHEN agent.status = 'disabled' THEN 1
         ELSE 0
       END,
       agent.display_name,
       agent.created_at`,
  ).all(userId, userId) as Array<{
    id: string;
    display_name: string;
    avatar_media_id: string | null;
    status: "active" | "disabled";
    deleted_at: string | null;
    purge_after: string | null;
    purged_at: string | null;
    created_at: string;
    updated_at: string;
    owner_type: "personal" | "organization";
    owner_user_id: string | null;
    personal_owner_name: string | null;
    organization_id: string | null;
    organization_name: string | null;
    organization_icon: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    avatarMediaId: row.avatar_media_id,
    status: row.status,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
    purgedAt: row.purged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: row.owner_type === "organization"
      ? {
          type: "organization" as const,
          id: row.organization_id!,
          name: row.organization_name!,
          icon: row.organization_icon,
        }
      : {
          type: "personal" as const,
          id: row.owner_user_id!,
          name: row.personal_owner_name ?? "Personal",
        },
    credentials: listCredentials(database, row.id),
    memberships: listMemberships(database, row.id),
  }));
}

export function listPersonalAgents(database: NyxDatabase, userId: string) {
  return listAccountAgents(database, userId).filter((agent) => agent.owner.type === "personal");
}

export function listOrganizationAgents(
  database: NyxDatabase,
  organizationId: string,
  userId: string,
) {
  const organizationRole = requireOrganizationPermission(
    database,
    organizationId,
    userId,
    "agents.read",
  );
  const canManage = organizationRoleAllows(organizationRole, "agents.manage");
  const organization = database.prepare(
    "SELECT name, icon FROM organizations WHERE id = ? AND lifecycle_state = 'active'",
  ).get(organizationId) as { name: string; icon: string | null } | undefined;
  if (!organization) throw new AgentServiceError("NOT_FOUND", "조직을 찾을 수 없습니다.");
  const rows = database.prepare(
    `SELECT agent.id, agent.display_name, agent.avatar_media_id, agent.status,
            agent.deleted_at, agent.purge_after, agent.purged_at,
            agent.created_at, agent.updated_at
     FROM agents agent
     JOIN agent_ownership ownership ON ownership.agent_id = agent.id
     WHERE ownership.owner_type = 'organization' AND ownership.organization_id = ?
     ORDER BY
       CASE
         WHEN agent.purged_at IS NOT NULL THEN 3
         WHEN agent.deleted_at IS NOT NULL THEN 2
         WHEN agent.status = 'disabled' THEN 1
         ELSE 0
       END,
       agent.display_name COLLATE NOCASE, agent.created_at`,
  ).all(organizationId) as Array<{
    id: string;
    display_name: string;
    avatar_media_id: string | null;
    status: "active" | "disabled";
    deleted_at: string | null;
    purge_after: string | null;
    purged_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    avatarMediaId: row.avatar_media_id,
    status: row.status,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
    purgedAt: row.purged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: {
      type: "organization" as const,
      id: organizationId,
      name: organization.name,
      icon: organization.icon,
    },
    credentials: canManage ? listCredentials(database, row.id) : [],
    memberships: canManage ? listMemberships(database, row.id) : [],
  }));
}

export function listWorkspaceAgentMemberships(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
) {
  requireAgentWorkspaceAccess(database, workspaceId, userId, "read");
  return (database.prepare(
    `SELECT membership.id AS membership_id, membership.agent_identity_id,
            membership.workspace_id, workspace.name AS workspace_name,
            membership.role, membership.status, membership.permission_allow_json,
            membership.permission_deny_json, membership.root_document_id,
            document.title AS root_document_title,
            membership.created_at, membership.updated_at
     FROM workspace_agents membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     LEFT JOIN documents document ON document.id = membership.root_document_id
     WHERE membership.workspace_id = ?
     ORDER BY membership.status, membership.display_name`,
  ).all(workspaceId) as Parameters<typeof membershipFromRow>[0][]).map(membershipFromRow);
}

export function createAccountAgent(
  database: NyxDatabase,
  input: { userId: string; displayName: string },
) {
  const displayName = normalizedName(input.displayName, "에이전트 이름");
  const count = database.prepare(
    `SELECT COUNT(*) AS count
     FROM agents agent
     JOIN agent_ownership ownership ON ownership.agent_id = agent.id
     WHERE ownership.owner_type = 'personal' AND ownership.owner_user_id = ?
       AND agent.status = 'active' AND agent.deleted_at IS NULL`,
  ).get(input.userId) as { count: number };
  if (count.count >= 100) throw new AgentServiceError("INVALID_INPUT", "활성 에이전트는 계정당 최대 100개입니다.");
  const id = randomUUID();
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `INSERT INTO agents
       (id, owner_user_id, display_name, avatar_media_id, status,
        created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`,
    ).run(id, input.userId, displayName, input.userId, now, now);
    database.prepare(
      `INSERT INTO agent_ownership
       (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
       VALUES (?, 'personal', ?, NULL, ?, ?)`,
    ).run(id, input.userId, now, now);
  })();
  return listAccountAgents(database, input.userId).find((agent) => agent.id === id)!;
}

export function createOrganizationAgent(
  database: NyxDatabase,
  input: {
    organizationId: string;
    userId: string;
    actorLabel: string;
    displayName: string;
  },
) {
  requireOrganizationPermission(database, input.organizationId, input.userId, "agents.manage");
  const displayName = normalizedName(input.displayName, "에이전트 이름");
  const count = database.prepare(
    `SELECT COUNT(*) AS count
     FROM agents agent
     JOIN agent_ownership ownership ON ownership.agent_id = agent.id
     WHERE ownership.owner_type = 'organization' AND ownership.organization_id = ?
       AND agent.status = 'active' AND agent.deleted_at IS NULL`,
  ).get(input.organizationId) as { count: number };
  if (Number(count.count) >= 250) {
    throw new AgentServiceError("INVALID_INPUT", "활성 에이전트는 조직당 최대 250개입니다.");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `INSERT INTO agents
       (id, owner_user_id, display_name, avatar_media_id, status,
        created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`,
    ).run(id, input.userId, displayName, input.userId, now, now);
    database.prepare(
      `INSERT INTO agent_ownership
       (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
       VALUES (?, 'organization', NULL, ?, ?, ?)`,
    ).run(id, input.organizationId, now, now);
    recordOrganizationAuditEvent(database, {
      organizationId: input.organizationId,
      action: "organization.agent_created",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "agent",
      targetId: id,
      metadata: { displayName },
      createdAt: now,
    });
  })();
  return listOrganizationAgents(database, input.organizationId, input.userId).find(
    (agent) => agent.id === id,
  )!;
}

export function updateAccountAgent(
  database: NyxDatabase,
  input: {
    userId: string;
    agentId: string;
    displayName?: string;
    avatarMediaId?: string | null;
    status?: "active" | "disabled";
  },
) {
  const current = requireMutableAgent(
    requireOwnedAgent(database, input.userId, input.agentId),
  );
  const displayName = input.displayName === undefined
    ? current.display_name
    : normalizedName(input.displayName, "에이전트 이름");
  if (input.avatarMediaId) {
    const media = database.prepare(
      `SELECT 1 FROM media_assets media
       JOIN workspace_members member ON member.workspace_id = media.workspace_id
       WHERE media.id = ? AND member.user_id = ?`,
    ).get(input.avatarMediaId, input.userId);
    if (!media) throw new AgentServiceError("INVALID_INPUT", "접근 가능한 워크스페이스의 이미지를 선택해주세요.");
  }
  const avatarMediaId = input.avatarMediaId === undefined ? current.avatar_media_id : input.avatarMediaId;
  const status = input.status ?? current.status;
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE agents SET display_name = ?, avatar_media_id = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(displayName, avatarMediaId, status, now, input.agentId);
    database.prepare(
      `UPDATE workspace_agents
       SET display_name = ?, avatar_media_id = ?,
           status = CASE WHEN ? = 'disabled' THEN 'disabled' ELSE status END,
           updated_at = ?
       WHERE agent_identity_id = ?`,
    ).run(displayName, avatarMediaId, status, now, input.agentId);
    recordGlobalAgentAudit(database, {
      agentId: input.agentId,
      userId: input.userId,
      action: "agent.global_updated",
      targetType: "agent",
      targetId: input.agentId,
      metadata: {
        before: { displayName: current.display_name, avatarMediaId: current.avatar_media_id, status: current.status },
        after: { displayName, avatarMediaId, status },
      },
      createdAt: now,
    });
  })();
  return listAccountAgents(database, input.userId).find((agent) => agent.id === input.agentId)!;
}

const AGENT_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

function cancelActiveAgentAssignments(
  database: NyxDatabase,
  agentId: string,
  now: string,
) {
  return database.prepare(
    `UPDATE agent_document_assignments
     SET status = 'cancelled', updated_at = ?
     WHERE status = 'active'
       AND agent_id IN (
         SELECT id FROM workspace_agents WHERE agent_identity_id = ?
       )`,
  ).run(now, agentId);
}

export function deleteAccountAgent(
  database: NyxDatabase,
  input: { userId: string; agentId: string; now?: string },
) {
  const current = requireOwnedAgent(database, input.userId, input.agentId);
  if (current.purged_at) {
    throw new AgentServiceError("CONFLICT", "이미 영구 삭제된 에이전트입니다.");
  }
  if (current.deleted_at) {
    throw new AgentServiceError("CONFLICT", "이미 삭제된 에이전트입니다.");
  }
  const now = input.now ?? new Date().toISOString();
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new AgentServiceError("INVALID_INPUT", "삭제 시각을 확인해주세요.");
  }
  const purgeAfter = new Date(timestamp + AGENT_RECOVERY_WINDOW_MS).toISOString();
  database.transaction(() => {
    const disabledMemberships = database.prepare(
      `UPDATE workspace_agents
       SET status = 'disabled', updated_at = ?
       WHERE agent_identity_id = ? AND status = 'active'`,
    ).run(now, input.agentId);
    const revokedCredentials = database.prepare(
      `UPDATE agent_credentials
       SET revoked_at = ?, updated_at = ?
       WHERE agent_id = ? AND revoked_at IS NULL`,
    ).run(now, now, input.agentId);
    database.prepare(
      `UPDATE workspace_api_tokens
       SET revoked_at = ?
       WHERE id IN (
         SELECT id FROM agent_credentials WHERE agent_id = ?
       ) AND revoked_at IS NULL`,
    ).run(now, input.agentId);
    const cancelledAssignments = cancelActiveAgentAssignments(database, input.agentId, now);
    database.prepare(
      `UPDATE agents
       SET status = 'disabled', deleted_at = ?, purge_after = ?,
           purged_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, purgeAfter, now, input.agentId);
    recordGlobalAgentAudit(database, {
      agentId: input.agentId,
      userId: input.userId,
      action: "agent.global_deleted",
      targetType: "agent",
      targetId: input.agentId,
      metadata: {
        purgeAfter,
        disabledMembershipCount: disabledMemberships.changes,
        revokedCredentialCount: revokedCredentials.changes,
        cancelledAssignmentCount: cancelledAssignments.changes,
      },
      createdAt: now,
    });
  })();
  return listAccountAgents(database, input.userId).find((agent) => agent.id === input.agentId)!;
}

export function restoreAccountAgent(
  database: NyxDatabase,
  input: { userId: string; agentId: string; now?: string },
) {
  const current = requireOwnedAgent(database, input.userId, input.agentId);
  if (current.purged_at) {
    throw new AgentServiceError("CONFLICT", "복구 기간이 지나 영구 삭제된 에이전트입니다.");
  }
  if (!current.deleted_at || !current.purge_after) {
    throw new AgentServiceError("CONFLICT", "삭제된 에이전트가 아닙니다.");
  }
  const now = input.now ?? new Date().toISOString();
  if (Date.parse(now) >= Date.parse(current.purge_after)) {
    throw new AgentServiceError("CONFLICT", "30일 복구 기간이 지났습니다.");
  }
  database.transaction(() => {
    database.prepare(
      `UPDATE agents
       SET status = 'active', deleted_at = NULL, purge_after = NULL,
           purged_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, input.agentId);
    recordGlobalAgentAudit(database, {
      agentId: input.agentId,
      userId: input.userId,
      action: "agent.global_restored",
      targetType: "agent",
      targetId: input.agentId,
      metadata: {
        credentialsRemainRevoked: true,
        membershipsRemainDisabled: true,
      },
      createdAt: now,
    });
  })();
  return listAccountAgents(database, input.userId).find((agent) => agent.id === input.agentId)!;
}

export function validateAccountAgentPurge(
  database: NyxDatabase,
  input: { userId: string; agentId: string; confirmationName: string },
) {
  const current = requireOwnedAgent(database, input.userId, input.agentId);
  if (current.purged_at) {
    throw new AgentServiceError("CONFLICT", "이미 영구 삭제된 에이전트입니다.");
  }
  if (!current.deleted_at) {
    throw new AgentServiceError("CONFLICT", "먼저 에이전트를 삭제해주세요.");
  }
  const confirmationName = input.confirmationName.trim();
  if (!confirmationName || confirmationName.length > 80 || confirmationName !== current.display_name) {
    throw new AgentServiceError("INVALID_INPUT", "에이전트 이름이 일치하지 않습니다.");
  }
  return {
    id: current.id,
    displayName: current.display_name,
    deletedAt: current.deleted_at,
    purgeAfter: current.purge_after,
  };
}

function purgeAccountAgentData(
  database: NyxDatabase,
  input: {
    agentId: string;
    now: string;
    actorType: "human" | "system";
    actorUserId?: string | null;
    actorLabel: string;
    purgeMode: "manual" | "retention";
    backupGenerationId?: string | null;
  },
) {
  const marked = database.prepare(
    `UPDATE agents
     SET status = 'disabled', purge_after = NULL, purged_at = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL`,
  ).run(input.now, input.now, input.agentId);
  if (marked.changes !== 1) {
    throw new AgentServiceError("CONFLICT", "에이전트의 삭제 상태가 변경되었습니다. 화면을 새로고침해주세요.");
  }
  const cancelledAssignments = cancelActiveAgentAssignments(database, input.agentId, input.now);
  const legacyCredentials = database.prepare(
    `DELETE FROM workspace_api_tokens
     WHERE id IN (
       SELECT id FROM agent_credentials WHERE agent_id = ?
     )`,
  ).run(input.agentId);
  const credentials = database.prepare(
    "DELETE FROM agent_credentials WHERE agent_id = ?",
  ).run(input.agentId);
  recordGlobalAgentAudit(database, {
    agentId: input.agentId,
    userId: input.actorUserId,
    actorType: input.actorType,
    actorLabel: input.actorLabel,
    action: "agent.global_purged",
    targetType: "agent",
    targetId: input.agentId,
    metadata: {
      purgeMode: input.purgeMode,
      backupGenerationId: input.backupGenerationId ?? null,
      deletedCredentialCount: credentials.changes,
      deletedLegacyCredentialCount: legacyCredentials.changes,
      cancelledAssignmentCount: cancelledAssignments.changes,
      retainedTombstone: true,
      historicalAttributionRetained: true,
    },
    createdAt: input.now,
  });
}

export function purgeAccountAgent(
  database: NyxDatabase,
  input: {
    userId: string;
    agentId: string;
    confirmationName: string;
    backupGenerationId: string;
    actorLabel?: string;
    now?: string;
  },
) {
  validateAccountAgentPurge(database, input);
  if (!input.backupGenerationId.trim()) {
    throw new AgentServiceError("INVALID_INPUT", "검증된 삭제 직전 백업이 필요합니다.");
  }
  const now = input.now ?? new Date().toISOString();
  database.transaction(() => purgeAccountAgentData(database, {
    agentId: input.agentId,
    now,
    actorType: "human",
    actorUserId: input.userId,
    actorLabel: input.actorLabel?.trim() || "사용자",
    purgeMode: "manual",
    backupGenerationId: input.backupGenerationId,
  })).immediate();
  return listAccountAgents(database, input.userId).find((agent) => agent.id === input.agentId)!;
}

export function purgeExpiredAccountAgents(
  database: NyxDatabase,
  input: { now?: string; backupGenerationId?: string | null } = {},
) {
  const now = input.now ?? new Date().toISOString();
  const due = database.prepare(
    `SELECT id
     FROM agents
     WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after <= ?
     ORDER BY purge_after, id`,
  ).all(now) as Array<{ id: string }>;
  const purgedIds: string[] = [];
  database.transaction(() => {
    for (const agent of due) {
      purgeAccountAgentData(database, {
        agentId: agent.id,
        now,
        actorType: "system",
        actorLabel: "Nyxdoc 보존 정책",
        purgeMode: "retention",
        backupGenerationId: input.backupGenerationId,
      });
      purgedIds.push(agent.id);
    }
  })();
  return purgedIds;
}

function validatePermissionOverrides(allow: readonly WorkspacePermission[], deny: readonly WorkspacePermission[]) {
  const permissionAllow = Array.from(new Set(allow));
  const permissionDeny = Array.from(new Set(deny));
  if ([...permissionAllow, ...permissionDeny].some((permission) => !WORKSPACE_PERMISSIONS.includes(permission))) {
    throw new AgentServiceError("INVALID_INPUT", "알 수 없는 에이전트 권한이 포함되어 있습니다.");
  }
  const nonDelegable = permissionAllow.find((permission) => AGENT_NON_DELEGABLE_PERMISSIONS.has(permission));
  if (nonDelegable) {
    throw new AgentServiceError("INVALID_INPUT", `${nonDelegable} 권한은 사람의 승인 경계를 넘어 직접 위임할 수 없습니다.`);
  }
  return {
    permissionAllow,
    permissionDeny: permissionDeny.filter((permission) => !permissionAllow.includes(permission)),
  };
}

function validateMembershipRoot(database: NyxDatabase, workspaceId: string, rootDocumentId: string | null) {
  if (!rootDocumentId) return null;
  const document = database.prepare(
    `SELECT id FROM documents
     WHERE id = ? AND workspace_id = ? AND lifecycle_state = 'active'`,
  ).get(rootDocumentId, workspaceId);
  if (!document) throw new AgentServiceError("INVALID_INPUT", "이 워크스페이스의 활성 문서를 선택해주세요.");
  return rootDocumentId;
}

function agentWorkspaceOwnershipCompatibility(
  database: NyxDatabase,
  input: { userId: string; workspaceId: string; agentId: string },
) {
  const row = database.prepare(
    `SELECT agent_owner.owner_type AS agent_owner_type,
            agent_owner.owner_user_id AS agent_owner_user_id,
            agent_owner.organization_id AS agent_organization_id,
            workspace_owner.owner_type AS workspace_owner_type,
            workspace_owner.owner_user_id AS workspace_owner_user_id,
            workspace_owner.organization_id AS workspace_organization_id
     FROM agent_ownership agent_owner
     JOIN workspace_ownership workspace_owner ON workspace_owner.workspace_id = ?
     WHERE agent_owner.agent_id = ?`,
  ).get(input.workspaceId, input.agentId) as {
    agent_owner_type: "personal" | "organization";
    agent_owner_user_id: string | null;
    agent_organization_id: string | null;
    workspace_owner_type: "personal" | "organization";
    workspace_owner_user_id: string | null;
    workspace_organization_id: string | null;
  } | undefined;
  if (!row) throw new AgentServiceError("NOT_FOUND", "에이전트나 워크스페이스 소유권을 찾을 수 없습니다.");
  if (row.workspace_owner_type === "personal") {
    if (
      row.agent_owner_type !== "personal"
      || row.agent_owner_user_id !== row.workspace_owner_user_id
      || row.agent_owner_user_id !== input.userId
    ) {
      throw new AgentServiceError(
        "FORBIDDEN",
        "개인 워크스페이스에는 그 사용자가 소유한 개인 에이전트만 할당할 수 있습니다.",
      );
    }
    return { organizationId: null, personalAgentApproval: false };
  }
  const organizationId = row.workspace_organization_id;
  if (!organizationId) {
    throw new AgentServiceError("CONFLICT", "워크스페이스 조직 소유권이 올바르지 않습니다.");
  }
  requireOrganizationPermission(database, organizationId, input.userId, "agents.manage");
  if (row.agent_owner_type === "organization") {
    if (row.agent_organization_id !== organizationId) {
      throw new AgentServiceError("FORBIDDEN", "다른 조직이 소유한 에이전트는 할당할 수 없습니다.");
    }
    return { organizationId, personalAgentApproval: false };
  }
  if (row.agent_owner_user_id !== input.userId) {
    throw new AgentServiceError(
      "FORBIDDEN",
      "개인 에이전트 반입은 에이전트 소유자와 조직 관리자가 같은 요청에서 승인해야 합니다.",
    );
  }
  return { organizationId, personalAgentApproval: true };
}

export function assignAgentToWorkspace(
  database: NyxDatabase,
  input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    role?: AgentWorkspaceRole;
    rootDocumentId?: string | null;
    permissionAllow?: WorkspacePermission[];
    permissionDeny?: WorkspacePermission[];
  },
) {
  requireAgentWorkspaceAccess(database, input.workspaceId, input.userId, "manage");
  const agent = requireMutableAgent(
    requireOwnedAgent(database, input.userId, input.agentId),
    "할당",
  );
  const ownership = agentWorkspaceOwnershipCompatibility(database, input);
  if (agent.status !== "active") throw new AgentServiceError("INVALID_INPUT", "비활성 에이전트는 할당할 수 없습니다.");
  const existing = database.prepare(
    "SELECT id, status FROM workspace_agents WHERE workspace_id = ? AND agent_identity_id = ?",
  ).get(input.workspaceId, input.agentId) as { id: string; status: string } | undefined;
  if (existing?.status === "active") throw new AgentServiceError("CONFLICT", "이미 이 워크스페이스에 할당된 에이전트입니다.");
  const role = input.role ?? "viewer";
  const rootDocumentId = validateMembershipRoot(database, input.workspaceId, input.rootDocumentId ?? null);
  const overrides = validatePermissionOverrides(input.permissionAllow ?? [], input.permissionDeny ?? []);
  const membershipId = existing?.id ?? randomUUID();
  const now = new Date().toISOString();
  database.transaction(() => {
    if (ownership.organizationId && ownership.personalAgentApproval) {
      database.prepare(
        `INSERT INTO organization_agent_approvals
         (id, organization_id, agent_id, approved_by_user_id, approved_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(organization_id, agent_id) DO UPDATE SET
           approved_by_user_id = excluded.approved_by_user_id,
           approved_at = excluded.approved_at,
           revoked_at = NULL`,
      ).run(
        randomUUID(),
        ownership.organizationId,
        input.agentId,
        input.userId,
        now,
      );
      recordOrganizationAuditEvent(database, {
        organizationId: ownership.organizationId,
        action: "organization.personal_agent_approved",
        actorUserId: input.userId,
        actorLabel: "사용자",
        targetType: "agent",
        targetId: input.agentId,
        metadata: { workspaceId: input.workspaceId },
        createdAt: now,
      });
    }
    if (existing) {
      database.prepare(
        `UPDATE workspace_agents
         SET role = ?, status = 'active', permission_allow_json = ?, permission_deny_json = ?,
             root_document_id = ?, display_name = ?, updated_at = ?
         WHERE id = ?`,
      ).run(role, JSON.stringify(overrides.permissionAllow), JSON.stringify(overrides.permissionDeny), rootDocumentId, agent.display_name, now, membershipId);
    } else {
      database.prepare(
        `INSERT INTO workspace_agents
         (id, workspace_id, display_name, avatar_media_id, role, status,
          created_by_user_id, created_at, updated_at, agent_identity_id,
          permission_allow_json, permission_deny_json, root_document_id)
         VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        membershipId,
        input.workspaceId,
        agent.display_name,
        role,
        input.userId,
        now,
        now,
        input.agentId,
        JSON.stringify(overrides.permissionAllow),
        JSON.stringify(overrides.permissionDeny),
        rootDocumentId,
      );
    }
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: existing ? "agent.membership_reactivated" : "agent.assigned",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: "사용자",
      targetType: "agent",
      targetId: input.agentId,
      metadata: { membershipId, role, rootDocumentId, ...overrides },
      createdAt: now,
    });
    recordOrganizationWorkspaceAgentAudit(database, {
      workspaceId: input.workspaceId,
      action: existing
        ? "organization.agent_workspace_reactivated"
        : "organization.agent_workspace_assigned",
      userId: input.userId,
      agentId: input.agentId,
      metadata: { membershipId, role, rootDocumentId, ...overrides },
      createdAt: now,
    });
  })();
  return listWorkspaceAgentMemberships(database, input.workspaceId, input.userId)
    .find((membership) => membership.membershipId === membershipId)!;
}

export function updateAgentWorkspaceMembership(
  database: NyxDatabase,
  input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    role: AgentWorkspaceRole;
    rootDocumentId: string | null;
    permissionAllow: WorkspacePermission[];
    permissionDeny: WorkspacePermission[];
    status?: "active" | "disabled";
  },
) {
  requireAgentWorkspaceAccess(database, input.workspaceId, input.userId, "manage");
  requireMutableAgent(
    requireOwnedAgent(database, input.userId, input.agentId),
    "권한을 변경",
  );
  const current = database.prepare(
    `SELECT id, role, status, root_document_id, permission_allow_json, permission_deny_json
     FROM workspace_agents WHERE workspace_id = ? AND agent_identity_id = ?`,
  ).get(input.workspaceId, input.agentId) as {
    id: string;
    role: AgentWorkspaceRole;
    status: "active" | "disabled";
    root_document_id: string | null;
    permission_allow_json: string;
    permission_deny_json: string;
  } | undefined;
  if (!current) throw new AgentServiceError("NOT_FOUND", "워크스페이스 에이전트 할당을 찾을 수 없습니다.");
  const rootDocumentId = validateMembershipRoot(database, input.workspaceId, input.rootDocumentId);
  const overrides = validatePermissionOverrides(input.permissionAllow, input.permissionDeny);
  const status = input.status ?? current.status;
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE workspace_agents
       SET role = ?, status = ?, root_document_id = ?, permission_allow_json = ?,
           permission_deny_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.role, status, rootDocumentId, JSON.stringify(overrides.permissionAllow), JSON.stringify(overrides.permissionDeny), now, current.id);
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: status === "disabled" ? "agent.unassigned" : "agent.permissions_updated",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: "사용자",
      targetType: "agent",
      targetId: input.agentId,
      metadata: {
        membershipId: current.id,
        before: {
          role: current.role,
          status: current.status,
          rootDocumentId: current.root_document_id,
          permissionAllow: parseJsonList(current.permission_allow_json, WORKSPACE_PERMISSIONS),
          permissionDeny: parseJsonList(current.permission_deny_json, WORKSPACE_PERMISSIONS),
        },
        after: { role: input.role, status, rootDocumentId, ...overrides },
      },
      createdAt: now,
    });
    recordOrganizationWorkspaceAgentAudit(database, {
      workspaceId: input.workspaceId,
      action: status === "disabled"
        ? "organization.agent_workspace_unassigned"
        : "organization.agent_workspace_permissions_updated",
      userId: input.userId,
      agentId: input.agentId,
      metadata: {
        membershipId: current.id,
        before: {
          role: current.role,
          status: current.status,
          rootDocumentId: current.root_document_id,
          permissionAllow: parseJsonList(current.permission_allow_json, WORKSPACE_PERMISSIONS),
          permissionDeny: parseJsonList(current.permission_deny_json, WORKSPACE_PERMISSIONS),
        },
        after: { role: input.role, status, rootDocumentId, ...overrides },
      },
      createdAt: now,
    });
  })();
  return listWorkspaceAgentMemberships(database, input.workspaceId, input.userId)
    .find((membership) => membership.membershipId === current.id)!;
}

function normalizeScopes(scopes: readonly ApiTokenScope[]) {
  const result = Array.from(new Set(scopes));
  if (!result.length || result.some((scope) => !API_TOKEN_SCOPES.includes(scope))) {
    throw new AgentServiceError("INVALID_INPUT", "유효한 연결 키 권한을 하나 이상 선택해주세요.");
  }
  if (result.includes("documents:write") && !result.includes("documents:read")) {
    throw new AgentServiceError("INVALID_INPUT", "문서 쓰기에는 읽기 권한이 필요합니다.");
  }
  if (result.includes("documents:commit") && !result.includes("documents:write")) {
    throw new AgentServiceError("INVALID_INPUT", "정본 저장에는 문서 쓰기 권한이 필요합니다.");
  }
  if (result.includes("revisions:restore") && !result.includes("documents:commit")) {
    throw new AgentServiceError("INVALID_INPUT", "리비전 복원에는 정본 저장 권한이 필요합니다.");
  }
  return result;
}

function validateCredentialWorkspaces(
  database: NyxDatabase,
  agentId: string,
  defaultWorkspaceId: string | null,
  workspaceAllowlist: readonly string[],
) {
  const memberships = new Set((database.prepare(
    "SELECT workspace_id FROM workspace_agents WHERE agent_identity_id = ? AND status = 'active'",
  ).all(agentId) as Array<{ workspace_id: string }>).map((row) => row.workspace_id));
  const allowlist = Array.from(new Set(workspaceAllowlist));
  if (allowlist.some((workspaceId) => !memberships.has(workspaceId))) {
    throw new AgentServiceError("INVALID_INPUT", "에이전트가 할당되지 않은 워크스페이스가 키 제한에 포함되어 있습니다.");
  }
  if (defaultWorkspaceId && !memberships.has(defaultWorkspaceId)) {
    throw new AgentServiceError("INVALID_INPUT", "기본 워크스페이스에 먼저 에이전트를 할당해주세요.");
  }
  if (defaultWorkspaceId && allowlist.length && !allowlist.includes(defaultWorkspaceId)) {
    throw new AgentServiceError("INVALID_INPUT", "기본 워크스페이스는 키의 허용 범위에도 포함되어야 합니다.");
  }
  return { defaultWorkspaceId, workspaceAllowlist: allowlist };
}

function normalizeExpiry(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new AgentServiceError("INVALID_INPUT", "연결 키 만료일은 현재보다 뒤여야 합니다.");
  }
  return new Date(timestamp).toISOString();
}

export function createAgentCredential(
  database: NyxDatabase,
  input: {
    userId: string;
    agentId: string;
    name: string;
    scopes?: ApiTokenScope[];
    defaultWorkspaceId?: string | null;
    workspaceAllowlist?: string[];
    ipAllowlist?: string[];
    expiresAt?: string | null;
  },
) {
  const agent = requireMutableAgent(
    requireOwnedAgent(database, input.userId, input.agentId),
    "연결 키를 생성",
  );
  if (agent.status !== "active") {
    throw new AgentServiceError("INVALID_INPUT", "비활성 에이전트에는 새 연결 키를 만들 수 없습니다.");
  }
  const activeCount = database.prepare(
    "SELECT COUNT(*) AS count FROM agent_credentials WHERE agent_id = ? AND revoked_at IS NULL",
  ).get(input.agentId) as { count: number };
  if (activeCount.count >= 20) throw new AgentServiceError("INVALID_INPUT", "활성 연결 키는 에이전트마다 최대 20개입니다.");
  const name = normalizedName(input.name, "연결 키 이름");
  const scopes = normalizeScopes(input.scopes ?? DEFAULT_API_TOKEN_SCOPES);
  const workspaces = validateCredentialWorkspaces(
    database,
    input.agentId,
    input.defaultWorkspaceId ?? null,
    input.workspaceAllowlist ?? [],
  );
  let ipAllowlist: string[];
  try {
    ipAllowlist = normalizeIpAllowlist(input.ipAllowlist ?? []);
  } catch (error) {
    throw new AgentServiceError("INVALID_INPUT", error instanceof IpAllowlistError ? error.message : "IP 제한을 확인해주세요.");
  }
  const expiresAt = normalizeExpiry(input.expiresAt);
  const secret = randomBytes(32).toString("base64url");
  const token = `nyx_live_${secret}`;
  const prefix = `nyx_live_${secret.slice(0, 7)}`;
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO agent_credentials
     (id, agent_id, created_by_user_id, name, token_prefix, token_hash,
      scopes_json, default_workspace_id, workspace_allowlist_json,
      ip_allowlist_json, last_used_at, last_used_ip, expires_at, revoked_at,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
  ).run(
    id,
    input.agentId,
    input.userId,
    name,
    prefix,
    createHash("sha256").update(token, "utf8").digest("hex"),
    JSON.stringify(scopes),
    workspaces.defaultWorkspaceId,
    JSON.stringify(workspaces.workspaceAllowlist),
    JSON.stringify(ipAllowlist),
    expiresAt,
    now,
    now,
  );
  recordGlobalAgentAudit(database, {
    agentId: input.agentId,
    userId: input.userId,
    action: "credential.global_created",
    targetType: "credential",
    targetId: id,
    metadata: {
      prefix,
      scopes,
      defaultWorkspaceId: workspaces.defaultWorkspaceId,
      workspaceAllowlist: workspaces.workspaceAllowlist,
      ipAllowlist,
      expiresAt,
    },
    createdAt: now,
  });
  return { token, credential: listCredentials(database, input.agentId).find((credential) => credential.id === id)! };
}

export function updateAgentCredential(
  database: NyxDatabase,
  input: {
    userId: string;
    agentId: string;
    credentialId: string;
    name: string;
    scopes: ApiTokenScope[];
    defaultWorkspaceId: string | null;
    workspaceAllowlist: string[];
    ipAllowlist: string[];
    expiresAt: string | null;
  },
) {
  requireMutableAgent(
    requireOwnedAgent(database, input.userId, input.agentId),
    "연결 키를 수정",
  );
  const current = database.prepare(
    "SELECT id FROM agent_credentials WHERE id = ? AND agent_id = ? AND revoked_at IS NULL",
  ).get(input.credentialId, input.agentId);
  if (!current) throw new AgentServiceError("NOT_FOUND", "활성 연결 키를 찾을 수 없습니다.");
  const name = normalizedName(input.name, "연결 키 이름");
  const scopes = normalizeScopes(input.scopes);
  const workspaces = validateCredentialWorkspaces(database, input.agentId, input.defaultWorkspaceId, input.workspaceAllowlist);
  let ipAllowlist: string[];
  try {
    ipAllowlist = normalizeIpAllowlist(input.ipAllowlist);
  } catch (error) {
    throw new AgentServiceError("INVALID_INPUT", error instanceof IpAllowlistError ? error.message : "IP 제한을 확인해주세요.");
  }
  const expiresAt = normalizeExpiry(input.expiresAt);
  const now = new Date().toISOString();
  database.prepare(
    `UPDATE agent_credentials
     SET name = ?, scopes_json = ?, default_workspace_id = ?,
         workspace_allowlist_json = ?, ip_allowlist_json = ?, expires_at = ?, updated_at = ?
     WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
  ).run(name, JSON.stringify(scopes), workspaces.defaultWorkspaceId, JSON.stringify(workspaces.workspaceAllowlist), JSON.stringify(ipAllowlist), expiresAt, now, input.credentialId, input.agentId);
  recordGlobalAgentAudit(database, {
    agentId: input.agentId,
    userId: input.userId,
    action: "credential.global_updated",
    targetType: "credential",
    targetId: input.credentialId,
    metadata: {
      name,
      scopes,
      defaultWorkspaceId: workspaces.defaultWorkspaceId,
      workspaceAllowlist: workspaces.workspaceAllowlist,
      ipAllowlist,
      expiresAt,
    },
    createdAt: now,
  });
  return listCredentials(database, input.agentId).find((credential) => credential.id === input.credentialId)!;
}

function wizardCredentialScopes(role: AgentWorkspaceRole): ApiTokenScope[] {
  if (role === "viewer") return ["documents:read", "changes:read"];
  return [
    "documents:read",
    "documents:write",
    "documents:commit",
    "changes:read",
    "revisions:restore",
  ];
}

function validateCredentialForWorkspaceRole(
  credential: AgentCredentialSummary,
  role: AgentWorkspaceRole,
) {
  if (credential.revokedAt) {
    throw new AgentServiceError("INVALID_INPUT", "폐기된 연결 키는 사용할 수 없습니다.");
  }
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
    throw new AgentServiceError("INVALID_INPUT", "만료된 연결 키는 사용할 수 없습니다.");
  }
  if (!credential.scopes.includes("documents:read")) {
    throw new AgentServiceError("INVALID_INPUT", "이 연결 키에는 문서 읽기 권한이 없습니다.");
  }
  if (role !== "viewer" && (
    !credential.scopes.includes("documents:write")
    || !credential.scopes.includes("documents:commit")
  )) {
    throw new AgentServiceError(
      "INVALID_INPUT",
      "에디터와 관리자 역할에는 읽기·쓰기·정본 저장이 가능한 연결 키가 필요합니다.",
    );
  }
}

export function connectAgentToWorkspace(
  database: NyxDatabase,
  input: ConnectAgentToWorkspaceInput,
): ConnectAgentToWorkspaceResult {
  return database.transaction(() => {
    const workspaceOwner = database.prepare(
      `SELECT owner_type, organization_id
       FROM workspace_ownership WHERE workspace_id = ?`,
    ).get(input.workspaceId) as {
      owner_type: "personal" | "organization";
      organization_id: string | null;
    } | undefined;
    if (!workspaceOwner) {
      throw new AgentServiceError("NOT_FOUND", "워크스페이스 소유권을 찾을 수 없습니다.");
    }
    const selectedAgent = input.agent.mode === "new"
      ? workspaceOwner.owner_type === "organization" && workspaceOwner.organization_id
        ? createOrganizationAgent(database, {
            organizationId: workspaceOwner.organization_id,
            userId: input.userId,
            actorLabel: "사용자",
            displayName: input.agent.displayName,
          })
        : createAccountAgent(database, {
            userId: input.userId,
            displayName: input.agent.displayName,
          })
      : (() => {
        const agentId = input.agent.agentId;
        return listAccountAgents(database, input.userId).find((agent) => agent.id === agentId);
      })();
    if (!selectedAgent) throw new AgentServiceError("NOT_FOUND", "에이전트를 찾을 수 없습니다.");
    if (selectedAgent.deletedAt || selectedAgent.purgedAt || selectedAgent.status !== "active") {
      throw new AgentServiceError("INVALID_INPUT", "활성 상태인 에이전트를 선택해주세요.");
    }
    if (input.agent.mode === "new" && input.credential.mode === "existing") {
      throw new AgentServiceError("INVALID_INPUT", "새 에이전트에는 새 연결 키를 만들어주세요.");
    }

    let existingCredential: AgentCredentialSummary | null = null;
    if (input.credential.mode === "existing") {
      const credentialId = input.credential.credentialId;
      existingCredential = selectedAgent.credentials.find(
        (credential) => credential.id === credentialId,
      ) ?? null;
      if (!existingCredential) {
        throw new AgentServiceError("NOT_FOUND", "선택한 에이전트의 연결 키를 찾을 수 없습니다.");
      }
      validateCredentialForWorkspaceRole(existingCredential, input.role);
    }

    const membership = assignAgentToWorkspace(database, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      agentId: selectedAgent.id,
      role: input.role,
      rootDocumentId: input.rootDocumentId,
    });

    let token: string | null = null;
    let credential: AgentCredentialSummary;
    let expandedCredentialWorkspaceAllowlist = false;
    if (input.credential.mode === "new") {
      const created = createAgentCredential(database, {
        userId: input.userId,
        agentId: selectedAgent.id,
        name: input.credential.name,
        scopes: wizardCredentialScopes(input.role),
        defaultWorkspaceId: input.workspaceId,
        workspaceAllowlist: input.credential.restrictToWorkspace ? [input.workspaceId] : [],
      });
      token = created.token;
      credential = created.credential;
    } else {
      const current = existingCredential!;
      const workspaceAllowlist = current.workspaceAllowlist.length
        && !current.workspaceAllowlist.includes(input.workspaceId)
        ? [...current.workspaceAllowlist, input.workspaceId]
        : current.workspaceAllowlist;
      expandedCredentialWorkspaceAllowlist = workspaceAllowlist.length !== current.workspaceAllowlist.length;
      credential = expandedCredentialWorkspaceAllowlist
        ? updateAgentCredential(database, {
          userId: input.userId,
          agentId: selectedAgent.id,
          credentialId: current.id,
          name: current.name,
          scopes: current.scopes,
          defaultWorkspaceId: current.defaultWorkspaceId,
          workspaceAllowlist,
          ipAllowlist: current.ipAllowlist,
          expiresAt: current.expiresAt,
        })
        : current;
    }

    return {
      agent: listAccountAgents(database, input.userId).find((agent) => agent.id === selectedAgent.id)!,
      membership,
      credential,
      token,
      expandedCredentialWorkspaceAllowlist,
    };
  })();
}

export function revokeAgentCredential(
  database: NyxDatabase,
  input: { userId: string; agentId: string; credentialId: string },
) {
  requireMutableAgent(
    requireOwnedAgent(database, input.userId, input.agentId),
    "연결 키를 폐기",
  );
  const now = new Date().toISOString();
  const result = database.prepare(
    `UPDATE agent_credentials SET revoked_at = ?, updated_at = ?
     WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
  ).run(now, now, input.credentialId, input.agentId);
  if (result.changes !== 1) throw new AgentServiceError("NOT_FOUND", "활성 연결 키를 찾을 수 없습니다.");
  database.prepare(
    "UPDATE workspace_api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).run(now, input.credentialId);
  recordGlobalAgentAudit(database, {
    agentId: input.agentId,
    userId: input.userId,
    action: "credential.global_revoked",
    targetType: "credential",
    targetId: input.credentialId,
    createdAt: now,
  });
}

export function rotateAgentCredential(
  database: NyxDatabase,
  input: { userId: string; agentId: string; credentialId: string },
) {
  requireMutableAgent(
    requireOwnedAgent(database, input.userId, input.agentId),
    "연결 키를 회전",
  );
  const current = database.prepare(
    `SELECT name, scopes_json, default_workspace_id, workspace_allowlist_json,
            ip_allowlist_json, expires_at
     FROM agent_credentials
     WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
  ).get(input.credentialId, input.agentId) as {
    name: string;
    scopes_json: string;
    default_workspace_id: string | null;
    workspace_allowlist_json: string;
    ip_allowlist_json: string;
    expires_at: string | null;
  } | undefined;
  if (!current) throw new AgentServiceError("NOT_FOUND", "활성 연결 키를 찾을 수 없습니다.");
  const preservedExpiry = current.expires_at && Date.parse(current.expires_at) > Date.now()
    ? current.expires_at
    : null;
  return database.transaction(() => {
    revokeAgentCredential(database, input);
    return createAgentCredential(database, {
      userId: input.userId,
      agentId: input.agentId,
      name: current.name,
      scopes: parseJsonList(current.scopes_json, API_TOKEN_SCOPES),
      defaultWorkspaceId: current.default_workspace_id,
      workspaceAllowlist: parseJsonList<string>(current.workspace_allowlist_json),
      ipAllowlist: parseJsonList<string>(current.ip_allowlist_json),
      expiresAt: preservedExpiry,
    });
  })();
}
