import type { NyxDatabase } from "@/lib/db/client";
import type { DocumentSummary } from "@/lib/documents/types";

const MAX_EXPANDED_DOCUMENTS = 2_000;

export type WorkspaceNavigationPreference = {
  expandedDocumentIds: string[];
  lastActiveDocumentId: string | null;
  version: number;
  updatedAt: string | null;
};

type NavigationPreferenceRow = {
  expanded_document_ids_json: string;
  last_active_document_id: string | null;
  version: number;
  updated_at: string;
};

export class NavigationPreferenceConflictError extends Error {
  constructor(readonly current: WorkspaceNavigationPreference) {
    super("Workspace navigation preference changed in another session.");
    this.name = "NavigationPreferenceConflictError";
  }
}

function visibleDocumentIds(documents: DocumentSummary[]) {
  return new Set(documents.map((document) => document.id));
}

function sanitizeExpandedDocumentIds(
  value: unknown,
  allowedDocumentIds: ReadonlySet<string>,
) {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string"
      || !allowedDocumentIds.has(candidate)
      || seen.has(candidate)
    ) continue;
    seen.add(candidate);
    result.push(candidate);
    if (result.length >= MAX_EXPANDED_DOCUMENTS) break;
  }
  return result;
}

function parseExpandedDocumentIds(
  value: string,
  allowedDocumentIds: ReadonlySet<string>,
) {
  try {
    return sanitizeExpandedDocumentIds(JSON.parse(value), allowedDocumentIds);
  } catch {
    return [];
  }
}

function ancestorIds(documents: DocumentSummary[], documentId: string) {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const result: string[] = [];
  const visited = new Set<string>();
  let cursor = byId.get(documentId)?.parentDocumentId ?? null;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    result.push(cursor);
    cursor = byId.get(cursor)?.parentDocumentId ?? null;
  }
  return result;
}

export function getWorkspaceNavigationPreference(
  database: NyxDatabase,
  input: {
    userId: string;
    workspaceId: string;
    documents: DocumentSummary[];
    activeDocumentId: string;
  },
): WorkspaceNavigationPreference {
  const row = database.prepare(
    `SELECT expanded_document_ids_json, last_active_document_id, version, updated_at
     FROM user_workspace_navigation_preferences
     WHERE user_id = ? AND workspace_id = ?`,
  ).get(input.userId, input.workspaceId) as NavigationPreferenceRow | undefined;
  const allowedDocumentIds = visibleDocumentIds(input.documents);
  const expandedDocumentIds = row
    ? parseExpandedDocumentIds(row.expanded_document_ids_json, allowedDocumentIds)
    : [];

  const lastActiveDocumentId = row?.last_active_document_id
    && allowedDocumentIds.has(row.last_active_document_id)
    ? row.last_active_document_id
    : null;

  if (lastActiveDocumentId !== input.activeDocumentId) {
    const expanded = new Set(expandedDocumentIds);
    for (const id of ancestorIds(input.documents, input.activeDocumentId)) expanded.add(id);
    expandedDocumentIds.splice(0, expandedDocumentIds.length, ...expanded);
  }

  return {
    expandedDocumentIds,
    lastActiveDocumentId,
    version: row?.version ?? 0,
    updatedAt: row?.updated_at ?? null,
  };
}

export function saveWorkspaceNavigationPreference(
  database: NyxDatabase,
  input: {
    userId: string;
    workspaceId: string;
    documents: DocumentSummary[];
    expandedDocumentIds: string[];
    activeDocumentId: string;
    expectedVersion: number;
  },
): WorkspaceNavigationPreference {
  const allowedDocumentIds = visibleDocumentIds(input.documents);
  if (!allowedDocumentIds.has(input.activeDocumentId)) {
    throw new Error("Navigation preference active document is not readable.");
  }
  const expandedDocumentIds = sanitizeExpandedDocumentIds(
    input.expandedDocumentIds,
    allowedDocumentIds,
  );
  const updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(expandedDocumentIds);
  const result = input.expectedVersion === 0
    ? database.prepare(
      `INSERT INTO user_workspace_navigation_preferences
         (user_id, workspace_id, expanded_document_ids_json,
          last_active_document_id, version, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(user_id, workspace_id) DO NOTHING`,
    ).run(
      input.userId,
      input.workspaceId,
      serialized,
      input.activeDocumentId,
      updatedAt,
    )
    : database.prepare(
      `UPDATE user_workspace_navigation_preferences
       SET expanded_document_ids_json = ?,
           last_active_document_id = ?,
           version = version + 1,
           updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND version = ?`,
    ).run(
      serialized,
      input.activeDocumentId,
      updatedAt,
      input.userId,
      input.workspaceId,
      input.expectedVersion,
    );
  if (result.changes === 0) {
    throw new NavigationPreferenceConflictError(getWorkspaceNavigationPreference(database, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      documents: input.documents,
      activeDocumentId: input.activeDocumentId,
    }));
  }
  return {
    expandedDocumentIds,
    lastActiveDocumentId: input.activeDocumentId,
    version: input.expectedVersion + 1,
    updatedAt,
  };
}
