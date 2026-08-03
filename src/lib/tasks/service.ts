import { randomUUID } from "node:crypto";
import { recordWorkspaceAuditEvent } from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import {
  prepareAgentWrite,
  recordAgentWrite,
  replayAgentWrite,
} from "@/lib/documents/idempotency";
import type { DocumentActor } from "@/lib/documents/types";
import type {
  DocumentTask,
  DocumentTaskAttachment,
  DocumentTaskAttachmentField,
  DocumentTaskAttachmentInput,
  DocumentTaskEvent,
  DocumentTaskEventType,
  DocumentTaskPriority,
  DocumentTaskStatus,
} from "@/lib/tasks/types";
import { TaskServiceError } from "@/lib/tasks/types";

type TaskRow = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  status: DocumentTaskStatus;
  priority: DocumentTaskPriority;
  progress: number;
  target_document_id: string | null;
  target_document_title: string | null;
  assigned_agent_id: string | null;
  assigned_agent_display_name: string | null;
  assigned_agent_avatar_media_id: string | null;
  requires_review: number;
  blocker: string | null;
  result_summary: string | null;
  result_document_id: string | null;
  result_document_title: string | null;
  result_revision_id: string | null;
  result_revision_number: number | null;
  created_by_type: "human" | "agent";
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_label: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
};

type TaskEventRow = {
  cursor: number;
  id: string;
  task_id: string;
  event_type: DocumentTaskEventType;
  from_status: DocumentTaskStatus | null;
  to_status: DocumentTaskStatus | null;
  message: string | null;
  actor_type: "human" | "agent" | "system";
  actor_user_id: string | null;
  actor_agent_id: string | null;
  actor_label: string;
  metadata_json: string;
  created_at: string;
};

type TaskAttachmentRow = {
  id: string;
  task_id: string;
  media_id: string;
  field: DocumentTaskAttachmentField;
  position: number;
  mime_type: string;
  byte_size: number;
  original_filename: string | null;
  created_at: string;
};

const TASK_SELECT = `
  SELECT task.id, task.workspace_id,
         workspace.name AS workspace_name, workspace.slug AS workspace_slug,
         task.title, task.description,
         task.acceptance_criteria, task.status, task.priority, task.progress,
         task.target_document_id, target.title AS target_document_title,
         task.assigned_agent_id,
         assigned_identity.display_name AS assigned_agent_display_name,
         assigned_identity.avatar_media_id AS assigned_agent_avatar_media_id,
         task.requires_review, task.blocker, task.result_summary,
         task.result_document_id, result.title AS result_document_title,
         task.result_revision_id, result_revision.revision_number AS result_revision_number,
         task.created_by_type, task.created_by_user_id, task.created_by_agent_id,
         task.created_by_label, task.started_at, task.completed_at, task.cancelled_at,
         task.created_at, task.updated_at, task.version
  FROM document_tasks task
  JOIN workspaces workspace ON workspace.id = task.workspace_id
  LEFT JOIN documents target ON target.id = task.target_document_id
  LEFT JOIN workspace_agents assigned_membership ON assigned_membership.id = task.assigned_agent_id
  LEFT JOIN agents assigned_identity ON assigned_identity.id = assigned_membership.agent_identity_id
  LEFT JOIN documents result ON result.id = task.result_document_id
  LEFT JOIN document_revisions result_revision ON result_revision.id = task.result_revision_id
`;

const TASK_STATUS_ORDER = `
  CASE task.status
    WHEN 'in_progress' THEN 0
    WHEN 'blocked' THEN 1
    WHEN 'review' THEN 2
    WHEN 'ready' THEN 3
    WHEN 'completed' THEN 4
    ELSE 5
  END
`;

const TASK_PRIORITY_ORDER = `
  CASE task.priority
    WHEN 'urgent' THEN 0
    WHEN 'high' THEN 1
    WHEN 'normal' THEN 2
    ELSE 3
  END
`;

function normalizedText(value: string, label: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TaskServiceError(
      "INVALID_INPUT",
      `${label}은 1자 이상 ${maxLength.toLocaleString("ko-KR")}자 이하여야 합니다.`,
    );
  }
  return normalized;
}

function optionalText(value: string | null | undefined, maxLength: number) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TaskServiceError(
      "INVALID_INPUT",
      `입력 내용은 ${maxLength.toLocaleString("ko-KR")}자 이하여야 합니다.`,
    );
  }
  return normalized || null;
}

function actorMembershipId(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
) {
  if (actor.type !== "agent") return null;
  const row = actor.tokenId
    ? database.prepare(
      `SELECT membership.id
       FROM workspace_agents membership
       JOIN agent_credentials credential
         ON credential.id = ?
        AND credential.agent_id = membership.agent_identity_id
        AND credential.revoked_at IS NULL
       JOIN agent_credential_grant_bindings binding
         ON binding.credential_id = credential.id
        AND binding.grant_id = membership.id
        AND binding.status = 'active'
        AND binding.revoked_at IS NULL
       WHERE membership.workspace_id = ?
         AND membership.status = 'active' AND membership.revoked_at IS NULL`,
    ).get(actor.tokenId, workspaceId) as { id: string } | undefined
    : database.prepare(
      `SELECT id
       FROM workspace_agents
       WHERE workspace_id = ?
         AND (agent_identity_id = ? OR id = ?)
         AND status = 'active' AND revoked_at IS NULL`,
    ).get(workspaceId, actor.principalId ?? "", actor.principalId ?? "") as { id: string } | undefined;
  if (!row) {
    throw new TaskServiceError("FORBIDDEN", "현재 워크스페이스의 활성 에이전트 연결을 찾을 수 없습니다.");
  }
  return row.id;
}

function actorColumns(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
) {
  const agentId = actorMembershipId(database, workspaceId, actor);
  return {
    userId: actor.type === "human" ? actor.userId : null,
    agentId,
  };
}

function requireActiveDocument(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string | null | undefined,
  label: string,
) {
  if (!documentId) return null;
  const row = database.prepare(
    `SELECT id, title FROM documents
     WHERE id = ? AND workspace_id = ?
       AND status = 'active' AND lifecycle_state = 'active'`,
  ).get(documentId, workspaceId) as { id: string; title: string } | undefined;
  if (!row) throw new TaskServiceError("NOT_FOUND", `${label} 문서를 찾을 수 없습니다.`);
  return row;
}

function requireActiveAgent(
  database: NyxDatabase,
  workspaceId: string,
  agentId: string | null | undefined,
) {
  if (!agentId) return null;
  const row = database.prepare(
    `SELECT membership.id
     FROM workspace_agents membership
     JOIN agents identity ON identity.id = membership.agent_identity_id
     WHERE membership.id = ? AND membership.workspace_id = ?
       AND membership.status = 'active'
       AND identity.status = 'active'
       AND identity.deleted_at IS NULL
       AND identity.purged_at IS NULL`,
  ).get(agentId, workspaceId) as { id: string } | undefined;
  if (!row) throw new TaskServiceError("NOT_FOUND", "활성 에이전트를 찾을 수 없습니다.");
  return row;
}

function documentPaths(database: NyxDatabase, workspaceId: string) {
  const rows = database.prepare(
    `SELECT id, title, parent_document_id
     FROM documents WHERE workspace_id = ?`,
  ).all(workspaceId) as Array<{
    id: string;
    title: string;
    parent_document_id: string | null;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return new Map(rows.map((row) => {
    const path: Array<{ id: string; title: string }> = [];
    const visited = new Set<string>();
    let current: typeof row | undefined = row;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift({ id: current.id, title: current.title });
      current = current.parent_document_id ? byId.get(current.parent_document_id) : undefined;
    }
    return [row.id, path] as const;
  }));
}

function taskAttachments(
  database: NyxDatabase,
  workspaceId: string,
  taskIds: string[],
) {
  const result = new Map<string, DocumentTaskAttachment[]>();
  if (taskIds.length === 0) return result;
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT attachment.id, attachment.task_id, attachment.media_id,
            attachment.field, attachment.position, attachment.created_at,
            media.mime_type, media.byte_size, media.original_filename
     FROM document_task_attachments attachment
     JOIN media_assets media ON media.id = attachment.media_id
     WHERE attachment.workspace_id = ?
       AND attachment.task_id IN (${placeholders})
     ORDER BY attachment.task_id, attachment.field, attachment.position, attachment.id`,
  ).all(workspaceId, ...taskIds) as TaskAttachmentRow[];
  for (const row of rows) {
    const attachment: DocumentTaskAttachment = {
      id: row.id,
      taskId: row.task_id,
      mediaId: row.media_id,
      field: row.field,
      position: Number(row.position),
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      originalFilename: row.original_filename,
      url: `/api/media/${row.media_id}`,
      createdAt: row.created_at,
    };
    const entries = result.get(row.task_id) ?? [];
    entries.push(attachment);
    result.set(row.task_id, entries);
  }
  return result;
}

function normalizeTaskAttachments(
  database: NyxDatabase,
  workspaceId: string,
  attachments: DocumentTaskAttachmentInput[] | undefined,
) {
  if (attachments === undefined) return undefined;
  if (attachments.length > 20) {
    throw new TaskServiceError("INVALID_INPUT", "Agent To-do에는 이미지를 최대 20개까지 첨부할 수 있습니다.");
  }
  const seen = new Set<string>();
  const normalized = attachments.map((attachment) => {
    const key = `${attachment.field}:${attachment.mediaId}`;
    if (seen.has(key)) {
      throw new TaskServiceError("INVALID_INPUT", "같은 이미지를 같은 입력란에 중복 첨부할 수 없습니다.");
    }
    seen.add(key);
    const media = database.prepare(
      "SELECT id FROM media_assets WHERE id = ? AND workspace_id = ?",
    ).get(attachment.mediaId, workspaceId) as { id: string } | undefined;
    if (!media) {
      throw new TaskServiceError("NOT_FOUND", "첨부할 이미지를 현재 워크스페이스에서 찾을 수 없습니다.");
    }
    return { mediaId: media.id, field: attachment.field };
  });
  return normalized;
}

function replaceTaskAttachments(
  database: NyxDatabase,
  workspaceId: string,
  taskId: string,
  attachments: DocumentTaskAttachmentInput[],
  createdAt: string,
) {
  database.prepare("DELETE FROM document_task_attachments WHERE task_id = ?")
    .run(taskId);
  const insert = database.prepare(
    `INSERT INTO document_task_attachments
     (id, workspace_id, task_id, media_id, field, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const positions = new Map<DocumentTaskAttachmentField, number>();
  for (const attachment of attachments) {
    const position = positions.get(attachment.field) ?? 0;
    insert.run(
      randomUUID(),
      workspaceId,
      taskId,
      attachment.mediaId,
      attachment.field,
      position,
      createdAt,
    );
    positions.set(attachment.field, position + 1);
  }
}

function mapTask(
  row: TaskRow,
  paths: Map<string, Array<{ id: string; title: string }>>,
  attachments: Map<string, DocumentTaskAttachment[]>,
): DocumentTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspaceSlug: row.workspace_slug,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    attachments: attachments.get(row.id) ?? [],
    status: row.status,
    priority: row.priority,
    progress: Number(row.progress),
    targetDocumentId: row.target_document_id,
    targetDocumentTitle: row.target_document_title,
    targetDocumentPath: row.target_document_id ? paths.get(row.target_document_id) ?? [] : [],
    assignedAgentId: row.assigned_agent_id,
    assignedAgentDisplayName: row.assigned_agent_display_name,
    assignedAgentAvatarMediaId: row.assigned_agent_avatar_media_id,
    requiresReview: Boolean(row.requires_review),
    blocker: row.blocker,
    resultSummary: row.result_summary,
    resultDocumentId: row.result_document_id,
    resultDocumentTitle: row.result_document_title,
    resultRevisionId: row.result_revision_id,
    resultRevisionNumber: row.result_revision_number === null
      ? null
      : Number(row.result_revision_number),
    createdBy: {
      type: row.created_by_type,
      id: row.created_by_type === "human" ? row.created_by_user_id : row.created_by_agent_id,
      label: row.created_by_label,
    },
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
  };
}

function fetchTaskRow(database: NyxDatabase, workspaceId: string, taskId: string) {
  return database.prepare(
    `${TASK_SELECT}
     WHERE task.workspace_id = ? AND task.id = ?`,
  ).get(workspaceId, taskId) as TaskRow | undefined;
}

function requireTaskRow(database: NyxDatabase, workspaceId: string, taskId: string) {
  const row = fetchTaskRow(database, workspaceId, taskId);
  if (!row) throw new TaskServiceError("NOT_FOUND", "Agent To-do를 찾을 수 없습니다.");
  return row;
}

function requireExpectedVersion(row: TaskRow, expectedVersion: number) {
  if (row.version !== expectedVersion) {
    throw new TaskServiceError(
      "CONFLICT",
      "Agent To-do가 먼저 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도해주세요.",
      { expectedVersion, currentVersion: Number(row.version) },
    );
  }
}

function requireTaskUpdate(
  result: { changes: number | bigint },
  expectedVersion: number,
) {
  if (Number(result.changes) !== 1) {
    throw new TaskServiceError(
      "CONFLICT",
      "Agent To-do가 먼저 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도해주세요.",
      { expectedVersion },
    );
  }
}

function parseMetadata(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return { unreadable: true };
  }
}

function recordTaskEvent(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    taskId: string;
    eventType: DocumentTaskEventType;
    fromStatus?: DocumentTaskStatus | null;
    toStatus?: DocumentTaskStatus | null;
    message?: string | null;
    actor: DocumentActor;
    actorAgentId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt: string;
  },
) {
  database.prepare(
    `INSERT INTO document_task_events
     (id, workspace_id, task_id, event_type, from_status, to_status, message,
      actor_type, actor_user_id, actor_agent_id, actor_label, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.workspaceId,
    input.taskId,
    input.eventType,
    input.fromStatus ?? null,
    input.toStatus ?? null,
    input.message?.trim() || null,
    input.actor.type,
    input.actor.type === "human" ? input.actor.userId : null,
    input.actorAgentId ?? null,
    input.actor.label,
    JSON.stringify(input.metadata ?? {}),
    input.createdAt,
  );
}

function auditTask(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    taskId: string;
    action: string;
    actor: DocumentActor;
    actorAgentId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt: string;
  },
) {
  recordWorkspaceAuditEvent(database, {
    workspaceId: input.workspaceId,
    action: input.action,
    actorType: input.actor.type,
    actorUserId: input.actor.type === "human" ? input.actor.userId : null,
    actorAgentId: input.actorAgentId ?? null,
    actorLabel: input.actor.label,
    targetType: "document_task",
    targetId: input.taskId,
    metadata: input.metadata,
    createdAt: input.createdAt,
  });
}

function statusEventType(
  fromStatus: DocumentTaskStatus,
  toStatus: DocumentTaskStatus,
): DocumentTaskEventType {
  if (toStatus === "blocked") return "blocked";
  if (toStatus === "review") return "submitted";
  if (toStatus === "completed") return "completed";
  if (toStatus === "cancelled") return "cancelled";
  if (fromStatus === "completed" || fromStatus === "cancelled") return "reopened";
  return "updated";
}

const ALLOWED_TRANSITIONS: Record<DocumentTaskStatus, ReadonlySet<DocumentTaskStatus>> = {
  ready: new Set(["ready", "in_progress", "completed", "cancelled"]),
  in_progress: new Set(["in_progress", "ready", "blocked", "review", "completed", "cancelled"]),
  blocked: new Set(["blocked", "ready", "in_progress", "completed", "cancelled"]),
  review: new Set(["review", "in_progress", "completed", "cancelled"]),
  completed: new Set(["completed", "ready"]),
  cancelled: new Set(["cancelled", "ready"]),
};

function assertTransition(fromStatus: DocumentTaskStatus, toStatus: DocumentTaskStatus) {
  if (!ALLOWED_TRANSITIONS[fromStatus].has(toStatus)) {
    throw new TaskServiceError(
      "CONFLICT",
      `${fromStatus} 상태에서 ${toStatus} 상태로 바로 변경할 수 없습니다.`,
    );
  }
}

export function listDocumentTasks(
  database: NyxDatabase,
  workspaceId: string,
  query: {
    status?: DocumentTaskStatus;
    priority?: DocumentTaskPriority;
    assignedAgentId?: string | null;
    targetDocumentId?: string | null;
    openOnly?: boolean;
    availableToAgentId?: string;
    offset?: number;
    limit?: number;
  } = {},
) {
  const conditions = ["task.workspace_id = ?"];
  const values: unknown[] = [workspaceId];
  if (query.status) {
    conditions.push("task.status = ?");
    values.push(query.status);
  }
  if (query.priority) {
    conditions.push("task.priority = ?");
    values.push(query.priority);
  }
  if (query.assignedAgentId !== undefined) {
    if (query.assignedAgentId === null) {
      conditions.push("task.assigned_agent_id IS NULL");
    } else {
      conditions.push("task.assigned_agent_id = ?");
      values.push(query.assignedAgentId);
    }
  }
  if (query.targetDocumentId !== undefined) {
    if (query.targetDocumentId === null) {
      conditions.push("task.target_document_id IS NULL");
    } else {
      conditions.push("task.target_document_id = ?");
      values.push(query.targetDocumentId);
    }
  }
  if (query.openOnly) {
    conditions.push("task.status NOT IN ('completed', 'cancelled')");
  }
  if (query.availableToAgentId) {
    conditions.push("(task.assigned_agent_id IS NULL OR task.assigned_agent_id = ?)");
    values.push(query.availableToAgentId);
  }
  const total = database.prepare(
    `SELECT COUNT(*) AS count FROM document_tasks task WHERE ${conditions.join(" AND ")}`,
  ).get(...values) as { count: number };
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const limit = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 100)));
  const rows = database.prepare(
    `${TASK_SELECT}
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${TASK_STATUS_ORDER}, ${TASK_PRIORITY_ORDER},
              task.updated_at DESC, task.id ASC
     LIMIT ? OFFSET ?`,
  ).all(...values, limit, offset) as TaskRow[];
  const paths = documentPaths(database, workspaceId);
  const attachments = taskAttachments(database, workspaceId, rows.map((row) => row.id));
  const tasks = rows.map((row) => mapTask(row, paths, attachments));
  return {
    tasks,
    total: Number(total.count),
    nextOffset: offset + tasks.length < Number(total.count) ? offset + tasks.length : null,
  };
}

export function getDocumentTask(
  database: NyxDatabase,
  workspaceId: string,
  taskId: string,
) {
  return mapTask(
    requireTaskRow(database, workspaceId, taskId),
    documentPaths(database, workspaceId),
    taskAttachments(database, workspaceId, [taskId]),
  );
}

export function getDocumentTaskById(
  database: NyxDatabase,
  taskId: string,
) {
  const row = database.prepare(
    `${TASK_SELECT}
     WHERE task.id = ?`,
  ).get(taskId) as TaskRow | undefined;
  if (!row) throw new TaskServiceError("NOT_FOUND", "Agent To-do를 찾을 수 없습니다.");
  return mapTask(
    row,
    documentPaths(database, row.workspace_id),
    taskAttachments(database, row.workspace_id, [taskId]),
  );
}

export function listDocumentTaskEvents(
  database: NyxDatabase,
  workspaceId: string,
  taskId: string,
  limit = 100,
): DocumentTaskEvent[] {
  requireTaskRow(database, workspaceId, taskId);
  const rows = database.prepare(
    `SELECT cursor, id, task_id, event_type, from_status, to_status, message,
            actor_type, actor_user_id, actor_agent_id, actor_label, metadata_json, created_at
     FROM document_task_events
     WHERE workspace_id = ? AND task_id = ?
     ORDER BY cursor DESC
     LIMIT ?`,
  ).all(workspaceId, taskId, Math.max(1, Math.min(200, Math.trunc(limit)))) as TaskEventRow[];
  return rows.map((row) => ({
    cursor: Number(row.cursor),
    id: row.id,
    taskId: row.task_id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    message: row.message,
    actor: {
      type: row.actor_type,
      id: row.actor_type === "human" ? row.actor_user_id : row.actor_agent_id,
      label: row.actor_label,
    },
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  }));
}

export function createDocumentTask(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
  input: {
    title: string;
    description?: string;
    acceptanceCriteria?: string;
    attachments?: DocumentTaskAttachmentInput[];
    priority?: DocumentTaskPriority;
    targetDocumentId?: string | null;
    assignedAgentId?: string | null;
    requiresReview?: boolean;
    requestId?: string;
  },
) {
  const payload = {
    workspaceId,
    title: input.title,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
    attachments: input.attachments ?? [],
    priority: input.priority ?? "normal",
    targetDocumentId: input.targetDocumentId ?? null,
    assignedAgentId: input.assignedAgentId ?? null,
    requiresReview: input.requiresReview ?? true,
  };
  const idempotency = prepareAgentWrite(actor, "create_document_task", input.requestId, payload);
  const replayed = replayAgentWrite<DocumentTask>(database, idempotency);
  if (replayed) return replayed;
  const title = normalizedText(input.title, "작업 제목", 200);
  const description = optionalText(input.description ?? "", 10_000) ?? "";
  const acceptanceCriteria = optionalText(input.acceptanceCriteria ?? "", 5_000) ?? "";
  const attachments = normalizeTaskAttachments(database, workspaceId, input.attachments ?? []) ?? [];
  const target = requireActiveDocument(database, workspaceId, input.targetDocumentId, "대상");
  const assigned = requireActiveAgent(database, workspaceId, input.assignedAgentId);
  const owner = actorColumns(database, workspaceId, actor);
  const id = randomUUID();
  const now = new Date().toISOString();
  let result!: DocumentTask;
  database.transaction(() => {
    database.prepare(
      `INSERT INTO document_tasks
       (id, workspace_id, title, description, acceptance_criteria, status, priority,
        progress, target_document_id, assigned_agent_id, requires_review,
        created_by_type, created_by_user_id, created_by_agent_id, created_by_label,
        created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      id,
      workspaceId,
      title,
      description,
      acceptanceCriteria,
      input.priority ?? "normal",
      target?.id ?? null,
      assigned?.id ?? null,
      input.requiresReview === false ? 0 : 1,
      actor.type,
      owner.userId,
      owner.agentId,
      actor.label,
      now,
      now,
    );
    replaceTaskAttachments(database, workspaceId, id, attachments, now);
    recordTaskEvent(database, {
      workspaceId,
      taskId: id,
      eventType: "created",
      toStatus: "ready",
      message: description || null,
      actor,
      actorAgentId: owner.agentId,
      metadata: {
        priority: input.priority ?? "normal",
        targetDocumentId: target?.id ?? null,
        assignedAgentId: assigned?.id ?? null,
        requiresReview: input.requiresReview !== false,
        attachmentCount: attachments.length,
      },
      createdAt: now,
    });
    auditTask(database, {
      workspaceId,
      taskId: id,
      action: "task.created",
      actor,
      actorAgentId: owner.agentId,
      metadata: {
        targetDocumentId: target?.id ?? null,
        assignedAgentId: assigned?.id ?? null,
      },
      createdAt: now,
    });
    result = getDocumentTask(database, workspaceId, id);
    recordAgentWrite(database, idempotency, target?.id ?? null, result);
  })();
  return result;
}

export function updateDocumentTask(
  database: NyxDatabase,
  workspaceId: string,
  taskId: string,
  actor: DocumentActor,
  input: {
    expectedVersion: number;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    attachments?: DocumentTaskAttachmentInput[];
    priority?: DocumentTaskPriority;
    targetDocumentId?: string | null;
    assignedAgentId?: string | null;
    requiresReview?: boolean;
    status?: DocumentTaskStatus;
    progress?: number;
    blocker?: string | null;
    resultSummary?: string | null;
  },
) {
  const current = requireTaskRow(database, workspaceId, taskId);
  requireExpectedVersion(current, input.expectedVersion);
  const target = input.targetDocumentId === undefined
    ? undefined
    : requireActiveDocument(database, workspaceId, input.targetDocumentId, "대상");
  const assigned = input.assignedAgentId === undefined
    ? undefined
    : requireActiveAgent(database, workspaceId, input.assignedAgentId);
  const attachments = normalizeTaskAttachments(database, workspaceId, input.attachments);
  const nextStatus = input.status ?? current.status;
  assertTransition(current.status, nextStatus);
  const nextProgress = nextStatus === "completed" || nextStatus === "review"
    ? 100
    : Math.max(0, Math.min(100, input.progress ?? current.progress));
  const blocker = input.blocker === undefined
    ? (nextStatus === "blocked" ? current.blocker : null)
    : optionalText(input.blocker, 2_000);
  if (nextStatus === "blocked" && !blocker) {
    throw new TaskServiceError("INVALID_INPUT", "막힘 상태에는 이유를 입력해주세요.");
  }
  const now = new Date().toISOString();
  const owner = actorColumns(database, workspaceId, actor);
  const eventType = nextStatus === current.status
    ? (input.progress !== undefined ? "progress" : "updated")
    : statusEventType(current.status, nextStatus);
  let result!: DocumentTask;
  database.transaction(() => {
    const update = database.prepare(
      `UPDATE document_tasks
       SET title = ?, description = ?, acceptance_criteria = ?, priority = ?,
           target_document_id = ?, assigned_agent_id = ?, requires_review = ?,
           status = ?, progress = ?, blocker = ?, result_summary = ?,
           started_at = ?,
           completed_at = ?,
           cancelled_at = ?,
           updated_at = ?, version = version + 1
       WHERE id = ? AND workspace_id = ? AND version = ?`,
    ).run(
      input.title === undefined ? current.title : normalizedText(input.title, "작업 제목", 200),
      input.description === undefined
        ? current.description
        : optionalText(input.description, 10_000) ?? "",
      input.acceptanceCriteria === undefined
        ? current.acceptance_criteria
        : optionalText(input.acceptanceCriteria, 5_000) ?? "",
      input.priority ?? current.priority,
      target === undefined ? current.target_document_id : target?.id ?? null,
      assigned === undefined ? current.assigned_agent_id : assigned?.id ?? null,
      input.requiresReview === undefined ? current.requires_review : input.requiresReview ? 1 : 0,
      nextStatus,
      nextProgress,
      blocker,
      input.resultSummary === undefined
        ? current.result_summary
        : optionalText(input.resultSummary, 5_000),
      nextStatus === "in_progress" ? current.started_at ?? now : current.started_at,
      nextStatus === "completed" ? current.completed_at ?? now : null,
      nextStatus === "cancelled" ? current.cancelled_at ?? now : null,
      now,
      taskId,
      workspaceId,
      input.expectedVersion,
    );
    requireTaskUpdate(update, input.expectedVersion);
    if (attachments !== undefined) {
      replaceTaskAttachments(database, workspaceId, taskId, attachments, now);
    }
    recordTaskEvent(database, {
      workspaceId,
      taskId,
      eventType,
      fromStatus: current.status,
      toStatus: nextStatus,
      message: blocker ?? input.resultSummary ?? null,
      actor,
      actorAgentId: owner.agentId,
      metadata: {
        progress: nextProgress,
        assignedAgentId: assigned === undefined ? current.assigned_agent_id : assigned?.id ?? null,
        attachmentCount: attachments?.length,
      },
      createdAt: now,
    });
    auditTask(database, {
      workspaceId,
      taskId,
      action: "task.updated",
      actor,
      actorAgentId: owner.agentId,
      metadata: {
        fromStatus: current.status,
        toStatus: nextStatus,
        progress: nextProgress,
      },
      createdAt: now,
    });
    result = getDocumentTask(database, workspaceId, taskId);
  })();
  return result;
}

function requireAssignedTask(
  current: TaskRow,
  actorAgentId: string,
  action: string,
) {
  if (current.assigned_agent_id !== actorAgentId) {
    throw new TaskServiceError("FORBIDDEN", `자신에게 할당된 작업만 ${action}할 수 있습니다.`);
  }
}

export function claimDocumentTask(
  database: NyxDatabase,
  workspaceId: string,
  taskId: string,
  actor: DocumentActor,
  input: {
    expectedVersion: number;
    requestId: string;
    message?: string | null;
  },
) {
  const actorAgentId = actorMembershipId(database, workspaceId, actor);
  if (!actorAgentId) throw new TaskServiceError("FORBIDDEN", "에이전트만 작업을 가져갈 수 있습니다.");
  const payload = { taskId, expectedVersion: input.expectedVersion, message: input.message ?? null };
  const idempotency = prepareAgentWrite(actor, "claim_document_task", input.requestId, payload);
  const replayed = replayAgentWrite<DocumentTask>(database, idempotency);
  if (replayed) return replayed;
  const current = requireTaskRow(database, workspaceId, taskId);
  requireExpectedVersion(current, input.expectedVersion);
  if (current.status !== "ready") {
    throw new TaskServiceError("CONFLICT", "대기 중인 작업만 가져갈 수 있습니다.");
  }
  if (current.assigned_agent_id && current.assigned_agent_id !== actorAgentId) {
    throw new TaskServiceError("FORBIDDEN", "다른 에이전트에게 할당된 작업입니다.");
  }
  const now = new Date().toISOString();
  let result!: DocumentTask;
  database.transaction(() => {
    const update = database.prepare(
      `UPDATE document_tasks
       SET assigned_agent_id = ?, status = 'in_progress', started_at = COALESCE(started_at, ?),
           blocker = NULL, updated_at = ?, version = version + 1
       WHERE id = ? AND workspace_id = ? AND version = ?`,
    ).run(actorAgentId, now, now, taskId, workspaceId, input.expectedVersion);
    requireTaskUpdate(update, input.expectedVersion);
    recordTaskEvent(database, {
      workspaceId,
      taskId,
      eventType: "claimed",
      fromStatus: current.status,
      toStatus: "in_progress",
      message: input.message,
      actor,
      actorAgentId,
      createdAt: now,
    });
    auditTask(database, {
      workspaceId,
      taskId,
      action: "task.claimed",
      actor,
      actorAgentId,
      createdAt: now,
    });
    result = getDocumentTask(database, workspaceId, taskId);
    recordAgentWrite(database, idempotency, current.target_document_id, result);
  })();
  return result;
}

export function reportDocumentTask(
  database: NyxDatabase,
  workspaceId: string,
  taskId: string,
  actor: DocumentActor,
  input: {
    expectedVersion: number;
    requestId: string;
    status: "in_progress" | "blocked" | "ready";
    progress?: number;
    message?: string | null;
  },
) {
  const actorAgentId = actorMembershipId(database, workspaceId, actor);
  if (!actorAgentId) throw new TaskServiceError("FORBIDDEN", "에이전트만 작업 진행 상황을 보고할 수 있습니다.");
  const payload = { taskId, ...input };
  const idempotency = prepareAgentWrite(actor, "report_document_task", input.requestId, payload);
  const replayed = replayAgentWrite<DocumentTask>(database, idempotency);
  if (replayed) return replayed;
  const current = requireTaskRow(database, workspaceId, taskId);
  requireExpectedVersion(current, input.expectedVersion);
  requireAssignedTask(current, actorAgentId, "보고");
  if (!["in_progress", "blocked"].includes(current.status)) {
    throw new TaskServiceError("CONFLICT", "진행 중이거나 막힌 작업만 진행 상황을 보고할 수 있습니다.");
  }
  if (input.status === "blocked" && !input.message?.trim()) {
    throw new TaskServiceError("INVALID_INPUT", "막힌 이유를 알려주세요.");
  }
  const now = new Date().toISOString();
  const progress = Math.max(0, Math.min(99, input.progress ?? current.progress));
  let result!: DocumentTask;
  database.transaction(() => {
    const update = database.prepare(
      `UPDATE document_tasks
       SET status = ?, progress = ?, blocker = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND workspace_id = ? AND version = ?`,
    ).run(
      input.status,
      progress,
      input.status === "blocked" ? input.message?.trim() : null,
      now,
      taskId,
      workspaceId,
      input.expectedVersion,
    );
    requireTaskUpdate(update, input.expectedVersion);
    recordTaskEvent(database, {
      workspaceId,
      taskId,
      eventType: input.status === "blocked" ? "blocked" : "progress",
      fromStatus: current.status,
      toStatus: input.status,
      message: input.message,
      actor,
      actorAgentId,
      metadata: { progress },
      createdAt: now,
    });
    auditTask(database, {
      workspaceId,
      taskId,
      action: "task.progress_reported",
      actor,
      actorAgentId,
      metadata: { status: input.status, progress },
      createdAt: now,
    });
    result = getDocumentTask(database, workspaceId, taskId);
    recordAgentWrite(database, idempotency, current.target_document_id, result);
  })();
  return result;
}

export function completeDocumentTask(
  database: NyxDatabase,
  workspaceId: string,
  taskId: string,
  actor: DocumentActor,
  input: {
    expectedVersion: number;
    requestId: string;
    resultSummary: string;
    resultDocumentId?: string | null;
    resultRevisionNumber?: number | null;
  },
) {
  const actorAgentId = actorMembershipId(database, workspaceId, actor);
  if (!actorAgentId) throw new TaskServiceError("FORBIDDEN", "에이전트만 작업 결과를 제출할 수 있습니다.");
  const payload = { taskId, ...input };
  const idempotency = prepareAgentWrite(actor, "complete_document_task", input.requestId, payload);
  const replayed = replayAgentWrite<DocumentTask>(database, idempotency);
  if (replayed) return replayed;
  const current = requireTaskRow(database, workspaceId, taskId);
  requireExpectedVersion(current, input.expectedVersion);
  requireAssignedTask(current, actorAgentId, "완료");
  if (!["in_progress", "blocked"].includes(current.status)) {
    throw new TaskServiceError("CONFLICT", "진행 중이거나 막힌 작업만 완료할 수 있습니다.");
  }
  const summary = normalizedText(input.resultSummary, "작업 결과", 5_000);
  const resultDocument = requireActiveDocument(
    database,
    workspaceId,
    input.resultDocumentId,
    "결과",
  );
  let resultRevision: { id: string; revision_number: number } | null = null;
  if (resultDocument || input.resultRevisionNumber !== undefined && input.resultRevisionNumber !== null) {
    if (!resultDocument || !input.resultRevisionNumber) {
      throw new TaskServiceError("INVALID_INPUT", "결과 문서와 결과 리비전 번호를 함께 입력해주세요.");
    }
    resultRevision = database.prepare(
      `SELECT id, revision_number
       FROM document_revisions
       WHERE document_id = ? AND revision_number = ?`,
    ).get(resultDocument.id, input.resultRevisionNumber) as {
      id: string;
      revision_number: number;
    } | undefined ?? null;
    if (!resultRevision) {
      throw new TaskServiceError("NOT_FOUND", "결과 문서의 리비전을 찾을 수 없습니다.");
    }
  }
  const nextStatus: DocumentTaskStatus = current.requires_review ? "review" : "completed";
  const now = new Date().toISOString();
  let result!: DocumentTask;
  database.transaction(() => {
    const update = database.prepare(
      `UPDATE document_tasks
       SET status = ?, progress = 100, blocker = NULL, result_summary = ?,
           result_document_id = ?, result_revision_id = ?,
           completed_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND workspace_id = ? AND version = ?`,
    ).run(
      nextStatus,
      summary,
      resultDocument?.id ?? null,
      resultRevision?.id ?? null,
      nextStatus === "completed" ? now : null,
      now,
      taskId,
      workspaceId,
      input.expectedVersion,
    );
    requireTaskUpdate(update, input.expectedVersion);
    recordTaskEvent(database, {
      workspaceId,
      taskId,
      eventType: nextStatus === "review" ? "submitted" : "completed",
      fromStatus: current.status,
      toStatus: nextStatus,
      message: summary,
      actor,
      actorAgentId,
      metadata: {
        resultDocumentId: resultDocument?.id ?? null,
        resultRevisionNumber: resultRevision?.revision_number ?? null,
      },
      createdAt: now,
    });
    auditTask(database, {
      workspaceId,
      taskId,
      action: nextStatus === "review" ? "task.submitted" : "task.completed",
      actor,
      actorAgentId,
      metadata: {
        resultDocumentId: resultDocument?.id ?? null,
        resultRevisionNumber: resultRevision?.revision_number ?? null,
      },
      createdAt: now,
    });
    result = getDocumentTask(database, workspaceId, taskId);
    recordAgentWrite(
      database,
      idempotency,
      resultDocument?.id ?? current.target_document_id,
      result,
    );
  })();
  return result;
}
