import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AGENT_NON_DELEGABLE_PERMISSIONS,
  WORKSPACE_PERMISSIONS,
  legacyRoleForAgentProfile,
  listAgentProfilePermissions,
  listAgentPrincipalPermissions,
  recordWorkspaceAuditEvent,
  requireHumanWorkspacePermission,
  type AgentAccessProfile,
  type AgentWorkspaceRole,
  type WorkspacePermission,
} from "@/lib/authz/permissions";
import { cancelAssignmentsOutsideWorkspaceAgentGrantBoundary } from "@/lib/agents/workspace-grant-boundary";
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
import type { AgentIdentityId, WorkspaceAgentGrantId } from "@/lib/agents/identifiers";

export type AgentCredentialBindingSummary = {
  id: string;
  grantId: string;
  workspaceId: string;
  workspaceName: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
};

export type AgentCredentialSummary = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  defaultWorkspaceId: string | null;
  workspaceIds: string[];
  ipAllowlist: string[];
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  bindings: AgentCredentialBindingSummary[];
};

export type AgentWorkspaceMembershipSummary = {
  /** WorkspaceAgentGrantId (`workspace_agents.id`) scoped to this workspace. */
  membershipId: WorkspaceAgentGrantId;
  /** Global AgentIdentityId (`agents.id`) shared across workspace grants. */
  agentId: AgentIdentityId;
  workspaceId: string;
  workspaceName: string;
  accessProfile: AgentAccessProfile;
  capabilities: WorkspacePermission[];
  scopeMode: "workspace" | "document_tree";
  policyVersion: number;
  revokedAt: string | null;
  status: "active" | "disabled";
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
  accessProfile?: AgentAccessProfile;
  capabilities?: WorkspacePermission[];
  rootDocumentId: string | null;
  credential:
    | { mode: "existing"; credentialId: string }
    | { mode: "new"; name: string; restrictToWorkspace: boolean }
    | { mode: "later" };
};

export type ConnectAgentToWorkspaceResult = {
  agent: AccountAgentSummary;
  membership: AgentWorkspaceMembershipSummary;
  credential: AgentCredentialSummary | null;
  binding: AgentCredentialBindingSummary | null;
  token: string | null;
};

export class AgentServiceError extends Error {
  constructor(
    public readonly code:
      | "FORBIDDEN"
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "CONFLICT"
      | "AGENT_TENANT_MISMATCH"
      | "GRANT_ALREADY_ACTIVE"
      | "INVALID_DOCUMENT_SCOPE"
      | "CREDENTIAL_AGENT_MISMATCH"
      | "CREDENTIAL_REVOKED"
      | "CREDENTIAL_EXPIRED"
      | "CREDENTIAL_NOT_BOUND_TO_GRANT",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentServiceError";
  }
}

function normalizeCapabilities(
  profile: AgentAccessProfile,
  explicitCapabilities?: readonly WorkspacePermission[],
) {
  if (profile === "custom" && !explicitCapabilities?.length) {
    throw new AgentServiceError(
      "INVALID_INPUT",
      "사용자 지정 접근 프로필에는 하나 이상의 명시적 권한이 필요합니다.",
      { field: "capabilities" },
    );
  }
  const profileCapabilities = profile === "custom" ? [] : listAgentProfilePermissions(profile);
  if (profile !== "custom" && explicitCapabilities) {
    const explicit = new Set(explicitCapabilities);
    const differs = explicit.size !== profileCapabilities.length
      || profileCapabilities.some((permission) => !explicit.has(permission));
    if (differs) {
      throw new AgentServiceError(
        "INVALID_INPUT",
        "고정 접근 프로필과 상충하는 개별 권한을 함께 지정할 수 없습니다.",
        { field: "capabilities", accessProfile: profile },
      );
    }
  }
  const values = profile === "custom"
    ? Array.from(new Set(explicitCapabilities))
    : profileCapabilities;
  if (values.some((permission) => !WORKSPACE_PERMISSIONS.includes(permission))) {
    throw new AgentServiceError("INVALID_INPUT", "알 수 없는 에이전트 권한이 포함되어 있습니다.");
  }
  const protectedPermission = values.find((permission) => AGENT_NON_DELEGABLE_PERMISSIONS.has(permission));
  if (protectedPermission) {
    throw new AgentServiceError(
      "INVALID_INPUT",
      "사람에게만 허용된 보호 권한은 에이전트 접근에 추가할 수 없습니다.",
      { field: "capabilities", permission: protectedPermission },
    );
  }
  const needsDocumentRead = values.some((permission) => [
    "documents.create",
    "documents.update",
    "documents.commit",
    "documents.trash_own",
    "documents.trash",
    "documents.restore",
    "revisions.read",
    "revisions.restore",
    "changes.read",
    "media.upload",
    "exports.create",
  ].includes(permission));
  if (needsDocumentRead && !values.includes("documents.read")) {
    throw new AgentServiceError(
      "INVALID_INPUT",
      "문서 작업 권한에는 문서 읽기 권한이 필요합니다.",
      { field: "capabilities", requires: "documents.read" },
    );
  }
  return WORKSPACE_PERMISSIONS.filter((permission) => values.includes(permission));
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
    /** Global AgentIdentityId (`agents.id`), not a WorkspaceAgentGrantId. */
    agentId: AgentIdentityId;
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
  access_profile: AgentAccessProfile;
  capabilities_json: string;
  scope_mode: "workspace" | "document_tree";
  policy_version: number;
  revoked_at: string | null;
  status: "active" | "disabled";
  root_document_id: string | null;
  root_document_title: string | null;
  created_at: string;
  updated_at: string;
}): AgentWorkspaceMembershipSummary {
  const capabilities = parseJsonList(row.capabilities_json, WORKSPACE_PERMISSIONS);
  return {
    membershipId: row.membership_id,
    agentId: row.agent_identity_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    accessProfile: row.access_profile,
    capabilities,
    scopeMode: row.scope_mode,
    policyVersion: Number(row.policy_version),
    revokedAt: row.revoked_at,
    status: row.status,
    effectivePermissions: listAgentPrincipalPermissions({ capabilities }),
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
  const scopes = parseJsonList(row.scopes_json, API_TOKEN_SCOPES);
  // Credentials issued before explicit draft commits existed treated
  // documents:write as the complete editor capability. Authentication keeps
  // that contract, so management and connection flows must expose the same
  // effective scope or they incorrectly force users to replace a valid key.
  if (scopes.includes("documents:write") && !scopes.includes("documents:commit")) {
    scopes.splice(scopes.indexOf("documents:write") + 1, 0, "documents:commit");
  }
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    scopes,
    defaultWorkspaceId: row.default_workspace_id,
    workspaceIds: parseJsonList<string>(row.workspace_allowlist_json),
    ipAllowlist: parseJsonList<string>(row.ip_allowlist_json),
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    bindings: [],
  };
}

function listCredentialBindings(database: NyxDatabase, credentialId: string) {
  return (database.prepare(
    `SELECT binding.id, binding.grant_id, membership.workspace_id,
            workspace.name AS workspace_name, binding.status,
            binding.created_at, binding.revoked_at
     FROM agent_credential_grant_bindings binding
     JOIN workspace_agents membership ON membership.id = binding.grant_id
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     WHERE binding.credential_id = ?
     ORDER BY binding.status, workspace.name COLLATE NOCASE, binding.created_at`,
  ).all(credentialId) as Array<{
    id: string;
    grant_id: string;
    workspace_id: string;
    workspace_name: string;
    status: "active" | "revoked";
    created_at: string;
    revoked_at: string | null;
  }>).map((row): AgentCredentialBindingSummary => ({
    id: row.id,
    grantId: row.grant_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }));
}

type ActiveGrantRow = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  agent_identity_id: string;
};

function listActiveGrantRows(database: NyxDatabase, agentId: string) {
  return database.prepare(
    `SELECT membership.id, membership.workspace_id, workspace.name AS workspace_name,
            membership.agent_identity_id
     FROM workspace_agents membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     WHERE membership.agent_identity_id = ?
       AND membership.status = 'active'
       AND membership.revoked_at IS NULL
       AND workspace.lifecycle_state = 'active'
     ORDER BY workspace.name COLLATE NOCASE, membership.created_at`,
  ).all(agentId) as ActiveGrantRow[];
}

function resolveCredentialGrantRows(
  database: NyxDatabase,
  input: {
    userId: string;
    agentId: string;
    workspaceIds: readonly string[];
  },
) {
  const activeGrants = listActiveGrantRows(database, input.agentId);
  const requestedWorkspaceIds = Array.from(new Set(input.workspaceIds));
  // Bindings are always explicit. An empty list means that the credential is
  // currently unbound; it never means present or future access to everything.
  const selected = activeGrants.filter(
    (grant) => requestedWorkspaceIds.includes(grant.workspace_id),
  );
  if (requestedWorkspaceIds.some(
    (workspaceId) => !selected.some((grant) => grant.workspace_id === workspaceId),
  )) {
    throw new AgentServiceError(
      "INVALID_INPUT",
      "에이전트 접근 권한이 없는 워크스페이스가 연결 키 범위에 포함되어 있습니다.",
      { field: "workspaceIds" },
    );
  }
  for (const grant of selected) {
    requireAgentWorkspaceAccess(database, grant.workspace_id, input.userId, "manage");
  }
  return selected;
}

function reconcileCredentialGrantBindings(
  database: NyxDatabase,
  input: {
    userId: string;
    agentId: string;
    credentialId: string;
    workspaceIds: readonly string[];
  },
) {
  const selected = resolveCredentialGrantRows(database, input);
  const selectedGrantIds = new Set(selected.map((grant) => grant.id));
  const now = new Date().toISOString();
  const existing = database.prepare(
    `SELECT binding.id, binding.grant_id, binding.status, binding.revoked_at
     FROM agent_credential_grant_bindings binding
     JOIN workspace_agents membership ON membership.id = binding.grant_id
     WHERE binding.credential_id = ? AND membership.agent_identity_id = ?`,
  ).all(input.credentialId, input.agentId) as Array<{
    id: string;
    grant_id: string;
    status: "active" | "revoked";
    revoked_at: string | null;
  }>;
  const activeByGrant = new Map(existing
    .filter((binding) => binding.status === "active" && !binding.revoked_at)
    .map((binding) => [binding.grant_id, binding]));

  for (const binding of activeByGrant.values()) {
    if (selectedGrantIds.has(binding.grant_id)) continue;
    database.prepare(
      `UPDATE agent_credential_grant_bindings
       SET status = 'revoked', revoked_at = ? WHERE id = ?`,
    ).run(now, binding.id);
  }
  for (const grant of selected) {
    if (activeByGrant.has(grant.id)) continue;
    database.prepare(
      `INSERT INTO agent_credential_grant_bindings
       (id, credential_id, grant_id, status, created_by_user_id, created_at, revoked_at)
       VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
    ).run(randomUUID(), input.credentialId, grant.id, input.userId, now);
  }
  return selected;
}

export function bindAgentCredentialToGrant(
  database: NyxDatabase,
  input: {
    userId: string;
    agentId: string;
    credentialId: string;
    grantId: string;
  },
) {
  requireMutableAgent(
    requireOwnedAgent(database, input.userId, input.agentId),
    "연결 키를 워크스페이스 접근에 연결",
  );
  const credential = database.prepare(
    `SELECT id, revoked_at, expires_at
     FROM agent_credentials WHERE id = ? AND agent_id = ?`,
  ).get(input.credentialId, input.agentId) as {
    id: string;
    revoked_at: string | null;
    expires_at: string | null;
  } | undefined;
  if (!credential) {
    throw new AgentServiceError(
      "CREDENTIAL_AGENT_MISMATCH",
      "선택한 연결 키는 이 에이전트에 속하지 않습니다.",
      { credentialId: input.credentialId, agentId: input.agentId },
    );
  }
  if (credential.revoked_at) {
    throw new AgentServiceError("CREDENTIAL_REVOKED", "폐기된 연결 키는 사용할 수 없습니다.");
  }
  if (credential.expires_at && Date.parse(credential.expires_at) <= Date.now()) {
    throw new AgentServiceError("CREDENTIAL_EXPIRED", "만료된 연결 키는 사용할 수 없습니다.");
  }
  const grant = database.prepare(
    `SELECT membership.id, membership.workspace_id, membership.agent_identity_id
     FROM workspace_agents membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     WHERE membership.id = ? AND membership.status = 'active'
       AND membership.revoked_at IS NULL AND workspace.lifecycle_state = 'active'`,
  ).get(input.grantId) as {
    id: string;
    workspace_id: string;
    agent_identity_id: string;
  } | undefined;
  if (!grant) throw new AgentServiceError("NOT_FOUND", "활성 에이전트 접근 권한을 찾을 수 없습니다.");
  if (grant.agent_identity_id !== input.agentId) {
    throw new AgentServiceError(
      "CREDENTIAL_AGENT_MISMATCH",
      "연결 키와 워크스페이스 접근 권한의 에이전트가 다릅니다.",
    );
  }
  requireAgentWorkspaceAccess(database, grant.workspace_id, input.userId, "manage");
  const active = database.prepare(
    `SELECT id FROM agent_credential_grant_bindings
     WHERE credential_id = ? AND grant_id = ?
       AND status = 'active' AND revoked_at IS NULL`,
  ).get(input.credentialId, input.grantId) as { id: string } | undefined;
  if (!active) {
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO agent_credential_grant_bindings
       (id, credential_id, grant_id, status, created_by_user_id, created_at, revoked_at)
       VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
    ).run(randomUUID(), input.credentialId, input.grantId, input.userId, now);
    recordWorkspaceAuditEvent(database, {
      workspaceId: grant.workspace_id,
      action: "agent.credential_bound",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: "사용자",
      targetType: "credential",
      targetId: input.credentialId,
      metadata: { agentId: input.agentId, grantId: input.grantId },
      createdAt: now,
    });
  }
  return listCredentialBindings(database, input.credentialId)
    .find((binding) => binding.grantId === input.grantId && binding.status === "active")!;
}

function listMemberships(database: NyxDatabase, agentId: string) {
  return (database.prepare(
    `SELECT membership.id AS membership_id, membership.agent_identity_id,
            membership.workspace_id, workspace.name AS workspace_name,
            membership.access_profile, membership.capabilities_json,
            membership.scope_mode, membership.policy_version, membership.revoked_at,
            membership.status, membership.root_document_id,
            document.title AS root_document_title,
            membership.created_at, membership.updated_at
     FROM workspace_agents membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN documents document ON document.id = membership.root_document_id
     WHERE membership.agent_identity_id = ? AND membership.revoked_at IS NULL
       AND workspace.lifecycle_state = 'active'
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
  ).all(agentId) as Parameters<typeof credentialFromRow>[0][]).map((row) => {
    const credential = credentialFromRow(row);
    const bindings = listCredentialBindings(database, credential.id);
    return {
      ...credential,
      bindings,
      workspaceIds: bindings
        .filter((binding) => binding.status === "active" && !binding.revokedAt)
        .map((binding) => binding.workspaceId),
    };
  });
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
            membership.access_profile, membership.capabilities_json,
            membership.scope_mode, membership.policy_version, membership.revoked_at,
            membership.status, membership.root_document_id,
            document.title AS root_document_title,
            membership.created_at, membership.updated_at
     FROM workspace_agents membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     LEFT JOIN documents document ON document.id = membership.root_document_id
     WHERE membership.workspace_id = ? AND membership.revoked_at IS NULL
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
    /** Global AgentIdentityId (`agents.id`), not a WorkspaceAgentGrantId. */
    agentId: AgentIdentityId;
    accessProfile?: AgentAccessProfile;
    capabilities?: WorkspacePermission[];
    rootDocumentId?: string | null;
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
    `SELECT id, status FROM workspace_agents
     WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL`,
  ).get(input.workspaceId, input.agentId) as { id: string; status: string } | undefined;
  if (existing?.status === "active") {
    throw new AgentServiceError(
      "GRANT_ALREADY_ACTIVE",
      "이미 이 워크스페이스에 활성 접근이 있습니다.",
      { agentId: input.agentId, workspaceId: input.workspaceId, grantId: existing.id },
    );
  }
  const accessProfile = input.accessProfile ?? "reader";
  const capabilities = normalizeCapabilities(accessProfile, input.capabilities);
  const role = accessProfile === "custom"
    ? (capabilities.includes("documents.update") ? "editor" : "viewer")
    : legacyRoleForAgentProfile(accessProfile);
  const rootDocumentId = validateMembershipRoot(database, input.workspaceId, input.rootDocumentId ?? null);
  const scopeMode = rootDocumentId ? "document_tree" : "workspace";
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
             root_document_id = ?, display_name = ?, access_profile = ?, capabilities_json = ?,
             scope_mode = ?, policy_version = policy_version + 1, updated_at = ?
         WHERE id = ?`,
      ).run(
        role,
        "[]",
        "[]",
        rootDocumentId,
        agent.display_name,
        accessProfile,
        JSON.stringify(capabilities),
        scopeMode,
        now,
        membershipId,
      );
    } else {
      database.prepare(
        `INSERT INTO workspace_agents
         (id, workspace_id, display_name, avatar_media_id, role, status,
          created_by_user_id, created_at, updated_at, agent_identity_id,
          permission_allow_json, permission_deny_json, root_document_id,
          access_profile, capabilities_json, scope_mode, policy_version, revoked_at)
         VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`,
      ).run(
        membershipId,
        input.workspaceId,
        agent.display_name,
        role,
        input.userId,
        now,
        now,
        input.agentId,
        "[]",
        "[]",
        rootDocumentId,
        accessProfile,
        JSON.stringify(capabilities),
        scopeMode,
      );
    }
    // A reactivated grant may have historical active assignments created
    // before its current root-document boundary was configured.
    cancelAssignmentsOutsideWorkspaceAgentGrantBoundary(database, {
      grant: {
        id: membershipId,
        agentIdentityId: input.agentId,
        workspaceId: input.workspaceId,
        status: "active",
        scopeMode,
        rootDocumentId,
      },
      actor: { type: "human", userId: input.userId, label: "사용자" },
      reason: "grant_scope_changed",
      now,
    });
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: existing ? "agent.membership_reactivated" : "agent.assigned",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: "사용자",
      targetType: "agent",
      targetId: input.agentId,
      metadata: { membershipId, accessProfile, capabilities, rootDocumentId },
      createdAt: now,
    });
    recordOrganizationWorkspaceAgentAudit(database, {
      workspaceId: input.workspaceId,
      action: existing
        ? "organization.agent_workspace_reactivated"
        : "organization.agent_workspace_assigned",
      userId: input.userId,
      agentId: input.agentId,
      metadata: { membershipId, accessProfile, capabilities, rootDocumentId },
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
    /** Global AgentIdentityId (`agents.id`), not a WorkspaceAgentGrantId. */
    agentId: AgentIdentityId;
    accessProfile?: AgentAccessProfile;
    capabilities?: WorkspacePermission[];
    rootDocumentId: string | null;
    status?: "active" | "disabled";
  },
) {
  requireAgentWorkspaceAccess(database, input.workspaceId, input.userId, "manage");
  requireMutableAgent(
    requireOwnedAgent(database, input.userId, input.agentId),
    "권한을 변경",
  );
  const current = database.prepare(
    `SELECT id, role, access_profile, capabilities_json, status, root_document_id,
            policy_version
     FROM workspace_agents
     WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL`,
  ).get(input.workspaceId, input.agentId) as {
    id: string;
    role: AgentWorkspaceRole;
    access_profile: AgentAccessProfile;
    capabilities_json: string;
    status: "active" | "disabled";
    root_document_id: string | null;
    policy_version: number;
  } | undefined;
  if (!current) throw new AgentServiceError("NOT_FOUND", "워크스페이스 에이전트 할당을 찾을 수 없습니다.");
  const rootDocumentId = validateMembershipRoot(database, input.workspaceId, input.rootDocumentId);
  const accessProfile = input.accessProfile ?? current.access_profile;
  const capabilities = normalizeCapabilities(
    accessProfile,
    input.capabilities ?? parseJsonList(current.capabilities_json, WORKSPACE_PERMISSIONS),
  );
  const role = accessProfile === "custom"
    ? (capabilities.includes("documents.update") ? "editor" : "viewer")
    : legacyRoleForAgentProfile(accessProfile);
  const status = input.status ?? current.status;
  const scopeMode = rootDocumentId ? "document_tree" : "workspace";
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE workspace_agents
       SET role = ?, access_profile = ?, capabilities_json = ?, status = ?,
           root_document_id = ?, scope_mode = ?, permission_allow_json = ?,
           permission_deny_json = ?, policy_version = policy_version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      role,
      accessProfile,
      JSON.stringify(capabilities),
      status,
      rootDocumentId,
      scopeMode,
      "[]",
      "[]",
      now,
      current.id,
    );
    cancelAssignmentsOutsideWorkspaceAgentGrantBoundary(database, {
      grant: {
        id: current.id,
        agentIdentityId: input.agentId,
        workspaceId: input.workspaceId,
        status,
        scopeMode,
        rootDocumentId,
      },
      actor: { type: "human", userId: input.userId, label: "사용자" },
      reason: status === "disabled" ? "grant_disabled" : "grant_scope_changed",
      now,
    });
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
          accessProfile: current.access_profile,
          capabilities: parseJsonList(current.capabilities_json, WORKSPACE_PERMISSIONS),
          status: current.status,
          rootDocumentId: current.root_document_id,
        },
        after: { role, accessProfile, capabilities, status, rootDocumentId },
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
          accessProfile: current.access_profile,
          capabilities: parseJsonList(current.capabilities_json, WORKSPACE_PERMISSIONS),
          status: current.status,
          rootDocumentId: current.root_document_id,
        },
        after: { role, accessProfile, capabilities, status, rootDocumentId },
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
  if (result.includes("documents:commit") && !result.includes("documents:read")) {
    throw new AgentServiceError("INVALID_INPUT", "정본 저장에는 문서 읽기 권한이 필요합니다.");
  }
  if (result.includes("revisions:restore") && !result.includes("documents:read")) {
    throw new AgentServiceError("INVALID_INPUT", "리비전 복원에는 문서 읽기 권한이 필요합니다.");
  }
  return result;
}

function validateCredentialDefaultWorkspace(
  defaultWorkspaceId: string | null,
  selectedGrants: readonly ActiveGrantRow[],
) {
  if (
    defaultWorkspaceId
    && !selectedGrants.some((grant) => grant.workspace_id === defaultWorkspaceId)
  ) {
    throw new AgentServiceError(
      "INVALID_INPUT",
      "기본 워크스페이스는 이 연결 키에 명시적으로 연결되어 있어야 합니다.",
      { field: "defaultWorkspaceId" },
    );
  }
  return defaultWorkspaceId;
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
  const selectedGrants = resolveCredentialGrantRows(database, {
    userId: input.userId,
    agentId: input.agentId,
    workspaceIds: input.workspaceAllowlist ?? [],
  });
  const defaultWorkspaceId = validateCredentialDefaultWorkspace(
    input.defaultWorkspaceId ?? null,
    selectedGrants,
  );
  const workspaceIds = selectedGrants.map((grant) => grant.workspace_id);
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
  database.transaction(() => {
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
      defaultWorkspaceId,
      JSON.stringify(workspaceIds),
      JSON.stringify(ipAllowlist),
      expiresAt,
      now,
      now,
    );
    reconcileCredentialGrantBindings(database, {
      userId: input.userId,
      agentId: input.agentId,
      credentialId: id,
      workspaceIds,
    });
  })();
  recordGlobalAgentAudit(database, {
    agentId: input.agentId,
    userId: input.userId,
    action: "credential.global_created",
    targetType: "credential",
    targetId: id,
    metadata: {
      prefix,
      scopes,
      defaultWorkspaceId,
      workspaceIds,
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
  const selectedGrants = resolveCredentialGrantRows(database, {
    userId: input.userId,
    agentId: input.agentId,
    workspaceIds: input.workspaceAllowlist,
  });
  const defaultWorkspaceId = validateCredentialDefaultWorkspace(
    input.defaultWorkspaceId,
    selectedGrants,
  );
  const workspaceIds = selectedGrants.map((grant) => grant.workspace_id);
  let ipAllowlist: string[];
  try {
    ipAllowlist = normalizeIpAllowlist(input.ipAllowlist);
  } catch (error) {
    throw new AgentServiceError("INVALID_INPUT", error instanceof IpAllowlistError ? error.message : "IP 제한을 확인해주세요.");
  }
  const expiresAt = normalizeExpiry(input.expiresAt);
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE agent_credentials
       SET name = ?, scopes_json = ?, default_workspace_id = ?,
           workspace_allowlist_json = ?, ip_allowlist_json = ?, expires_at = ?, updated_at = ?
       WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
    ).run(
      name,
      JSON.stringify(scopes),
      defaultWorkspaceId,
      JSON.stringify(workspaceIds),
      JSON.stringify(ipAllowlist),
      expiresAt,
      now,
      input.credentialId,
      input.agentId,
    );
    reconcileCredentialGrantBindings(database, {
      userId: input.userId,
      agentId: input.agentId,
      credentialId: input.credentialId,
      workspaceIds,
    });
  })();
  recordGlobalAgentAudit(database, {
    agentId: input.agentId,
    userId: input.userId,
    action: "credential.global_updated",
    targetType: "credential",
    targetId: input.credentialId,
    metadata: {
      name,
      scopes,
      defaultWorkspaceId,
      workspaceIds,
      ipAllowlist,
      expiresAt,
    },
    createdAt: now,
  });
  return listCredentials(database, input.agentId).find((credential) => credential.id === input.credentialId)!;
}

function wizardCredentialScopes(capabilities: readonly WorkspacePermission[]): ApiTokenScope[] {
  const scopes: ApiTokenScope[] = [];
  if (capabilities.includes("documents.read")) scopes.push("documents:read");
  if (capabilities.includes("documents.update")) scopes.push("documents:write");
  if (capabilities.includes("documents.commit")) scopes.push("documents:commit");
  if (capabilities.includes("changes.read")) scopes.push("changes:read");
  if (capabilities.includes("revisions.restore")) scopes.push("revisions:restore");
  return scopes.length ? scopes : ["documents:read"];
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
    }

    const membership = assignAgentToWorkspace(database, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      agentId: selectedAgent.id,
      accessProfile: input.accessProfile,
      capabilities: input.capabilities,
      rootDocumentId: input.rootDocumentId,
    });

    let token: string | null = null;
    let credential: AgentCredentialSummary | null = null;
    let binding: AgentCredentialBindingSummary | null = null;
    if (input.credential.mode === "new") {
      const created = createAgentCredential(database, {
        userId: input.userId,
        agentId: selectedAgent.id,
        name: input.credential.name,
        scopes: wizardCredentialScopes(membership.capabilities),
        defaultWorkspaceId: input.workspaceId,
        // A newly issued key starts on the grant being configured. Additional
        // grants can be attached explicitly from credential settings.
        workspaceAllowlist: [input.workspaceId],
      });
      token = created.token;
      credential = created.credential;
      binding = credential.bindings.find((item) => item.grantId === membership.membershipId) ?? null;
    } else if (input.credential.mode === "existing") {
      binding = bindAgentCredentialToGrant(database, {
        userId: input.userId,
        agentId: selectedAgent.id,
        credentialId: existingCredential!.id,
        grantId: membership.membershipId,
      });
      credential = listCredentials(database, selectedAgent.id)
        .find((item) => item.id === existingCredential!.id) ?? null;
    }

    return {
      agent: listAccountAgents(database, input.userId).find((agent) => agent.id === selectedAgent.id)!,
      membership,
      credential,
      binding,
      token,
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
  database.transaction(() => {
    const result = database.prepare(
      `UPDATE agent_credentials SET revoked_at = ?, updated_at = ?
       WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
    ).run(now, now, input.credentialId, input.agentId);
    if (result.changes !== 1) throw new AgentServiceError("NOT_FOUND", "활성 연결 키를 찾을 수 없습니다.");
    database.prepare(
      `UPDATE agent_credential_grant_bindings
       SET status = 'revoked', revoked_at = ?
       WHERE credential_id = ? AND status = 'active' AND revoked_at IS NULL`,
    ).run(now, input.credentialId);
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
  })();
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
    `SELECT name, scopes_json, default_workspace_id, ip_allowlist_json, expires_at
     FROM agent_credentials
     WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
  ).get(input.credentialId, input.agentId) as {
    name: string;
    scopes_json: string;
    default_workspace_id: string | null;
    ip_allowlist_json: string;
    expires_at: string | null;
  } | undefined;
  if (!current) throw new AgentServiceError("NOT_FOUND", "활성 연결 키를 찾을 수 없습니다.");
  // `workspace_allowlist_json` remains a legacy storage mirror. A credential can
  // be attached to another workspace later without rewriting that mirror, so the
  // active binding rows are the only authoritative source when rotating a key.
  const boundWorkspaceIds = (database.prepare(
    `SELECT DISTINCT membership.workspace_id
     FROM agent_credential_grant_bindings binding
     JOIN workspace_agents membership ON membership.id = binding.grant_id
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     WHERE binding.credential_id = ?
       AND binding.status = 'active' AND binding.revoked_at IS NULL
       AND membership.agent_identity_id = ?
       AND membership.status = 'active' AND membership.revoked_at IS NULL
       AND workspace.lifecycle_state = 'active'
     ORDER BY membership.workspace_id`,
  ).all(input.credentialId, input.agentId) as Array<{ workspace_id: string }>)
    .map((row) => row.workspace_id);
  const defaultWorkspaceId = current.default_workspace_id
    && boundWorkspaceIds.includes(current.default_workspace_id)
    ? current.default_workspace_id
    : null;
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
      defaultWorkspaceId,
      workspaceAllowlist: boundWorkspaceIds,
      ipAllowlist: parseJsonList<string>(current.ip_allowlist_json),
      expiresAt: preservedExpiry,
    });
  })();
}
