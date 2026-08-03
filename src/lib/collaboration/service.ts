import { randomUUID } from "node:crypto";
import { assertWorkspaceAgentGrantCanAccessDocument } from "@/lib/agents/workspace-grant-boundary";
import type { WorkspaceAgentGrantId } from "@/lib/agents/identifiers";
import { recordWorkspaceAuditEvent } from "@/lib/authz/permissions";
import type {
  CollaborationActor,
  DocumentAssignment,
  SavedView,
  SavedViewQuery,
  SavedViewResult,
  WorkspaceAgentSummary,
} from "@/lib/collaboration/types";
import type { NyxDatabase } from "@/lib/db/client";
import { WORKSPACE_PERMISSIONS, type WorkspacePermission } from "@/lib/authz/permissions";
import { queryDocuments } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";

type SavedViewRow = {
  id: string;
  name: string;
  query_json: string;
  visibility: "private" | "workspace";
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
};

type AssignmentRow = {
  id: string;
  document_id: string;
  document_title: string;
  agent_id: string;
  agent_identity_id: string;
  agent_display_name: string;
  agent_avatar_media_id: string | null;
  assignment_type: DocumentAssignment["assignmentType"];
  status: DocumentAssignment["status"];
  note: string | null;
  assigned_by_user_id: string | null;
  assigned_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
};

function actorColumns(actor: CollaborationActor) {
  return actor.type === "human"
    ? { userId: actor.userId, agentId: null }
    : { userId: null, agentId: actor.agentId };
}

function mapSavedView(row: SavedViewRow): SavedView {
  let query: SavedViewQuery;
  try {
    query = JSON.parse(row.query_json) as SavedViewQuery;
  } catch {
    throw new DocumentServiceError("INVALID_INPUT", "저장된 보기의 조건을 읽을 수 없습니다.");
  }
  return {
    id: row.id,
    name: row.name,
    query,
    visibility: row.visibility,
    createdBy: row.created_by_user_id
      ? { type: "human", id: row.created_by_user_id }
      : { type: "agent", id: row.created_by_agent_id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignment(row: AssignmentRow): DocumentAssignment {
  return {
    id: row.id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    agentId: row.agent_id,
    agentIdentityId: row.agent_identity_id,
    agentDisplayName: row.agent_display_name,
    agentAvatarMediaId: row.agent_avatar_media_id,
    assignmentType: row.assignment_type,
    status: row.status,
    note: row.note,
    assignedBy: row.assigned_by_user_id
      ? { type: "human", id: row.assigned_by_user_id }
      : { type: "agent", id: row.assigned_by_agent_id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertVisibleSavedView(
  row: SavedViewRow | undefined,
  actor: CollaborationActor,
) {
  if (!row) throw new DocumentServiceError("NOT_FOUND", "저장된 보기를 찾을 수 없습니다.");
  if (
    row.visibility === "private"
    && !(
      (actor.type === "human" && row.created_by_user_id === actor.userId)
      || (actor.type === "agent" && row.created_by_agent_id === actor.agentId)
    )
  ) {
    throw new DocumentServiceError("NOT_FOUND", "저장된 보기를 찾을 수 없습니다.");
  }
  return row;
}

function assertSavedViewOwner(
  row: SavedViewRow,
  actor: CollaborationActor,
  allowWorkspaceAdmin = false,
) {
  const owns = actor.type === "human"
    ? row.created_by_user_id === actor.userId
    : row.created_by_agent_id === actor.agentId;
  if (!owns && !(allowWorkspaceAdmin && row.visibility === "workspace")) {
    throw new DocumentServiceError("FORBIDDEN", "이 저장된 보기는 만든 사용자만 변경할 수 있습니다.");
  }
}

export function listWorkspaceAgents(
  database: NyxDatabase,
  workspaceId: string,
  options: { includeDisabled?: boolean } = {},
): WorkspaceAgentSummary[] {
  const rows = database.prepare(
    `SELECT membership.id, membership.agent_identity_id, identity.display_name, identity.avatar_media_id,
            membership.access_profile, membership.capabilities_json, membership.status,
            membership.created_at, membership.updated_at,
            COUNT(CASE WHEN x.status = 'active' THEN 1 END) AS active_assignment_count
     FROM workspace_agents membership
     JOIN agents identity
       ON identity.id = membership.agent_identity_id
      AND identity.status = 'active'
      AND identity.deleted_at IS NULL
      AND identity.purged_at IS NULL
     LEFT JOIN agent_document_assignments x
       ON x.agent_id = membership.id AND x.workspace_id = membership.workspace_id
     WHERE membership.workspace_id = ?
       AND membership.revoked_at IS NULL
       AND (? = 1 OR membership.status = 'active')
     GROUP BY membership.id
     ORDER BY CASE membership.status WHEN 'active' THEN 0 ELSE 1 END,
              identity.display_name COLLATE NOCASE ASC, membership.id ASC`,
  ).all(workspaceId, options.includeDisabled ? 1 : 0) as Array<{
    id: string;
    agent_identity_id: string;
    display_name: string;
    avatar_media_id: string | null;
    access_profile: WorkspaceAgentSummary["accessProfile"];
    capabilities_json: string;
    status: WorkspaceAgentSummary["status"];
    created_at: string;
    updated_at: string;
    active_assignment_count: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    agentIdentityId: row.agent_identity_id,
    displayName: row.display_name,
    avatarMediaId: row.avatar_media_id,
    accessProfile: row.access_profile,
    capabilities: (() => {
      try {
        const parsed = JSON.parse(row.capabilities_json) as unknown;
        if (!Array.isArray(parsed)) return [];
        return WORKSPACE_PERMISSIONS.filter((permission) => parsed.includes(permission)) as WorkspacePermission[];
      } catch {
        return [];
      }
    })(),
    status: row.status,
    activeAssignmentCount: Number(row.active_assignment_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function listSavedViews(
  database: NyxDatabase,
  workspaceId: string,
  actor: CollaborationActor,
): SavedView[] {
  const owner = actorColumns(actor);
  const rows = database.prepare(
    `SELECT id, name, query_json, visibility, created_by_user_id, created_by_agent_id,
            created_at, updated_at
     FROM workspace_saved_views
     WHERE workspace_id = ?
       AND (visibility = 'workspace' OR created_by_user_id = ? OR created_by_agent_id = ?)
     ORDER BY name COLLATE NOCASE ASC, id ASC`,
  ).all(workspaceId, owner.userId, owner.agentId) as SavedViewRow[];
  return rows.map(mapSavedView);
}

export function createSavedView(
  database: NyxDatabase,
  workspaceId: string,
  actor: CollaborationActor,
  input: { name: string; query: SavedViewQuery; visibility: "private" | "workspace" },
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const owner = actorColumns(actor);
  database.transaction(() => {
    database.prepare(
      `INSERT INTO workspace_saved_views
       (id, workspace_id, name, query_json, visibility, created_by_user_id,
        created_by_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      workspaceId,
      input.name.trim(),
      JSON.stringify(input.query),
      input.visibility,
      owner.userId,
      owner.agentId,
      now,
      now,
    );
    recordWorkspaceAuditEvent(database, {
      workspaceId,
      action: "saved_view.created",
      actorType: actor.type,
      actorUserId: owner.userId,
      actorAgentId: owner.agentId,
      actorLabel: actor.label,
      targetType: "saved_view",
      targetId: id,
      metadata: { name: input.name.trim(), visibility: input.visibility, query: input.query },
      createdAt: now,
    });
  })();
  return getSavedView(database, workspaceId, id, actor);
}

export function getSavedView(
  database: NyxDatabase,
  workspaceId: string,
  viewId: string,
  actor: CollaborationActor,
) {
  const row = database.prepare(
    `SELECT id, name, query_json, visibility, created_by_user_id, created_by_agent_id,
            created_at, updated_at
     FROM workspace_saved_views WHERE id = ? AND workspace_id = ?`,
  ).get(viewId, workspaceId) as SavedViewRow | undefined;
  return mapSavedView(assertVisibleSavedView(row, actor));
}

export function updateSavedView(
  database: NyxDatabase,
  workspaceId: string,
  viewId: string,
  actor: CollaborationActor,
  input: { name?: string; query?: SavedViewQuery; visibility?: "private" | "workspace" },
  options: { allowWorkspaceAdmin?: boolean } = {},
) {
  const current = database.prepare(
    `SELECT id, name, query_json, visibility, created_by_user_id, created_by_agent_id,
            created_at, updated_at
     FROM workspace_saved_views WHERE id = ? AND workspace_id = ?`,
  ).get(viewId, workspaceId) as SavedViewRow | undefined;
  const row = assertVisibleSavedView(current, actor);
  assertSavedViewOwner(row, actor, options.allowWorkspaceAdmin);
  const now = new Date().toISOString();
  const owner = actorColumns(actor);
  database.transaction(() => {
    database.prepare(
      `UPDATE workspace_saved_views
       SET name = ?, query_json = ?, visibility = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      input.name?.trim() ?? row.name,
      input.query ? JSON.stringify(input.query) : row.query_json,
      input.visibility ?? row.visibility,
      now,
      viewId,
      workspaceId,
    );
    recordWorkspaceAuditEvent(database, {
      workspaceId,
      action: "saved_view.updated",
      actorType: actor.type,
      actorUserId: owner.userId,
      actorAgentId: owner.agentId,
      actorLabel: actor.label,
      targetType: "saved_view",
      targetId: viewId,
      metadata: input,
      createdAt: now,
    });
  })();
  return getSavedView(database, workspaceId, viewId, actor);
}

export function deleteSavedView(
  database: NyxDatabase,
  workspaceId: string,
  viewId: string,
  actor: CollaborationActor,
  options: { allowWorkspaceAdmin?: boolean } = {},
) {
  const current = database.prepare(
    `SELECT id, name, query_json, visibility, created_by_user_id, created_by_agent_id,
            created_at, updated_at
     FROM workspace_saved_views WHERE id = ? AND workspace_id = ?`,
  ).get(viewId, workspaceId) as SavedViewRow | undefined;
  const row = assertVisibleSavedView(current, actor);
  assertSavedViewOwner(row, actor, options.allowWorkspaceAdmin);
  const owner = actorColumns(actor);
  database.transaction(() => {
    database.prepare("DELETE FROM workspace_saved_views WHERE id = ? AND workspace_id = ?")
      .run(viewId, workspaceId);
    recordWorkspaceAuditEvent(database, {
      workspaceId,
      action: "saved_view.deleted",
      actorType: actor.type,
      actorUserId: owner.userId,
      actorAgentId: owner.agentId,
      actorLabel: actor.label,
      targetType: "saved_view",
      targetId: viewId,
      metadata: { name: row.name },
    });
  })();
}

/**
 * Reads assignment records without applying current grant or identity lifecycle
 * filters, so completed and revoked-agent assignments remain available as history.
 */
export function listAssignmentHistory(
  database: NyxDatabase,
  workspaceId: string,
  query: {
    documentId?: string;
    agentId?: string;
    status?: DocumentAssignment["status"];
    activeDocumentsOnly?: boolean;
  } = {},
): DocumentAssignment[] {
  const conditions = ["x.workspace_id = ?"];
  const values: unknown[] = [workspaceId];
  if (query.activeDocumentsOnly) {
    conditions.push("d.status = 'active'", "d.lifecycle_state = 'active'");
  }
  if (query.documentId) {
    conditions.push("x.document_id = ?");
    values.push(query.documentId);
  }
  if (query.agentId) {
    conditions.push("x.agent_id = ?");
    values.push(query.agentId);
  }
  if (query.status) {
    conditions.push("x.status = ?");
    values.push(query.status);
  }
  const rows = database.prepare(
    `SELECT x.id, x.document_id, d.title AS document_title, x.agent_id,
            a.agent_identity_id,
            a.display_name AS agent_display_name, a.avatar_media_id AS agent_avatar_media_id,
            x.assignment_type, x.status, x.note, x.assigned_by_user_id,
            x.assigned_by_agent_id, x.created_at, x.updated_at
     FROM agent_document_assignments x
     JOIN documents d ON d.id = x.document_id AND d.workspace_id = x.workspace_id
     JOIN workspace_agents a ON a.id = x.agent_id AND a.workspace_id = x.workspace_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY CASE x.status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
              x.updated_at DESC, x.id ASC`,
  ).all(...values) as AssignmentRow[];
  return rows.map(mapAssignment);
}

// Compatibility name for existing assignment-listing consumers.
export const listAssignments = listAssignmentHistory;

export function runSavedView(
  database: NyxDatabase,
  workspaceId: string,
  viewId: string,
  actor: CollaborationActor,
): SavedViewResult {
  const view = getSavedView(database, workspaceId, viewId, actor);
  const result = queryDocuments(database, workspaceId, { ...view.query, offset: 0 });
  const assignments = listAssignments(database, workspaceId, { status: "active" });
  const byDocument = new Map<string, DocumentAssignment[]>();
  for (const assignment of assignments) {
    const current = byDocument.get(assignment.documentId) ?? [];
    current.push(assignment);
    byDocument.set(assignment.documentId, current);
  }
  return {
    view,
    documents: result.documents.map((document) => ({
      ...document,
      assignments: byDocument.get(document.id) ?? [],
    })),
    total: result.total,
  };
}

export function assignDocument(
  database: NyxDatabase,
  workspaceId: string,
  actor: CollaborationActor,
  input: {
    documentId: string;
    /** WorkspaceAgentGrantId (`workspace_agents.id`), not AgentIdentityId. */
    agentId: WorkspaceAgentGrantId;
    assignmentType: DocumentAssignment["assignmentType"];
    note?: string | null;
  },
) {
  const document = database.prepare(
    `SELECT id FROM documents
     WHERE id = ? AND workspace_id = ?
       AND status = 'active' AND lifecycle_state = 'active'`,
  ).get(input.documentId, workspaceId);
  if (!document) throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
  assertWorkspaceAgentGrantCanAccessDocument(
    database,
    workspaceId,
    input.agentId,
    input.documentId,
  );
  const existing = database.prepare(
    `SELECT id FROM agent_document_assignments
     WHERE workspace_id = ? AND document_id = ? AND agent_id = ?
       AND assignment_type = ? AND status = 'active'`,
  ).get(workspaceId, input.documentId, input.agentId, input.assignmentType) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  const now = new Date().toISOString();
  const owner = actorColumns(actor);
  database.transaction(() => {
    if (existing) {
      database.prepare(
        `UPDATE agent_document_assignments SET note = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).run(input.note?.trim() || null, now, id, workspaceId);
    } else {
      database.prepare(
        `INSERT INTO agent_document_assignments
         (id, workspace_id, agent_id, document_id, assignment_type, status, note,
          assigned_by_user_id, assigned_by_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        workspaceId,
        input.agentId,
        input.documentId,
        input.assignmentType,
        input.note?.trim() || null,
        owner.userId,
        owner.agentId,
        now,
        now,
      );
    }
    recordWorkspaceAuditEvent(database, {
      workspaceId,
      action: existing ? "assignment.updated" : "assignment.created",
      actorType: actor.type,
      actorUserId: owner.userId,
      actorAgentId: owner.agentId,
      actorLabel: actor.label,
      targetType: "assignment",
      targetId: id,
      metadata: {
        documentId: input.documentId,
        agentId: input.agentId,
        assignmentType: input.assignmentType,
        grantsAccess: false,
      },
      createdAt: now,
    });
  })();
  return listAssignments(database, workspaceId).find((assignment) => assignment.id === id)!;
}

export function updateAssignment(
  database: NyxDatabase,
  workspaceId: string,
  assignmentId: string,
  actor: CollaborationActor,
  input: { status?: DocumentAssignment["status"]; note?: string | null },
) {
  const current = listAssignments(database, workspaceId).find((item) => item.id === assignmentId);
  if (!current) throw new DocumentServiceError("NOT_FOUND", "담당 지정을 찾을 수 없습니다.");
  const nextStatus = input.status ?? current.status;
  if (nextStatus === "active") {
    assertWorkspaceAgentGrantCanAccessDocument(
      database,
      workspaceId,
      current.agentId,
      current.documentId,
    );
  }
  const now = new Date().toISOString();
  const owner = actorColumns(actor);
  database.transaction(() => {
    database.prepare(
      `UPDATE agent_document_assignments SET status = ?, note = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(nextStatus, input.note === undefined ? current.note : input.note?.trim() || null, now, assignmentId, workspaceId);
    recordWorkspaceAuditEvent(database, {
      workspaceId,
      action: "assignment.updated",
      actorType: actor.type,
      actorUserId: owner.userId,
      actorAgentId: owner.agentId,
      actorLabel: actor.label,
      targetType: "assignment",
      targetId: assignmentId,
      metadata: input,
      createdAt: now,
    });
  })();
  return listAssignments(database, workspaceId).find((item) => item.id === assignmentId)!;
}
