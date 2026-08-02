import { randomBytes, randomUUID } from "node:crypto";
import { recordWorkspaceAuditEvent } from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import { getDocument } from "@/lib/documents/service";
import type { DocumentDetail } from "@/lib/documents/types";

type PublicShareRow = {
  id: string;
  workspace_id: string;
  document_id: string;
  public_token: string;
  enabled: number;
  created_by_user_id: string;
  created_by_label: string;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
};

export type DocumentPublicShare = {
  id: string;
  workspaceId: string;
  documentId: string;
  publicToken: string;
  enabled: boolean;
  createdByUserId: string;
  createdByLabel: string;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
};

export type PublicSharedDocument = {
  share: DocumentPublicShare;
  workspace: { id: string; name: string };
  document: DocumentDetail;
};

export class PublicShareError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "PublicShareError";
  }
}

function mapShare(row: PublicShareRow): DocumentPublicShare {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    documentId: row.document_id,
    publicToken: row.public_token,
    enabled: row.enabled === 1,
    createdByUserId: row.created_by_user_id,
    createdByLabel: row.created_by_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  };
}

function loadShare(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
) {
  return database.prepare(
    `SELECT id, workspace_id, document_id, public_token, enabled,
            created_by_user_id, created_by_label, created_at, updated_at, disabled_at
     FROM document_public_shares
     WHERE workspace_id = ? AND document_id = ?`,
  ).get(workspaceId, documentId) as PublicShareRow | undefined;
}

export function getDocumentPublicShare(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
) {
  getDocument(database, workspaceId, documentId);
  const row = loadShare(database, workspaceId, documentId);
  return row ? mapShare(row) : null;
}

export function enableDocumentPublicShare(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    documentId: string;
    userId: string;
    actorLabel: string;
  },
) {
  getDocument(database, input.workspaceId, input.documentId);
  const now = new Date().toISOString();
  const existing = loadShare(database, input.workspaceId, input.documentId);

  if (existing) {
    if (!existing.enabled) {
      database.prepare(
        `UPDATE document_public_shares
         SET enabled = 1, updated_at = ?, disabled_at = NULL
         WHERE id = ?`,
      ).run(now, existing.id);
      recordWorkspaceAuditEvent(database, {
        workspaceId: input.workspaceId,
        action: "document.public_share.enabled",
        actorType: "human",
        actorUserId: input.userId,
        actorLabel: input.actorLabel,
        targetType: "document",
        targetId: input.documentId,
      });
    }
    return mapShare(loadShare(database, input.workspaceId, input.documentId)!);
  }

  const id = randomUUID();
  const publicToken = randomBytes(32).toString("base64url");
  database.prepare(
    `INSERT INTO document_public_shares
     (id, workspace_id, document_id, public_token, enabled,
      created_by_user_id, created_by_label, created_at, updated_at, disabled_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.workspaceId,
    input.documentId,
    publicToken,
    input.userId,
    input.actorLabel,
    now,
    now,
  );
  recordWorkspaceAuditEvent(database, {
    workspaceId: input.workspaceId,
    action: "document.public_share.created",
    actorType: "human",
    actorUserId: input.userId,
    actorLabel: input.actorLabel,
    targetType: "document",
    targetId: input.documentId,
  });
  return mapShare(loadShare(database, input.workspaceId, input.documentId)!);
}

export function disableDocumentPublicShare(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    documentId: string;
    userId: string;
    actorLabel: string;
  },
) {
  getDocument(database, input.workspaceId, input.documentId);
  const existing = loadShare(database, input.workspaceId, input.documentId);
  if (!existing) return null;
  if (existing.enabled) {
    const now = new Date().toISOString();
    database.prepare(
      `UPDATE document_public_shares
       SET enabled = 0, updated_at = ?, disabled_at = ?
       WHERE id = ?`,
    ).run(now, now, existing.id);
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: "document.public_share.disabled",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "document",
      targetId: input.documentId,
    });
  }
  return mapShare(loadShare(database, input.workspaceId, input.documentId)!);
}

export function getPublicSharedDocument(
  database: NyxDatabase,
  publicToken: string,
): PublicSharedDocument {
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicToken)) {
    throw new PublicShareError("NOT_FOUND", "공유 문서를 찾을 수 없습니다.");
  }
  const row = database.prepare(
    `SELECT share.id, share.workspace_id, share.document_id, share.public_token,
            share.enabled, share.created_by_user_id, share.created_by_label,
            share.created_at, share.updated_at, share.disabled_at,
            workspace.name AS workspace_name
     FROM document_public_shares share
     JOIN workspaces workspace ON workspace.id = share.workspace_id
     JOIN documents document ON document.id = share.document_id
     WHERE share.public_token = ?
       AND share.enabled = 1
       AND workspace.lifecycle_state = 'active'
       AND document.status = 'active'
       AND document.lifecycle_state = 'active'`,
  ).get(publicToken) as (PublicShareRow & { workspace_name: string }) | undefined;
  if (!row) throw new PublicShareError("NOT_FOUND", "공유 문서를 찾을 수 없습니다.");
  return {
    share: mapShare(row),
    workspace: { id: row.workspace_id, name: row.workspace_name },
    document: getDocument(database, row.workspace_id, row.document_id),
  };
}

export function publicDocumentMediaIds(document: DocumentDetail) {
  const mediaIds = new Set<string>();
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "img" && typeof record.mediaId === "string") {
      mediaIds.add(record.mediaId);
    }
    if (Array.isArray(record.children)) record.children.forEach(visit);
  }
  visit(document.content.blocks);
  return mediaIds;
}
