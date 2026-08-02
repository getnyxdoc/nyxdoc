export const DOCUMENT_TASK_STATUSES = [
  "ready",
  "in_progress",
  "blocked",
  "review",
  "completed",
  "cancelled",
] as const;

export const DOCUMENT_TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const DOCUMENT_TASK_EVENT_TYPES = [
  "created",
  "updated",
  "claimed",
  "progress",
  "blocked",
  "submitted",
  "completed",
  "reopened",
  "cancelled",
] as const;

export type DocumentTaskStatus = (typeof DOCUMENT_TASK_STATUSES)[number];
export type DocumentTaskPriority = (typeof DOCUMENT_TASK_PRIORITIES)[number];
export type DocumentTaskEventType = (typeof DOCUMENT_TASK_EVENT_TYPES)[number];

export const DOCUMENT_TASK_ATTACHMENT_FIELDS = [
  "description",
  "acceptance_criteria",
] as const;

export type DocumentTaskAttachmentField =
  (typeof DOCUMENT_TASK_ATTACHMENT_FIELDS)[number];

export type DocumentTaskAttachment = {
  id: string;
  taskId: string;
  mediaId: string;
  field: DocumentTaskAttachmentField;
  position: number;
  mimeType: string;
  byteSize: number;
  originalFilename: string | null;
  url: string;
  createdAt: string;
};

export type DocumentTaskAttachmentInput = {
  mediaId: string;
  field: DocumentTaskAttachmentField;
};

export type DocumentTask = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  attachments: DocumentTaskAttachment[];
  status: DocumentTaskStatus;
  priority: DocumentTaskPriority;
  progress: number;
  targetDocumentId: string | null;
  targetDocumentTitle: string | null;
  targetDocumentPath: Array<{ id: string; title: string }>;
  assignedAgentId: string | null;
  assignedAgentDisplayName: string | null;
  assignedAgentAvatarMediaId: string | null;
  requiresReview: boolean;
  blocker: string | null;
  resultSummary: string | null;
  resultDocumentId: string | null;
  resultDocumentTitle: string | null;
  resultRevisionId: string | null;
  resultRevisionNumber: number | null;
  createdBy: {
    type: "human" | "agent";
    id: string | null;
    label: string;
  };
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type DocumentTaskEvent = {
  cursor: number;
  id: string;
  taskId: string;
  eventType: DocumentTaskEventType;
  fromStatus: DocumentTaskStatus | null;
  toStatus: DocumentTaskStatus | null;
  message: string | null;
  actor: {
    type: "human" | "agent" | "system";
    id: string | null;
    label: string;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
};

export class TaskServiceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "FORBIDDEN"
      | "CONFLICT"
      | "IDEMPOTENCY_CONFLICT",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TaskServiceError";
  }
}
