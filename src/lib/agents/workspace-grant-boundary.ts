import { recordWorkspaceAuditEvent } from "@/lib/authz/permissions";
import type { AgentIdentityId, WorkspaceAgentGrantId } from "@/lib/agents/identifiers";
import type { NyxDatabase } from "@/lib/db/client";
import { DocumentServiceError } from "@/lib/documents/types";

/**
 * The authorization boundary attached to one workspace-local agent grant.
 * `id` is a WorkspaceAgentGrantId (`workspace_agents.id`); `agentIdentityId`
 * is the global AgentIdentityId (`agents.id`). Keeping both values here makes
 * it difficult for callers to accidentally apply a global identity as a
 * document-assignment target.
 */
export type WorkspaceAgentGrantBoundary = {
  id: WorkspaceAgentGrantId;
  agentIdentityId: AgentIdentityId;
  workspaceId: string;
  status: "active" | "disabled";
  scopeMode: "workspace" | "document_tree";
  rootDocumentId: string | null;
};

export type AssignmentBoundaryAuditActor = {
  type: "system" | "human" | "agent";
  label: string;
  userId?: string | null;
  agentId?: string | null;
};

function boundaryFromRow(row: {
  id: string;
  agent_identity_id: string;
  workspace_id: string;
  status: "active" | "disabled";
  scope_mode: "workspace" | "document_tree";
  root_document_id: string | null;
}): WorkspaceAgentGrantBoundary {
  return {
    id: row.id,
    agentIdentityId: row.agent_identity_id,
    workspaceId: row.workspace_id,
    status: row.status,
    scopeMode: row.scope_mode,
    rootDocumentId: row.root_document_id,
  };
}

/** Returns only an active, non-revoked grant whose global agent is still active. */
export function getActiveWorkspaceAgentGrant(
  database: NyxDatabase,
  workspaceId: string,
  workspaceAgentGrantId: WorkspaceAgentGrantId,
): WorkspaceAgentGrantBoundary | null {
  const row = database.prepare(
    `SELECT membership.id, membership.agent_identity_id, membership.workspace_id,
            membership.status, membership.scope_mode, membership.root_document_id
     FROM workspace_agents membership
     JOIN agents identity
       ON identity.id = membership.agent_identity_id
      AND identity.status = 'active'
      AND identity.deleted_at IS NULL
      AND identity.purged_at IS NULL
     JOIN workspaces workspace
       ON workspace.id = membership.workspace_id
      AND workspace.lifecycle_state = 'active'
     WHERE membership.id = ?
       AND membership.workspace_id = ?
       AND membership.status = 'active'
       AND membership.revoked_at IS NULL`,
  ).get(workspaceAgentGrantId, workspaceId) as Parameters<typeof boundaryFromRow>[0] | undefined;
  return row ? boundaryFromRow(row) : null;
}

function activeDocumentExists(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
) {
  return Boolean(database.prepare(
    `SELECT 1 FROM documents
     WHERE id = ? AND workspace_id = ?
       AND status = 'active' AND lifecycle_state = 'active'`,
  ).get(documentId, workspaceId));
}

/**
 * Checks the document boundary of one already-resolved workspace grant. This
 * is intentionally separate from capability checks: an assignment must never
 * be created merely because an agent has a broad role.
 */
export function workspaceAgentGrantCanAccessDocument(
  database: NyxDatabase,
  grant: WorkspaceAgentGrantBoundary,
  documentId: string,
) {
  if (grant.status !== "active" || !activeDocumentExists(database, grant.workspaceId, documentId)) {
    return false;
  }
  if (grant.scopeMode === "workspace") return true;
  if (!grant.rootDocumentId) return false;
  return Boolean(database.prepare(
    `WITH RECURSIVE ancestors(id, parent_document_id) AS (
       SELECT id, parent_document_id
       FROM documents
       WHERE id = ? AND workspace_id = ?
         AND status = 'active' AND lifecycle_state = 'active'
       UNION ALL
       SELECT document.id, document.parent_document_id
       FROM documents document
       JOIN ancestors ancestor ON ancestor.parent_document_id = document.id
       WHERE document.workspace_id = ?
         AND document.status = 'active' AND document.lifecycle_state = 'active'
     )
     SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`,
  ).get(documentId, grant.workspaceId, grant.workspaceId, grant.rootDocumentId));
}

/**
 * Enforces that an assignment target is both an active workspace grant and is
 * permitted to reach the target document. The details are intentionally
 * machine-readable so REST and MCP clients can surface a precise denial.
 */
export function assertWorkspaceAgentGrantCanAccessDocument(
  database: NyxDatabase,
  workspaceId: string,
  workspaceAgentGrantId: WorkspaceAgentGrantId,
  documentId: string,
) {
  const grant = getActiveWorkspaceAgentGrant(database, workspaceId, workspaceAgentGrantId);
  if (!grant) {
    throw new DocumentServiceError("NOT_FOUND", "활성 에이전트를 찾을 수 없습니다.", {
      reason: "ASSIGNEE_GRANT_NOT_ACTIVE",
      field: "agentId",
      workspaceAgentGrantId,
      documentId,
    });
  }
  if (!workspaceAgentGrantCanAccessDocument(database, grant, documentId)) {
    throw new DocumentServiceError("FORBIDDEN", "담당 에이전트의 문서 범위 밖입니다.", {
      reason: "ASSIGNEE_DOCUMENT_SCOPE_DENIED",
      field: "agentId",
      workspaceAgentGrantId: grant.id,
      agentIdentityId: grant.agentIdentityId,
      documentId,
      scopeMode: grant.scopeMode,
      rootDocumentId: grant.rootDocumentId,
    });
  }
  return grant;
}

/**
 * Cancels active assignments that no longer fit a grant boundary. Callers run
 * this inside their existing write transaction, so a narrowed grant or moved
 * document cannot commit while leaving an out-of-bound active assignment.
 */
export function cancelAssignmentsOutsideWorkspaceAgentGrantBoundary(
  database: NyxDatabase,
  input: {
    grant: WorkspaceAgentGrantBoundary;
    actor: AssignmentBoundaryAuditActor;
    reason: "grant_scope_changed" | "grant_disabled" | "document_moved";
    now: string;
  },
) {
  const assignments = database.prepare(
    `SELECT id, document_id
     FROM agent_document_assignments
     WHERE workspace_id = ? AND agent_id = ? AND status = 'active'`,
  ).all(input.grant.workspaceId, input.grant.id) as Array<{ id: string; document_id: string }>;
  let cancelled = 0;
  for (const assignment of assignments) {
    if (workspaceAgentGrantCanAccessDocument(database, input.grant, assignment.document_id)) continue;
    const result = database.prepare(
      `UPDATE agent_document_assignments
       SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND status = 'active'`,
    ).run(input.now, assignment.id);
    if (result.changes !== 1) continue;
    cancelled += 1;
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.grant.workspaceId,
      action: "assignment.cancelled_outside_agent_boundary",
      actorType: input.actor.type,
      actorUserId: input.actor.userId ?? null,
      actorAgentId: input.actor.agentId ?? null,
      actorLabel: input.actor.label,
      targetType: "assignment",
      targetId: assignment.id,
      metadata: {
        reason: input.reason,
        documentId: assignment.document_id,
        workspaceAgentGrantId: input.grant.id,
        agentIdentityId: input.grant.agentIdentityId,
        scopeMode: input.grant.scopeMode,
        rootDocumentId: input.grant.rootDocumentId,
      },
      createdAt: input.now,
    });
  }
  return cancelled;
}

/** Rechecks every active document-tree grant after a document tree move. */
export function cancelAssignmentsOutsideWorkspaceAgentBoundaries(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    actor: AssignmentBoundaryAuditActor;
    reason: "document_moved";
    now: string;
  },
) {
  const grants = database.prepare(
    `SELECT id, agent_identity_id, workspace_id, status, scope_mode, root_document_id
     FROM workspace_agents
     WHERE workspace_id = ?
       AND status = 'active'
       AND revoked_at IS NULL
       AND scope_mode = 'document_tree'`,
  ).all(input.workspaceId) as Parameters<typeof boundaryFromRow>[0][];
  return grants.reduce((count, row) => count + cancelAssignmentsOutsideWorkspaceAgentGrantBoundary(database, {
    grant: boundaryFromRow(row),
    actor: input.actor,
    reason: input.reason,
    now: input.now,
  }), 0);
}
