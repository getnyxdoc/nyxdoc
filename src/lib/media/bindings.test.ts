import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDocument,
  getDocument,
  updateDocument,
} from "@/lib/documents/service";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";
import {
  assertDocumentMediaAssetsBelongToWorkspace,
  bindMediaAssetToDocument,
  documentHasMediaBinding,
  resolveAuthorizedMediaDocumentBinding,
  syncDocumentMediaBindingsFromHistory,
} from "@/lib/media/bindings";
import {
  authenticateApiToken,
  createWorkspaceToken,
  tokenCanAccessDocument,
  tokenDocumentActor,
} from "@/lib/tokens/service";
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

function imageContent(
  mediaId: string,
  blockId: string = randomUUID(),
): NyxdocDocumentV2 {
  return {
    schemaVersion: 2,
    blocks: [{
      id: blockId,
      type: "img",
      mediaId,
      url: `/api/media/${mediaId}`,
      children: [{ text: "" }],
    }],
  };
}

function insertMediaAsset(
  database: ReturnType<typeof createTestDatabase>,
  workspaceId: string,
  userId: string,
) {
  const mediaId = randomUUID();
  database.prepare(
    `INSERT INTO media_assets
     (id, workspace_id, storage_key, sha256, mime_type, byte_size,
      original_filename, uploaded_by_user_id, uploaded_by_token_id, created_at)
     VALUES (?, ?, ?, ?, 'image/png', 1, NULL, ?, NULL, ?)`,
  ).run(
    mediaId,
    workspaceId,
    `${mediaId}.png`,
    `sha-${mediaId}`,
    userId,
    new Date().toISOString(),
  );
  return mediaId;
}

describe("media document bindings", () => {
  it("accepts only media assets owned by the document workspace", () => {
    const database = createTestDatabase();
    const owner = createTestUser(database);
    const foreign = createTestUser(database, {
      name: "Foreign media owner",
      email: "foreign-media-binding@example.com",
    });
    const ownedMediaId = randomUUID();
    const foreignMediaId = randomUUID();
    const now = new Date().toISOString();
    const insert = database.prepare(
      `INSERT INTO media_assets
       (id, workspace_id, storage_key, sha256, mime_type, byte_size,
        original_filename, uploaded_by_user_id, uploaded_by_token_id, created_at)
       VALUES (?, ?, ?, ?, 'image/png', 1, NULL, ?, NULL, ?)`,
    );
    insert.run(
      ownedMediaId,
      owner.workspace.id,
      `${ownedMediaId}.png`,
      `sha-${ownedMediaId}`,
      owner.user.id,
      now,
    );
    insert.run(
      foreignMediaId,
      foreign.workspace.id,
      `${foreignMediaId}.png`,
      `sha-${foreignMediaId}`,
      foreign.user.id,
      now,
    );
    const content = (mediaId: string): NyxdocDocumentV2 => ({
      schemaVersion: 2 as const,
      blocks: [{
        id: randomUUID(),
        type: "img" as const,
        mediaId,
        url: `/api/media/${mediaId}`,
        children: [{ text: "" }],
      }],
    });

    expect(() => assertDocumentMediaAssetsBelongToWorkspace(
      database,
      owner.workspace.id,
      content(ownedMediaId),
    )).not.toThrow();
    expect(() => assertDocumentMediaAssetsBelongToWorkspace(
      database,
      owner.workspace.id,
      content(foreignMediaId),
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => assertDocumentMediaAssetsBelongToWorkspace(
      database,
      owner.workspace.id,
      content(randomUUID()),
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

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

  it("requires revisions.read for an image retained only by a past revision", () => {
    const database = createTestDatabase();
    const { user, workspace } = createTestUser(database);
    const mediaId = insertMediaAsset(database, workspace.id, user.id);
    const document = createDocument(database, workspace.id, {
      type: "human",
      userId: user.id,
      label: user.name,
      source: "web",
    }, {
      title: "Former image",
      content: imageContent(mediaId, "former-image"),
    }).document;
    updateDocument(database, workspace.id, {
      type: "human",
      userId: user.id,
      label: user.name,
      source: "web",
    }, document.id, {
      baseRevision: document.revisionNumber,
      content: {
        schemaVersion: 2,
        blocks: [{ id: "replacement-paragraph", type: "p", children: [{ text: "No image now" }] }],
      },
    });

    expect(database.prepare(
      `SELECT current_binding, revision_binding
       FROM document_media_bindings
       WHERE workspace_id = ? AND document_id = ? AND media_id = ?`,
    ).get(workspace.id, document.id, mediaId)).toEqual({
      current_binding: 0,
      revision_binding: 1,
    });
    expect(resolveAuthorizedMediaDocumentBinding(database, {
      workspaceId: workspace.id,
      mediaId,
      canReadDocument: (documentId) => documentId === document.id,
    })).toBeNull();
    expect(resolveAuthorizedMediaDocumentBinding(database, {
      workspaceId: workspace.id,
      mediaId,
      canReadDocument: (documentId) => documentId === document.id,
      canReadRevision: (documentId) => documentId === document.id,
    })).toBe(document.id);
  });

  it("clears stale historical provenance when retained revision snapshots no longer reference it", () => {
    const database = createTestDatabase();
    const { user, workspace } = createTestUser(database);
    const document = createActiveDocument(database, workspace.id, user.id, "No image history");
    const mediaId = insertMediaAsset(database, workspace.id, user.id);
    bindMediaAssetToDocument(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      mediaId,
    });
    database.prepare(
      `UPDATE document_media_bindings
       SET current_binding = 0, revision_binding = 1
       WHERE workspace_id = ? AND document_id = ? AND media_id = ?`,
    ).run(workspace.id, document.id, mediaId);

    syncDocumentMediaBindingsFromHistory(database, workspace.id, document.id);

    expect(database.prepare(
      `SELECT current_binding, revision_binding
       FROM document_media_bindings
       WHERE workspace_id = ? AND document_id = ? AND media_id = ?`,
    ).get(workspace.id, document.id, mediaId)).toEqual({
      current_binding: 0,
      revision_binding: 0,
    });
    expect(documentHasMediaBinding(
      database,
      workspace.id,
      document.id,
      mediaId,
    )).toBe(false);
  });

  it("does not let a tree-scoped agent bind known media from an unreadable document", () => {
    const database = createTestDatabase();
    const { user, workspace } = createTestUser(database);
    const allowedRoot = createActiveDocument(database, workspace.id, user.id, "Allowed root");
    const allowedChild = createActiveDocument(
      database,
      workspace.id,
      user.id,
      "Allowed child",
      allowedRoot.id,
    );
    const mediaId = insertMediaAsset(database, workspace.id, user.id);
    const source = createDocument(database, workspace.id, {
      type: "human",
      userId: user.id,
      label: user.name,
      source: "web",
    }, {
      title: "Outside media source",
      content: imageContent(mediaId, "outside-media"),
    }).document;
    const credential = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Tree-scoped media agent",
      role: "editor",
      rootDocumentId: allowedRoot.id,
      scopes: ["documents:read", "documents:write", "documents:commit"],
    });
    const identity = authenticateApiToken(database, `Bearer ${credential.token}`);
    const actor = tokenDocumentActor(identity, "mcp");
    const canReadDocument = (documentId: string) =>
      tokenCanAccessDocument(database, identity, documentId);

    expect(canReadDocument(source.id)).toBe(false);
    expect(resolveAuthorizedMediaDocumentBinding(database, {
      workspaceId: workspace.id,
      mediaId,
      canReadDocument,
    })).toBeNull();

    expect(() => updateDocument(database, workspace.id, actor, allowedChild.id, {
      baseRevision: allowedChild.revisionNumber,
      content: imageContent(mediaId, "escalation-attempt"),
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const documentCountBeforeCreate = database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
    ).get(workspace.id);
    expect(() => createDocument(database, workspace.id, actor, {
      title: "Escalation attempt child",
      parentDocumentId: allowedRoot.id,
      content: imageContent(mediaId, "create-escalation-attempt"),
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
    ).get(workspace.id)).toEqual(documentCountBeforeCreate);

    expect(documentHasMediaBinding(
      database,
      workspace.id,
      allowedChild.id,
      mediaId,
    )).toBe(false);
    expect(resolveAuthorizedMediaDocumentBinding(database, {
      workspaceId: workspace.id,
      mediaId,
      canReadDocument,
    })).toBeNull();
    expect(getDocument(database, workspace.id, allowedChild.id)).toMatchObject({
      revisionNumber: allowedChild.revisionNumber,
      content: allowedChild.content,
    });
  });

  it("allows a tree-scoped agent to reuse media from readable scope and its current document", () => {
    const database = createTestDatabase();
    const { user, workspace } = createTestUser(database);
    const mediaId = insertMediaAsset(database, workspace.id, user.id);
    const allowedRoot = createDocument(database, workspace.id, {
      type: "human",
      userId: user.id,
      label: user.name,
      source: "web",
    }, {
      title: "Readable media source",
      content: imageContent(mediaId, "readable-source-media"),
    }).document;
    const allowedChild = createActiveDocument(
      database,
      workspace.id,
      user.id,
      "Allowed reuse target",
      allowedRoot.id,
    );
    const credential = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Tree-scoped reuse agent",
      role: "editor",
      rootDocumentId: allowedRoot.id,
      scopes: ["documents:read", "documents:write", "documents:commit"],
    });
    const identity = authenticateApiToken(database, `Bearer ${credential.token}`);
    const actor = tokenDocumentActor(identity, "mcp");

    const reused = updateDocument(database, workspace.id, actor, allowedChild.id, {
      baseRevision: allowedChild.revisionNumber,
      content: imageContent(mediaId, "readable-scope-reuse"),
    }).document;
    expect(documentHasMediaBinding(
      database,
      workspace.id,
      allowedChild.id,
      mediaId,
    )).toBe(true);

    const sameDocumentEdit = updateDocument(database, workspace.id, actor, allowedChild.id, {
      baseRevision: reused.revisionNumber,
      title: "Allowed reuse target edited",
      content: imageContent(mediaId, "same-document-reuse"),
    }).document;
    expect(sameDocumentEdit).toMatchObject({
      title: "Allowed reuse target edited",
      revisionNumber: reused.revisionNumber + 1,
    });
  });
});
