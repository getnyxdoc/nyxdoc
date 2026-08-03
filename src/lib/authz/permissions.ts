import { randomUUID } from "node:crypto";
import type { AgentIdentityId, WorkspaceAgentGrantId } from "@/lib/agents/identifiers";
import type { NyxDatabase } from "@/lib/db/client";

export const WORKSPACE_PERMISSIONS = [
  "workspace.read",
  "workspace.update",
  "members.read",
  "members.manage",
  "agents.read",
  "agents.manage",
  "credentials.read",
  "credentials.manage",
  "documents.read",
  "documents.create",
  "documents.update",
  "documents.commit",
  "documents.trash_own",
  "documents.trash",
  "documents.restore",
  "documents.purge",
  "documents.share",
  "revisions.read",
  "revisions.restore",
  "changes.read",
  "media.upload",
  "saved_views.read",
  "saved_views.manage",
  "assignments.read",
  "assignments.manage",
  "tasks.read",
  "tasks.create",
  "tasks.update",
  "tasks.manage",
  "admin_requests.read",
  "admin_requests.create",
  "admin_requests.review",
  "audit.read",
  "exports.create",
  "backups.manage",
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];
export type HumanWorkspaceRole = "owner" | "admin" | "editor" | "viewer";
export type HumanDocumentGrantRole = "editor" | "viewer";
export type AgentWorkspaceRole = "admin" | "editor" | "viewer";
export const AGENT_ACCESS_PROFILES = ["reader", "drafter", "writer", "custom"] as const;
export type AgentAccessProfile = (typeof AGENT_ACCESS_PROFILES)[number];

export type HumanWorkspacePrincipal = {
  type: "human";
  workspaceId: string;
  userId: string;
  role: HumanWorkspaceRole;
  accessSource: "membership" | "team";
};

type HumanDocumentPrincipalBase = {
  type: "human";
  workspaceId: string;
  documentId: string;
  userId: string;
};
export type HumanDocumentPrincipal = HumanDocumentPrincipalBase & (
  | { role: HumanWorkspaceRole; source: "workspace" }
  | { role: HumanDocumentGrantRole; source: "document_grant" }
);

export type AgentWorkspacePrincipal = {
  type: "agent";
  workspaceId: string;
  /** WorkspaceAgentGrantId (`workspace_agents.id`) for this workspace access grant. */
  membershipId: WorkspaceAgentGrantId;
  /** Global AgentIdentityId (`agents.id`) shared across all workspace grants. */
  agentId: AgentIdentityId;
  accessProfile: AgentAccessProfile;
  /** Canonical grant capabilities. Authorization fails closed without these. */
  capabilities: WorkspacePermission[];
  displayName: string;
  avatarMediaId: string | null;
};

export class AuthorizationError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

const ALL_PERMISSIONS = new Set<WorkspacePermission>(WORKSPACE_PERMISSIONS);
const BASE_EDITOR_PERMISSIONS = new Set<WorkspacePermission>([
  "workspace.read",
  "agents.read",
  "documents.read",
  "documents.create",
  "documents.update",
  "documents.commit",
  "documents.trash_own",
  "revisions.read",
  "revisions.restore",
  "changes.read",
  "media.upload",
  "saved_views.read",
  "saved_views.manage",
  "assignments.read",
  "tasks.read",
  "tasks.create",
  "tasks.update",
  "exports.create",
]);
const HUMAN_EDITOR_PERMISSIONS = new Set<WorkspacePermission>([
  ...BASE_EDITOR_PERMISSIONS,
  "documents.trash",
  "documents.restore",
  "documents.share",
]);
const VIEWER_PERMISSIONS = new Set<WorkspacePermission>([
  "workspace.read",
  "agents.read",
  "documents.read",
  "revisions.read",
  "changes.read",
  "saved_views.read",
  "assignments.read",
  "tasks.read",
  "exports.create",
]);
const AGENT_DRAFTER_PERMISSIONS = new Set<WorkspacePermission>([
  ...VIEWER_PERMISSIONS,
  "documents.create",
  "documents.update",
  "documents.trash_own",
  "media.upload",
  "saved_views.manage",
  "tasks.create",
  "tasks.update",
]);
const AGENT_WRITER_PERMISSIONS = new Set<WorkspacePermission>([
  ...AGENT_DRAFTER_PERMISSIONS,
  "documents.commit",
]);
const DOCUMENT_GRANT_PERMISSIONS: Record<
  HumanDocumentGrantRole,
  ReadonlySet<WorkspacePermission>
> = {
  viewer: new Set<WorkspacePermission>([
    "documents.read",
    "revisions.read",
    "changes.read",
    "exports.create",
  ]),
  editor: new Set<WorkspacePermission>([
    "documents.read",
    "documents.update",
    "documents.commit",
    "revisions.read",
    "revisions.restore",
    "changes.read",
    "media.upload",
    "exports.create",
  ]),
};
const AGENT_ADMIN_PERMISSIONS = new Set<WorkspacePermission>([
  ...BASE_EDITOR_PERMISSIONS,
  "members.read",
  "credentials.read",
  "documents.trash",
  "documents.restore",
  "assignments.manage",
  "tasks.manage",
  "admin_requests.read",
  "admin_requests.create",
  "audit.read",
]);

const HUMAN_ROLE_PERMISSIONS: Record<HumanWorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  owner: ALL_PERMISSIONS,
  admin: new Set(WORKSPACE_PERMISSIONS.filter((permission) => permission !== "backups.manage")),
  editor: HUMAN_EDITOR_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

const AGENT_ROLE_PERMISSIONS: Record<AgentWorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  admin: AGENT_ADMIN_PERMISSIONS,
  editor: BASE_EDITOR_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

const AGENT_PROFILE_PERMISSIONS: Record<Exclude<AgentAccessProfile, "custom">, ReadonlySet<WorkspacePermission>> = {
  reader: VIEWER_PERMISSIONS,
  drafter: AGENT_DRAFTER_PERMISSIONS,
  writer: AGENT_WRITER_PERMISSIONS,
};

export const AGENT_NON_DELEGABLE_PERMISSIONS = new Set<WorkspacePermission>([
  "workspace.update",
  "members.manage",
  "agents.manage",
  "credentials.manage",
  "documents.purge",
  "documents.share",
  "admin_requests.review",
  "backups.manage",
]);

function normalizeHumanRole(row: { role: string; access_role: string | null }): HumanWorkspaceRole {
  if (row.role === "owner") return "owner";
  if (["admin", "editor", "viewer"].includes(row.access_role ?? "")) {
    return row.access_role as HumanWorkspaceRole;
  }
  return "editor";
}

export function humanWorkspaceRoleRank(role: HumanWorkspaceRole) {
  return { viewer: 1, editor: 2, admin: 3, owner: 4 }[role];
}

export function getHumanWorkspacePrincipal(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
): HumanWorkspacePrincipal | null {
  const rows = database.prepare(
    `SELECT membership.role, membership.access_role, 'membership' AS access_source
     FROM workspace_members membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     WHERE membership.workspace_id = ? AND membership.user_id = ?
       AND workspace.lifecycle_state = 'active'
       AND (ownership.owner_type = 'personal' OR organization.lifecycle_state = 'active')
     UNION ALL
     SELECT 'member' AS role, team_grant.access_role, 'team' AS access_source
     FROM workspace_team_grants team_grant
     JOIN workspaces workspace ON workspace.id = team_grant.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     JOIN organizations organization ON organization.id = ownership.organization_id
     JOIN team_members team_member
       ON team_member.team_id = team_grant.team_id
      AND team_member.organization_id = team_grant.organization_id
     JOIN organization_members organization_member
       ON organization_member.organization_id = team_grant.organization_id
      AND organization_member.user_id = team_member.user_id
     WHERE team_grant.workspace_id = ? AND team_member.user_id = ?
       AND ownership.owner_type = 'organization'
       AND ownership.organization_id = team_grant.organization_id
       AND workspace.lifecycle_state = 'active'
       AND organization.lifecycle_state = 'active'`,
  ).all(workspaceId, userId, workspaceId, userId) as Array<{
    role: string;
    access_role: string | null;
    access_source: "membership" | "team";
  }>;
  if (rows.length === 0) return null;
  const selected = rows
    .map((row) => ({ ...row, normalizedRole: normalizeHumanRole(row) }))
    .sort((left, right) => humanWorkspaceRoleRank(right.normalizedRole)
      - humanWorkspaceRoleRank(left.normalizedRole))[0]!;
  return {
    type: "human",
    workspaceId,
    userId,
    role: selected.normalizedRole,
    accessSource: selected.access_source,
  };
}

export function getHumanDocumentPrincipal(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  userId: string,
): HumanDocumentPrincipal | null {
  const workspacePrincipal = getHumanWorkspacePrincipal(database, workspaceId, userId);
  if (workspacePrincipal) {
    const document = database.prepare(
      `SELECT 1
       FROM documents document
       JOIN workspaces workspace ON workspace.id = document.workspace_id
       WHERE document.workspace_id = ? AND document.id = ?
         AND workspace.lifecycle_state = 'active'
         AND document.status = 'active'
         AND document.lifecycle_state = 'active'`,
    ).get(workspaceId, documentId);
    if (!document) return null;
    return {
      ...workspacePrincipal,
      documentId,
      source: "workspace",
    };
  }

  const grant = database.prepare(
    `SELECT grant_entry.role
     FROM document_human_grants grant_entry
     JOIN documents document
       ON document.id = grant_entry.document_id
      AND document.workspace_id = grant_entry.workspace_id
     JOIN workspaces workspace ON workspace.id = grant_entry.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN organization_members organization_member
       ON organization_member.organization_id = ownership.organization_id
      AND organization_member.user_id = grant_entry.user_id
     JOIN user recipient ON recipient.id = grant_entry.user_id
     WHERE grant_entry.workspace_id = ?
       AND grant_entry.document_id = ?
       AND grant_entry.user_id = ?
       AND grant_entry.role IN ('viewer', 'editor')
       AND workspace.lifecycle_state = 'active'
       AND (ownership.owner_type = 'personal'
         OR (organization.lifecycle_state = 'active' AND organization_member.id IS NOT NULL))
       AND document.status = 'active'
       AND document.lifecycle_state = 'active'
       AND recipient.emailVerified = 1`,
  ).get(workspaceId, documentId, userId) as { role: HumanDocumentGrantRole } | undefined;
  if (!grant) return null;
  return {
    type: "human",
    workspaceId,
    documentId,
    userId,
    role: grant.role,
    source: "document_grant",
  };
}

export function humanRoleAllows(role: HumanWorkspaceRole, permission: WorkspacePermission) {
  return HUMAN_ROLE_PERMISSIONS[role].has(permission);
}

export function humanDocumentPrincipalAllows(
  principal: HumanDocumentPrincipal,
  permission: WorkspacePermission,
) {
  return principal.source === "workspace"
    ? humanRoleAllows(principal.role, permission)
    : DOCUMENT_GRANT_PERMISSIONS[principal.role].has(permission);
}

export function agentRoleAllows(role: AgentWorkspaceRole, permission: WorkspacePermission) {
  return AGENT_ROLE_PERMISSIONS[role].has(permission);
}

export function listAgentRolePermissions(role: AgentWorkspaceRole) {
  return WORKSPACE_PERMISSIONS.filter((permission) => AGENT_ROLE_PERMISSIONS[role].has(permission));
}

export function listAgentProfilePermissions(profile: AgentAccessProfile) {
  if (profile === "custom") return [];
  return WORKSPACE_PERMISSIONS.filter((permission) => AGENT_PROFILE_PERMISSIONS[profile].has(permission));
}

export function legacyRoleForAgentProfile(profile: AgentAccessProfile): AgentWorkspaceRole {
  return profile === "reader" ? "viewer" : "editor";
}

export function agentPrincipalAllows(
  principal: Pick<AgentWorkspacePrincipal, "capabilities">,
  permission: WorkspacePermission,
) {
  return principal.capabilities.includes(permission);
}

export function listAgentPrincipalPermissions(
  principal: Pick<AgentWorkspacePrincipal, "capabilities">,
) {
  return WORKSPACE_PERMISSIONS.filter((permission) => agentPrincipalAllows(principal, permission));
}

export function requireHumanWorkspacePermission(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
  permission: WorkspacePermission,
): HumanWorkspacePrincipal {
  const principal = getHumanWorkspacePrincipal(database, workspaceId, userId);
  if (!principal) {
    throw new AuthorizationError("NOT_FOUND", "워크스페이스를 찾을 수 없습니다.");
  }
  if (!humanRoleAllows(principal.role, permission)) {
    throw new AuthorizationError("FORBIDDEN", "이 작업을 수행할 권한이 없습니다.");
  }
  return principal;
}

export function requireHumanDocumentPermission(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  userId: string,
  permission: WorkspacePermission,
): HumanDocumentPrincipal {
  const principal = getHumanDocumentPrincipal(database, workspaceId, documentId, userId);
  if (!principal) {
    throw new AuthorizationError("NOT_FOUND", "문서를 찾을 수 없습니다.");
  }
  if (!humanDocumentPrincipalAllows(principal, permission)) {
    throw new AuthorizationError("FORBIDDEN", "이 문서에서 해당 작업을 수행할 권한이 없습니다.");
  }
  return principal;
}

export function requireAgentWorkspacePermission(
  principal: AgentWorkspacePrincipal,
  permission: WorkspacePermission,
) {
  if (!agentPrincipalAllows(principal, permission)) {
    throw new AuthorizationError("FORBIDDEN", "이 에이전트의 워크스페이스 grant에는 해당 capability가 없습니다.");
  }
}

export function recordWorkspaceAuditEvent(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    action: string;
    outcome?: "succeeded" | "denied" | "failed";
    actorType: "system" | "human" | "agent";
    actorUserId?: string | null;
    actorAgentId?: string | null;
    actorLabel: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  },
) {
  database.prepare(
    `INSERT INTO workspace_audit_events
     (id, workspace_id, action, outcome, actor_type, actor_user_id, actor_agent_id,
      actor_label, target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.workspaceId,
    input.action,
    input.outcome ?? "succeeded",
    input.actorType,
    input.actorUserId ?? null,
    input.actorAgentId ?? null,
    input.actorLabel,
    input.targetType,
    input.targetId ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.createdAt ?? new Date().toISOString(),
  );
}
