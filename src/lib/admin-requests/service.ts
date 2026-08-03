import { randomUUID } from "node:crypto";
import {
  recordWorkspaceAuditEvent,
  requireAgentWorkspacePermission,
  requireHumanWorkspacePermission,
  type AgentWorkspacePrincipal,
} from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import { createWorkspace } from "@/lib/workspaces/service";
import { listWorkspaceTokens, type ApiTokenSummary } from "@/lib/tokens/service";
import {
  assignAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
  createOrganizationAgent,
  revokeAgentCredential,
  rotateAgentCredential,
  updateAgentWorkspaceMembership,
} from "@/lib/agents/service";
import {
  proposeAdminActionSchema,
  reviewAdminActionSchema,
  type AdminActionProposal,
  type ProposeAdminActionInput,
  type ReviewAdminActionInput,
} from "@/lib/admin-requests/schemas";
import {
  AdminActionRequestError,
  type AdminActionRequest,
  type AdminActionReviewResult,
  type AdminActionStatus,
} from "@/lib/admin-requests/types";

const REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

type AdminRequestRow = {
  id: string;
  workspace_id: string;
  request_id: string;
  action_type: AdminActionProposal["actionType"];
  status: AdminActionStatus;
  reason: string;
  payload_json: string;
  precondition_json: string;
  preview_text: string;
  requested_by_agent_id: string | null;
  requested_by_label: string;
  requested_at: string;
  expires_at: string;
  reviewed_by_user_id: string | null;
  reviewed_by_label: string | null;
  reviewed_at: string | null;
  decision_note: string | null;
  execution_result_json: string | null;
};

type ReviewUser = { id: string; name: string; email: string };

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function mapRequest(row: AdminRequestRow): AdminActionRequest {
  return {
    id: row.id,
    requestId: row.request_id,
    workspaceId: row.workspace_id,
    actionType: row.action_type,
    status: row.status,
    reason: row.reason,
    payload: parseObject(row.payload_json) ?? {},
    preview: row.preview_text,
    requestedByAgentId: row.requested_by_agent_id,
    requestedByLabel: row.requested_by_label,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedByLabel: row.reviewed_by_label,
    reviewedAt: row.reviewed_at,
    decisionNote: row.decision_note,
    executionResult: parseObject(row.execution_result_json),
  };
}

function getRequestRow(database: NyxDatabase, workspaceId: string, requestId: string) {
  return database.prepare(
    `SELECT * FROM workspace_admin_action_requests
     WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, requestId) as AdminRequestRow | undefined;
}

type ActiveBoundCredential = {
  credentialId: string;
  agentIdentityId: string;
  membershipId: string;
  bindingId: string;
  displayName: string;
  credentialUpdatedAt: string;
};

function activeBoundCredential(
  database: NyxDatabase,
  workspaceId: string,
  credentialId: string,
) {
  const now = new Date().toISOString();
  return database.prepare(
    `SELECT credential.id AS credential_id, credential.agent_id AS agent_identity_id,
            credential.updated_at AS credential_updated_at, membership.id AS membership_id,
            binding.id AS binding_id, agent.display_name
     FROM agent_credentials credential
     JOIN agents agent
       ON agent.id = credential.agent_id AND agent.status = 'active'
     JOIN workspace_agents membership
       ON membership.agent_identity_id = credential.agent_id
      AND membership.workspace_id = ?
      AND membership.status = 'active' AND membership.revoked_at IS NULL
     JOIN agent_credential_grant_bindings binding
       ON binding.credential_id = credential.id AND binding.grant_id = membership.id
      AND binding.status = 'active' AND binding.revoked_at IS NULL
     WHERE credential.id = ? AND credential.revoked_at IS NULL
       AND (credential.expires_at IS NULL OR credential.expires_at > ?)`,
  ).get(workspaceId, credentialId, now) as {
    credential_id: string;
    agent_identity_id: string;
    credential_updated_at: string;
    membership_id: string;
    binding_id: string;
    display_name: string;
  } | undefined satisfies {
    credential_id: string;
    agent_identity_id: string;
    credential_updated_at: string;
    membership_id: string;
    binding_id: string;
    display_name: string;
  } | undefined;
}

function toActiveBoundCredential(row: ReturnType<typeof activeBoundCredential>): ActiveBoundCredential | null {
  if (!row) return null;
  return {
    credentialId: row.credential_id,
    agentIdentityId: row.agent_identity_id,
    membershipId: row.membership_id,
    bindingId: row.binding_id,
    displayName: row.display_name,
    credentialUpdatedAt: row.credential_updated_at,
  };
}

function synchronizeSelectedCredentialBindingsForRotation(
  database: NyxDatabase,
  credentialId: string,
) {
  const workspaceIds = (database.prepare(
    `SELECT DISTINCT membership.workspace_id
     FROM agent_credential_grant_bindings binding
     JOIN workspace_agents membership ON membership.id = binding.grant_id
     WHERE binding.credential_id = ?
       AND binding.status = 'active' AND binding.revoked_at IS NULL
       AND membership.status = 'active' AND membership.revoked_at IS NULL
     ORDER BY membership.workspace_id`,
  ).all(credentialId) as Array<{ workspace_id: string }>).map((row) => row.workspace_id);
  const current = database.prepare(
    `SELECT default_workspace_id, workspace_allowlist_json
     FROM agent_credentials WHERE id = ? AND revoked_at IS NULL`,
  ).get(credentialId) as {
    default_workspace_id: string | null;
    workspace_allowlist_json: string;
  } | undefined;
  if (!current || workspaceIds.length === 0) {
    throw new AdminActionRequestError("NOT_FOUND", "회전할 활성 연결 키를 찾을 수 없습니다.");
  }
  const defaultWorkspaceId = current.default_workspace_id && workspaceIds.includes(current.default_workspace_id)
    ? current.default_workspace_id
    : workspaceIds[0];
  const serializedWorkspaceIds = JSON.stringify(workspaceIds);
  if (
    current.workspace_allowlist_json === serializedWorkspaceIds
    && current.default_workspace_id === defaultWorkspaceId
  ) {
    return;
  }
  database.prepare(
    `UPDATE agent_credentials
     SET workspace_allowlist_json = ?, default_workspace_id = ?, updated_at = ?
     WHERE id = ? AND revoked_at IS NULL`,
  ).run(serializedWorkspaceIds, defaultWorkspaceId, new Date().toISOString(), credentialId);
}

function proposalContext(
  database: NyxDatabase,
  workspaceId: string,
  proposal: AdminActionProposal,
): { precondition: Record<string, unknown>; preview: string } {
  switch (proposal.actionType) {
    case "workspace.create":
      return {
        precondition: {},
        preview: `새 워크스페이스 ‘${proposal.payload.name}’을 만듭니다. 승인한 사람이 소유자가 되며, 요청한 에이전트에는 자동으로 접근 권한이 생기지 않습니다.`,
      };
    case "workspace.update": {
      const workspace = database.prepare(
        `SELECT name, trash_retention_days, trash_auto_purge, updated_at
         FROM workspaces WHERE id = ?`,
      ).get(workspaceId) as {
        name: string;
        trash_retention_days: number;
        trash_auto_purge: number;
        updated_at: string;
      } | undefined;
      if (!workspace) throw new AdminActionRequestError("NOT_FOUND", "워크스페이스를 찾을 수 없습니다.");
      const changes = [
        proposal.payload.name !== undefined ? `이름 → ‘${proposal.payload.name}’` : null,
        proposal.payload.trashRetentionDays !== undefined
          ? `휴지통 보존 → ${proposal.payload.trashRetentionDays}일`
          : null,
        proposal.payload.trashAutoPurge !== undefined
          ? `자동 영구 삭제 → ${proposal.payload.trashAutoPurge ? "사용" : "사용 안 함"}`
          : null,
      ].filter(Boolean).join(", ");
      return {
        precondition: { updatedAt: workspace.updated_at },
        preview: `현재 워크스페이스 설정을 변경합니다: ${changes}.`,
      };
    }
    case "agent.connect": {
      const rootTitle = proposal.payload.rootDocumentId
        ? (database.prepare(
          `SELECT title FROM documents
           WHERE id = ? AND workspace_id = ? AND lifecycle_state = 'active'`,
        ).get(proposal.payload.rootDocumentId, workspaceId) as { title: string } | undefined)?.title
        : null;
      if (proposal.payload.rootDocumentId && !rootTitle) {
        throw new AdminActionRequestError("INVALID_INPUT", "접근 범위의 루트 문서를 찾을 수 없습니다.");
      }
      return {
        precondition: {},
        preview: `‘${proposal.payload.name}’ 에이전트 신원을 만들고 ${proposal.payload.accessProfile} 접근 프로필로 연결합니다. ${rootTitle ? `범위는 ‘${rootTitle}’ 이하` : "범위는 전체 워크스페이스"}이며, 명시적으로 이 워크스페이스에 연결된 키를 발급합니다. 키는 승인한 사람에게 한 번만 표시됩니다.`,
      };
    }
    case "agent.update": {
      const agent = database.prepare(
        `SELECT display_name, access_profile, capabilities_json, root_document_id, status, updated_at
         FROM workspace_agents WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL`,
      ).get(workspaceId, proposal.payload.agentId) as {
        display_name: string;
        access_profile: string;
        capabilities_json: string;
        root_document_id: string | null;
        status: string;
        updated_at: string;
      } | undefined;
      if (!agent) throw new AdminActionRequestError("NOT_FOUND", "에이전트를 찾을 수 없습니다.");
      const changes = [
        proposal.payload.accessProfile !== undefined ? `접근 프로필 → ${proposal.payload.accessProfile}` : null,
        proposal.payload.capabilities !== undefined ? `사용자 지정 권한 → ${proposal.payload.capabilities.length}개` : null,
        proposal.payload.rootDocumentId !== undefined ? "접근 문서 범위 변경" : null,
        proposal.payload.status !== undefined ? `상태 → ${proposal.payload.status}` : null,
      ].filter(Boolean).join(", ");
      return {
        precondition: { agentUpdatedAt: agent.updated_at },
        preview: `‘${agent.display_name}’ 에이전트를 변경합니다: ${changes}.`,
      };
    }
    case "credential.rotate": {
      const credential = toActiveBoundCredential(
        activeBoundCredential(database, workspaceId, proposal.payload.credentialId),
      );
      if (!credential) {
        throw new AdminActionRequestError(
          "NOT_FOUND",
          "현재 워크스페이스에 명시적으로 연결된 활성 연결 키를 찾을 수 없습니다.",
        );
      }
      return {
        precondition: {
          credentialId: credential.credentialId,
          agentId: credential.agentIdentityId,
          membershipId: credential.membershipId,
          bindingId: credential.bindingId,
          credentialUpdatedAt: credential.credentialUpdatedAt,
        },
        preview: `‘${credential.displayName}’의 선택한 연결 키를 회전합니다. 기존 키의 명시적 워크스페이스 연결만 새 키로 이어지며, 새 키는 승인한 사람에게 한 번만 표시됩니다.`,
      };
    }
    case "credential.revoke": {
      const credential = toActiveBoundCredential(
        activeBoundCredential(database, workspaceId, proposal.payload.credentialId),
      );
      if (!credential) throw new AdminActionRequestError("NOT_FOUND", "활성 연결 키를 찾을 수 없습니다.");
      return {
        precondition: {
          credentialId: credential.credentialId,
          agentId: credential.agentIdentityId,
          membershipId: credential.membershipId,
          bindingId: credential.bindingId,
          credentialUpdatedAt: credential.credentialUpdatedAt,
        },
        preview: `‘${credential.displayName}’의 선택한 연결 키를 폐기합니다. 이 키의 모든 명시적 워크스페이스 연결이 즉시 중단되며, 에이전트 신원과 과거 기록은 유지됩니다.`,
      };
    }
  }
}

function expireRequests(database: NyxDatabase, workspaceId: string, now: string) {
  const expired = database.prepare(
    `SELECT id, requested_by_agent_id, requested_by_label
     FROM workspace_admin_action_requests
     WHERE workspace_id = ? AND status = 'pending' AND expires_at <= ?`,
  ).all(workspaceId, now) as Array<{
    id: string;
    requested_by_agent_id: string | null;
    requested_by_label: string;
  }>;
  if (expired.length === 0) return;
  database.transaction(() => {
    database.prepare(
      `UPDATE workspace_admin_action_requests
       SET status = 'expired', reviewed_at = ?
       WHERE workspace_id = ? AND status = 'pending' AND expires_at <= ?`,
    ).run(now, workspaceId, now);
    for (const item of expired) {
      recordWorkspaceAuditEvent(database, {
        workspaceId,
        action: "admin_request.expired",
        actorType: "system",
        actorLabel: "Nyxdoc",
        targetType: "admin_action_request",
        targetId: item.id,
        metadata: {
          requestedByAgentId: item.requested_by_agent_id,
          requestedByLabel: item.requested_by_label,
        },
        createdAt: now,
      });
    }
  })();
}

export function proposeAdminAction(
  database: NyxDatabase,
  principal: AgentWorkspacePrincipal,
  rawInput: ProposeAdminActionInput,
) {
  requireAgentWorkspacePermission(principal, "admin_requests.create");
  const input = proposeAdminActionSchema.parse(rawInput);
  const serializedPayload = JSON.stringify(input.action.payload);
  const existing = database.prepare(
    `SELECT * FROM workspace_admin_action_requests
     WHERE workspace_id = ? AND request_id = ?`,
  ).get(principal.workspaceId, input.requestId) as AdminRequestRow | undefined;
  if (existing) {
    if (
      existing.action_type !== input.action.actionType
      || existing.reason !== input.reason
      || existing.payload_json !== serializedPayload
    ) {
      throw new AdminActionRequestError(
        "CONFLICT",
        "같은 requestId가 다른 관리 요청에 이미 사용되었습니다.",
      );
    }
    return mapRequest(existing);
  }

  const context = proposalContext(database, principal.workspaceId, input.action);
  const now = new Date().toISOString();
  const id = randomUUID();
  const expiresAt = new Date(Date.parse(now) + REQUEST_LIFETIME_MS).toISOString();
  database.transaction(() => {
    database.prepare(
      `INSERT INTO workspace_admin_action_requests
       (id, workspace_id, request_id, action_type, status, reason, payload_json,
        precondition_json, preview_text, requested_by_agent_id, requested_by_label,
        requested_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      principal.workspaceId,
      input.requestId,
      input.action.actionType,
      input.reason,
      serializedPayload,
      JSON.stringify(context.precondition),
      context.preview,
      principal.membershipId,
      principal.displayName,
      now,
      expiresAt,
    );
    recordWorkspaceAuditEvent(database, {
      workspaceId: principal.workspaceId,
      action: "admin_request.created",
      actorType: "agent",
      actorAgentId: principal.agentId,
      actorLabel: principal.displayName,
      targetType: "admin_action_request",
      targetId: id,
      metadata: {
        actionType: input.action.actionType,
        requestId: input.requestId,
        reason: input.reason,
        requiresHumanApproval: true,
      },
      createdAt: now,
    });
  })();
  return mapRequest(getRequestRow(database, principal.workspaceId, id)!);
}

export function listAdminActionRequests(
  database: NyxDatabase,
  workspaceId: string,
  query: { status?: AdminActionStatus; limit?: number } = {},
) {
  expireRequests(database, workspaceId, new Date().toISOString());
  const conditions = ["workspace_id = ?"];
  const values: unknown[] = [workspaceId];
  if (query.status) {
    conditions.push("status = ?");
    values.push(query.status);
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 50)));
  values.push(limit);
  return (database.prepare(
    `SELECT * FROM workspace_admin_action_requests
     WHERE ${conditions.join(" AND ")}
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, requested_at DESC
     LIMIT ?`,
  ).all(...values) as AdminRequestRow[]).map(mapRequest);
}

function assertPrecondition(
  database: NyxDatabase,
  workspaceId: string,
  proposal: AdminActionProposal,
  expected: Record<string, unknown>,
) {
  if (proposal.actionType === "workspace.update") {
    const row = database.prepare("SELECT updated_at FROM workspaces WHERE id = ?")
      .get(workspaceId) as { updated_at: string } | undefined;
    if (!row || row.updated_at !== expected.updatedAt) {
      throw new AdminActionRequestError("CONFLICT", "워크스페이스 설정이 요청 후 변경되었습니다. 새 요청이 필요합니다.");
    }
  }
  if (proposal.actionType === "agent.update") {
    const row = database.prepare(
      "SELECT updated_at FROM workspace_agents WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL",
    ).get(workspaceId, proposal.payload.agentId) as { updated_at: string } | undefined;
    if (!row || row.updated_at !== expected.agentUpdatedAt) {
      throw new AdminActionRequestError("CONFLICT", "에이전트 정보가 요청 후 변경되었습니다. 새 요청이 필요합니다.");
    }
  }
  if (proposal.actionType === "credential.rotate" || proposal.actionType === "credential.revoke") {
    const credential = toActiveBoundCredential(
      activeBoundCredential(database, workspaceId, proposal.payload.credentialId),
    );
    if (
      !credential
      || credential.agentIdentityId !== expected.agentId
      || credential.membershipId !== expected.membershipId
      || credential.bindingId !== expected.bindingId
      || credential.credentialUpdatedAt !== expected.credentialUpdatedAt
    ) {
      throw new AdminActionRequestError(
        "CONFLICT",
        "연결 키의 활성 워크스페이스 연결이 요청 후 변경되거나 이미 해제되었습니다.",
      );
    }
  }
}

function executeApprovedAction(
  database: NyxDatabase,
  workspaceId: string,
  reviewer: ReviewUser,
  proposal: AdminActionProposal,
  requestId: string,
): { result: Record<string, unknown>; revealedToken?: string; tokenSummary?: ApiTokenSummary } {
  switch (proposal.actionType) {
    case "workspace.create": {
      const workspace = createWorkspace(database, reviewer, proposal.payload.name);
      return { result: { workspace } };
    }
    case "workspace.update": {
      requireHumanWorkspacePermission(database, workspaceId, reviewer.id, "workspace.update");
      const before = database.prepare(
        `SELECT name, trash_retention_days, trash_auto_purge
         FROM workspaces WHERE id = ?`,
      ).get(workspaceId) as {
        name: string;
        trash_retention_days: number;
        trash_auto_purge: number;
      };
      const after = {
        name: proposal.payload.name ?? before.name,
        trashRetentionDays: proposal.payload.trashRetentionDays ?? before.trash_retention_days,
        trashAutoPurge: proposal.payload.trashAutoPurge ?? Boolean(before.trash_auto_purge),
      };
      const now = new Date().toISOString();
      database.prepare(
        `UPDATE workspaces
         SET name = ?, trash_retention_days = ?, trash_auto_purge = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        after.name,
        after.trashRetentionDays,
        after.trashAutoPurge ? 1 : 0,
        now,
        workspaceId,
      );
      recordWorkspaceAuditEvent(database, {
        workspaceId,
        action: "workspace.updated",
        actorType: "human",
        actorUserId: reviewer.id,
        actorLabel: reviewer.name,
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { before, after, adminRequestId: requestId },
        createdAt: now,
      });
      return { result: { workspaceId, ...after } };
    }
    case "agent.connect": {
      const ownership = database.prepare(
        `SELECT owner_type, organization_id
         FROM workspace_ownership
         WHERE workspace_id = ?`,
      ).get(workspaceId) as {
        owner_type: "personal" | "organization";
        organization_id: string | null;
      } | undefined;
      if (!ownership) throw new AdminActionRequestError("NOT_FOUND", "워크스페이스 소유권을 찾을 수 없습니다.");
      const agent = ownership.owner_type === "organization"
        ? (() => {
          if (!ownership.organization_id) {
            throw new AdminActionRequestError("CONFLICT", "조직 워크스페이스 소유권이 올바르지 않습니다.");
          }
          return createOrganizationAgent(database, {
            organizationId: ownership.organization_id,
            userId: reviewer.id,
            actorLabel: reviewer.name,
            displayName: proposal.payload.name,
          });
        })()
        : createAccountAgent(database, {
          userId: reviewer.id,
          displayName: proposal.payload.name,
        });
      const membership = assignAgentToWorkspace(database, {
        workspaceId,
        userId: reviewer.id,
        agentId: agent.id,
        accessProfile: proposal.payload.accessProfile,
        ...(proposal.payload.capabilities ? { capabilities: proposal.payload.capabilities } : {}),
        rootDocumentId: proposal.payload.rootDocumentId ?? null,
      });
      const created = createAgentCredential(database, {
        userId: reviewer.id,
        agentId: agent.id,
        name: proposal.payload.credentialName ?? `${proposal.payload.name} 연결 키`,
        scopes: proposal.payload.scopes,
        defaultWorkspaceId: workspaceId,
        workspaceAllowlist: [workspaceId],
      });
      const tokenSummary = listWorkspaceTokens(database, workspaceId, reviewer.id)
        .find((token) => token.id === created.credential.id);
      if (!tokenSummary) {
        throw new AdminActionRequestError("CONFLICT", "생성된 연결 키의 명시적 워크스페이스 연결을 확인할 수 없습니다.");
      }
      return {
        result: {
          agentId: agent.id,
          membershipId: membership.membershipId,
          tokenSummary,
        },
        revealedToken: created.token,
        tokenSummary,
      };
    }
    case "agent.update": {
      const current = database.prepare(
        `SELECT root_document_id
         FROM workspace_agents
         WHERE workspace_id = ? AND agent_identity_id = ? AND revoked_at IS NULL`,
      ).get(workspaceId, proposal.payload.agentId) as { root_document_id: string | null } | undefined;
      if (!current) throw new AdminActionRequestError("NOT_FOUND", "에이전트를 찾을 수 없습니다.");
      const agent = updateAgentWorkspaceMembership(database, {
        workspaceId,
        userId: reviewer.id,
        agentId: proposal.payload.agentId,
        ...(proposal.payload.accessProfile ? { accessProfile: proposal.payload.accessProfile } : {}),
        ...(proposal.payload.capabilities ? { capabilities: proposal.payload.capabilities } : {}),
        rootDocumentId: proposal.payload.rootDocumentId === undefined
          ? current.root_document_id
          : proposal.payload.rootDocumentId,
        status: proposal.payload.status,
      });
      return { result: { agent } };
    }
    case "credential.rotate": {
      const credential = toActiveBoundCredential(
        activeBoundCredential(database, workspaceId, proposal.payload.credentialId),
      );
      if (!credential) {
        throw new AdminActionRequestError(
          "NOT_FOUND",
          "회전할 명시적 워크스페이스 연결 키를 찾을 수 없습니다.",
        );
      }
      // Legacy credentials may still have an empty serialized allowlist. Bindings are canonical,
      // so synchronize only this explicitly selected credential before the rotation helper clones it.
      synchronizeSelectedCredentialBindingsForRotation(database, credential.credentialId);
      const rotated = rotateAgentCredential(database, {
        userId: reviewer.id,
        agentId: credential.agentIdentityId,
        credentialId: credential.credentialId,
      });
      const summary = listWorkspaceTokens(database, workspaceId, reviewer.id)
        .find((token) => token.id === rotated.credential.id);
      if (!summary) throw new AdminActionRequestError("NOT_FOUND", "회전된 연결 키를 읽을 수 없습니다.");
      return {
        result: { tokenSummary: summary },
        revealedToken: rotated.token,
        tokenSummary: summary,
      };
    }
    case "credential.revoke": {
      const credential = toActiveBoundCredential(
        activeBoundCredential(database, workspaceId, proposal.payload.credentialId),
      );
      if (!credential) {
        throw new AdminActionRequestError(
          "NOT_FOUND",
          "폐기할 명시적 워크스페이스 연결 키를 찾을 수 없습니다.",
        );
      }
      revokeAgentCredential(database, {
        userId: reviewer.id,
        agentId: credential.agentIdentityId,
        credentialId: credential.credentialId,
      });
      return { result: { credentialId: credential.credentialId, revoked: true } };
    }
  }
}

export function reviewAdminAction(
  database: NyxDatabase,
  workspaceId: string,
  reviewer: ReviewUser,
  adminRequestId: string,
  rawInput: ReviewAdminActionInput,
): AdminActionReviewResult {
  requireHumanWorkspacePermission(database, workspaceId, reviewer.id, "admin_requests.review");
  const input = reviewAdminActionSchema.parse(rawInput);
  expireRequests(database, workspaceId, new Date().toISOString());
  const initial = getRequestRow(database, workspaceId, adminRequestId);
  if (!initial) throw new AdminActionRequestError("NOT_FOUND", "관리 요청을 찾을 수 없습니다.");
  if (initial.status === "expired") {
    throw new AdminActionRequestError("EXPIRED", "이 관리 요청은 만료되었습니다. 새 요청이 필요합니다.");
  }
  if (initial.status !== "pending") {
    throw new AdminActionRequestError("CONFLICT", "이미 처리된 관리 요청입니다.");
  }
  const now = new Date().toISOString();
  if (input.decision === "reject") {
    database.transaction(() => {
      database.prepare(
        `UPDATE workspace_admin_action_requests
         SET status = 'rejected', reviewed_by_user_id = ?, reviewed_by_label = ?,
             reviewed_at = ?, decision_note = ?
         WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
      ).run(reviewer.id, reviewer.name, now, input.note ?? null, workspaceId, adminRequestId);
      recordWorkspaceAuditEvent(database, {
        workspaceId,
        action: "admin_request.rejected",
        actorType: "human",
        actorUserId: reviewer.id,
        actorLabel: reviewer.name,
        targetType: "admin_action_request",
        targetId: adminRequestId,
        metadata: {
          actionType: initial.action_type,
          requestedByAgentId: initial.requested_by_agent_id,
          note: input.note ?? null,
        },
        createdAt: now,
      });
    })();
    return { request: mapRequest(getRequestRow(database, workspaceId, adminRequestId)!) };
  }

  try {
    return database.transaction(() => {
      const current = getRequestRow(database, workspaceId, adminRequestId);
      if (!current || current.status !== "pending") {
        throw new AdminActionRequestError("CONFLICT", "관리 요청 상태가 변경되었습니다.");
      }
      const proposal = adminActionProposalSchemaForRow(current);
      assertPrecondition(
        database,
        workspaceId,
        proposal,
        parseObject(current.precondition_json) ?? {},
      );
      const execution = executeApprovedAction(
        database,
        workspaceId,
        reviewer,
        proposal,
        adminRequestId,
      );
      database.prepare(
        `UPDATE workspace_admin_action_requests
         SET status = 'executed', reviewed_by_user_id = ?, reviewed_by_label = ?,
             reviewed_at = ?, decision_note = ?, execution_result_json = ?
         WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
      ).run(
        reviewer.id,
        reviewer.name,
        now,
        input.note ?? null,
        JSON.stringify(execution.result),
        workspaceId,
        adminRequestId,
      );
      recordWorkspaceAuditEvent(database, {
        workspaceId,
        action: "admin_request.executed",
        actorType: "human",
        actorUserId: reviewer.id,
        actorLabel: reviewer.name,
        targetType: "admin_action_request",
        targetId: adminRequestId,
        metadata: {
          actionType: current.action_type,
          requestedByAgentId: current.requested_by_agent_id,
          requestedByLabel: current.requested_by_label,
          result: execution.result,
        },
        createdAt: now,
      });
      return {
        request: mapRequest(getRequestRow(database, workspaceId, adminRequestId)!),
        ...(execution.revealedToken ? { revealedToken: execution.revealedToken } : {}),
        ...(execution.tokenSummary ? { tokenSummary: execution.tokenSummary } : {}),
      };
    })();
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "관리 작업을 실행하지 못했습니다.";
    database.transaction(() => {
      const changed = database.prepare(
        `UPDATE workspace_admin_action_requests
         SET status = 'failed', reviewed_by_user_id = ?, reviewed_by_label = ?,
             reviewed_at = ?, decision_note = ?, execution_result_json = ?
         WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
      ).run(
        reviewer.id,
        reviewer.name,
        failedAt,
        input.note ?? null,
        JSON.stringify({ error: message }),
        workspaceId,
        adminRequestId,
      );
      if (changed.changes === 1) {
        recordWorkspaceAuditEvent(database, {
          workspaceId,
          action: "admin_request.failed",
          outcome: "failed",
          actorType: "human",
          actorUserId: reviewer.id,
          actorLabel: reviewer.name,
          targetType: "admin_action_request",
          targetId: adminRequestId,
          metadata: { actionType: initial.action_type, error: message },
          createdAt: failedAt,
        });
      }
    })();
    if (error instanceof AdminActionRequestError) throw error;
    throw new AdminActionRequestError("CONFLICT", message);
  }
}

function adminActionProposalSchemaForRow(row: AdminRequestRow): AdminActionProposal {
  const payload = parseObject(row.payload_json);
  if (!payload) throw new AdminActionRequestError("INVALID_INPUT", "저장된 관리 요청을 해석할 수 없습니다.");
  return proposeAdminActionSchema.shape.action.parse({
    actionType: row.action_type,
    payload,
  });
}
