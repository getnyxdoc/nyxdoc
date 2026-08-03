import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDocument } from "@/lib/documents/service";
import {
  bindMediaAssetToDocument,
  resolveAuthorizedMediaDocumentBinding,
} from "@/lib/media/bindings";
import { createTestDatabase, createTestUser } from "@/test/fixture";

function createActiveDocument(
  database: ReturnType<typeof createTestDatabase>,
  workspaceId: string,
  userId: string,
  title: string,
  parentDocumentId?: string,
) {
  return createDocument(database, workspaceId, {
    type: "human",
    userId,
    label: "Owner",
    source: "web",
  }, {
    title,
    parentDocumentId,
    content: { schemaVersion: 2, blocks: [{ id: randomUUID(), type: "p", children: [{ text: title }] }] },
  }).document;
}

describe("media document bindings", () => {
  it("resolves an asset only through an active in-scope document binding", () => {
    const database = createTestDatabase();
    const { user, workspace } = createTestUser(database);
    const root = createActiveDocument(database, workspace.id, user.id, "Root");
    const child = createActiveDocument(database, workspace.id, user.id, "Child", root.id);
    const outside = createActiveDocument(database, workspace.id, user.id, "Outside");
    const mediaId = randomUUID();
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO media_assets
       (id, workspace_id, storage_key, sha256, mime_type, byte_size,
        original_filename, uploaded_by_user_id, uploaded_by_token_id, created_at)
       VALUES (?, ?, ?, ?, 'image/png', 1, NULL, ?, NULL, ?)`,
    ).run(mediaId, workspace.id, `${mediaId}.png`, `sha-${mediaId}`, user.id, now);
    bindMediaAssetToDocument(database, { workspaceId: workspace.id, documentId: child.id, mediaId });

    expect(resolveAuthorizedMediaDocumentBinding(database, {
      workspaceId: workspace.id,
      mediaId,
      canReadDocument: (documentId) => documentId === root.id || documentId === child.id,
    })).toBe(child.id);
    expect(resolveAuthorizedMediaDocumentBinding(database, {
      workspaceId: workspace.id,
      mediaId,
      canReadDocument: (documentId) => documentId === outside.id,
    })).toBeNull();
  });

  it("fails closed when an asset has no active document binding", () => {
    const database = createTestDatabase();
    const { user, workspace } = createTestUser(database);
    const mediaId = randomUUID();
    database.prepare(
      `INSERT INTO media_assets
       (id, workspace_id, storage_key, sha256, mime_type, byte_size,
        original_filename, uploaded_by_user_id, uploaded_by_token_id, created_at)
       VALUES (?, ?, ?, ?, 'image/png', 1, NULL, ?, NULL, ?)`,
    ).run(mediaId, workspace.id, `${mediaId}.png`, `sha-${mediaId}`, user.id, new Date().toISOString());

    expect(resolveAuthorizedMediaDocumentBinding(database, {
      workspaceId: workspace.id,
      mediaId,
      canReadDocument: () => true,
    })).toBeNull();
  });
});
