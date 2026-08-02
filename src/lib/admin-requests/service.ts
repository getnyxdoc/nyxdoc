import { randomUUID } from "node:crypto";
import {
  recordWorkspaceAuditEvent,
  requireAgentWorkspacePermission,
  requireHumanWorkspacePermission,
  type AgentWorkspacePrincipal,
} from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import { createWorkspace } from "@/lib/workspaces/service";
import {
  createWorkspaceToken,
  listWorkspaceTokens,
  revokeWorkspaceToken,
  updateWorkspaceAgent,
  type ApiTokenSummary,
} from "@/lib/tokens/service";
import { rotateAgentCredential } from "@/lib/agents/service";
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

function activeCredentialId(database: NyxDatabase, workspaceId: string, agentId: string) {
  return (database.prepare(
    `SELECT credential.id
     FROM workspace_agents membership
     JOIN agent_credentials credential ON credential.agent_id = membership.agent_identity_id
     WHERE membership.workspace_id = ? AND membership.id = ?
       AND credential.revoked_at IS NULL
     ORDER BY credential.created_at DESC, credential.id DESC LIMIT 1`,
  ).get(workspaceId, agentId) as { id: string } | undefined)?.id ?? null;
}

function globalAgentIdForMembership(database: NyxDatabase, workspaceId: string, membershipId: string) {
  return (database.prepare(
    `SELECT agent_identity_id FROM workspace_agents
     WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, membershipId) as { agent_identity_id: string } | undefined)?.agent_identity_id ?? null;
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
        preview: `‘${proposal.payload.name}’ 에이전트를 ${proposal.payload.role} 역할로 연결하고, ${rootTitle ? `‘${rootTitle}’ 이하` : "전체 워크스페이스"}에 한정된 키를 발급합니다. 키는 승인한 사람에게 한 번만 표시됩니다.`,
      };
    }
    case "agent.update": {
      const agent = database.prepare(
        `SELECT display_name, role, status, updated_at
         FROM workspace_agents WHERE workspace_id = ? AND id = ?`,
      ).get(workspaceId, proposal.payload.agentId) as {
        display_name: string;
        role: string;
        status: string;
        updated_at: string;
      } | undefined;
      if (!agent) throw new AdminActionRequestError("NOT_FOUND", "에이전트를 찾을 수 없습니다.");
      const changes = [
        proposal.payload.displayName !== undefined ? `이름 → ‘${proposal.payload.displayName}’` : null,
        proposal.payload.role !== undefined ? `역할 → ${proposal.payload.role}` : null,
        proposal.payload.status !== undefined ? `상태 → ${proposal.payload.status}` : null,
      ].filter(Boolean).join(", ");
      return {
        precondition: { agentUpdatedAt: agent.updated_at },
        preview: `‘${agent.display_name}’ 에이전트를 변경합니다: ${changes}.`,
      };
    }
    case "credential.rotate": {
      const agent = database.prepare(
        `SELECT display_name, status, updated_at
         FROM workspace_agents WHERE workspace_id = ? AND id = ?`,
      ).get(workspaceId, proposal.payload.agentId) as {
        display_name: string;
        status: string;
        updated_at: string;
      } | undefined;
      if (!agent) throw new AdminActionRequestError("NOT_FOUND", "에이전트를 찾을 수 없습니다.");
      if (agent.status !== "active") {
        throw new AdminActionRequestError("INVALID_INPUT", "비활성 에이전트의 키는 회전할 수 없습니다.");
      }
      return {
        precondition: {
          agentUpdatedAt: agent.updated_at,
          activeCredentialId: activeCredentialId(database, workspaceId, proposal.payload.agentId),
        },
        preview: `‘${agent.display_name}’의 가장 최근 활성 연결 키 하나를 전역으로 회전합니다. 이 키를 사용하던 모든 워크스페이스 연결에 영향이 있으며, 새 키는 승인한 사람에게 한 번만 표시됩니다.`,
      };
    }
    case "credential.revoke": {
      const credential = database.prepare(
        `SELECT credential.id, credential.agent_id,
                membership.id AS membership_id, agent.display_name
         FROM agent_credentials credential
         JOIN agents agent ON agent.id = credential.agent_id
         JOIN workspace_agents membership
           ON membership.agent_identity_id = credential.agent_id
          AND membership.workspace_id = ?
         WHERE credential.id = ? AND credential.revoked_at IS NULL`,
      ).get(workspaceId, proposal.payload.credentialId) as {
        id: string;
        agent_id: string;
        membership_id: string;
        display_name: string;
      } | undefined;
      if (!credential) throw new AdminActionRequestError("NOT_FOUND", "활성 연결 키를 찾을 수 없습니다.");
      return {
        precondition: {
          credentialId: credential.id,
          agentId: credential.agent_id,
          membershipId: credential.membership_id,
        },
        preview: `‘${credential.display_name}’의 연결 키를 전역으로 폐기합니다. 이 키를 사용하는 모든 워크스페이스 연결이 즉시 중단되며, 에이전트 신원과 과거 기록은 유지됩니다.`,
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
      principal.agentId,
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
  if (proposal.actionType === "agent.update" || proposal.actionType === "credential.rotate") {
    const row = database.prepare(
      "SELECT updated_at FROM workspace_agents WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, proposal.payload.agentId) as { updated_at: string } | undefined;
    if (!row || row.updated_at !== expected.agentUpdatedAt) {
      throw new AdminActionRequestError("CONFLICT", "에이전트 정보가 요청 후 변경되었습니다. 새 요청이 필요합니다.");
    }
  }
  if (proposal.actionType === "credential.rotate") {
    if (activeCredentialId(database, workspaceId, proposal.payload.agentId) !== expected.activeCredentialId) {
      throw new AdminActionRequestError("CONFLICT", "연결 키가 요청 후 변경되었습니다. 새 요청이 필요합니다.");
    }
  }
  if (proposal.actionType === "credential.revoke") {
    const row = database.prepare(
      `SELECT credential.agent_id
       FROM agent_credentials credential
       JOIN workspace_agents membership
         ON membership.agent_identity_id = credential.agent_id
        AND membership.workspace_id = ?
       WHERE credential.id = ? AND credential.revoked_at IS NULL`,
    ).get(workspaceId, proposal.payload.credentialId) as { agent_id: string } | undefined;
    if (!row || row.agent_id !== expected.agentId) {
      throw new AdminActionRequestError("CONFLICT", "연결 키가 요청 후 변경되거나 이미 폐기되었습니다.");
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
      const created = createWorkspaceToken(database, {
        workspaceId,
        userId: reviewer.id,
        name: proposal.payload.name,
        role: proposal.payload.role,
        scopes: proposal.payload.scopes,
        rootDocumentId: proposal.payload.rootDocumentId,
      });
      return {
        result: { tokenSummary: created.summary },
        revealedToken: created.token,
        tokenSummary: created.summary,
      };
    }
    case "agent.update": {
      const agent = updateWorkspaceAgent(database, {
        workspaceId,
        userId: reviewer.id,
        agentId: proposal.payload.agentId,
        displayName: proposal.payload.displayName,
        role: proposal.payload.role,
        status: proposal.payload.status,
      });
      return { result: { agent } };
    }
    case "credential.rotate": {
      const globalAgentId = globalAgentIdForMembership(database, workspaceId, proposal.payload.agentId);
      const credentialId = activeCredentialId(database, workspaceId, proposal.payload.agentId);
      if (!globalAgentId || !credentialId) {
        throw new AdminActionRequestError("NOT_FOUND", "회전할 활성 연결 키를 찾을 수 없습니다.");
      }
      const rotated = rotateAgentCredential(database, {
        userId: reviewer.id,
        agentId: globalAgentId,
        credentialId,
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
      revokeWorkspaceToken(database, {
        workspaceId,
        userId: reviewer.id,
        tokenId: proposal.payload.credentialId,
      });
      return { result: { credentialId: proposal.payload.credentialId, revoked: true } };
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
