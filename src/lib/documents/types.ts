import type { NyxdocBlock, NyxdocDocumentV2 } from "@/lib/editor/schema";
import type { BlockIdNormalization } from "@/lib/documents/block-ids";

export type DocumentActorType = "system" | "human" | "agent";
export type DocumentMutationSource = "seed" | "web" | "mcp" | "api" | "rollback" | "migration";

export type DocumentActor = {
  type: DocumentActorType;
  userId: string;
  tokenId?: string;
  principalId?: string;
  avatarMediaId?: string | null;
  label: string;
  source: DocumentMutationSource;
};

export const DOCUMENT_WORKFLOW_STATUSES = ["draft", "review", "final"] as const;
export type DocumentWorkflowStatus = (typeof DOCUMENT_WORKFLOW_STATUSES)[number];

export type DocumentMetadata = {
  documentType: string | null;
  workflowStatus: DocumentWorkflowStatus;
  tags: string[];
};

export type DocumentSummary = {
  id: string;
  title: string;
  slug: string;
  status: "active" | "archived";
  parentDocumentId: string | null;
  treeOrder: number;
  revisionId: string | null;
  revisionNumber: number;
  documentType: string | null;
  workflowStatus: DocumentWorkflowStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type DocumentPathItem = {
  id: string;
  title: string;
};

export type DocumentListEntry = DocumentSummary & {
  path: DocumentPathItem[];
};

export type DocumentSearchMatch = {
  kind: "title" | "body";
  blockId: string | null;
  nodeType: NyxdocBlock["type"] | null;
  snippet: string;
};

export type DocumentSearchResult = {
  documentId: string;
  title: string;
  parentDocumentId: string | null;
  path: DocumentPathItem[];
  revisionNumber: number;
  documentType: string | null;
  workflowStatus: DocumentWorkflowStatus;
  tags: string[];
  updatedAt: string;
  matches: DocumentSearchMatch[];
};

export type DocumentBacklink = {
  document: DocumentListEntry;
  blockIds: string[];
};

export type DocumentDetail = DocumentSummary & {
  workspaceId: string;
  content: NyxdocDocumentV2;
};

export type DocumentEvent = {
  cursor: number;
  id: string;
  documentId: string;
  documentTitle: string;
  revisionId: string;
  revisionNumber: number;
  eventType: "created" | "updated" | "archived" | "restored";
  actorType: DocumentActorType;
  actorLabel: string;
  actorPrincipalId: string | null;
  actorAvatarMediaId: string | null;
  source: string;
  summary: string;
  createdAt: string;
};

export type DocumentRevision = {
  id: string;
  number: number;
  summary: string;
  actorType: DocumentActorType;
  actorLabel: string;
  actorPrincipalId: string | null;
  actorAvatarMediaId: string | null;
  source: string;
  createdAt: string;
};

export type DocumentRevisionSnapshot = DocumentRevision & {
  title: string;
  parentDocumentId: string | null;
  metadata: DocumentMetadata;
  content: NyxdocDocumentV2;
};

export type DocumentRevisionDiff = {
  documentId: string;
  fromRevision: number;
  toRevision: number;
  document: {
    titleChanged: boolean;
    parentChanged: boolean;
    metadataChanged: boolean;
    before: Pick<DocumentRevisionSnapshot, "title" | "parentDocumentId" | "metadata">;
    after: Pick<DocumentRevisionSnapshot, "title" | "parentDocumentId" | "metadata">;
  };
  added: Array<{ blockId: string; index: number; block: NyxdocDocumentV2["blocks"][number] }>;
  removed: Array<{ blockId: string; index: number; block: NyxdocDocumentV2["blocks"][number] }>;
  modified: Array<{
    blockId: string;
    before: NyxdocDocumentV2["blocks"][number];
    after: NyxdocDocumentV2["blocks"][number];
  }>;
  moved: Array<{ blockId: string; fromIndex: number; toIndex: number }>;
};

export type DocumentMutationResult = {
  document: DocumentDetail;
  eventCursor: number | null;
  unchanged: boolean;
  normalization?: BlockIdNormalization;
};

export type DocumentTreeDropPosition = "before" | "after";

export type DocumentTreeReorderResult = {
  documentId: string;
  parentDocumentId: string | null;
  targetDocumentId: string;
  position: DocumentTreeDropPosition;
  treeOrder: number;
  orderedDocumentIds: string[];
  eventCursor: number | null;
  unchanged: boolean;
};

export type DocumentDraftCas = {
  expectedGeneration: number;
  expectedDraftVersion: number;
  expectedBaseRevision: number;
};

export type TrashBatchSummary = {
  id: string;
  rootDocumentId: string;
  rootTitle: string;
  documentCount: number;
  trashedAt: string;
  purgeAfter: string;
  actorType: DocumentActorType;
  actorLabel: string;
};

export type TrashMutationResult = {
  rootDocumentId: string;
  documentIds: string[];
  documentCount: number;
};

export type DocumentPatchOperation =
  | { op: "replace_block"; blockId: string; block: Record<string, unknown> }
  | { op: "insert_before" | "insert_after"; anchorBlockId: string; blocks: Array<Record<string, unknown>> }
  | { op: "delete_block"; blockId: string }
  | { op: "move_before" | "move_after"; blockId: string; anchorBlockId: string };

export type PatchDocumentInput = {
  baseRevision: number;
  requestId: string;
  operations: DocumentPatchOperation[];
  summary?: string;
};

export type DocumentServiceErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "IDEMPOTENCY_CONFLICT"
  | "DRAFT_CONFLICT"
  | "DRAFT_NOT_SYNCED"
  | "DRAFT_VERSION_CONFLICT"
  | "COLLABORATION_UNAVAILABLE"
  | "REVISION_CONFLICT";

export class DocumentServiceError extends Error {
  constructor(
    public readonly code: DocumentServiceErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DocumentServiceError";
  }
}
