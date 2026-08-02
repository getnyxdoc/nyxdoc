import type { DraftActor, WorkingDocument } from "@/lib/collaboration/drafts";
import type {
  DocumentMutationResult,
  DocumentPatchOperation,
} from "@/lib/documents/types";
import type {
  ArchiveDocumentInput,
  ArchiveDocumentResult,
} from "@/lib/documents/service";
import type { BlockIdNormalization } from "@/lib/documents/block-ids";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";

export type DraftReplacement = {
  title?: string;
  parentDocumentId?: string | null;
  documentType?: string | null;
  workflowStatus?: "draft" | "review" | "final";
  tags?: string[];
  content?: NyxdocDocumentV2;
};

export type ReadWorkingDocumentRequest = {
  workspaceId: string;
  documentId: string;
};

export type ReplaceWorkingDocumentRequest = {
  roomName: string;
  actor: DraftActor;
  expectedDraftVersion?: number;
  requestId?: string;
  replacement: DraftReplacement;
};

export type ReplaceAndCommitWorkingDocumentRequest = ReplaceWorkingDocumentRequest & {
  summary?: string;
  idempotencyDraftVersion?: number;
};

export type PatchWorkingDocumentRequest = {
  roomName: string;
  actor: DraftActor;
  expectedDraftVersion: number;
  requestId: string;
  operations: DocumentPatchOperation[];
};

export type CommitWorkingDocumentRequest = {
  roomName: string;
  actor: DraftActor;
  expectedDraftVersion: number;
  synchronizationFence?: {
    generation: number;
    stateVector: string;
  };
  requestId?: string;
  summary?: string;
};

export type ResetWorkingDocumentRequest = {
  workspaceId: string;
  documentId: string;
  actor: DraftActor;
  revisionId?: string;
  requestId?: string;
};

export type WorkingDocumentResponse = {
  workingDocument: WorkingDocument;
  normalization?: BlockIdNormalization;
};
export type CommitWorkingDocumentResponse = DocumentMutationResult & {
  workingDocument: WorkingDocument;
  normalization?: BlockIdNormalization;
};
export type ReplaceAndCommitWorkingDocumentResponse = CommitWorkingDocumentResponse;
export type ResetWorkingDocumentResponse = {
  roomName: string;
  workingDocument: WorkingDocument;
};

export type ArchiveWorkingTreeRequest = ArchiveDocumentInput & {
  workspaceId: string;
  documentId: string;
  actor: DraftActor;
};

export type ArchiveWorkingTreeResponse = ArchiveDocumentResult;

export type CollaborationErrorResponse = {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
};
