import type {
  DocumentDetail,
  DocumentRevision,
  DocumentSummary,
  TrashBatchSummary,
} from "@/lib/documents/types";
import type {
  DocumentAssignment,
  SavedView,
  WorkspaceAgentSummary,
} from "@/lib/collaboration/types";
import type { CollaborationState } from "@/lib/collaboration/drafts";
import type {
  TrashedWorkspaceSummary,
  WorkspaceSummary,
} from "@/lib/workspaces/service";
import type { DocumentTask } from "@/lib/tasks/types";
import type { WorkspaceNavigationPreference } from "@/lib/workspaces/navigation-preferences";

export type WorkspaceTrashGroup = {
  workspace: WorkspaceSummary;
  documents: TrashBatchSummary[];
  canRestoreDocuments: boolean;
  canPurgeDocuments: boolean;
};

export type WorkspaceView = {
  user: { id: string; name: string; email: string; image: string | null };
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  documents: DocumentSummary[];
  activeDocument: DocumentDetail;
  revisions: DocumentRevision[];
  trashWorkspaces: WorkspaceTrashGroup[];
  trashedWorkspaces: TrashedWorkspaceSummary[];
  agents: WorkspaceAgentSummary[];
  assignments: DocumentAssignment[];
  tasks: DocumentTask[];
  savedViews: SavedView[];
  navigation: WorkspaceNavigationPreference;
  collaboration: Pick<
    CollaborationState,
    | "generation"
    | "roomName"
    | "baseRevisionNumber"
    | "draftVersion"
    | "committedDraftVersion"
    | "hasUncommittedChanges"
    | "updatedAt"
  > & {
    publicUrl: string;
  };
  permissions: {
    canAccessWorkspaceFeatures: boolean;
    canCreateDocuments: boolean;
    canEditDocuments: boolean;
    canCommitDocuments: boolean;
    canExportDocuments: boolean;
    canShareDocuments: boolean;
    canTrashDocuments: boolean;
    canManageDocumentStructure: boolean;
    canRestoreRevisions: boolean;
    canManageAssignments: boolean;
    canCreateTasks: boolean;
    canUpdateTasks: boolean;
    canManageTasks: boolean;
    canManageSavedViews: boolean;
    canManageAllSavedViews: boolean;
  };
};
