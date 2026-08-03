import type { AgentAccessProfile, WorkspacePermission } from "@/lib/authz/permissions";
import type { DocumentListEntry, DocumentWorkflowStatus } from "@/lib/documents/types";

export const ASSIGNMENT_TYPES = ["owner", "contributor", "reviewer"] as const;
export const ASSIGNMENT_STATUSES = ["active", "completed", "cancelled"] as const;

export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export type CollaborationActor =
  | { type: "human"; userId: string; label: string }
  | { type: "agent"; agentId: string; label: string };

export type WorkspaceAgentSummary = {
  id: string;
  displayName: string;
  avatarMediaId: string | null;
  accessProfile: AgentAccessProfile;
  capabilities: WorkspacePermission[];
  status: "active" | "disabled";
  activeAssignmentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SavedViewQuery = {
  parentDocumentId?: string | null;
  withinDocumentId?: string;
  titlePrefix?: string;
  documentType?: string;
  workflowStatus?: DocumentWorkflowStatus;
  tag?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  updatedWithinDays?: number;
  assignedAgentId?: string;
  assignmentType?: AssignmentType;
  unassigned?: boolean;
  sort?: "tree" | "updated_desc";
  limit?: number;
};

export type SavedView = {
  id: string;
  name: string;
  query: SavedViewQuery;
  visibility: "private" | "workspace";
  createdBy: { type: "human" | "agent"; id: string | null };
  createdAt: string;
  updatedAt: string;
};

export type DocumentAssignment = {
  id: string;
  documentId: string;
  documentTitle: string;
  agentId: string;
  agentDisplayName: string;
  agentAvatarMediaId: string | null;
  assignmentType: AssignmentType;
  status: AssignmentStatus;
  note: string | null;
  assignedBy: { type: "human" | "agent"; id: string | null };
  createdAt: string;
  updatedAt: string;
};

export type SavedViewResult = {
  view: SavedView;
  documents: Array<DocumentListEntry & { assignments: DocumentAssignment[] }>;
  total: number;
};
