import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCollaborationCommands,
  createStoredCollaborationDocumentProvider,
} from "@/lib/collaboration/commands";
import {
  collaborationYDocFromState,
  ensureCollaborationState,
  loadCollaborationStateByRoom,
  persistCollaborationUpdate,
  replaceWorkingDocument,
  workingDocumentFromStoredState,
} from "@/lib/collaboration/drafts";
import type { NyxDatabase } from "@/lib/db/client";
import {
  createDocument,
  getDocument,
  listDocumentRevisions,
} from "@/lib/documents/service";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import { documentHasMediaBinding } from "@/lib/media/bindings";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const actor = {
    type: "human" as const,
    userId: user.id,
    principalId: user.id,
    label: user.name,
    source: "web" as const,
  };
  const created = createDocument(database, workspace.id, actor, {
    title: "통합 하드닝 문서",
    content: parseNyxdocDocumentV2({
      schemaVersion: 2,
      blocks: [{ id: "canonical", type: "p", children: [{ text: "정본" }] }],
    }),
  });
  const state = ensureCollaborationState(database, workspace.id, created.document.id);
  return { database, user, workspace, actor, created, state };
}

function insertMediaAsset(
  database: NyxDatabase,
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

function imageDocument(mediaId: string) {
  return parseNyxdocDocumentV2({
    schemaVersion: 2,
    blocks: [{
      id: "image",
      type: "img",
      mediaId,
      url: `/api/media/${mediaId}`,
      children: [{ text: "" }],
    }],
  });
}

function collaborationRequestCount(database: NyxDatabase, requestId: string) {
  return Number((database.prepare(
    `SELECT COUNT(*) AS count
     FROM collaboration_idempotency_requests
     WHERE request_id = ?`,
  ).get(requestId) as { count: number }).count);
}

describe("integrated collaboration hardening invariants", () => {
  it("never lets a rejected stale-process commit overwrite a concurrently persisted Yjs update", async () => {
    const { database, workspace, actor, created, state } = fixture();
    const staleProcessDocument = collaborationYDocFromState(state.state);
    const concurrentProcessDocument = collaborationYDocFromState(state.state);
    const concurrentActor = {
      ...actor,
      principalId: "concurrent-process",
      label: "Concurrent process",
      source: "api" as const,
    };

    replaceWorkingDocument(concurrentProcessDocument, { tags: ["process-b"] }, {
      context: { actor: concurrentActor, recordedByEndpoint: true },
    });
    const concurrentState = persistCollaborationUpdate(
      database,
      state.roomName,
      concurrentProcessDocument,
      concurrentActor,
    );
    expect(concurrentState.draftVersion).toBe(1);
    expect(workingDocumentFromStoredState(database, workspace.id, created.document.id))
      .toMatchObject({
        title: "통합 하드닝 문서",
        metadata: { tags: ["process-b"] },
        draftVersion: 1,
      });

    // This process did not receive process B's update, but made its own local
    // edit before attempting a commit with the latest observed draft version.
    replaceWorkingDocument(staleProcessDocument, { title: "stale process title" }, {
      context: { actor, recordedByEndpoint: true },
    });
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          expect(roomName).toBe(state.roomName);
          return await callback(staleProcessDocument);
        },
        closeConnections() {},
      },
    });
    const requestId = "integrated-stale-commit-001";

    await expect(commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId,
      expectedDraftVersion: concurrentState.draftVersion,
      summary: "stale process must not clobber process B",
    })).rejects.toMatchObject({ code: "DRAFT_VERSION_CONFLICT" });

    // A failed commit is observationally atomic: the concurrent stored update,
    // optimistic token, canonical revision, and idempotency ledger stay fixed.
    expect(workingDocumentFromStoredState(database, workspace.id, created.document.id))
      .toMatchObject({
        title: "통합 하드닝 문서",
        metadata: { tags: ["process-b"] },
        draftVersion: 1,
      });
    expect(getDocument(database, workspace.id, created.document.id)).toMatchObject({
      title: "통합 하드닝 문서",
      tags: [],
      revisionNumber: 1,
    });
    expect(collaborationRequestCount(database, requestId)).toBe(0);
  });

  it("rejects an invalid live media reference before changing stored draft, canonical history, or receipt", async () => {
    const { database, workspace, actor, created, state } = fixture();
    const other = createTestUser(database, { name: "Other workspace owner" });
    const foreignMediaId = insertMediaAsset(database, other.workspace.id, other.user.id);
    const liveDocument = collaborationYDocFromState(state.state);
    replaceWorkingDocument(liveDocument, { content: imageDocument(foreignMediaId) }, {
      context: { actor, recordedByEndpoint: true },
    });
    const storedBefore = loadCollaborationStateByRoom(database, state.roomName);
    const requestId = "integrated-invalid-media-001";
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          expect(roomName).toBe(state.roomName);
          return await callback(liveDocument);
        },
        closeConnections() {},
      },
    });

    await expect(commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId,
      expectedDraftVersion: state.draftVersion,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const storedAfter = loadCollaborationStateByRoom(database, state.roomName);
    expect(storedAfter.state).toEqual(storedBefore.state);
    expect(storedAfter.draftVersion).toBe(storedBefore.draftVersion);
    expect(workingDocumentFromStoredState(database, workspace.id, created.document.id).content)
      .toEqual(created.document.content);
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);
    expect(collaborationRequestCount(database, requestId)).toBe(0);
  });

  it("commits the exact projected valid-media draft once and binds only canonical content", async () => {
    const { database, user, workspace, actor, created, state } = fixture();
    const mediaId = insertMediaAsset(database, workspace.id, user.id);
    const commands = createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    });
    const content = imageDocument(mediaId);
    const changed = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: "integrated-valid-media-draft-001",
      expectedDraftVersion: state.draftVersion,
      replacement: { content },
    });
    expect(changed.workingDocument.content).toEqual(content);

    const committed = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId: "integrated-valid-media-commit-001",
      expectedDraftVersion: changed.workingDocument.draftVersion,
      summary: "valid media invariant",
    });

    expect(committed.unchanged).toBe(false);
    expect(committed.document).toMatchObject({
      revisionNumber: 2,
      content,
    });
    expect(committed.workingDocument).toMatchObject({
      content,
      hasUncommittedChanges: false,
    });
    expect(committed.workingDocument.committedDraftVersion)
      .toBe(committed.workingDocument.draftVersion);
    expect(getDocument(database, workspace.id, created.document.id).content).toEqual(content);
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);
    expect(documentHasMediaBinding(
      database,
      workspace.id,
      created.document.id,
      mediaId,
    )).toBe(true);
  });
});
