import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { listAgentProfilePermissions } from "@/lib/authz/permissions";
import type { WorkspaceView } from "@/lib/workspace/view";
import { AgentLinkFixture } from "./agent-link-fixture";

const currentContent = {
  schemaVersion: 2 as const,
  blocks: [
    { id: "workspace-e2e-title", type: "h1" as const, children: [{ text: "현재 본문" }] },
    { id: "workspace-e2e-body", type: "p" as const, children: [{ text: "리비전 2의 내용입니다." }] },
    {
      id: "workspace-e2e-agent-link",
      type: "p" as const,
      children: [
        { text: "에이전트 출처 링크: " },
        {
          id: "workspace-e2e-agent-link-inline",
          type: "a" as const,
          url: "https://learn.chatgpt.com/docs/build-skills",
          children: [{ text: "https://learn.chatgpt.com/docs/build-skills" }],
        },
      ],
    },
  ],
};

const primaryDocument = {
  id: "document-e2e",
  title: "리비전 동작 검증",
  slug: "revision-e2e",
  status: "active" as const,
  parentDocumentId: null,
  treeOrder: 100,
  revisionId: "revision-2",
  revisionNumber: 2,
  documentType: "test",
  workflowStatus: "draft" as const,
  tags: [],
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T01:00:00.000Z",
};

const navigationDocuments = Array.from({ length: 48 }, (_, index) => ({
  id: `document-navigation-${String(index + 1).padStart(2, "0")}`,
  title: `탐색 상태 검증 문서 ${String(index + 1).padStart(2, "0")}`,
  slug: `navigation-${index + 1}`,
  status: "active" as const,
  parentDocumentId: index >= 1 && index <= 4 ? "document-navigation-01" : null,
  treeOrder: 200 + index * 100,
  revisionId: `revision-navigation-${index + 1}`,
  revisionNumber: 1,
  documentType: "test",
  workflowStatus: "draft" as const,
  tags: [],
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T01:00:00.000Z",
}));

const taskAgents = [{
  id: "00000000-0000-4000-8000-0000000000e1",
  displayName: "Editor Agent",
  avatarMediaId: null,
  accessProfile: "writer" as const,
  capabilities: listAgentProfilePermissions("writer"),
  status: "active" as const,
  activeAssignmentCount: 0,
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T01:00:00.000Z",
}, {
  id: "00000000-0000-4000-8000-0000000000a1",
  displayName: "Admin Agent",
  avatarMediaId: null,
  accessProfile: "custom" as const,
  capabilities: [
    ...listAgentProfilePermissions("writer"),
    "assignments.manage" as const,
    "tasks.manage" as const,
  ],
  status: "active" as const,
  activeAssignmentCount: 0,
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T01:00:00.000Z",
}, {
  id: "00000000-0000-4000-8000-0000000000d1",
  displayName: "Disabled Admin",
  avatarMediaId: null,
  accessProfile: "custom" as const,
  capabilities: [
    ...listAgentProfilePermissions("writer"),
    "assignments.manage" as const,
    "tasks.manage" as const,
  ],
  status: "disabled" as const,
  activeAssignmentCount: 0,
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T01:00:00.000Z",
}];

const baseView: WorkspaceView = {
  user: {
    id: "user-e2e",
    name: "Revision E2E",
    email: "revision-e2e@example.com",
    image: null,
  },
  workspace: {
    id: "workspace-e2e",
    name: "Revision E2E Workspace",
    slug: "revision-e2e",
    role: "owner",
    accessSource: "membership",
    owner: { type: "personal", id: "user-e2e", name: "Revision E2E", icon: null },
    lifecycleState: "active",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T01:00:00.000Z",
  },
  workspaces: [{
      id: "workspace-e2e",
      name: "Revision E2E Workspace",
      slug: "revision-e2e",
      role: "owner",
      accessSource: "membership",
      owner: { type: "personal", id: "user-e2e", name: "Revision E2E", icon: null },
      lifecycleState: "active",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T01:00:00.000Z",
    }, {
      id: "workspace-secondary-e2e",
      name: "Secondary E2E Workspace",
      slug: "secondary-e2e",
      role: "owner",
      accessSource: "membership",
      owner: { type: "personal", id: "user-e2e", name: "Revision E2E", icon: null },
      lifecycleState: "active",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T01:00:00.000Z",
    }],
  documents: [primaryDocument, ...navigationDocuments],
  navigation: {
    expandedDocumentIds: [],
    lastActiveDocumentId: null,
    version: 0,
    updatedAt: null,
  },
  activeDocument: {
    ...primaryDocument,
    workspaceId: "workspace-e2e",
    content: currentContent,
  },
  revisions: [
    {
      id: "revision-2",
      number: 2,
      summary: "현재 본문으로 수정",
      actorType: "human",
      actorLabel: "Revision E2E",
      actorPrincipalId: "user-e2e",
      actorAvatarMediaId: null,
      source: "web",
      createdAt: "2026-07-14T01:00:00.000Z",
    },
    {
      id: "revision-1",
      number: 1,
      summary: "첫 문서 생성",
      actorType: "agent",
      actorLabel: "Codex",
      actorPrincipalId: "agent-e2e",
      actorAvatarMediaId: null,
      source: "mcp",
      createdAt: "2026-07-14T00:00:00.000Z",
    },
  ],
  trashWorkspaces: [{
    workspace: {
      id: "workspace-e2e",
      name: "Revision E2E Workspace",
      slug: "revision-e2e",
      role: "owner",
      accessSource: "membership",
      owner: { type: "personal", id: "user-e2e", name: "Revision E2E", icon: null },
      lifecycleState: "active",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T01:00:00.000Z",
    },
    documents: [{
      id: "trash-batch-e2e",
      rootDocumentId: "document-trashed-e2e",
      rootTitle: "삭제된 운영 문서",
      documentCount: 2,
      trashedAt: "2026-07-18T01:00:00.000Z",
      purgeAfter: "2026-08-17T01:00:00.000Z",
      actorType: "human",
      actorLabel: "Revision E2E",
    }],
    canRestoreDocuments: true,
    canPurgeDocuments: true,
  }, {
    workspace: {
      id: "workspace-secondary-e2e",
      name: "Secondary E2E Workspace",
      slug: "secondary-e2e",
      role: "owner",
      accessSource: "membership",
      owner: { type: "personal", id: "user-e2e", name: "Revision E2E", icon: null },
      lifecycleState: "active",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T01:00:00.000Z",
    },
    documents: [],
    canRestoreDocuments: true,
    canPurgeDocuments: true,
  }],
  trashedWorkspaces: [{
    id: "workspace-trashed-e2e",
    name: "Archived E2E Workspace",
    slug: "archived-e2e",
    role: "owner",
    owner: { type: "personal", id: "user-e2e", name: "Revision E2E", icon: null },
    lifecycleState: "trashed",
    trashedAt: "2026-07-17T02:00:00.000Z",
    purgeAfter: "2026-08-16T02:00:00.000Z",
    trashedByLabel: "Revision E2E",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-17T02:00:00.000Z",
  }],
  agents: taskAgents,
  assignments: [],
  tasks: [{
    id: "task-e2e-ready",
    workspaceId: "workspace-e2e",
    workspaceName: "Revision E2E Workspace",
    workspaceSlug: "revision-e2e",
    title: "운영 문서에서 빠진 절차 보강",
    description: "현재 문서를 읽고 빠진 절차를 보완합니다.",
    acceptanceCriteria: "결과 리비전과 변경 요약을 남깁니다.",
    attachments: [],
    status: "ready",
    priority: "high",
    progress: 0,
    targetDocumentId: "document-e2e",
    targetDocumentTitle: "리비전 동작 검증",
    targetDocumentPath: [{ id: "document-e2e", title: "리비전 동작 검증" }],
    assignedAgentId: null,
    assignedAgentDisplayName: null,
    assignedAgentAvatarMediaId: null,
    requiresReview: true,
    blocker: null,
    resultSummary: null,
    resultDocumentId: null,
    resultDocumentTitle: null,
    resultRevisionId: null,
    resultRevisionNumber: null,
    createdBy: { type: "human", id: "user-e2e", label: "Revision E2E" },
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    version: 1,
  }],
  savedViews: [],
  collaboration: {
    generation: 1,
    roomName: "nyxdoc:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:g1",
    baseRevisionNumber: 2,
    draftVersion: 0,
    committedDraftVersion: 0,
    hasUncommittedChanges: false,
    updatedAt: "2026-07-14T01:00:00.000Z",
    publicUrl: "ws://127.0.0.1:3101",
  },
  permissions: {
    canAccessWorkspaceFeatures: true,
    canCreateDocuments: true,
    canEditDocuments: true,
    canCommitDocuments: true,
    canExportDocuments: true,
    canShareDocuments: true,
    canTrashDocuments: true,
    canManageDocumentStructure: true,
    canRestoreRevisions: true,
    canManageAssignments: true,
    canCreateTasks: true,
    canUpdateTasks: true,
    canManageTasks: true,
    canManageSavedViews: true,
    canManageAllSavedViews: true,
  },
};

export default async function WorkspaceE2EPage({
  searchParams,
}: {
  searchParams: Promise<{ active?: string; fixture?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { active, fixture } = await searchParams;
  if (fixture === "agent-link-reader" || fixture === "agent-link-editor") {
    return (
      <AgentLinkFixture
        document={currentContent}
        readOnly={fixture === "agent-link-reader"}
      />
    );
  }
  const activeSummary = baseView.documents.find((document) => document.id === active);
  const view = activeSummary
    ? {
        ...baseView,
        activeDocument: {
          ...activeSummary,
          workspaceId: baseView.workspace.id,
          content: currentContent,
        },
        collaboration: {
          ...baseView.collaboration,
          roomName: `nyxdoc:00000000-0000-4000-8000-000000000001:${activeSummary.id}:g1`,
        },
      }
    : baseView;

  return <WorkspaceShell view={view} />;
}
