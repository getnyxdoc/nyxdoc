import type { NyxDatabase } from "@/lib/db/client";
import {
  getHumanDocumentPrincipal,
  humanDocumentPrincipalAllows,
} from "@/lib/authz/permissions";
import {
  nyxdocDocumentV2Schema,
  type NyxdocDocumentV2,
} from "@/lib/editor/schema";
import {
  DocumentServiceError,
  type DocumentActor,
} from "@/lib/documents/types";

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

/**
 * Every image embedded in a document body must resolve to an asset owned by
 * that document's workspace. Run this at every canonical and draft
 * persistence boundary so an invalid reference cannot survive until commit.
 */
export function assertDocumentMediaAssetsBelongToWorkspace(
  database: NyxDatabase,
  workspaceId: string,
  content: NyxdocDocumentV2,
) {
  const mediaIds = documentMediaIds(content);
  if (mediaIds.length === 0) return;
  const found = new Set<string>();
  for (let index = 0; index < mediaIds.length; index += 500) {
    const chunk = mediaIds.slice(index, index + 500);
    const rows = database.prepare(
      `SELECT id FROM media_assets
       WHERE workspace_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
    ).all(workspaceId, ...chunk) as Array<{ id: string }>;
    rows.forEach((row) => found.add(row.id));
  }
  const missing = mediaIds.find((mediaId) => !found.has(mediaId));
  if (missing) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "문서 이미지가 이 워크스페이스의 미디어 저장소에 없습니다.",
      { mediaId: missing },
    );
  }
}

type MediaAssetAuthorizationRow = {
  uploaded_by_credential_id: string | null;
  uploaded_by_token_id: string | null;
  uploaded_by_user_id: string | null;
};

function mediaAssetAuthorizationRow(
  database: NyxDatabase,
  workspaceId: string,
  mediaId: string,
) {
  return database.prepare(
    `SELECT uploaded_by_user_id, uploaded_by_token_id, uploaded_by_credential_id
     FROM media_assets
     WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, mediaId) as MediaAssetAuthorizationRow | undefined;
}

function agentHasAuthorizedUploadContext(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    mediaId: string;
    credentialId: string;
    asset: MediaAssetAuthorizationRow;
    canReadDocument: (documentId: string) => boolean;
  },
) {
  if (
    input.asset.uploaded_by_credential_id === input.credentialId
    || input.asset.uploaded_by_token_id === input.credentialId
  ) {
    return true;
  }
  const tickets = database.prepare(
    `SELECT document_id
     FROM agent_media_upload_tickets
     WHERE workspace_id = ? AND credential_id = ? AND media_id = ?
       AND consumed_at IS NOT NULL
     ORDER BY created_at, id`,
  ).all(input.workspaceId, input.credentialId, input.mediaId) as Array<{
    document_id: string | null;
  }>;
  return tickets.some((ticket) => (
    ticket.document_id === null || input.canReadDocument(ticket.document_id)
  ));
}

/**
 * A media UUID is a reference, not an access grant. Before canonical content
 * creates a new document binding, require either actor-owned upload provenance
 * or an existing binding to a document the actor can currently read.
 */
export function assertDocumentMediaReferencesAuthorized(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    actor: DocumentActor;
    content: NyxdocDocumentV2;
    agentCanReadDocument?: (documentId: string) => boolean;
    agentCanReadRevision?: (documentId: string) => boolean;
  },
) {
  assertDocumentMediaAssetsBelongToWorkspace(
    database,
    input.workspaceId,
    input.content,
  );
  const mediaIds = documentMediaIds(input.content);
  if (mediaIds.length === 0 || input.actor.type === "system") return;

  let canReadDocument: (documentId: string) => boolean;
  let canReadRevision: ((documentId: string) => boolean) | undefined;
  if (input.actor.type === "human") {
    canReadDocument = (documentId) => {
      const principal = getHumanDocumentPrincipal(
        database,
        input.workspaceId,
        documentId,
        input.actor.userId,
      );
      return Boolean(
        principal && humanDocumentPrincipalAllows(principal, "documents.read"),
      );
    };
    canReadRevision = (documentId) => {
      const principal = getHumanDocumentPrincipal(
        database,
        input.workspaceId,
        documentId,
        input.actor.userId,
      );
      return Boolean(
        principal && humanDocumentPrincipalAllows(principal, "revisions.read"),
      );
    };
  } else {
    if (!input.actor.tokenId || !input.agentCanReadDocument) {
      throw new DocumentServiceError(
        "FORBIDDEN",
        "문서 이미지 작업의 에이전트 연결을 확인할 수 없습니다.",
      );
    }
    canReadDocument = input.agentCanReadDocument;
    canReadRevision = input.agentCanReadRevision;
  }

  for (const mediaId of mediaIds) {
    const asset = mediaAssetAuthorizationRow(database, input.workspaceId, mediaId);
    const actorUploaded = input.actor.type === "human"
      ? asset?.uploaded_by_user_id === input.actor.userId
      : Boolean(asset && input.actor.tokenId && agentHasAuthorizedUploadContext(database, {
          workspaceId: input.workspaceId,
          mediaId,
          credentialId: input.actor.tokenId,
          asset,
          canReadDocument,
        }));
    if (
      actorUploaded
      || resolveAuthorizedMediaDocumentBinding(database, {
        workspaceId: input.workspaceId,
        mediaId,
        canReadDocument,
        canReadRevision,
      })
    ) {
      continue;
    }
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "문서 이미지가 현재 작업자에게 허용된 문서 또는 업로드 범위에 없습니다.",
      { mediaId },
    );
  }
}

function hasBindingProvenanceColumns(database: NyxDatabase) {
  const columns = database.prepare(
    "SELECT name FROM pragma_table_info('document_media_bindings')",
  ).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  return names.has("current_binding") && names.has("revision_binding");
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
  if (!hasBindingProvenanceColumns(database)) {
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
    return;
  }
  upsertDocumentMediaBinding(database, {
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    mediaId: input.mediaId,
    current: true,
    history: false,
    createdAt: input.createdAt,
  });
}

/**
 * The two flags record two independent facts about the same document/media
 * pair: the asset is in the current document projection, and/or it is kept by
 * at least one retained revision.  Keeping them on one row avoids making a
 * media reference itself an authorization grant while preserving the existing
 * document/media uniqueness invariant.
 */
function upsertDocumentMediaBinding(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    documentId: string;
    mediaId: string;
    current: boolean;
    history: boolean;
    createdAt?: string;
  },
) {
  database.prepare(
    `INSERT INTO document_media_bindings
     (workspace_id, document_id, media_id, current_binding, revision_binding, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id, media_id) DO UPDATE SET
       current_binding = MAX(document_media_bindings.current_binding, excluded.current_binding),
       revision_binding = MAX(document_media_bindings.revision_binding, excluded.revision_binding)`,
  ).run(
    input.workspaceId,
    input.documentId,
    input.mediaId,
    input.current ? 1 : 0,
    input.history ? 1 : 0,
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
  if (!hasBindingProvenanceColumns(database)) {
    documentMediaIds(content).forEach((mediaId) => bindMediaAssetToDocument(database, {
      workspaceId,
      documentId,
      mediaId,
      createdAt,
    }));
    return;
  }
  const mediaIds = documentMediaIds(content);
  database.prepare(
    `UPDATE document_media_bindings
     SET current_binding = 0
     WHERE workspace_id = ? AND document_id = ? AND current_binding <> 0`,
  ).run(workspaceId, documentId);
  for (const mediaId of mediaIds) {
    upsertDocumentMediaBinding(database, {
      workspaceId,
      documentId,
      mediaId,
      current: true,
      history: true,
      createdAt,
    });
  }
  // Keep the second provenance fact exact whenever canonical content changes.
  // The newly appended revision is not visible yet at this point, but any
  // media removed by this update is already classified from retained history.
  syncDocumentMediaBindingsFromHistory(database, workspaceId, documentId, createdAt);
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
  if (!hasBindingProvenanceColumns(database)) {
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
    return;
  }
  const mediaIds = new Set<string>();
  for (const revision of revisions) {
    try {
      const content = nyxdocDocumentV2Schema.safeParse(JSON.parse(revision.snapshot_json));
      if (content.success) {
        documentMediaIds(content.data).forEach((mediaId) => mediaIds.add(mediaId));
      }
    } catch {
      // Older or damaged snapshots remain readable without weakening media authorization.
    }
  }
  database.prepare(
    `UPDATE document_media_bindings
     SET revision_binding = 0
     WHERE workspace_id = ? AND document_id = ? AND revision_binding <> 0`,
  ).run(workspaceId, documentId);
  for (const mediaId of mediaIds) {
    upsertDocumentMediaBinding(database, {
      workspaceId,
      documentId,
      mediaId,
      current: false,
      history: true,
      createdAt,
    });
  }
}

export function documentHasMediaBinding(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  mediaId: string,
) {
  if (!hasBindingProvenanceColumns(database)) {
    return Boolean(database.prepare(
      `SELECT 1 FROM document_media_bindings
       WHERE workspace_id = ? AND document_id = ? AND media_id = ?`,
    ).get(workspaceId, documentId, mediaId));
  }
  return Boolean(database.prepare(
    `SELECT 1 FROM document_media_bindings
     WHERE workspace_id = ? AND document_id = ? AND media_id = ?
       AND (current_binding <> 0 OR revision_binding <> 0)`,
  ).get(workspaceId, documentId, mediaId));
}

/**
 * Returns a document binding that authorizes a media asset in its exact
 * context. Current-document media needs document read access; revision-only
 * media additionally needs revision read access.
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
    canReadRevision?: (documentId: string) => boolean;
  },
) {
  const supportsProvenance = hasBindingProvenanceColumns(database);
  const bindings = database.prepare(
    `SELECT binding.document_id${supportsProvenance ? ", binding.current_binding, binding.revision_binding" : ""}
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
  ).all(input.workspaceId, input.mediaId) as Array<{
    document_id: string;
    current_binding?: number;
    revision_binding?: number;
  }>;

  if (!supportsProvenance) {
    return bindings.find((binding) => input.canReadDocument(binding.document_id))?.document_id ?? null;
  }

  for (const binding of bindings) {
    if (
      Number(binding.current_binding) !== 0
      && input.canReadDocument(binding.document_id)
    ) {
      return binding.document_id;
    }
  }
  for (const binding of bindings) {
    if (
      Number(binding.revision_binding) !== 0
      && input.canReadDocument(binding.document_id)
      && input.canReadRevision?.(binding.document_id)
    ) {
      return binding.document_id;
    }
  }
  return null;
}
