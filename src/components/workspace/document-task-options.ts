import type { WorkspaceAgentSummary } from "@/lib/collaboration/types";
import type { DocumentSummary } from "@/lib/documents/types";
import type { AppLocale } from "@/lib/i18n/locales";

type TaskDocument = Pick<DocumentSummary, "id" | "parentDocumentId" | "title" | "treeOrder">;

export type TaskDocumentTreeRow = {
  document: TaskDocument;
  ancestors: string[];
  depth: number;
  hasChildren: boolean;
  path: string[];
};

const agentRolePriority: Record<WorkspaceAgentSummary["role"], number> = {
  admin: 3,
  editor: 2,
  viewer: 1,
};

export function taskAgentRoleLabel(
  role: WorkspaceAgentSummary["role"],
  locale: AppLocale,
) {
  return {
    en: { admin: "Administrator", editor: "Editor", viewer: "Viewer" },
    ko: { admin: "관리자", editor: "편집자", viewer: "뷰어" },
    ja: { admin: "管理者", editor: "編集者", viewer: "閲覧者" },
  }[locale][role];
}

export function orderedActiveTaskAgents(agents: WorkspaceAgentSummary[]) {
  return agents
    .filter((agent) => agent.status === "active")
    .sort((left, right) =>
      agentRolePriority[right.role] - agentRolePriority[left.role]
      || left.displayName.localeCompare(right.displayName)
      || left.id.localeCompare(right.id),
    );
}

export function preferredTaskAgentId(agents: WorkspaceAgentSummary[]) {
  return orderedActiveTaskAgents(agents)[0]?.id ?? "";
}

export function buildTaskDocumentTree(documents: TaskDocument[]): TaskDocumentTreeRow[] {
  const ids = new Set(documents.map((document) => document.id));
  const children = new Map<string | null, TaskDocument[]>();
  for (const document of documents) {
    const parentId = document.parentDocumentId
      && document.parentDocumentId !== document.id
      && ids.has(document.parentDocumentId)
      ? document.parentDocumentId
      : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(document);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) =>
      left.treeOrder - right.treeOrder
      || left.title.localeCompare(right.title, "ko")
      || left.id.localeCompare(right.id),
    );
  }

  const rows: TaskDocumentTreeRow[] = [];
  const visited = new Set<string>();
  function visit(document: TaskDocument, ancestors: string[], path: string[]) {
    if (visited.has(document.id)) return;
    visited.add(document.id);
    const descendants = children.get(document.id) ?? [];
    rows.push({
      document,
      ancestors,
      depth: ancestors.length,
      hasChildren: descendants.length > 0,
      path: [...path, document.title],
    });
    for (const child of descendants) {
      visit(child, [...ancestors, document.id], [...path, document.title]);
    }
  }

  for (const root of children.get(null) ?? []) visit(root, [], []);
  for (const orphan of documents) visit(orphan, [], []);
  return rows;
}
