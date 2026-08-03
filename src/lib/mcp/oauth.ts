import { randomUUID } from "node:crypto";
import {
  assignAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
  listAccountAgents,
  revokeAgentCredential,
  updateAgentCredential,
} from "@/lib/agents/service";
import {
  getHumanWorkspacePrincipal,
  humanRoleAllows,
  type AgentAccessProfile,
  type WorkspacePermission,
  WORKSPACE_PERMISSIONS,
} from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import {
  API_TOKEN_SCOPES,
  authenticateAgentCredential,
  type ApiTokenIdentity,
  type ApiTokenScope,
} from "@/lib/tokens/service";
import { listUserMembershipWorkspaces } from "@/lib/workspaces/service";

export const MCP_OAUTH_IDENTITY_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
] as const;
export const MCP_OAUTH_SCOPES = [
  ...MCP_OAUTH_IDENTITY_SCOPES,
  ...API_TOKEN_SCOPES,
] as const;
export const MCP_OAUTH_DEFAULT_SCOPE = MCP_OAUTH_SCOPES.join(" ");
export const MCP_OAUTH_ACCESS_PROFILES = ["reader", "drafter", "writer"] as const;
export type McpOAuthAccessProfile = (typeof MCP_OAUTH_ACCESS_PROFILES)[number];

export class McpOAuthError extends Error {
  constructor(
    public readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_INPUT" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

type GrantRow = {
  id: string;
  user_id: string;
  client_id: string;
  client_name: string;
  agent_id: string;
  credential_id: string;
  scopes_json: string;
  status: "active" | "revoked";
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type MembershipRow = {
  status: "active" | "disabled";
};

export type McpOAuthAgentSelection =
  | { mode: "new"; displayName: string }
  | { mode: "existing"; agentId: string };

export type ProvisionMcpOAuthGrantInput = {
  userId: string;
  clientId: string;
  clientName: string;
  requestedScopes: string | readonly string[];
  workspaceIds: string[];
  accessProfile: McpOAuthAccessProfile;
  agent: McpOAuthAgentSelection;
};

export type McpOAuthWorkspaceAccess = {
  workspaceId: string;
  accessProfile: AgentAccessProfile;
  effectiveCapabilities: WorkspacePermission[];
};

function parseApiScopes(value: string | readonly string[]) {
  let values: readonly string[];
  if (typeof value !== "string") {
    values = [...value];
  } else if (value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      values = Array.isArray(parsed)
        ? parsed.filter((scope): scope is string => typeof scope === "string")
        : [];
    } catch {
      values = [];
    }
  } else {
    values = value.split(/\s+/);
  }
  return Array.from(new Set(values.filter((scope): scope is ApiTokenScope =>
    API_TOKEN_SCOPES.includes(scope as ApiTokenScope))));
}

function parseWorkspacePermissions(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((permission): permission is WorkspacePermission =>
        typeof permission === "string"
        && WORKSPACE_PERMISSIONS.includes(permission as WorkspacePermission))
      : [];
  } catch {
    return [];
  }
}

export function getMcpOAuthClient(database: NyxDatabase, clientId: string) {
  const client = database.prepare(
    `SELECT clientId, name, icon, disabled
     FROM oauthApplication
     WHERE clientId = ?`,
  ).get(clientId) as {
    clientId: string;
    name: string;
    icon: string | null;
    disabled: number | boolean | null;
  } | undefined;
  if (!client || Boolean(client.disabled)) return null;
  return {
    clientId: client.clientId,
    name: client.name,
    icon: client.icon,
  };
}

export function getMcpOAuthAuthorizationRequest(
  database: NyxDatabase,
  consentCode: string,
  userId: string,
) {
  const verification = database.prepare(
    `SELECT value, expiresAt
     FROM verification
     WHERE identifier = ?`,
  ).get(consentCode) as {
    value: string;
    expiresAt: string | number;
  } | undefined;
  if (!verification) return null;
  const expiresAt = typeof verification.expiresAt === "number"
    ? verification.expiresAt
    : Date.parse(verification.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;
  try {
    const parsed = JSON.parse(verification.value) as {
      clientId?: unknown;
      userId?: unknown;
      scope?: unknown;
    };
    if (
      parsed.userId !== userId
      || typeof parsed.clientId !== "string"
      || !Array.isArray(parsed.scope)
      || parsed.scope.some((scope) => typeof scope !== "string")
    ) {
      return null;
    }
    return {
      clientId: parsed.clientId,
      userId,
      scopes: parsed.scope as string[],
    };
  } catch {
    return null;
  }
}

function validateApiScopeDependencies(scopes: ApiTokenScope[]) {
  if (!scopes.length) {
    throw new McpOAuthError(
      "INVALID_INPUT",
      "The OAuth client did not request a Nyxdoc document scope.",
    );
  }
  if (scopes.includes("documents:write") && !scopes.includes("documents:read")) {
    throw new McpOAuthError("INVALID_INPUT", "documents:write requires documents:read.");
  }
  if (scopes.includes("documents:commit") && !scopes.includes("documents:read")) {
    throw new McpOAuthError("INVALID_INPUT", "documents:commit requires documents:read.");
  }
  if (scopes.includes("revisions:restore") && !scopes.includes("documents:read")) {
    throw new McpOAuthError("INVALID_INPUT", "revisions:restore requires documents:read.");
  }
  return scopes;
}

function grantForClient(database: NyxDatabase, userId: string, clientId: string) {
  return database.prepare(
    `SELECT id, user_id, client_id, client_name, agent_id, credential_id,
            scopes_json, status, created_at, updated_at, last_used_at, revoked_at
     FROM mcp_oauth_grants
     WHERE user_id = ? AND client_id = ?`,
  ).get(userId, clientId) as GrantRow | undefined;
}

function defaultOAuthAgentName(clientName: string) {
  const suffix = " OAuth";
  const normalized = clientName.trim().replace(/\s+/g, " ") || "MCP client";
  return `${normalized.slice(0, 80 - suffix.length)}${suffix}`;
}

function tableExists(database: NyxDatabase, tableName: string) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName));
}

function revokeIssuedOAuthTokens(
  database: NyxDatabase,
  userId: string,
  clientId: string,
) {
  if (!tableExists(database, "oauthAccessToken")) return 0;
  return database.prepare(
    "DELETE FROM oauthAccessToken WHERE userId = ? AND clientId = ?",
  ).run(userId, clientId).changes;
}

function revokePreviousOAuthCredential(
  database: NyxDatabase,
  input: {
    userId: string;
    agentId: string;
    credentialId: string;
  },
) {
  const credential = database.prepare(
    `SELECT credential.id, agent.status, agent.deleted_at, agent.purged_at
     FROM agent_credentials credential
     JOIN agents agent ON agent.id = credential.agent_id
     WHERE credential.id = ? AND credential.agent_id = ?
       AND credential.revoked_at IS NULL`,
  ).get(input.credentialId, input.agentId) as {
    id: string;
    status: "active" | "disabled";
    deleted_at: string | null;
    purged_at: string | null;
  } | undefined;
  if (!credential) return;
  if (
    credential.status === "active"
    && !credential.deleted_at
    && !credential.purged_at
  ) {
    revokeAgentCredential(database, input);
    return;
  }
  const now = new Date().toISOString();
  database.prepare(
    `UPDATE agent_credentials
     SET revoked_at = ?, updated_at = ?
     WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
  ).run(now, now, input.credentialId, input.agentId);
  if (tableExists(database, "workspace_api_tokens")) {
    database.prepare(
      `UPDATE workspace_api_tokens
       SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(now, input.credentialId);
  }
}

export function listMcpOAuthConsentWorkspaces(database: NyxDatabase, userId: string) {
  return listUserMembershipWorkspaces(database, userId)
    .filter((workspace) => {
      if (workspace.owner.type === "personal" && workspace.owner.id !== userId) {
        return false;
      }
      const principal = getHumanWorkspacePrincipal(database, workspace.id, userId);
      return Boolean(principal && humanRoleAllows(principal.role, "agents.manage"));
    })
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      owner: workspace.role === "owner",
      humanRole: workspace.role,
      namespace: {
        type: workspace.owner.type,
        id: workspace.owner.id,
        name: workspace.owner.name,
      },
    }));
}

export function listMcpOAuthConsentAgents(database: NyxDatabase, userId: string) {
  return listAccountAgents(database, userId)
    .filter((agent) =>
      agent.status === "active"
      && !agent.deletedAt
      && !agent.purgedAt)
    .map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      avatarMediaId: agent.avatarMediaId,
      owner: {
        type: agent.owner.type,
        id: agent.owner.id,
        name: agent.owner.name,
      },
      activeWorkspaceCount: agent.memberships.filter(
        (membership) => membership.status === "active",
      ).length,
      activeCredentialCount: agent.credentials.filter(
        (credential) =>
          !credential.revokedAt
          && (!credential.expiresAt || Date.parse(credential.expiresAt) > Date.now()),
      ).length,
    }));
}

export function getMcpOAuthConsentState(
  database: NyxDatabase,
  input: { userId: string; clientId: string; requestedScopes: string },
) {
  const grant = grantForClient(database, input.userId, input.clientId);
  const agents = listMcpOAuthConsentAgents(database, input.userId);
  const workspaceAccess = grant
    ? (database.prepare(
      `SELECT membership.workspace_id, membership.access_profile, membership.capabilities_json
       FROM agent_credential_grant_bindings binding
       JOIN workspace_agents membership ON membership.id = binding.grant_id
       WHERE binding.credential_id = ?
         AND binding.status = 'active' AND binding.revoked_at IS NULL
         AND membership.status = 'active' AND membership.revoked_at IS NULL
       ORDER BY membership.workspace_id`,
    ).all(grant.credential_id) as Array<{
      workspace_id: string;
      access_profile: AgentAccessProfile;
      capabilities_json: string;
    }>)
      .map((row): McpOAuthWorkspaceAccess => ({
        workspaceId: row.workspace_id,
        accessProfile: row.access_profile,
        effectiveCapabilities: parseWorkspacePermissions(row.capabilities_json),
      }))
    : [];
  const selectedWorkspaceIds = workspaceAccess.map((access) => access.workspaceId);
  return {
    grant: grant ? {
      id: grant.id,
      agentId: grant.agent_id,
      credentialId: grant.credential_id,
      status: grant.status,
    } : null,
    requestedScopes: validateApiScopeDependencies(
      parseApiScopes(input.requestedScopes),
    ),
    selectedWorkspaceIds,
    workspaceAccess,
    workspaces: listMcpOAuthConsentWorkspaces(database, input.userId),
    agents,
    initialAgent: grant && agents.some((agent) => agent.id === grant.agent_id)
      ? {
          mode: "existing" as const,
          agentId: grant.agent_id,
        }
      : {
          mode: "new" as const,
          displayName: defaultOAuthAgentName(
            grant?.client_name
            ?? getMcpOAuthClient(database, input.clientId)?.name
            ?? "MCP client",
          ),
        },
  };
}

function prepareMcpOAuthGrant(
  database: NyxDatabase,
  input: ProvisionMcpOAuthGrantInput,
) {
  const clientId = input.clientId.trim();
  const clientName = input.clientName.trim().slice(0, 120) || "MCP client";
  const workspaceIds = Array.from(new Set(input.workspaceIds));
  if (!clientId || clientId.length > 255) {
    throw new McpOAuthError("INVALID_INPUT", "The OAuth client identifier is invalid.");
  }
  if (!workspaceIds.length) {
    throw new McpOAuthError("INVALID_INPUT", "Select at least one workspace.");
  }
  if (!MCP_OAUTH_ACCESS_PROFILES.includes(input.accessProfile)) {
    throw new McpOAuthError("INVALID_INPUT", "The OAuth access profile is invalid.");
  }
  const available = new Set(
    listMcpOAuthConsentWorkspaces(database, input.userId).map((workspace) => workspace.id),
  );
  if (workspaceIds.some((workspaceId) => !available.has(workspaceId))) {
    throw new McpOAuthError(
      "FORBIDDEN",
      "One or more selected workspaces cannot be managed by this user.",
    );
  }
  const scopes = validateApiScopeDependencies(parseApiScopes(input.requestedScopes));
  const agentSelection = input.agent;
  if (
    agentSelection.mode === "new"
    && (!agentSelection.displayName.trim() || agentSelection.displayName.trim().length > 80)
  ) {
    throw new McpOAuthError("INVALID_INPUT", "The OAuth agent name is invalid.");
  }
  const availableAgents = listMcpOAuthConsentAgents(database, input.userId);
  if (
    agentSelection.mode === "existing"
    && !availableAgents.some((agent) => agent.id === agentSelection.agentId)
  ) {
    throw new McpOAuthError(
      "FORBIDDEN",
      "The selected agent is not active or cannot be managed by this user.",
    );
  }

  if (agentSelection.mode === "existing") {
    for (const workspaceId of workspaceIds) {
      const membership = database.prepare(
        `SELECT status
         FROM workspace_agents
         WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL`,
      ).get(workspaceId, agentSelection.agentId) as MembershipRow | undefined;
      if (membership && membership.status !== "active") {
        throw new McpOAuthError(
          "FORBIDDEN",
          "This agent has inactive workspace access. Activate or replace that workspace grant before OAuth consent.",
        );
      }
    }
  }

  return {
    clientId,
    clientName,
    workspaceIds,
    scopes,
    agentSelection,
  };
}

export function validateMcpOAuthGrantProvisioning(
  database: NyxDatabase,
  input: ProvisionMcpOAuthGrantInput,
) {
  const prepared = prepareMcpOAuthGrant(database, input);
  return {
    clientId: prepared.clientId,
    clientName: prepared.clientName,
    workspaceIds: prepared.workspaceIds,
    scopes: prepared.scopes,
    accessProfile: input.accessProfile,
    agent: prepared.agentSelection,
  };
}

export async function completeMcpOAuthConsent<T>(
  database: NyxDatabase,
  input: {
    provisioning: ProvisionMcpOAuthGrantInput | null;
    providerConsent: () => Promise<T>;
  },
) {
  // Validate every Nyxdoc-side precondition before asking the OAuth provider
  // to finalize consent. More importantly, do not mutate grants, credentials,
  // bindings, or existing OAuth tokens until provider consent has succeeded.
  if (input.provisioning) {
    validateMcpOAuthGrantProvisioning(database, input.provisioning);
  }
  const result = await input.providerConsent();
  if (input.provisioning) {
    provisionMcpOAuthGrant(database, input.provisioning);
  }
  return result;
}

export function provisionMcpOAuthGrant(
  database: NyxDatabase,
  input: ProvisionMcpOAuthGrantInput,
) {
  const {
    clientId,
    clientName,
    workspaceIds,
    scopes,
    agentSelection,
  } = prepareMcpOAuthGrant(database, input);

  return database.transaction(() => {
    const existing = grantForClient(database, input.userId, clientId);
    revokeIssuedOAuthTokens(database, input.userId, clientId);
    const agentId = agentSelection.mode === "existing"
      ? agentSelection.agentId
      : createAccountAgent(database, {
          userId: input.userId,
          displayName: agentSelection.displayName,
        }).id;
    if (existing && existing.agent_id !== agentId) {
      revokePreviousOAuthCredential(database, {
        userId: input.userId,
        agentId: existing.agent_id,
        credentialId: existing.credential_id,
      });
    }

    for (const workspaceId of workspaceIds) {
      const membership = database.prepare(
        `SELECT status
         FROM workspace_agents
         WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL`,
      ).get(workspaceId, agentId) as MembershipRow | undefined;
      if (!membership) {
        assignAgentToWorkspace(database, {
          userId: input.userId,
          workspaceId,
          agentId,
          accessProfile: input.accessProfile,
        });
        continue;
      }
      if (membership.status !== "active") {
        throw new McpOAuthError(
          "FORBIDDEN",
          "This agent has inactive workspace access. Activate or replace that workspace grant before OAuth consent.",
        );
      }
      // OAuth consent controls this OAuth credential and its explicit grant
      // bindings. Existing workspace grants are managed separately and must
      // never be broadened or narrowed as a side effect of re-consent.
    }

    const currentCredential = existing
      ? database.prepare(
        `SELECT id, name, ip_allowlist_json, expires_at
         FROM agent_credentials
         WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
      ).get(existing.credential_id, agentId) as {
        id: string;
        name: string;
        ip_allowlist_json: string;
        expires_at: string | null;
      } | undefined
      : undefined;
    let credentialId: string;
    if (currentCredential) {
      let ipAllowlist: string[] = [];
      try {
        const parsed = JSON.parse(currentCredential.ip_allowlist_json) as unknown;
        if (Array.isArray(parsed)) {
          ipAllowlist = parsed.filter((value): value is string => typeof value === "string");
        }
      } catch {
        ipAllowlist = [];
      }
      const credential = updateAgentCredential(database, {
        userId: input.userId,
        agentId,
        credentialId: currentCredential.id,
        name: currentCredential.name,
        scopes,
        defaultWorkspaceId: workspaceIds[0]!,
        workspaceAllowlist: workspaceIds,
        ipAllowlist,
        expiresAt: currentCredential.expires_at,
      });
      credentialId = credential.id;
    } else {
      const created = createAgentCredential(database, {
        userId: input.userId,
        agentId,
        name: `OAuth · ${clientName}`,
        scopes,
        defaultWorkspaceId: workspaceIds[0]!,
        workspaceAllowlist: workspaceIds,
      });
      credentialId = created.credential.id;
    }

    const now = new Date().toISOString();
    const grantId = existing?.id ?? randomUUID();
    database.prepare(
      `INSERT INTO mcp_oauth_grants
       (id, user_id, client_id, client_name, agent_id, credential_id,
        scopes_json, status, created_at, updated_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)
       ON CONFLICT(user_id, client_id) DO UPDATE SET
         client_name = excluded.client_name,
         agent_id = excluded.agent_id,
         credential_id = excluded.credential_id,
         scopes_json = excluded.scopes_json,
         status = 'active',
         updated_at = excluded.updated_at,
         revoked_at = NULL`,
    ).run(
      grantId,
      input.userId,
      clientId,
      clientName,
      agentId,
      credentialId,
      JSON.stringify(scopes),
      existing?.created_at ?? now,
      now,
    );
    return {
      id: grantId,
      userId: input.userId,
      clientId,
      clientName,
      agentId,
      credentialId,
      scopes,
      workspaceIds,
      accessProfile: input.accessProfile,
      status: "active" as const,
    };
  }).immediate();
}

export function resolveMcpOAuthIdentity(
  database: NyxDatabase,
  input: {
    userId: string;
    clientId: string;
    tokenScopes: string;
    workspaceId?: string | null;
    clientIp?: string | null;
  },
): ApiTokenIdentity {
  const grant = grantForClient(database, input.userId, input.clientId);
  if (!grant || grant.status !== "active" || grant.revoked_at) {
    throw new McpOAuthError("UNAUTHORIZED", "This OAuth connection is not authorized in Nyxdoc.");
  }
  const tokenScopes = validateApiScopeDependencies(parseApiScopes(input.tokenScopes));
  const grantedScopes = parseApiScopes(grant.scopes_json);
  const effectiveScopes = tokenScopes.filter((scope) => grantedScopes.includes(scope));
  const identity = authenticateAgentCredential(database, grant.credential_id, {
    workspaceId: input.workspaceId,
    clientIp: input.clientIp,
    scopeOverride: effectiveScopes,
  });
  if (identity.globalAgentId !== grant.agent_id) {
    throw new McpOAuthError("UNAUTHORIZED", "The OAuth agent binding is invalid.");
  }
  database.prepare(
    "UPDATE mcp_oauth_grants SET last_used_at = ?, updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), new Date().toISOString(), grant.id);
  return identity;
}
