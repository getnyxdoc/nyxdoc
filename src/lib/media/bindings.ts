import type { NyxDatabase } from "@/lib/db/client";
import {
  nyxdocDocumentV2Schema,
  type NyxdocDocumentV2,
} from "@/lib/editor/schema";

export function documentMediaIds(content: NyxdocDocumentV2) {
  const ids = new Set<string>();
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "img" && typeof node.mediaId === "string" && node.mediaId) {
      ids.add(node.mediaId);
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  }
  visit(content.blocks);
  return [...ids];
}

export function bindMediaAssetToDocument(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    documentId: string;
    mediaId: string;
    createdAt?: string;
  },
) {
  database.prepare(
    `INSERT OR IGNORE INTO document_media_bindings
     (workspace_id, document_id, media_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    input.workspaceId,
    input.documentId,
    input.mediaId,
    input.createdAt ?? new Date().toISOString(),
  );
}

export function syncDocumentMediaBindings(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  content: NyxdocDocumentV2,
  createdAt = new Date().toISOString(),
) {
  const mediaIds = documentMediaIds(content);
  for (const mediaId of mediaIds) {
    bindMediaAssetToDocument(database, {
      workspaceId,
      documentId,
      mediaId,
      createdAt,
    });
  }
}

export function syncDocumentMediaBindingsFromHistory(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  createdAt = new Date().toISOString(),
) {
  const revisions = database.prepare(
    `SELECT revision.snapshot_json
     FROM document_revisions revision
     JOIN documents document ON document.id = revision.document_id
     WHERE document.workspace_id = ? AND revision.document_id = ?
     ORDER BY revision.revision_number`,
  ).all(workspaceId, documentId) as Array<{ snapshot_json: string }>;
  for (const revision of revisions) {
    try {
      const content = nyxdocDocumentV2Schema.safeParse(JSON.parse(revision.snapshot_json));
      if (content.success) {
        syncDocumentMediaBindings(database, workspaceId, documentId, content.data, createdAt);
      }
    } catch {
      // Older or damaged snapshots remain readable without weakening media authorization.
    }
  }
}

export function documentHasMediaBinding(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  mediaId: string,
) {
  return Boolean(database.prepare(
    `SELECT 1 FROM document_media_bindings
     WHERE workspace_id = ? AND document_id = ? AND media_id = ?`,
  ).get(workspaceId, documentId, mediaId));
}

/**
 * Returns a currently readable document binding for a media asset.
 *
 * Media assets intentionally have no standalone read grant. Every private
 * read must travel through an active document that both references the asset
 * and is currently accessible to the caller. Callers provide their existing
 * human or agent document-authorizer, so this does not create a second
 * authorization model in the media layer.
 */
export function resolveAuthorizedMediaDocumentBinding(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    mediaId: string;
    canReadDocument: (documentId: string) => boolean;
  },
) {
  const bindings = database.prepare(
    `SELECT binding.document_id
     FROM document_media_bindings binding
     JOIN documents document
       ON document.id = binding.document_id
      AND document.workspace_id = binding.workspace_id
     JOIN media_assets media
       ON media.id = binding.media_id
      AND media.workspace_id = binding.workspace_id
     JOIN workspaces workspace ON workspace.id = binding.workspace_id
     WHERE binding.workspace_id = ?
       AND binding.media_id = ?
       AND document.status = 'active'
       AND document.lifecycle_state = 'active'
       AND workspace.lifecycle_state = 'active'
     ORDER BY binding.document_id`,
  ).all(input.workspaceId, input.mediaId) as Array<{ document_id: string }>;

  return bindings.find((binding) => input.canReadDocument(binding.document_id))?.document_id ?? null;
}
