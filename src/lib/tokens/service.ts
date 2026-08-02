import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  WORKSPACE_PERMISSIONS,
  agentPrincipalAllows,
  recordWorkspaceAuditEvent,
  requireHumanWorkspacePermission,
  type AgentWorkspaceRole,
  type WorkspacePermission,
} from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import type { DocumentActor, DocumentMutationSource } from "@/lib/documents/types";
import { ipMatchesAllowlist } from "@/lib/security/ip-allowlist";

export const API_TOKEN_SCOPES = [
  "documents:read",
  "documents:write",
  "documents:commit",
  "changes:read",
  "revisions:restore",
] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
export const DEFAULT_API_TOKEN_SCOPES: ApiTokenScope[] = [
  "documents:read",
  "documents:write",
  "documents:commit",
  "changes:read",
];
const TOKEN_SCOPE_PERMISSIONS: Record<ApiTokenScope, WorkspacePermission> = {
  "documents:read": "documents.read",
  "documents:write": "documents.update",
  "documents:commit": "documents.commit",
  "changes:read": "changes.read",
  "revisions:restore": "revisions.restore",
};

export type ApiTokenIdentity = {
  id: string;
  globalAgentId: string;
  agentId: string;
  workspaceId: string;
  userId: string;
  name: string;
  avatarMediaId: string | null;
  role: AgentWorkspaceRole;
  prefix: string;
  scopes: ApiTokenScope[];
  lastEventCursor: number;
  rootDocumentId: string | null;
  permissionAllow: WorkspacePermission[];
  permissionDeny: WorkspacePermission[];
  workspaceAllowlist: string[];
  ipAllowlist: string[];
};

export type ApiTokenWorkspaceIdentity = {
  identity: ApiTokenIdentity;
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
};

export type ApiTokenSummary = {
  id: string;
  agentId: string;
  name: string;
  avatarMediaId: string | null;
  role: AgentWorkspaceRole;
  prefix: string;
  scopes: ApiTokenScope[];
  lastEventCursor: number;
  lastUsedAt: string | null;
  createdAt: string;
  rootDocumentId: string | null;
  rootDocumentTitle: string | null;
};

export type WorkspaceAgentProfile = {
  id: string;
  displayName: string;
  avatarMediaId: string | null;
  role: AgentWorkspaceRole;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export class ApiTokenError extends Error {
  constructor(
    public readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_INPUT" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ApiTokenError";
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function parseScopes(value: string): ApiTokenScope[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const scopes = parsed.filter((scope): scope is ApiTokenScope =>
      API_TOKEN_SCOPES.includes(scope as ApiTokenScope),
    );
    // Connections issued before explicit draft commits existed treated
    // documents:write as the complete editor capability. Preserve that exact
    // role contract without rewriting canonical production rows in a schema
    // migration; any subsequent permissions save stores the explicit scope.
    if (scopes.includes("documents:write") && !scopes.includes("documents:commit")) {
      scopes.splice(scopes.indexOf("documents:write") + 1, 0, "documents:commit");
    }
    return scopes;
  } catch {
    return [];
  }
}

function parseStringList<T extends string>(value: string, allowed?: readonly T[]): T[] {
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

function validateCredentialScopes(scopesInput: ApiTokenScope[]) {
  const scopes = Array.from(new Set(scopesInput));
  if (scopes.length < 1 || scopes.some((scope) => !API_TOKEN_SCOPES.includes(scope))) {
    throw new ApiTokenError("INVALID_INPUT", "유효한 연결 권한을 하나 이상 선택해야 합니다.");
  }
  if (scopes.includes("documents:write") && !scopes.includes("documents:read")) {
    throw new ApiTokenError("INVALID_INPUT", "문서 쓰기 권한에는 문서 읽기 권한이 필요합니다.");
  }
  if (scopes.includes("documents:commit") && !scopes.includes("documents:write")) {
    throw new ApiTokenError("INVALID_INPUT", "정본 저장 권한에는 문서 쓰기 권한이 필요합니다.");
  }
  if (
    scopes.includes("revisions:restore")
    && (!scopes.includes("documents:read") || !scopes.includes("documents:write") || !scopes.includes("documents:commit"))
  ) {
    throw new ApiTokenError("INVALID_INPUT", "리비전 복원 권한에는 문서 읽기, 쓰기, 정본 저장 권한이 필요합니다.");
  }
  return scopes;
}

function validateRoleScopes(role: AgentWorkspaceRole, scopes: ApiTokenScope[]) {
  const unsupported = scopes.find((scope) => !agentPrincipalAllows({
    role,
    permissionAllow: [],
    permissionDeny: [],
  }, TOKEN_SCOPE_PERMISSIONS[scope]));
  if (unsupported) {
    throw new ApiTokenError(
      "INVALID_INPUT",
      `${role} 역할에서 사용할 수 없는 연결 권한(${unsupported})이 포함되어 있습니다.`,
    );
  }
}

function resolveCredentialRoot(
  database: NyxDatabase,
  workspaceId: string,
  rootDocumentId: string | null,
) {
  if (!rootDocumentId) return { rootDocumentId: null, rootDocumentTitle: null };
  const root = database
    .prepare(
      `SELECT title FROM documents
       WHERE id = ? AND workspace_id = ? AND status = 'active' AND lifecycle_state = 'active'`,
    )
    .get(rootDocumentId, workspaceId) as { title: string } | undefined;
  if (!root) throw new ApiTokenError("INVALID_INPUT", "연결 범위의 루트 문서를 찾을 수 없습니다.");
  return { rootDocumentId, rootDocumentTitle: root.title };
}

export function createWorkspaceToken(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    userId: string;
    name: string;
    role?: AgentWorkspaceRole;
    scopes?: ApiTokenScope[];
    rootDocumentId?: string | null;
  },
) {
  requireHumanWorkspacePermission(
    database,
    input.workspaceId,
    input.userId,
    "credentials.manage",
  );
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) {
    throw new ApiTokenError("INVALID_INPUT", "연결 이름은 1자 이상 80자 이하여야 합니다.");
  }
  const activeCount = database
    .prepare(
      `SELECT COUNT(*) AS count FROM workspace_api_tokens
       WHERE workspace_id = ? AND revoked_at IS NULL`,
    )
    .get(input.workspaceId) as { count: number };
  if (activeCount.count >= 20) {
    throw new ApiTokenError("INVALID_INPUT", "활성 연결은 워크스페이스당 최대 20개까지 만들 수 있습니다.");
  }
  const scopes = validateCredentialScopes(input.scopes ?? (
    input.role === "viewer"
      ? ["documents:read", "changes:read"]
      : DEFAULT_API_TOKEN_SCOPES
  ));
  const role: AgentWorkspaceRole = input.role
    ?? (scopes.includes("documents:write") ? "editor" : "viewer");
  validateRoleScopes(role, scopes);
  const { rootDocumentId, rootDocumentTitle } = resolveCredentialRoot(
    database,
    input.workspaceId,
    input.rootDocumentId ?? null,
  );

  const secret = randomBytes(32).toString("base64url");
  const token = `nyx_live_${secret}`;
  const prefix = `nyx_live_${secret.slice(0, 7)}`;
  const id = randomUUID();
  const agentId = randomUUID();
  const createdAt = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `INSERT INTO agents
       (id, owner_user_id, display_name, avatar_media_id, status,
        created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`,
    ).run(agentId, input.userId, name, input.userId, createdAt, createdAt);
    database.prepare(
      `INSERT INTO agent_ownership
       (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
       VALUES (?, 'personal', ?, NULL, ?, ?)`,
    ).run(agentId, input.userId, createdAt, createdAt);
    database.prepare(
      `INSERT INTO workspace_agents
       (id, workspace_id, display_name, avatar_media_id, role, status,
        created_by_user_id, created_at, updated_at, agent_identity_id,
        permission_allow_json, permission_deny_json, root_document_id)
       VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?, '[]', '[]', ?)`,
    ).run(agentId, input.workspaceId, name, role, input.userId, createdAt, createdAt, agentId, rootDocumentId);
    database.prepare(
      `INSERT INTO agent_credentials
       (id, agent_id, created_by_user_id, name, token_prefix, token_hash,
        scopes_json, default_workspace_id, workspace_allowlist_json,
        ip_allowlist_json, last_used_at, last_used_ip, expires_at, revoked_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      id,
      agentId,
      input.userId,
      name,
      prefix,
      hashToken(token),
      JSON.stringify(scopes),
      input.workspaceId,
      createdAt,
      createdAt,
    );
    database.prepare(
      `INSERT INTO workspace_api_tokens
       (id, workspace_id, created_by_user_id, name, token_prefix, token_hash,
        scopes_json, last_event_cursor, root_document_id, agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      id,
      input.workspaceId,
      input.userId,
      name,
      prefix,
      hashToken(token),
      JSON.stringify(scopes),
      rootDocumentId,
      agentId,
      createdAt,
    );
    database.prepare(
      `INSERT INTO agent_credential_workspace_state
       (credential_id, workspace_id, last_event_cursor, last_used_at, last_used_ip)
       VALUES (?, ?, 0, NULL, NULL)`,
    ).run(id, input.workspaceId);
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: "agent.created",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: "사용자",
      targetType: "agent",
      targetId: agentId,
      metadata: { role, credentialId: id, rootDocumentId, scopes },
      createdAt,
    });
  })();

  return {
    token,
    summary: {
      id,
      agentId,
      name,
      avatarMediaId: null,
      role,
      prefix,
      scopes,
      lastEventCursor: 0,
      lastUsedAt: null,
      createdAt,
      rootDocumentId,
      rootDocumentTitle,
    } satisfies ApiTokenSummary,
  };
}

function loadWorkspaceAgent(
  database: NyxDatabase,
  workspaceId: string,
  agentId: string,
) {
  return database.prepare(
    `SELECT membership.id, membership.agent_identity_id,
            agent.display_name, agent.avatar_media_id,
            agent.status AS identity_status, agent.deleted_at, agent.purged_at,
            membership.role, membership.status,
            membership.created_at, membership.updated_at
     FROM workspace_agents membership
     JOIN agents agent ON agent.id = membership.agent_identity_id
     WHERE membership.id = ? AND membership.workspace_id = ?`,
  ).get(agentId, workspaceId) as {
    id: string;
    agent_identity_id: string;
    display_name: string;
    avatar_media_id: string | null;
    identity_status: "active" | "disabled";
    deleted_at: string | null;
    purged_at: string | null;
    role: AgentWorkspaceRole;
    status: "active" | "disabled";
    created_at: string;
    updated_at: string;
  } | undefined;
}

function mapWorkspaceAgent(row: NonNullable<ReturnType<typeof loadWorkspaceAgent>>): WorkspaceAgentProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarMediaId: row.avatar_media_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function updateWorkspaceAgent(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    displayName?: string;
    avatarMediaId?: string | null;
    role?: AgentWorkspaceRole;
    status?: "active" | "disabled";
  },
): WorkspaceAgentProfile {
  requireHumanWorkspacePermission(database, input.workspaceId, input.userId, "agents.manage");
  const current = loadWorkspaceAgent(database, input.workspaceId, input.agentId);
  if (!current) throw new ApiTokenError("NOT_FOUND", "에이전트를 찾을 수 없습니다.");
  if (current.deleted_at || current.purged_at) {
    throw new ApiTokenError("INVALID_INPUT", "삭제된 에이전트는 계정의 에이전트 메뉴에서 먼저 복구해주세요.");
  }
  const displayName = input.displayName === undefined
    ? current.display_name
    : input.displayName.trim().replace(/\s+/g, " ");
  if (!displayName || displayName.length > 80) {
    throw new ApiTokenError("INVALID_INPUT", "에이전트 이름은 1자 이상 80자 이하여야 합니다.");
  }
  if (input.avatarMediaId) {
    const media = database.prepare(
      "SELECT 1 FROM media_assets WHERE id = ? AND workspace_id = ?",
    ).get(input.avatarMediaId, input.workspaceId);
    if (!media) throw new ApiTokenError("INVALID_INPUT", "이 워크스페이스의 이미지를 선택해주세요.");
  }
  const avatarMediaId = input.avatarMediaId === undefined
    ? current.avatar_media_id
    : input.avatarMediaId;
  const role = input.role ?? current.role;
  const status = input.status ?? current.status;
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE agents
       SET display_name = ?, avatar_media_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(displayName, avatarMediaId, now, current.agent_identity_id);
    database.prepare(
      `UPDATE workspace_agents
       SET display_name = ?, role = ?, status = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(displayName, role, status, now, input.agentId, input.workspaceId);
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: "agent.updated",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: "사용자",
      targetType: "agent",
      targetId: input.agentId,
      metadata: {
        before: {
          displayName: current.display_name,
          avatarMediaId: current.avatar_media_id,
          role: current.role,
          status: current.status,
        },
        after: { displayName, avatarMediaId, role, status },
      },
      createdAt: now,
    });
  })();
  return mapWorkspaceAgent({
    ...current,
    display_name: displayName,
    avatar_media_id: avatarMediaId,
    role,
    status,
    updated_at: now,
  });
}

export function updateWorkspaceConnectionPermissions(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    userId: string;
    tokenId: string;
    role: AgentWorkspaceRole;
    scopes: ApiTokenScope[];
    rootDocumentId: string | null;
  },
): ApiTokenSummary {
  requireHumanWorkspacePermission(database, input.workspaceId, input.userId, "agents.manage");
  requireHumanWorkspacePermission(database, input.workspaceId, input.userId, "credentials.manage");
  const current = database.prepare(
    `SELECT credential.id, credential.token_prefix, credential.scopes_json,
            credential.last_used_at, credential.created_at,
            membership.id AS agent_id, membership.agent_identity_id,
            membership.root_document_id,
            agent.display_name, agent.avatar_media_id, membership.role,
            COALESCE(state.last_event_cursor, 0) AS last_event_cursor
     FROM agent_credentials credential
     JOIN agents agent ON agent.id = credential.agent_id
     JOIN workspace_agents membership
       ON membership.agent_identity_id = credential.agent_id
      AND membership.workspace_id = ?
     LEFT JOIN agent_credential_workspace_state state
       ON state.credential_id = credential.id AND state.workspace_id = membership.workspace_id
     WHERE credential.id = ? AND credential.revoked_at IS NULL`,
  ).get(input.workspaceId, input.tokenId) as {
    id: string;
    token_prefix: string;
    scopes_json: string;
    last_event_cursor: number;
    last_used_at: string | null;
    created_at: string;
    root_document_id: string | null;
    agent_id: string;
    agent_identity_id: string;
    display_name: string;
    avatar_media_id: string | null;
    role: AgentWorkspaceRole;
  } | undefined;
  if (!current) throw new ApiTokenError("NOT_FOUND", "활성 연결을 찾을 수 없습니다.");

  const scopes = validateCredentialScopes(input.scopes);
  validateRoleScopes(input.role, scopes);
  const { rootDocumentId, rootDocumentTitle } = resolveCredentialRoot(
    database,
    input.workspaceId,
    input.rootDocumentId,
  );
  const previousScopes = parseScopes(current.scopes_json);
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE workspace_agents SET role = ?, root_document_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(input.role, rootDocumentId, now, current.agent_id, input.workspaceId);
    database.prepare(
      `UPDATE agent_credentials SET scopes_json = ?, updated_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(JSON.stringify(scopes), now, current.id);
    database.prepare(
      `UPDATE workspace_api_tokens SET scopes_json = ?, root_document_id = ?
       WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    ).run(JSON.stringify(scopes), rootDocumentId, current.id, input.workspaceId);
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: "connection.permissions_updated",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: "사용자",
      targetType: "credential",
      targetId: current.id,
      metadata: {
        agentId: current.agent_id,
        before: {
          role: current.role,
          scopes: previousScopes,
          rootDocumentId: current.root_document_id,
        },
        after: { role: input.role, scopes, rootDocumentId },
      },
      createdAt: now,
    });
  })();

  return {
    id: current.id,
    agentId: current.agent_id,
    name: current.display_name,
    avatarMediaId: current.avatar_media_id,
    role: input.role,
    prefix: current.token_prefix,
    scopes,
    lastEventCursor: Number(current.last_event_cursor),
    lastUsedAt: current.last_used_at,
    createdAt: current.created_at,
    rootDocumentId,
    rootDocumentTitle,
  };
}

export function rotateWorkspaceAgentCredential(
  database: NyxDatabase,
  input: { workspaceId: string; userId: string; agentId: string },
) {
  requireHumanWorkspacePermission(database, input.workspaceId, input.userId, "credentials.manage");
  const agent = loadWorkspaceAgent(database, input.workspaceId, input.agentId);
  if (!agent) throw new ApiTokenError("NOT_FOUND", "에이전트를 찾을 수 없습니다.");
  if (agent.deleted_at || agent.purged_at || agent.identity_status !== "active" || agent.status !== "active") {
    throw new ApiTokenError("INVALID_INPUT", "비활성 에이전트의 연결 키는 회전할 수 없습니다.");
  }
  const previous = database.prepare(
    `SELECT id, name, scopes_json, default_workspace_id,
            workspace_allowlist_json, ip_allowlist_json, expires_at
     FROM agent_credentials
     WHERE agent_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).get(agent.agent_identity_id) as {
    id: string;
    name: string;
    scopes_json: string;
    default_workspace_id: string | null;
    workspace_allowlist_json: string;
    ip_allowlist_json: string;
    expires_at: string | null;
  } | undefined;
  const scopes = previous ? parseScopes(previous.scopes_json) : DEFAULT_API_TOKEN_SCOPES;
  const rootDocumentId = (database.prepare(
    "SELECT root_document_id FROM workspace_agents WHERE id = ? AND workspace_id = ?",
  ).get(input.agentId, input.workspaceId) as { root_document_id: string | null }).root_document_id;
  const rootDocumentTitle = rootDocumentId
    ? (database.prepare("SELECT title FROM documents WHERE id = ? AND workspace_id = ?")
      .get(rootDocumentId, input.workspaceId) as { title: string } | undefined)?.title ?? null
    : null;
  const secret = randomBytes(32).toString("base64url");
  const token = `nyx_live_${secret}`;
  const prefix = `nyx_live_${secret.slice(0, 7)}`;
  const id = randomUUID();
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE agent_credentials SET revoked_at = ?, updated_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(now, now, previous?.id ?? "");
    database.prepare(
      `UPDATE workspace_api_tokens SET revoked_at = ?
       WHERE id = ? AND workspace_id = ? AND agent_id = ? AND revoked_at IS NULL`,
    ).run(now, previous?.id ?? "", input.workspaceId, input.agentId);
    database.prepare(
      `INSERT INTO agent_credentials
       (id, agent_id, created_by_user_id, name, token_prefix, token_hash,
        scopes_json, default_workspace_id, workspace_allowlist_json,
        ip_allowlist_json, last_used_at, last_used_ip, expires_at, revoked_at,
        created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
    ).run(
      id,
      agent.agent_identity_id,
      input.userId,
      previous?.name ?? `${agent.display_name} 연결 키`,
      prefix,
      hashToken(token),
      JSON.stringify(scopes),
      previous?.default_workspace_id ?? input.workspaceId,
      previous?.workspace_allowlist_json ?? "[]",
      previous?.ip_allowlist_json ?? "[]",
      previous?.expires_at ?? null,
      now,
      now,
    );
    database.prepare(
      `INSERT INTO workspace_api_tokens
       (id, workspace_id, created_by_user_id, name, token_prefix, token_hash,
        scopes_json, last_event_cursor, root_document_id, agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      id,
      input.workspaceId,
      input.userId,
      `${agent.display_name} 연결 키`,
      prefix,
      hashToken(token),
      JSON.stringify(scopes),
      rootDocumentId,
      input.agentId,
      now,
    );
    database.prepare(
      `INSERT INTO agent_credential_workspace_state
       (credential_id, workspace_id, last_event_cursor, last_used_at, last_used_ip)
       VALUES (?, ?, 0, NULL, NULL)`,
    ).run(id, input.workspaceId);
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: "credential.rotated",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: "사용자",
      targetType: "credential",
      targetId: id,
      metadata: { agentId: input.agentId, previousCredentialId: previous?.id ?? null },
      createdAt: now,
    });
  })();
  return {
    token,
    summary: {
      id,
      agentId: input.agentId,
      name: agent.display_name,
      avatarMediaId: agent.avatar_media_id,
      role: agent.role,
      prefix,
      scopes,
      lastEventCursor: 0,
      lastUsedAt: null,
      createdAt: now,
      rootDocumentId,
      rootDocumentTitle,
    } satisfies ApiTokenSummary,
  };
}

export function listWorkspaceTokens(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
): ApiTokenSummary[] {
  requireHumanWorkspacePermission(database, workspaceId, userId, "credentials.read");
  const rows = database
    .prepare(
      `SELECT credential.id, credential.token_prefix, credential.scopes_json,
              COALESCE(state.last_event_cursor, 0) AS last_event_cursor,
              credential.last_used_at, credential.created_at,
              membership.root_document_id, document.title AS root_document_title,
              membership.id AS agent_id, agent.display_name, agent.avatar_media_id,
              membership.role
       FROM workspace_agents membership
       JOIN agents agent ON agent.id = membership.agent_identity_id
       JOIN agent_credentials credential
         ON credential.agent_id = agent.id AND credential.revoked_at IS NULL
       LEFT JOIN agent_credential_workspace_state state
         ON state.credential_id = credential.id AND state.workspace_id = membership.workspace_id
       LEFT JOIN documents document ON document.id = membership.root_document_id
       WHERE membership.workspace_id = ? AND membership.status = 'active'
         AND (credential.workspace_allowlist_json = '[]'
              OR EXISTS (SELECT 1 FROM json_each(credential.workspace_allowlist_json)
                         WHERE value = membership.workspace_id))
       ORDER BY credential.created_at DESC`,
    )
    .all(workspaceId) as Array<{
    id: string;
    token_prefix: string;
    scopes_json: string;
    last_event_cursor: number;
    last_used_at: string | null;
    created_at: string;
    root_document_id: string | null;
    root_document_title: string | null;
    agent_id: string;
    display_name: string;
    avatar_media_id: string | null;
    role: AgentWorkspaceRole;
  }>;
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    name: row.display_name,
    avatarMediaId: row.avatar_media_id,
    role: row.role,
    prefix: row.token_prefix,
    scopes: parseScopes(row.scopes_json),
    lastEventCursor: Number(row.last_event_cursor),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    rootDocumentId: row.root_document_id,
    rootDocumentTitle: row.root_document_title,
  }));
}

export function revokeWorkspaceToken(
  database: NyxDatabase,
  input: { workspaceId: string; userId: string; tokenId: string },
) {
  requireHumanWorkspacePermission(
    database,
    input.workspaceId,
    input.userId,
    "credentials.manage",
  );
  const now = new Date().toISOString();
  database.transaction(() => {
    const token = database.prepare(
      `SELECT membership.id AS agent_id
       FROM agent_credentials credential
       JOIN workspace_agents membership
         ON membership.agent_identity_id = credential.agent_id
        AND membership.workspace_id = ?
       WHERE credential.id = ? AND credential.revoked_at IS NULL`,
    ).get(input.workspaceId, input.tokenId) as { agent_id: string | null } | undefined;
    if (!token) throw new ApiTokenError("NOT_FOUND", "연결을 찾을 수 없습니다.");
    database.prepare(
      `UPDATE agent_credentials SET revoked_at = ?, updated_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(now, now, input.tokenId);
    database.prepare(
      `UPDATE workspace_api_tokens SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(now, input.tokenId);
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: "credential.revoked",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: "사용자",
      targetType: "credential",
      targetId: input.tokenId,
      metadata: { agentId: token.agent_id },
      createdAt: now,
    });
  })();
}

type CredentialAuthenticationRow = {
  id: string;
  global_agent_id: string;
  created_by_user_id: string;
  token_prefix: string;
  scopes_json: string;
  default_workspace_id: string | null;
  workspace_allowlist_json: string;
  ip_allowlist_json: string;
  expires_at: string | null;
  display_name: string;
  avatar_media_id: string | null;
};

const credentialAuthenticationSelect = `
  SELECT credential.id, credential.agent_id AS global_agent_id,
         credential.created_by_user_id, credential.token_prefix,
         credential.scopes_json, credential.default_workspace_id,
         credential.workspace_allowlist_json, credential.ip_allowlist_json,
         credential.expires_at, agent.display_name, agent.avatar_media_id
  FROM agent_credentials credential
  JOIN agents agent ON agent.id = credential.agent_id
`;

function authenticateCredentialRow(
  database: NyxDatabase,
  row: CredentialAuthenticationRow | undefined,
  options: {
    workspaceId?: string | null;
    clientIp?: string | null;
    scopeOverride?: readonly ApiTokenScope[];
  },
): ApiTokenIdentity {
  if (!row || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
    throw new ApiTokenError("UNAUTHORIZED", "유효하지 않거나 만료된 토큰입니다.");
  }
  const ipAllowlist = parseStringList<string>(row.ip_allowlist_json);
  if (ipAllowlist.length > 0 && (!options.clientIp || !ipMatchesAllowlist(options.clientIp, ipAllowlist))) {
    throw new ApiTokenError("UNAUTHORIZED", "이 연결 키에 허용되지 않은 네트워크입니다.");
  }
  const workspaceId = options.workspaceId || row.default_workspace_id;
  if (!workspaceId) {
    throw new ApiTokenError("FORBIDDEN", "대상 워크스페이스를 명시해주세요.");
  }
  const workspaceAllowlist = parseStringList<string>(row.workspace_allowlist_json);
  if (workspaceAllowlist.length > 0 && !workspaceAllowlist.includes(workspaceId)) {
    throw new ApiTokenError("FORBIDDEN", "이 연결 키에 허용되지 않은 워크스페이스입니다.");
  }
  const membership = database.prepare(
    `SELECT membership.id, membership.role, membership.root_document_id,
            membership.permission_allow_json, membership.permission_deny_json
     FROM workspace_agents membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     JOIN agent_ownership agent_owner ON agent_owner.agent_id = membership.agent_identity_id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN organization_agent_approvals approval
       ON approval.organization_id = ownership.organization_id
      AND approval.agent_id = membership.agent_identity_id
      AND approval.revoked_at IS NULL
     LEFT JOIN organization_members personal_agent_member
       ON personal_agent_member.organization_id = ownership.organization_id
      AND personal_agent_member.user_id = agent_owner.owner_user_id
     WHERE membership.workspace_id = ? AND membership.agent_identity_id = ?
       AND membership.status = 'active' AND workspace.lifecycle_state = 'active'
       AND (ownership.owner_type = 'personal' OR organization.lifecycle_state = 'active')
       AND (
         (ownership.owner_type = 'personal'
          AND agent_owner.owner_type = 'personal'
          AND agent_owner.owner_user_id = ownership.owner_user_id)
         OR
         (ownership.owner_type = 'organization' AND (
           (agent_owner.owner_type = 'organization'
            AND agent_owner.organization_id = ownership.organization_id)
           OR
           (agent_owner.owner_type = 'personal'
            AND approval.id IS NOT NULL
            AND personal_agent_member.id IS NOT NULL)
         ))
       )`,
  ).get(workspaceId, row.global_agent_id) as {
    id: string;
    role: AgentWorkspaceRole;
    root_document_id: string | null;
    permission_allow_json: string;
    permission_deny_json: string;
  } | undefined;
  if (!membership) {
    throw new ApiTokenError("FORBIDDEN", "이 에이전트는 대상 워크스페이스에 할당되지 않았습니다.");
  }
  const state = database.prepare(
    `SELECT last_event_cursor FROM agent_credential_workspace_state
     WHERE credential_id = ? AND workspace_id = ?`,
  ).get(row.id, workspaceId) as { last_event_cursor: number } | undefined;
  const now = new Date().toISOString();
  database
    .prepare("UPDATE agent_credentials SET last_used_at = ?, last_used_ip = ?, updated_at = ? WHERE id = ?")
    .run(now, options.clientIp ?? null, now, row.id);
  database.prepare(
    `INSERT INTO agent_credential_workspace_state
     (credential_id, workspace_id, last_event_cursor, last_used_at, last_used_ip)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(credential_id, workspace_id) DO UPDATE SET
       last_used_at = excluded.last_used_at,
       last_used_ip = excluded.last_used_ip`,
  ).run(row.id, workspaceId, now, options.clientIp ?? null);
  database.prepare("UPDATE workspace_api_tokens SET last_used_at = ? WHERE id = ?")
    .run(now, row.id);
  const permissionAllow = parseStringList(membership.permission_allow_json, WORKSPACE_PERMISSIONS);
  const permissionDeny = parseStringList(membership.permission_deny_json, WORKSPACE_PERMISSIONS);
  const credentialScopes = parseScopes(row.scopes_json);
  const scopes = options.scopeOverride
    ? credentialScopes.filter((scope) => options.scopeOverride!.includes(scope))
    : credentialScopes;
  return {
    id: row.id,
    globalAgentId: row.global_agent_id,
    agentId: membership.id,
    workspaceId,
    userId: row.created_by_user_id,
    name: row.display_name,
    avatarMediaId: row.avatar_media_id,
    role: membership.role,
    prefix: row.token_prefix,
    scopes,
    lastEventCursor: Number(state?.last_event_cursor ?? 0),
    rootDocumentId: membership.root_document_id,
    permissionAllow,
    permissionDeny,
    workspaceAllowlist,
    ipAllowlist,
  };
}

export function authenticateApiToken(
  database: NyxDatabase,
  authorization: string | null,
  options: { workspaceId?: string | null; clientIp?: string | null } = {},
): ApiTokenIdentity {
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].length > 200) {
    throw new ApiTokenError("UNAUTHORIZED", "Bearer 토큰이 필요합니다.");
  }
  const row = database
    .prepare(
      `${credentialAuthenticationSelect}
       WHERE credential.token_hash = ? AND credential.revoked_at IS NULL
         AND agent.status = 'active'`,
    )
    .get(hashToken(match[1])) as CredentialAuthenticationRow | undefined;
  return authenticateCredentialRow(database, row, options);
}

export function authenticateAgentCredential(
  database: NyxDatabase,
  credentialId: string,
  options: {
    workspaceId?: string | null;
    clientIp?: string | null;
    scopeOverride?: readonly ApiTokenScope[];
  } = {},
) {
  const row = database
    .prepare(
      `${credentialAuthenticationSelect}
       WHERE credential.id = ? AND credential.revoked_at IS NULL
         AND agent.status = 'active'`,
    )
    .get(credentialId) as CredentialAuthenticationRow | undefined;
  return authenticateCredentialRow(database, row, options);
}

export function listApiTokenWorkspaceIdentities(
  database: NyxDatabase,
  identity: ApiTokenIdentity,
): ApiTokenWorkspaceIdentity[] {
  const rows = database.prepare(
    `SELECT membership.id, membership.workspace_id,
            membership.role, membership.root_document_id,
            membership.permission_allow_json, membership.permission_deny_json,
            workspace.name AS workspace_name, workspace.slug AS workspace_slug,
            COALESCE(state.last_event_cursor, 0) AS last_event_cursor
     FROM workspace_agents membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     JOIN agent_ownership agent_owner ON agent_owner.agent_id = membership.agent_identity_id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN organization_agent_approvals approval
       ON approval.organization_id = ownership.organization_id
      AND approval.agent_id = membership.agent_identity_id
      AND approval.revoked_at IS NULL
     LEFT JOIN organization_members personal_agent_member
       ON personal_agent_member.organization_id = ownership.organization_id
      AND personal_agent_member.user_id = agent_owner.owner_user_id
     LEFT JOIN agent_credential_workspace_state state
       ON state.credential_id = ? AND state.workspace_id = membership.workspace_id
     WHERE membership.agent_identity_id = ?
       AND membership.status = 'active'
       AND workspace.lifecycle_state = 'active'
       AND (ownership.owner_type = 'personal' OR organization.lifecycle_state = 'active')
       AND (
         (ownership.owner_type = 'personal'
          AND agent_owner.owner_type = 'personal'
          AND agent_owner.owner_user_id = ownership.owner_user_id)
         OR
         (ownership.owner_type = 'organization' AND (
           (agent_owner.owner_type = 'organization'
            AND agent_owner.organization_id = ownership.organization_id)
           OR
           (agent_owner.owner_type = 'personal'
            AND approval.id IS NOT NULL
            AND personal_agent_member.id IS NOT NULL)
         ))
       )
     ORDER BY workspace.name COLLATE NOCASE, workspace.id`,
  ).all(identity.id, identity.globalAgentId) as Array<{
    id: string;
    workspace_id: string;
    role: AgentWorkspaceRole;
    root_document_id: string | null;
    permission_allow_json: string;
    permission_deny_json: string;
    workspace_name: string;
    workspace_slug: string;
    last_event_cursor: number;
  }>;

  return rows
    .filter((row) => (
      identity.workspaceAllowlist.length === 0
      || identity.workspaceAllowlist.includes(row.workspace_id)
    ))
    .map((row) => ({
      identity: {
        ...identity,
        agentId: row.id,
        workspaceId: row.workspace_id,
        role: row.role,
        rootDocumentId: row.root_document_id,
        permissionAllow: parseStringList(
          row.permission_allow_json,
          WORKSPACE_PERMISSIONS,
        ),
        permissionDeny: parseStringList(
          row.permission_deny_json,
          WORKSPACE_PERMISSIONS,
        ),
        lastEventCursor: Number(row.last_event_cursor),
      },
      workspace: {
        id: row.workspace_id,
        name: row.workspace_name,
        slug: row.workspace_slug,
      },
    }));
}

export function requireTokenScope(identity: ApiTokenIdentity, scope: ApiTokenScope) {
  if (!identity.scopes.includes(scope)) {
    throw new ApiTokenError("FORBIDDEN", `이 연결에는 ${scope} 권한이 없습니다.`);
  }
  const permission = TOKEN_SCOPE_PERMISSIONS[scope];
  if (!agentPrincipalAllows(identity, permission)) {
    throw new ApiTokenError("FORBIDDEN", `이 에이전트 역할에는 ${scope} 권한이 없습니다.`);
  }
}

export function tokenDocumentActor(
  identity: ApiTokenIdentity,
  source: DocumentMutationSource,
): DocumentActor {
  return {
    type: "agent",
    userId: identity.userId,
    tokenId: identity.id,
    principalId: identity.globalAgentId,
    avatarMediaId: identity.avatarMediaId,
    label: identity.name,
    source,
  };
}

export function tokenCanAccessDocument(
  database: NyxDatabase,
  identity: ApiTokenIdentity,
  documentId: string,
  includeArchived = false,
) {
  if (!identity.rootDocumentId) return true;
  return Boolean(database.prepare(
    `WITH RECURSIVE ancestors(id, parent_document_id) AS (
       SELECT id, parent_document_id
       FROM documents
       WHERE workspace_id = ? AND id = ? AND (? = 1 OR status = 'active')
       UNION ALL
       SELECT d.id, d.parent_document_id
       FROM documents d
       JOIN ancestors a ON d.id = a.parent_document_id
       WHERE d.workspace_id = ? AND (? = 1 OR d.status = 'active')
     )
     SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`,
  ).get(
    identity.workspaceId,
    documentId,
    includeArchived ? 1 : 0,
    identity.workspaceId,
    includeArchived ? 1 : 0,
    identity.rootDocumentId,
  ));
}

export function requireTokenDocumentAccess(
  database: NyxDatabase,
  identity: ApiTokenIdentity,
  documentId: string,
) {
  if (!tokenCanAccessDocument(database, identity, documentId)) {
    throw new ApiTokenError("FORBIDDEN", "이 연결에 허용된 문서 범위를 벗어났습니다.");
  }
}

export function resolveTokenReadRoot(
  database: NyxDatabase,
  identity: ApiTokenIdentity,
  requestedRoot?: string,
) {
  if (requestedRoot) requireTokenDocumentAccess(database, identity, requestedRoot);
  return requestedRoot ?? identity.rootDocumentId ?? undefined;
}

export function resolveTokenCreateParent(
  database: NyxDatabase,
  identity: ApiTokenIdentity,
  requestedParent: string | null | undefined,
) {
  if (!identity.rootDocumentId) return requestedParent;
  if (requestedParent === undefined || requestedParent === null) return identity.rootDocumentId;
  requireTokenDocumentAccess(database, identity, requestedParent);
  return requestedParent;
}

export function requireTokenParentAccess(
  database: NyxDatabase,
  identity: ApiTokenIdentity,
  requestedParent: string | null | undefined,
) {
  if (requestedParent === undefined || !identity.rootDocumentId) return;
  if (requestedParent === null) {
    throw new ApiTokenError("FORBIDDEN", "범위 제한 연결은 문서를 워크스페이스 최상위로 옮길 수 없습니다.");
  }
  requireTokenDocumentAccess(database, identity, requestedParent);
}

export function setTokenCursor(
  database: NyxDatabase,
  tokenId: string,
  cursor: number,
  workspaceId?: string,
) {
  if (!Number.isInteger(cursor) || cursor < 0) return;
  const resolvedWorkspaceId = workspaceId ?? (database.prepare(
    "SELECT default_workspace_id FROM agent_credentials WHERE id = ? AND revoked_at IS NULL",
  ).get(tokenId) as { default_workspace_id: string | null } | undefined)?.default_workspace_id;
  if (resolvedWorkspaceId) {
    database.prepare(
      `INSERT INTO agent_credential_workspace_state
       (credential_id, workspace_id, last_event_cursor, last_used_at, last_used_ip)
       VALUES (?, ?, ?, NULL, NULL)
       ON CONFLICT(credential_id, workspace_id) DO UPDATE SET
         last_event_cursor = excluded.last_event_cursor`,
    ).run(tokenId, resolvedWorkspaceId, cursor);
  }
  database
    .prepare(
      `UPDATE workspace_api_tokens
       SET last_event_cursor = ?
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(cursor, tokenId);
}
