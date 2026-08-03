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

export function taskAgentAccessLabel(
  profile: WorkspaceAgentSummary["accessProfile"],
  locale: AppLocale,
) {
  return {
    en: { reader: "Reader", drafter: "Drafter", writer: "Writer", custom: "Custom access" },
    ko: { reader: "읽기", drafter: "초안 작성", writer: "문서 작업", custom: "사용자 지정 권한" },
    ja: { reader: "閲覧", drafter: "下書き作成", writer: "文書作業", custom: "カスタムアクセス" },
  }[locale][profile];
}

function agentAccessPriority(agent: WorkspaceAgentSummary) {
  const capabilities = new Set(agent.capabilities);
  const operationLevel = capabilities.has("tasks.manage") || capabilities.has("assignments.manage")
    ? 4
    : capabilities.has("documents.commit")
      ? 3
      : capabilities.has("documents.update")
        ? 2
        : capabilities.has("documents.read")
          ? 1
          : 0;
  return operationLevel * 1_000 + capabilities.size;
}

export function orderedActiveTaskAgents(agents: WorkspaceAgentSummary[]) {
  return agents
    .filter((agent) => agent.status === "active")
    .sort((left, right) =>
      agentAccessPriority(right) - agentAccessPriority(left)
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
