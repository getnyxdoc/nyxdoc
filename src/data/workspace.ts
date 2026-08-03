import "server-only";

import { randomUUID } from "node:crypto";
import {
  humanDocumentPrincipalAllows,
  humanRoleAllows,
  requireHumanDocumentPermission,
} from "@/lib/authz/permissions";
import { ensureCollaborationState } from "@/lib/collaboration/drafts";
import {
  listAssignments,
  listSavedViews,
  listWorkspaceAgents,
} from "@/lib/collaboration/service";
import { getCollaborationPublicUrl } from "@/lib/config";
import { sqlite } from "@/lib/db/client";
import {
  createDocument,
  getDocument,
  listDocumentRevisions,
  listDocuments,
  listTrashBatches,
} from "@/lib/documents/service";
import { humanDocumentActor } from "@/lib/documents/actors";
import type { WorkspaceView } from "@/lib/workspace/view";
import { listDocumentTasks } from "@/lib/tasks/service";
import { listHumanGrantedDocuments } from "@/lib/sharing/access";
import type { AppLocale } from "@/lib/i18n/locales";
import {
  listUserMembershipWorkspaces,
  listUserTrashedWorkspaces,
  listUserWorkspaces,
  resolveUserWorkspace,
} from "@/lib/workspaces/service";
import { workspaceStarterContent } from "@/lib/workspaces/bootstrap";
import { getWorkspaceNavigationPreference } from "@/lib/workspaces/navigation-preferences";

type ViewUser = { id: string; name: string; email: string; image: string | null };

export function loadWorkspaceView(
  user: ViewUser,
  selectedDocumentId?: string,
  workspaceSelector?: string,
  fallbackOnMissingWorkspace = false,
  locale: AppLocale = "en",
): WorkspaceView {
  const workspace = resolveUserWorkspace(sqlite, user, {
    selector: workspaceSelector,
    documentId: selectedDocumentId,
    fallbackOnMissingSelector: fallbackOnMissingWorkspace,
    locale,
  });
  // `membership` and `team` are both resolved by getHumanWorkspacePrincipal
  // into a full workspace principal. Only a direct document grant is limited
  // to its explicitly shared documents.
  const hasWorkspaceAccess = workspace.accessSource !== "document_grant";
  let documents = hasWorkspaceAccess
    ? listDocuments(sqlite, workspace.id)
    : listHumanGrantedDocuments(sqlite, workspace.id, user.id);
  if (
    documents.length === 0
    && hasWorkspaceAccess
    && humanRoleAllows(workspace.role, "documents.create")
  ) {
    const starter = workspaceStarterContent(locale);
    createDocument(sqlite, workspace.id, humanDocumentActor(user), {
      title: starter.document.title,
      content: {
        schemaVersion: 2,
        blocks: starter.document.blocks.map((block) => ({
          id: randomUUID(),
          type: block.type,
          ...(block.listStyleType
            ? { listStyleType: block.listStyleType, indent: 1 }
            : {}),
          children: [{ text: block.content }],
        })),
      },
      summary: starter.revisionSummary,
    });
    documents = listDocuments(sqlite, workspace.id);
  }
  if (documents.length === 0) throw new Error("Workspace has no readable documents.");
  const activeSummary = documents.find((document) => document.id === selectedDocumentId) ?? documents[0];
  const activePrincipal = requireHumanDocumentPermission(
    sqlite,
    workspace.id,
    activeSummary.id,
    user.id,
    "documents.read",
  );
  const collaboration = ensureCollaborationState(sqlite, workspace.id, activeSummary.id);
  const actor = { type: "human" as const, userId: user.id, label: user.name };
  const workspaces = listUserWorkspaces(sqlite, user.id);
  const membershipWorkspaces = listUserMembershipWorkspaces(sqlite, user.id);
  const trashWorkspaces = membershipWorkspaces
    .filter((item) => humanRoleAllows(item.role, "documents.read"))
    .map((item) => ({
      workspace: item,
      documents: listTrashBatches(sqlite, item.id),
      canRestoreDocuments: humanRoleAllows(item.role, "documents.restore"),
      canPurgeDocuments: humanRoleAllows(item.role, "documents.purge"),
    }));
  return {
    user,
    workspace,
    workspaces,
    documents,
    activeDocument: getDocument(sqlite, workspace.id, activeSummary.id),
    revisions: listDocumentRevisions(sqlite, workspace.id, activeSummary.id, 12),
    trashWorkspaces,
    trashedWorkspaces: listUserTrashedWorkspaces(sqlite, user.id),
    agents: hasWorkspaceAccess ? listWorkspaceAgents(sqlite, workspace.id) : [],
    assignments: hasWorkspaceAccess
      ? listAssignments(sqlite, workspace.id, { status: "active" })
      : [],
    tasks: hasWorkspaceAccess
      ? listDocumentTasks(sqlite, workspace.id, { limit: 200 }).tasks
      : [],
    savedViews: hasWorkspaceAccess ? listSavedViews(sqlite, workspace.id, actor) : [],
    navigation: getWorkspaceNavigationPreference(sqlite, {
      userId: user.id,
      workspaceId: workspace.id,
      documents,
      activeDocumentId: activeSummary.id,
    }),
    collaboration: {
      generation: collaboration.generation,
      roomName: collaboration.roomName,
      baseRevisionNumber: collaboration.baseRevisionNumber,
      draftVersion: collaboration.draftVersion,
      committedDraftVersion: collaboration.committedDraftVersion,
      hasUncommittedChanges: collaboration.hasUncommittedChanges,
      updatedAt: collaboration.updatedAt,
      publicUrl: getCollaborationPublicUrl(),
    },
    permissions: {
      canAccessWorkspaceFeatures: hasWorkspaceAccess,
      canCreateDocuments: hasWorkspaceAccess && humanRoleAllows(workspace.role, "documents.create"),
      canEditDocuments: humanDocumentPrincipalAllows(activePrincipal, "documents.update"),
      canCommitDocuments: humanDocumentPrincipalAllows(activePrincipal, "documents.commit"),
      canExportDocuments: humanDocumentPrincipalAllows(activePrincipal, "exports.create"),
      canShareDocuments: hasWorkspaceAccess && humanRoleAllows(workspace.role, "documents.share"),
      canTrashDocuments: hasWorkspaceAccess && humanRoleAllows(workspace.role, "documents.trash"),
      canManageDocumentStructure: hasWorkspaceAccess && humanRoleAllows(workspace.role, "documents.update"),
      canRestoreRevisions: humanDocumentPrincipalAllows(activePrincipal, "revisions.restore"),
      canManageAssignments: hasWorkspaceAccess && humanRoleAllows(workspace.role, "assignments.manage"),
      canCreateTasks: hasWorkspaceAccess && humanRoleAllows(workspace.role, "tasks.create"),
      canUpdateTasks: hasWorkspaceAccess && humanRoleAllows(workspace.role, "tasks.update"),
      canManageTasks: hasWorkspaceAccess && humanRoleAllows(workspace.role, "tasks.manage"),
      canManageSavedViews: hasWorkspaceAccess && humanRoleAllows(workspace.role, "saved_views.manage"),
      canManageAllSavedViews: hasWorkspaceAccess
        && (workspace.role === "owner" || workspace.role === "admin"),
    },
  };
}
