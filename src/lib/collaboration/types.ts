import type { AgentAccessProfile, WorkspacePermission } from "@/lib/authz/permissions";
import type { AgentIdentityId, WorkspaceAgentGrantId } from "@/lib/agents/identifiers";
import type { DocumentListEntry, DocumentWorkflowStatus } from "@/lib/documents/types";

export const ASSIGNMENT_TYPES = ["owner", "contributor", "reviewer"] as const;
export const ASSIGNMENT_STATUSES = ["active", "completed", "cancelled"] as const;

export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export type CollaborationActor =
  | { type: "human"; userId: string; label: string }
  // agentId is the WorkspaceAgentGrantId because collaboration ownership
  // columns reference workspace_agents.id.
  | { type: "agent"; agentId: WorkspaceAgentGrantId; label: string };

export type WorkspaceAgentSummary = {
  /** WorkspaceAgentGrantId (`workspace_agents.id`), used as an assignment target. */
  id: WorkspaceAgentGrantId;
  /** Global AgentIdentityId (`agents.id`) shared across workspace grants. */
  agentIdentityId: AgentIdentityId;
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
  /** WorkspaceAgentGrantId; saved-view filters never accept a global identity ID. */
  assignedAgentId?: WorkspaceAgentGrantId;
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
  /** WorkspaceAgentGrantId (`workspace_agents.id`), not AgentIdentityId. */
  agentId: WorkspaceAgentGrantId;
  /** Global AgentIdentityId (`agents.id`) for this workspace grant. */
  agentIdentityId: AgentIdentityId;
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
