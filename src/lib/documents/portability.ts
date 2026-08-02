import type { NyxDatabase } from "@/lib/db/client";
import { nyxdocToMarkdown } from "@/lib/documents/markdown";
import { getDocument } from "@/lib/documents/service";

export function exportDocumentMarkdown(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
) {
  const document = getDocument(database, workspaceId, documentId);
  return {
    format: "markdown" as const,
    documentId: document.id,
    revisionNumber: document.revisionNumber,
    filename: `${document.slug}.md`,
    data: nyxdocToMarkdown(document.content),
  };
}

export function exportNyxdocBundle(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
) {
  const document = getDocument(database, workspaceId, documentId);
  const mediaIds = document.content.blocks.flatMap((block) => block.type === "img" ? [block.mediaId] : []);
  const media = mediaIds.length === 0
    ? []
    : database.prepare(
      `SELECT id, sha256, mime_type, byte_size, original_filename, created_at
       FROM media_assets
       WHERE workspace_id = ? AND id IN (${mediaIds.map(() => "?").join(",")})
       ORDER BY created_at ASC, id ASC`,
    ).all(workspaceId, ...mediaIds) as Array<{
      id: string;
      sha256: string;
      mime_type: string;
      byte_size: number;
      original_filename: string | null;
      created_at: string;
    }>;
  const bundle = {
    bundleVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    document: {
      id: document.id,
      title: document.title,
      slug: document.slug,
      parentDocumentId: document.parentDocumentId,
      revisionId: document.revisionId,
      revisionNumber: document.revisionNumber,
      metadata: {
        documentType: document.documentType,
        workflowStatus: document.workflowStatus,
        tags: document.tags,
      },
      content: document.content,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    },
    media: media.map((asset) => ({
      id: asset.id,
      url: `/api/media/${asset.id}`,
      sha256: asset.sha256,
      mimeType: asset.mime_type,
      byteSize: Number(asset.byte_size),
      originalFilename: asset.original_filename,
      createdAt: asset.created_at,
    })),
  };
  return {
    format: "nyxdoc_json" as const,
    documentId: document.id,
    revisionNumber: document.revisionNumber,
    filename: `${document.slug}.nyxdoc.json`,
    data: bundle,
  };
}
