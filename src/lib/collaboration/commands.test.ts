import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { slateNodesToInsertDelta } from "@slate-yjs/core";
import * as Y from "yjs";
import {
  createCollaborationCommands,
  createStoredCollaborationDocumentProvider,
} from "@/lib/collaboration/commands";
import {
  assignAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
  updateAgentWorkspaceMembership,
} from "@/lib/agents/service";
import {
  collaborationRoomName,
  collaborationYDocFromState,
  ensureCollaborationState,
  loadCollaborationStateByRoom,
  persistCollaborationUpdate,
  replaceWorkingDocument,
} from "@/lib/collaboration/drafts";
import type { NyxDatabase } from "@/lib/db/client";
import {
  createDocument,
  getDocument,
  getDocumentRevisionSnapshotByNumber,
  listDocumentRevisions,
  restoreTrashedDocument,
} from "@/lib/documents/service";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import { setDocumentHumanGrant } from "@/lib/sharing/access";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
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
    title: "공유 초안 테스트",
    content: parseNyxdocDocumentV2({
      schemaVersion: 2,
      blocks: [{ id: "initial", type: "p", children: [{ text: "정본 1" }] }],
    }),
  });
  const commands = createCollaborationCommands({
    database,
    provider: createStoredCollaborationDocumentProvider(database),
  });
  return { database, workspace, actor, created, commands };
}

function liveFixture() {
  const base = fixture();
  const state = ensureCollaborationState(
    base.database,
    base.workspace.id,
    base.created.document.id,
  );
  const liveDocument = collaborationYDocFromState(state.state);
  const commands = createCollaborationCommands({
    database: base.database,
    provider: {
      async withDocument(roomName, callback) {
        expect(roomName).toBe(state.roomName);
        return await callback(liveDocument);
      },
      closeConnections() {},
    },
  });
  return { ...base, state, liveDocument, commands };
}

function storedDraftSnapshot(database: NyxDatabase, documentId: string) {
  const row = database.prepare(
    `SELECT generation, draft_version, yjs_state
     FROM document_collaboration_states
     WHERE document_id = ?`,
  ).get(documentId) as {
    generation: number;
    draft_version: number;
    yjs_state: Buffer;
  } | undefined;
  if (!row) throw new Error("expected a stored collaboration draft");
  return {
    generation: Number(row.generation),
    draftVersion: Number(row.draft_version),
    state: Buffer.from(row.yjs_state),
  };
}

function storedDraftAtomicSnapshot(database: NyxDatabase, documentId: string) {
  const row = database.prepare(
    `SELECT generation, draft_version, committed_draft_version,
            base_revision_id, base_revision_number, yjs_state, committed_yjs_state,
            updated_at, committed_at, last_actor_type, last_actor_principal_id,
            last_actor_label, last_actor_avatar_media_id
     FROM document_collaboration_states
     WHERE document_id = ?`,
  ).get(documentId) as {
    generation: number;
    draft_version: number;
    committed_draft_version: number;
    base_revision_id: string | null;
    base_revision_number: number;
    yjs_state: Buffer;
    committed_yjs_state: Buffer;
    updated_at: string;
    committed_at: string | null;
    last_actor_type: string | null;
    last_actor_principal_id: string | null;
    last_actor_label: string | null;
    last_actor_avatar_media_id: string | null;
  } | undefined;
  if (!row) throw new Error("expected a stored collaboration draft");
  return {
    ...row,
    yjs_state: Buffer.from(row.yjs_state),
    committed_yjs_state: Buffer.from(row.committed_yjs_state),
  };
}

function storedContributors(database: NyxDatabase, documentId: string) {
  return database.prepare(
    `SELECT generation, contributor_key, actor_type, actor_principal_id,
            actor_label, actor_avatar_media_id, first_edit_at, last_edit_at, update_count
     FROM document_draft_contributors
     WHERE document_id = ?
     ORDER BY generation, contributor_key`,
  ).all(documentId);
}

function insertTestMediaAsset(
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

function imageBlock(mediaId: string, id = "draft-image") {
  return {
    id,
    type: "img" as const,
    mediaId,
    url: `/api/media/${mediaId}`,
    children: [{ text: "" }],
  };
}

const atomicMutationCases = [
  {
    name: "replaceWorking",
    requestId: "replace-failure-atomicity-001",
    expectedTitle: "원자적으로 교체한 제목",
    expectedText: "원자적으로 교체한 본문",
    run(input: ReturnType<typeof liveFixture>) {
      return input.commands.replaceWorking({
        roomName: input.state.roomName,
        actor: input.actor,
        requestId: "replace-failure-atomicity-001",
        expectedDraftVersion: input.state.draftVersion,
        replacement: {
          title: "원자적으로 교체한 제목",
          content: parseNyxdocDocumentV2({
            schemaVersion: 2,
            blocks: [{ id: "initial", type: "p", children: [{ text: "원자적으로 교체한 본문" }] }],
          }),
        },
      });
    },
  },
  {
    name: "patchWorking",
    requestId: "patch-failure-atomicity-001",
    expectedTitle: "공유 초안 테스트",
    expectedText: "원자적으로 패치한 본문",
    run(input: ReturnType<typeof liveFixture>) {
      return input.commands.patchWorking({
        roomName: input.state.roomName,
        actor: input.actor,
        requestId: "patch-failure-atomicity-001",
        expectedDraftVersion: input.state.draftVersion,
        operations: [{
          op: "replace_block",
          blockId: "initial",
          block: {
            id: "initial",
            type: "p",
            children: [{ text: "원자적으로 패치한 본문" }],
          },
        }],
      });
    },
  },
];

describe("collaboration command engine", () => {
  it("does not create a revision when a pristine document ends with a table", async () => {
    const { database, workspace, actor, commands } = fixture();
    const created = createDocument(database, workspace.id, actor, {
      title: "표로 끝나는 정본",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{
          id: "no-op-terminal-table",
          type: "table",
          children: [{
            id: "no-op-terminal-row",
            type: "tr",
            children: [{
              id: "no-op-terminal-cell",
              type: "td",
              children: [{
                id: "no-op-terminal-cell-paragraph",
                type: "p",
                children: [{ text: "정본 표" }],
              }],
            }],
          }],
        }],
      }),
    });
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const before = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });

    expect(before.workingDocument.content.blocks).toHaveLength(1);
    expect(before.workingDocument.hasUncommittedChanges).toBe(false);

    const committed = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId: "terminal-table-no-op-commit-001",
      expectedDraftVersion: before.workingDocument.draftVersion,
    });

    expect(committed.unchanged).toBe(true);
    expect(committed.document.revisionNumber).toBe(1);
    expect(committed.document.content).toEqual(created.document.content);
    expect(committed.workingDocument.hasUncommittedChanges).toBe(false);
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);
  });

  it.each(["missing", "foreign"] as const)(
    "rejects a %s-workspace media reference before replacing the shared draft",
    async (kind) => {
      const input = liveFixture();
      const initial = await input.commands.readWorking({
        workspaceId: input.workspace.id,
        documentId: input.created.document.id,
      });
      const mediaId = kind === "missing"
        ? randomUUID()
        : (() => {
            const other = createTestUser(input.database, {
              name: "Foreign Media Owner",
              email: `foreign-media-${randomUUID()}@example.com`,
            });
            return insertTestMediaAsset(
              input.database,
              other.workspace.id,
              other.user.id,
            );
          })();
      const storedBefore = storedDraftSnapshot(
        input.database,
        input.created.document.id,
      );

      await expect(input.commands.replaceWorking({
        roomName: input.state.roomName,
        actor: input.actor,
        expectedDraftVersion: initial.workingDocument.draftVersion,
        requestId: `invalid-media-replace-${kind}-001`,
        replacement: {
          content: parseNyxdocDocumentV2({
            schemaVersion: 2,
            blocks: [imageBlock(mediaId)],
          }),
        },
      })).rejects.toMatchObject({ code: "INVALID_INPUT" });

      const storedAfter = storedDraftSnapshot(
        input.database,
        input.created.document.id,
      );
      expect(storedAfter).toEqual(storedBefore);
      expect((await input.commands.readWorking({
        workspaceId: input.workspace.id,
        documentId: input.created.document.id,
      })).workingDocument).toMatchObject({
        draftVersion: initial.workingDocument.draftVersion,
        content: initial.workingDocument.content,
      });
    },
  );

  it("rejects a foreign-workspace media reference before patching the shared draft", async () => {
    const input = liveFixture();
    const initial = await input.commands.readWorking({
      workspaceId: input.workspace.id,
      documentId: input.created.document.id,
    });
    const other = createTestUser(input.database, {
      name: "Foreign Patch Media Owner",
      email: "foreign-patch-media@example.com",
    });
    const mediaId = insertTestMediaAsset(
      input.database,
      other.workspace.id,
      other.user.id,
    );
    const storedBefore = storedDraftSnapshot(input.database, input.created.document.id);

    await expect(input.commands.patchWorking({
      roomName: input.state.roomName,
      actor: input.actor,
      expectedDraftVersion: initial.workingDocument.draftVersion,
      requestId: "invalid-media-patch-foreign-001",
      operations: [{
        op: "insert_after",
        anchorBlockId: "initial",
        blocks: [imageBlock(mediaId, "foreign-patch-image")],
      }],
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(storedDraftSnapshot(input.database, input.created.document.id)).toEqual(storedBefore);
    expect((await input.commands.readWorking({
      workspaceId: input.workspace.id,
      documentId: input.created.document.id,
    })).workingDocument).toMatchObject({
      draftVersion: initial.workingDocument.draftVersion,
      content: initial.workingDocument.content,
    });
  });

  it("does not persist an invalid live media reference through a metadata-only replacement", async () => {
    const input = liveFixture();
    const storedBefore = storedDraftSnapshot(input.database, input.created.document.id);
    replaceWorkingDocument(input.liveDocument, {
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [imageBlock(randomUUID(), "invalid-live-image")],
      }),
    }, "test-invalid-live-media");
    const invalidLive = await input.commands.readWorking({
      workspaceId: input.workspace.id,
      documentId: input.created.document.id,
    });

    await expect(input.commands.replaceWorking({
      roomName: input.state.roomName,
      actor: input.actor,
      expectedDraftVersion: invalidLive.workingDocument.draftVersion,
      requestId: "invalid-live-media-metadata-replace-001",
      replacement: { title: "제목만 변경" },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(storedDraftSnapshot(input.database, input.created.document.id)).toEqual(storedBefore);
  });

  it("treats CRDT history-only differences as clean when the rendered document is unchanged", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const initial = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });

    const replaced = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: "same-visible-document-001",
      expectedDraftVersion: initial.workingDocument.draftVersion,
      replacement: {
        title: initial.workingDocument.title,
        parentDocumentId: initial.workingDocument.parentDocumentId,
        documentType: initial.workingDocument.metadata.documentType,
        workflowStatus: initial.workingDocument.metadata.workflowStatus,
        tags: initial.workingDocument.metadata.tags,
        content: initial.workingDocument.content,
      },
    });

    expect(replaced.workingDocument.draftVersion).toBeGreaterThan(0);
    expect(replaced.workingDocument.hasUncommittedChanges).toBe(false);

    const committed = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId: "same-visible-commit-001",
      expectedDraftVersion: replaced.workingDocument.draftVersion,
    });
    expect(committed.unchanged).toBe(true);
    expect(committed.document.revisionNumber).toBe(1);
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);
  });

  it("persists drafts without revisions and creates a revision only on explicit commit", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const initialEventCount = database.prepare(
      "SELECT COUNT(*) AS count FROM document_events WHERE document_id = ?",
    ).get(created.document.id) as { count: number };

    const input = {
      roomName: state.roomName,
      actor,
      requestId: "draft-replace-001",
      expectedDraftVersion: 0,
      replacement: {
        title: "공유 초안 변경",
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [{ id: "initial", type: "p", children: [{ text: "초안 변경" }] }],
        }),
      },
    };
    const changed = await commands.replaceWorking(input);
    expect(changed.workingDocument).toMatchObject({
      draftVersion: 1,
      baseRevisionNumber: 1,
      hasUncommittedChanges: true,
    });
    expect(getDocument(database, workspace.id, created.document.id)).toMatchObject({
      title: "공유 초안 테스트",
      revisionNumber: 1,
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_events WHERE document_id = ?",
    ).get(created.document.id)).toEqual(initialEventCount);

    const replayedChange = await commands.replaceWorking(input);
    expect(replayedChange).toMatchObject({
      workingDocument: changed.workingDocument,
      mutationState: {
        source: "working",
        replayed: true,
        receipt: { draftVersion: 1 },
        current: { draftVersion: 1 },
      },
    });
    await expect(commands.replaceWorking({
      ...input,
      replacement: { title: "같은 requestId의 다른 요청" },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(commands.replaceWorking({
      ...input,
      requestId: "draft-replace-stale-001",
      replacement: { title: "오래된 초안 수정" },
    })).rejects.toMatchObject({
      code: "DRAFT_CONFLICT",
      details: { expectedDraftVersion: 0, currentDraftVersion: 1 },
    });

    const commitInput = {
      roomName: state.roomName,
      actor,
      requestId: "draft-commit-001",
      expectedDraftVersion: 1,
      summary: "공유 초안을 검토하고 저장했습니다.",
    };
    const committed = await commands.commitWorking(commitInput);
    expect(committed.document).toMatchObject({ title: "공유 초안 변경", revisionNumber: 2 });
    expect(committed.workingDocument).toMatchObject({
      baseRevisionNumber: 2,
      hasUncommittedChanges: false,
    });
    const replayedCommit = await commands.commitWorking(commitInput);
    expect(replayedCommit).toMatchObject({
      document: committed.document,
      workingDocument: committed.workingDocument,
      mutationState: {
        source: "working",
        replayed: true,
        receipt: { draftVersion: committed.workingDocument.draftVersion },
        current: { draftVersion: committed.workingDocument.draftVersion },
      },
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_events WHERE document_id = ?",
    ).get(created.document.id)).toEqual({ count: initialEventCount.count + 1 });
  });

  it("rejects a collaboration mutation when an OAuth actor ceiling is read-only", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const agent = createAccountAgent(database, {
      userId: actor.userId,
      displayName: "Read-only OAuth collaboration agent",
    });
    assignAgentToWorkspace(database, {
      userId: actor.userId,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const credential = createAgentCredential(database, {
      userId: actor.userId,
      agentId: agent.id,
      name: "broad-backing-credential",
      scopes: ["documents:read", "documents:write", "documents:commit"],
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    const oauthActor = {
      type: "agent" as const,
      userId: actor.userId,
      tokenId: credential.credential.id,
      principalId: agent.id,
      label: agent.displayName,
      source: "mcp" as const,
      scopeCeiling: Object.freeze(["documents:read"] as const),
    };
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const before = storedDraftAtomicSnapshot(database, created.document.id);

    await expect(commands.replaceWorking({
      roomName: state.roomName,
      actor: oauthActor,
      requestId: "oauth-read-only-collaboration-denied-001",
      expectedDraftVersion: state.draftVersion,
      replacement: { title: "Must not be written" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(before);
  });

  for (const mutation of atomicMutationCases) {
    for (const failurePoint of ["persistence", "receipt"] as const) {
      it(`${mutation.name} leaves the live and stored draft unchanged after ${failurePoint} failure and retries`, async () => {
        const context = liveFixture();
        const {
          database,
          workspace,
          created,
          commands,
          state,
          liveDocument,
        } = context;
        const initialWorking = await commands.readWorking({
          workspaceId: workspace.id,
          documentId: created.document.id,
        });
        const initialLiveState = Buffer.from(Y.encodeStateAsUpdate(liveDocument));
        const initialStored = storedDraftSnapshot(database, created.document.id);
        const triggerName = failurePoint === "persistence"
          ? "inject_collaboration_persistence_failure"
          : "inject_collaboration_receipt_failure";
        database.exec(failurePoint === "persistence"
          ? `CREATE TEMP TRIGGER ${triggerName}
             BEFORE UPDATE OF yjs_state ON document_collaboration_states
             BEGIN
               SELECT RAISE(ABORT, 'injected collaboration persistence failure');
             END;`
          : `CREATE TEMP TRIGGER ${triggerName}
             BEFORE INSERT ON collaboration_idempotency_requests
             BEGIN
               SELECT RAISE(ABORT, 'injected collaboration receipt failure');
             END;`);

        try {
          await expect(mutation.run(context)).rejects.toThrow(
            `injected collaboration ${failurePoint} failure`,
          );
        } finally {
          database.exec(`DROP TRIGGER ${triggerName}`);
        }

        const afterFailure = await commands.readWorking({
          workspaceId: workspace.id,
          documentId: created.document.id,
        });
        expect(afterFailure.workingDocument).toEqual(initialWorking.workingDocument);
        expect(afterFailure.workingDocument).toMatchObject({
          generation: state.generation,
          draftVersion: state.draftVersion,
          content: initialWorking.workingDocument.content,
        });
        expect(Buffer.from(Y.encodeStateAsUpdate(liveDocument))).toEqual(initialLiveState);
        expect(storedDraftSnapshot(database, created.document.id)).toEqual(initialStored);
        expect(database.prepare(
          `SELECT COUNT(*) AS count
           FROM collaboration_idempotency_requests
           WHERE request_id = ?`,
        ).get(mutation.requestId)).toEqual({ count: 0 });

        const retried = await mutation.run(context);
        expect(retried.workingDocument).toMatchObject({
          generation: state.generation,
          draftVersion: state.draftVersion + 1,
          title: mutation.expectedTitle,
        });
        expect(retried.workingDocument.content.blocks[0]).toMatchObject({
          id: "initial",
          children: [{ text: mutation.expectedText }],
        });
        const afterRetryStored = storedDraftSnapshot(database, created.document.id);
        expect(afterRetryStored).toMatchObject({
          generation: state.generation,
          draftVersion: state.draftVersion + 1,
        });
        expect(afterRetryStored.state).not.toEqual(initialStored.state);
        expect(Buffer.from(Y.encodeStateAsUpdate(liveDocument))).toEqual(afterRetryStored.state);
        expect((await commands.readWorking({
          workspaceId: workspace.id,
          documentId: created.document.id,
        })).workingDocument).toEqual(retried.workingDocument);
        expect(database.prepare(
          `SELECT COUNT(*) AS count
           FROM collaboration_idempotency_requests
           WHERE request_id = ?`,
        ).get(mutation.requestId)).toEqual({ count: 1 });
      });
    }
  }

  it("rejects a stale process-local body before patching the latest stored draft", async () => {
    const { database, workspace, actor, created } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const staleProcessDocument = collaborationYDocFromState(state.state);
    const currentProcessDocument = collaborationYDocFromState(state.state);
    replaceWorkingDocument(currentProcessDocument, {
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [
          { id: "initial", type: "p", children: [{ text: "다른 프로세스의 최신 본문" }] },
          { id: "latest-only", type: "p", children: [{ text: "최신 프로세스에만 있는 블록" }] },
        ],
      }),
    }, { context: { actor, recordedByEndpoint: true } });
    const current = persistCollaborationUpdate(
      database,
      state.roomName,
      currentProcessDocument,
      actor,
    );
    const beforeStored = storedDraftAtomicSnapshot(database, created.document.id);
    const beforeStaleProcess = Buffer.from(Y.encodeStateAsUpdate(staleProcessDocument));
    const staleCommands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          expect(roomName).toBe(state.roomName);
          return await callback(staleProcessDocument);
        },
        closeConnections() {},
      },
    });
    const requestId = "stale-process-patch-authoritative-001";

    await expect(staleCommands.patchWorking({
      roomName: state.roomName,
      actor,
      requestId,
      expectedDraftVersion: current.draftVersion,
      operations: [{
        op: "replace_block",
        blockId: "initial",
        block: {
          id: "initial",
          type: "p",
          children: [{ text: "오래된 본문을 기준으로 만든 패치" }],
        },
      }],
    })).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(beforeStored);
    expect(Buffer.from(Y.encodeStateAsUpdate(staleProcessDocument))).toEqual(beforeStaleProcess);
    expect(loadCollaborationStateByRoom(database, state.roomName).draftVersion)
      .toBe(current.draftVersion);
    expect((await createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    }).readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    })).workingDocument.content.blocks).toEqual([
      { id: "initial", type: "p", children: [{ text: "다른 프로세스의 최신 본문" }] },
      { id: "latest-only", type: "p", children: [{ text: "최신 프로세스에만 있는 블록" }] },
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_idempotency_requests WHERE request_id = ?",
    ).get(requestId)).toEqual({ count: 0 });
  });

  it("rejects a divergent stale replace-and-commit before merging it and keeps the retry safe", async () => {
    const { database, workspace, actor, created } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const staleProcessDocument = collaborationYDocFromState(state.state);
    const currentProcessDocument = collaborationYDocFromState(state.state);
    replaceWorkingDocument(currentProcessDocument, {
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [
          { id: "initial", type: "p", children: [{ text: "보존해야 하는 최신 본문" }] },
          { id: "latest-only", type: "p", children: [{ text: "최신 추가 블록" }] },
        ],
      }),
    }, { context: { actor, recordedByEndpoint: true } });
    const current = persistCollaborationUpdate(
      database,
      state.roomName,
      currentProcessDocument,
      actor,
    );
    replaceWorkingDocument(staleProcessDocument, {
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "initial", type: "p", children: [{ text: "오래된 프로세스의 전체 교체" }] }],
      }),
    }, { context: { actor, recordedByEndpoint: true } });
    const beforeStored = storedDraftAtomicSnapshot(database, created.document.id);
    const beforeStaleProcess = Buffer.from(Y.encodeStateAsUpdate(staleProcessDocument));
    const staleCommands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          expect(roomName).toBe(state.roomName);
          return await callback(staleProcessDocument);
        },
        closeConnections() {},
      },
    });
    const request = {
      roomName: state.roomName,
      actor,
      requestId: "stale-replace-commit-authoritative-001",
      expectedDraftVersion: current.draftVersion,
      replacement: { title: "최신 초안만 저장할 제목" },
    };

    await expect(staleCommands.replaceAndCommitWorking(request))
      .rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(beforeStored);
    expect(Buffer.from(Y.encodeStateAsUpdate(staleProcessDocument))).toEqual(beforeStaleProcess);
    expect(getDocument(database, workspace.id, created.document.id)).toMatchObject({
      title: "공유 초안 테스트",
      revisionNumber: 1,
      content: created.document.content,
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_idempotency_requests WHERE request_id = ?",
    ).get(request.requestId)).toEqual({ count: 0 });

    const retried = await createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    }).replaceAndCommitWorking(request);
    expect(retried.document).toMatchObject({
      title: "최신 초안만 저장할 제목",
      revisionNumber: 2,
    });
    expect(retried.document.content.blocks).toEqual([
      { id: "initial", type: "p", children: [{ text: "보존해야 하는 최신 본문" }] },
      { id: "latest-only", type: "p", children: [{ text: "최신 추가 블록" }] },
    ]);
    expect(retried.workingDocument.hasUncommittedChanges).toBe(false);
  });

  it("separates an idempotent replay receipt from the current shared draft", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const firstInput = {
      roomName: state.roomName,
      actor,
      requestId: "replay-observation-first-001",
      expectedDraftVersion: 0,
      replacement: { title: "첫 번째 초안" },
    };
    const first = await commands.replaceWorking(firstInput);
    const second = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: "replay-observation-second-001",
      expectedDraftVersion: first.workingDocument.draftVersion,
      replacement: { title: "현재 초안" },
    });

    const replayed = await commands.replaceWorking(firstInput);
    expect(replayed.workingDocument).toMatchObject({
      title: "현재 초안",
      draftVersion: second.workingDocument.draftVersion,
    });
    expect(replayed.mutationState).toEqual({
      source: "working",
      replayed: true,
      receipt: {
        generation: first.workingDocument.generation,
        draftVersion: first.workingDocument.draftVersion,
        committedDraftVersion: first.workingDocument.committedDraftVersion,
        baseRevisionNumber: first.workingDocument.baseRevisionNumber,
        hasUncommittedChanges: first.workingDocument.hasUncommittedChanges,
      },
      current: {
        generation: second.workingDocument.generation,
        draftVersion: second.workingDocument.draftVersion,
        committedDraftVersion: second.workingDocument.committedDraftVersion,
        baseRevisionNumber: second.workingDocument.baseRevisionNumber,
        hasUncommittedChanges: second.workingDocument.hasUncommittedChanges,
      },
    });
  });

  it("repairs legacy drafts whose top-level block IDs belong to another document before commit", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const owner = createDocument(database, workspace.id, actor, {
      title: "블록 ID 소유 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "shared-title", type: "h1", children: [{ text: "먼저 저장된 문서" }] }],
      }),
    });
    expect(owner.document.content.blocks[0].id).toBe("shared-title");

    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const ydoc = collaborationYDocFromState(state.state);
    replaceWorkingDocument(ydoc, {
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "shared-title", type: "h1", children: [{ text: "복구할 초안" }] }],
      }),
    }, { context: { actor, recordedByEndpoint: true } });
    const persisted = persistCollaborationUpdate(database, state.roomName, ydoc, actor);
    expect(persisted.draftVersion).toBe(1);

    const committed = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId: "commit-conflicting-legacy-draft-001",
      expectedDraftVersion: 1,
      summary: "충돌 블록 ID를 문서별 ID로 정규화해 저장했습니다.",
    });

    expect(committed.normalization).toMatchObject({ remappedTopLevelBlockIds: 1 });
    expect(committed.workingDocument).toMatchObject({
      draftVersion: 2,
      committedDraftVersion: 2,
      baseRevisionNumber: 2,
      hasUncommittedChanges: false,
    });
    expect(committed.document.content.blocks[0].id).not.toBe("shared-title");
    expect(committed.document.content.blocks[0].children[0]).toMatchObject({ text: "복구할 초안" });
  });

  it("rolls back block-ID normalization when commit fails and permits the same retry", async () => {
    const { database, workspace, actor, created } = fixture();
    createDocument(database, workspace.id, actor, {
      title: "블록 ID 소유 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "atomic-shared-id", type: "h1", children: [{ text: "ID 소유자" }] }],
      }),
    });
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const liveDocument = collaborationYDocFromState(state.state);
    replaceWorkingDocument(liveDocument, {
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "atomic-shared-id", type: "h1", children: [{ text: "저장할 초안" }] }],
      }),
    }, { context: { actor, recordedByEndpoint: true } });
    const changed = persistCollaborationUpdate(database, state.roomName, liveDocument, actor);
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
    const requestId = "commit-normalization-atomic-retry-001";
    const beforeStored = storedDraftAtomicSnapshot(database, created.document.id);
    const beforeLive = Buffer.from(Y.encodeStateAsUpdate(liveDocument));
    const beforeContributors = database.prepare(
      `SELECT contributor_key, update_count
       FROM document_draft_contributors
       WHERE document_id = ? AND generation = ?
       ORDER BY contributor_key`,
    ).all(created.document.id, state.generation);
    database.exec(`CREATE TEMP TRIGGER inject_normalized_commit_failure
      BEFORE INSERT ON document_revisions
      BEGIN
        SELECT RAISE(ABORT, 'injected normalized commit failure');
      END;`);

    try {
      await expect(commands.commitWorking({
        roomName: state.roomName,
        actor,
        requestId,
        expectedDraftVersion: changed.draftVersion,
      })).rejects.toThrow("injected normalized commit failure");
    } finally {
      database.exec("DROP TRIGGER inject_normalized_commit_failure");
    }

    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(beforeStored);
    expect(Buffer.from(Y.encodeStateAsUpdate(liveDocument))).toEqual(beforeLive);
    expect(database.prepare(
      `SELECT contributor_key, update_count
       FROM document_draft_contributors
       WHERE document_id = ? AND generation = ?
       ORDER BY contributor_key`,
    ).all(created.document.id, state.generation)).toEqual(beforeContributors);
    expect(getDocument(database, workspace.id, created.document.id)).toMatchObject({
      revisionNumber: 1,
      content: created.document.content,
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_idempotency_requests WHERE request_id = ?",
    ).get(requestId)).toEqual({ count: 0 });

    const retried = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId,
      expectedDraftVersion: changed.draftVersion,
    });
    expect(retried.normalization).toMatchObject({ remappedTopLevelBlockIds: 1 });
    expect(retried.workingDocument).toMatchObject({
      draftVersion: changed.draftVersion + 1,
      committedDraftVersion: changed.draftVersion + 1,
      hasUncommittedChanges: false,
    });
    expect(retried.document).toMatchObject({ revisionNumber: 2 });
    expect(retried.document.content.blocks[0].id).not.toBe("atomic-shared-id");
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);
  });

  it("replaces and explicitly commits a draft in one retry-safe operation", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const input = {
      roomName: state.roomName,
      actor,
      requestId: "replace-commit-atomic-001",
      expectedDraftVersion: 0,
      replacement: {
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [{ id: "initial", type: "p", children: [{ text: "원자적 저장" }] }],
        }),
      },
      summary: "한 번의 요청으로 초안을 수정하고 저장했습니다.",
    };

    const committed = await commands.replaceAndCommitWorking(input);
    expect(committed.document).toMatchObject({ revisionNumber: 2 });
    expect(committed.workingDocument).toMatchObject({
      draftVersion: 1,
      baseRevisionNumber: 2,
      hasUncommittedChanges: false,
    });
    expect(committed.workingDocument.content.blocks[0].children[0]).toMatchObject({ text: "원자적 저장" });
    expect(await commands.replaceAndCommitWorking(input)).toMatchObject({
      document: committed.document,
      workingDocument: committed.workingDocument,
      mutationState: {
        source: "working",
        replayed: true,
        receipt: { draftVersion: committed.workingDocument.draftVersion },
        current: { draftVersion: committed.workingDocument.draftVersion },
      },
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);
  });

  it("rolls back both the candidate draft and canonical write when replace-and-commit fails", async () => {
    const { database, workspace, actor, created } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const liveDocument = collaborationYDocFromState(state.state);
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
    const input = {
      roomName: state.roomName,
      actor,
      requestId: "replace-commit-fault-001",
      expectedDraftVersion: state.draftVersion,
      replacement: {
        title: "실패하면 남지 않을 제목",
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [{ id: "initial", type: "p", children: [{ text: "실패하면 남지 않을 본문" }] }],
        }),
      },
      summary: "고장 주입 원자성 테스트",
    };
    database.exec(`
      CREATE TEMP TRIGGER inject_revision_failure
      BEFORE INSERT ON document_revisions
      BEGIN
        SELECT RAISE(ABORT, 'injected revision failure');
      END;
    `);

    await expect(commands.replaceAndCommitWorking(input)).rejects.toThrow("injected revision failure");
    database.exec("DROP TRIGGER inject_revision_failure");

    const afterFailure = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });
    expect(afterFailure.workingDocument).toMatchObject({
      title: "공유 초안 테스트",
      draftVersion: 0,
      committedDraftVersion: 0,
      baseRevisionNumber: 1,
      hasUncommittedChanges: false,
    });
    expect(afterFailure.workingDocument.content.blocks[0].children[0]).toMatchObject({ text: "정본 1" });
    expect(getDocument(database, workspace.id, created.document.id)).toMatchObject({
      title: "공유 초안 테스트",
      revisionNumber: 1,
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);

    const retried = await commands.replaceAndCommitWorking(input);
    expect(retried.document).toMatchObject({
      title: "실패하면 남지 않을 제목",
      revisionNumber: 2,
    });
    expect(retried.workingDocument).toMatchObject({
      draftVersion: 1,
      committedDraftVersion: 1,
      hasUncommittedChanges: false,
    });
  });

  it("moves a document tree atomically while preserving an uncommitted draft body", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const parent = createDocument(database, workspace.id, actor, {
      title: "새 상위 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "parent-body", type: "p", children: [{ text: "상위 문서" }] }],
      }),
    });
    const canonicalBefore = getDocument(database, workspace.id, created.document.id);
    const initial = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });
    const edited = await commands.replaceWorking({
      roomName: initial.workingDocument.roomName,
      actor,
      requestId: "dirty-tree-move-edit-001",
      expectedDraftVersion: initial.workingDocument.draftVersion,
      replacement: {
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [{ id: "initial", type: "p", children: [{ text: "아직 저장하지 않은 본문" }] }],
        }),
      },
    });
    const moveInput = {
      roomName: edited.workingDocument.roomName,
      actor,
      requestId: "dirty-tree-move-001",
      expectedGeneration: edited.workingDocument.generation,
      expectedDraftVersion: edited.workingDocument.draftVersion,
      expectedBaseRevision: edited.workingDocument.baseRevisionNumber,
      targetDocumentId: parent.document.id,
      position: "inside" as const,
      summary: "더티 초안을 보존한 채 문서 위치를 옮겼습니다.",
    };

    const moved = await commands.moveWorkingDocumentTree(moveInput);

    expect(moved.document).toMatchObject({
      parentDocumentId: parent.document.id,
      revisionNumber: 2,
    });
    expect(moved.tree).toMatchObject({
      documentId: created.document.id,
      parentDocumentId: parent.document.id,
      targetDocumentId: parent.document.id,
      position: "inside",
    });
    expect(moved.workingDocument).toMatchObject({
      parentDocumentId: parent.document.id,
      baseRevisionNumber: 2,
      draftVersion: edited.workingDocument.draftVersion + 1,
      committedDraftVersion: edited.workingDocument.committedDraftVersion,
      hasUncommittedChanges: true,
    });
    expect(moved.workingDocument.content.blocks[0].children[0]).toMatchObject({
      text: "아직 저장하지 않은 본문",
    });
    const revisionTwo = getDocumentRevisionSnapshotByNumber(
      database,
      workspace.id,
      created.document.id,
      2,
    );
    expect(revisionTwo.parentDocumentId).toBe(parent.document.id);
    expect(revisionTwo.content).toEqual(canonicalBefore.content);
    expect(revisionTwo.content.blocks[0].children[0]).toMatchObject({ text: "정본 1" });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);

    const replayed = await commands.moveWorkingDocumentTree(moveInput);
    expect(replayed).toMatchObject({
      document: { revisionNumber: 2 },
      mutationState: {
        replayed: true,
        receipt: { hasUncommittedChanges: true },
        current: { hasUncommittedChanges: true },
      },
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);

    const committed = await commands.commitWorking({
      roomName: moved.workingDocument.roomName,
      actor,
      requestId: "dirty-tree-move-commit-001",
      expectedDraftVersion: moved.workingDocument.draftVersion,
      summary: "보존된 본문 초안을 명시적으로 저장했습니다.",
    });
    expect(committed.document).toMatchObject({
      parentDocumentId: parent.document.id,
      revisionNumber: 3,
    });
    expect(committed.document.content.blocks[0].children[0]).toMatchObject({
      text: "아직 저장하지 않은 본문",
    });
    expect(committed.workingDocument.hasUncommittedChanges).toBe(false);
  });

  it("rejects a tree move when an OAuth actor ceiling is read-only without changing canonical or draft state", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const parent = createDocument(database, workspace.id, actor, {
      title: "읽기 전용 OAuth 이동 대상",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "readonly-parent", type: "p", children: [{ text: "상위 문서" }] }],
      }),
    });
    const agent = createAccountAgent(database, {
      userId: actor.userId,
      displayName: "Read-only OAuth tree agent",
    });
    assignAgentToWorkspace(database, {
      userId: actor.userId,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const credential = createAgentCredential(database, {
      userId: actor.userId,
      agentId: agent.id,
      name: "broad-tree-move-credential",
      scopes: ["documents:read", "documents:write", "documents:commit"],
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    const oauthActor = {
      type: "agent" as const,
      userId: actor.userId,
      tokenId: credential.credential.id,
      principalId: agent.id,
      label: agent.displayName,
      source: "mcp" as const,
      scopeCeiling: Object.freeze(["documents:read"] as const),
    };
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const canonicalBefore = getDocument(database, workspace.id, created.document.id);
    const revisionsBefore = listDocumentRevisions(database, workspace.id, created.document.id);
    const draftBefore = storedDraftAtomicSnapshot(database, created.document.id);

    await expect(commands.moveWorkingDocumentTree({
      roomName: state.roomName,
      actor: oauthActor,
      requestId: "oauth-read-only-tree-move-denied-001",
      expectedGeneration: state.generation,
      expectedDraftVersion: state.draftVersion,
      expectedBaseRevision: state.baseRevisionNumber,
      targetDocumentId: parent.document.id,
      position: "inside",
      summary: "읽기 전용 OAuth 세션에서는 이동되면 안 됩니다.",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(getDocument(database, workspace.id, created.document.id)).toEqual(canonicalBefore);
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toEqual(revisionsBefore);
    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(draftBefore);
  });

  it("moves a clean document tree without creating a dirty draft", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const parent = createDocument(database, workspace.id, actor, {
      title: "깨끗한 이동 대상",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "clean-parent", type: "p", children: [{ text: "상위 문서" }] }],
      }),
    });
    const initial = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });

    const moved = await commands.moveWorkingDocumentTree({
      roomName: initial.workingDocument.roomName,
      actor,
      requestId: "clean-tree-move-001",
      expectedGeneration: initial.workingDocument.generation,
      expectedDraftVersion: initial.workingDocument.draftVersion,
      expectedBaseRevision: initial.workingDocument.baseRevisionNumber,
      targetDocumentId: parent.document.id,
      position: "inside",
    });

    expect(moved.document).toMatchObject({
      parentDocumentId: parent.document.id,
      revisionNumber: 2,
    });
    expect(moved.workingDocument).toMatchObject({
      parentDocumentId: parent.document.id,
      baseRevisionNumber: 2,
      draftVersion: initial.workingDocument.draftVersion + 1,
      committedDraftVersion: initial.workingDocument.committedDraftVersion,
      hasUncommittedChanges: false,
    });
    expect(moved.workingDocument.content).toEqual(initial.workingDocument.content);
  });

  it("rejects a stale tree move without changing the canonical tree", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const parent = createDocument(database, workspace.id, actor, {
      title: "이동 대상",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "stale-parent", type: "p", children: [{ text: "상위 문서" }] }],
      }),
    });
    const initial = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });
    const changed = await commands.replaceWorking({
      roomName: initial.workingDocument.roomName,
      actor,
      requestId: "stale-tree-edit-001",
      expectedDraftVersion: initial.workingDocument.draftVersion,
      replacement: { title: "동시에 바뀐 초안 제목" },
    });

    await expect(commands.moveWorkingDocumentTree({
      roomName: initial.workingDocument.roomName,
      actor,
      requestId: "stale-tree-move-001",
      expectedGeneration: initial.workingDocument.generation,
      expectedDraftVersion: initial.workingDocument.draftVersion,
      expectedBaseRevision: initial.workingDocument.baseRevisionNumber,
      targetDocumentId: parent.document.id,
      position: "inside",
    })).rejects.toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
    });

    expect(getDocument(database, workspace.id, created.document.id)).toMatchObject({
      parentDocumentId: null,
      revisionNumber: 1,
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);
    const after = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });
    expect(after.workingDocument).toMatchObject({
      title: "동시에 바뀐 초안 제목",
      parentDocumentId: null,
      draftVersion: changed.workingDocument.draftVersion,
      baseRevisionNumber: 1,
      hasUncommittedChanges: true,
    });
  });

  it("rolls back the canonical revision and draft rebase when tree ordering fails", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const parent = createDocument(database, workspace.id, actor, {
      title: "롤백 상위 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "rollback-parent", type: "p", children: [{ text: "상위 문서" }] }],
      }),
    });
    const anchor = createDocument(database, workspace.id, actor, {
      title: "롤백 기준 문서",
      parentDocumentId: parent.document.id,
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "rollback-anchor", type: "p", children: [{ text: "기준 문서" }] }],
      }),
    });
    const initial = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });
    database.exec(`
      CREATE TRIGGER force_tree_move_failure
      BEFORE UPDATE OF tree_order ON documents
      WHEN NEW.id = '${created.document.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced tree move failure');
      END;
    `);

    await expect(commands.moveWorkingDocumentTree({
      roomName: initial.workingDocument.roomName,
      actor,
      requestId: "rollback-tree-move-001",
      expectedGeneration: initial.workingDocument.generation,
      expectedDraftVersion: initial.workingDocument.draftVersion,
      expectedBaseRevision: initial.workingDocument.baseRevisionNumber,
      targetDocumentId: anchor.document.id,
      position: "after",
    })).rejects.toThrow("forced tree move failure");

    expect(getDocument(database, workspace.id, created.document.id)).toMatchObject({
      parentDocumentId: null,
      revisionNumber: 1,
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);
    const after = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });
    expect(after.workingDocument).toMatchObject({
      parentDocumentId: null,
      baseRevisionNumber: 1,
      draftVersion: initial.workingDocument.draftVersion,
      committedDraftVersion: initial.workingDocument.committedDraftVersion,
      hasUncommittedChanges: false,
    });
  });

  it("rejects destructive reset and restore requests with stale draft, generation, or base revision", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const initial = ensureCollaborationState(database, workspace.id, created.document.id);
    const changed = await commands.replaceWorking({
      roomName: initial.roomName,
      actor,
      expectedDraftVersion: initial.draftVersion,
      replacement: { title: "버리기 전 초안" },
    });

    await expect(commands.resetWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      expectedGeneration: initial.generation,
      expectedDraftVersion: initial.draftVersion,
      expectedBaseRevision: initial.baseRevisionNumber,
      requestId: "discard-stale-draft-001",
    })).rejects.toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
      details: {
        expectedDraftVersion: 0,
        currentDraftVersion: 1,
      },
    });
    await expect(commands.resetWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      expectedGeneration: initial.generation + 1,
      expectedDraftVersion: changed.workingDocument.draftVersion,
      expectedBaseRevision: changed.workingDocument.baseRevisionNumber,
      requestId: "discard-stale-generation-001",
    })).rejects.toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
      details: {
        expectedGeneration: initial.generation + 1,
        currentGeneration: initial.generation,
      },
    });

    const committed = await commands.commitWorking({
      roomName: initial.roomName,
      actor,
      expectedDraftVersion: changed.workingDocument.draftVersion,
    });
    await expect(commands.resetWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      expectedGeneration: committed.workingDocument.generation,
      expectedDraftVersion: committed.workingDocument.draftVersion,
      expectedBaseRevision: initial.baseRevisionNumber,
      requestId: "restore-stale-base-001",
      revisionId: created.document.revisionId!,
    })).rejects.toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
      details: {
        expectedBaseRevision: 1,
        currentBaseRevision: 2,
      },
    });

    const discarded = await commands.resetWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      expectedGeneration: committed.workingDocument.generation,
      expectedDraftVersion: committed.workingDocument.draftVersion,
      expectedBaseRevision: committed.workingDocument.baseRevisionNumber,
      requestId: "discard-current-cas-001",
    });
    expect(discarded.workingDocument).toMatchObject({
      generation: initial.generation + 1,
      draftVersion: 0,
      baseRevisionNumber: 2,
      hasUncommittedChanges: false,
    });
  });

  it("restores a valid historical snapshot even when the replaced draft now has invalid media", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const other = createTestUser(database, {
      name: "Moved Media Workspace Owner",
      email: "moved-current-draft-media@example.com",
    });
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const mediaId = insertTestMediaAsset(database, workspace.id, actor.userId);
    const dirty = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: "invalid-current-media-draft-001",
      expectedDraftVersion: state.draftVersion,
      replacement: {
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [imageBlock(mediaId, "current-invalid-media")],
        }),
      },
    });
    database.prepare("UPDATE media_assets SET workspace_id = ? WHERE id = ?")
      .run(other.workspace.id, mediaId);

    const restored = await commands.resetWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      revisionId: created.document.revisionId!,
      requestId: "restore-over-invalid-current-media-001",
      expectedGeneration: dirty.workingDocument.generation,
      expectedDraftVersion: dirty.workingDocument.draftVersion,
      expectedBaseRevision: dirty.workingDocument.baseRevisionNumber,
    });

    expect(restored.workingDocument).toMatchObject({
      generation: state.generation + 1,
      title: created.document.title,
      content: created.document.content,
    });
  });

  it("rejects an unauthorized historical media snapshot without changing reset state", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const other = createTestUser(database, {
      name: "Historical Media Foreign Workspace",
      email: "historical-media-foreign@example.com",
    });
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const mediaId = insertTestMediaAsset(database, workspace.id, actor.userId);
    const imageDraft = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: "historical-media-draft-001",
      expectedDraftVersion: state.draftVersion,
      replacement: {
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [imageBlock(mediaId, "historical-media")],
        }),
      },
    });
    const imageCommit = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId: "historical-media-commit-001",
      expectedDraftVersion: imageDraft.workingDocument.draftVersion,
    });
    const imageRevision = getDocumentRevisionSnapshotByNumber(
      database,
      workspace.id,
      created.document.id,
      2,
    );
    const cleanDraft = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: "historical-media-clean-draft-001",
      expectedDraftVersion: imageCommit.workingDocument.draftVersion,
      replacement: {
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [{ id: "current-clean", type: "p", children: [{ text: "현재 유효한 본문" }] }],
        }),
      },
    });
    const cleanCommit = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId: "historical-media-clean-commit-001",
      expectedDraftVersion: cleanDraft.workingDocument.draftVersion,
    });
    database.prepare("DELETE FROM document_media_bindings WHERE media_id = ?").run(mediaId);
    database.prepare("UPDATE media_assets SET workspace_id = ? WHERE id = ?")
      .run(other.workspace.id, mediaId);
    const before = storedDraftAtomicSnapshot(database, created.document.id);
    const contributorsBefore = storedContributors(database, created.document.id);
    const requestId = "historical-media-restore-denied-001";

    await expect(commands.resetWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      revisionId: imageRevision.id,
      requestId,
      expectedGeneration: cleanCommit.workingDocument.generation,
      expectedDraftVersion: cleanCommit.workingDocument.draftVersion,
      expectedBaseRevision: cleanCommit.workingDocument.baseRevisionNumber,
    })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { mediaId },
    });

    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(before);
    expect(storedContributors(database, created.document.id)).toEqual(contributorsBefore);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_idempotency_requests WHERE request_id = ?",
    ).get(requestId)).toEqual({ count: 0 });
  });

  it("lets an agent with revision read and restore access load R1 historical media after R2 removes it", async () => {
    const { database, workspace, actor, commands } = fixture();
    const mediaId = insertTestMediaAsset(database, workspace.id, actor.userId);
    const revisionOne = createDocument(database, workspace.id, actor, {
      title: "Historical agent media restore",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [imageBlock(mediaId, "revision-one-image")],
      }),
    }).document;
    const state = ensureCollaborationState(database, workspace.id, revisionOne.id);
    const removed = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: "historical-agent-media-remove-draft-001",
      expectedDraftVersion: state.draftVersion,
      replacement: {
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [{ id: "revision-two-text", type: "p", children: [{ text: "Image removed" }] }],
        }),
      },
    });
    const revisionTwo = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId: "historical-agent-media-remove-commit-001",
      expectedDraftVersion: removed.workingDocument.draftVersion,
    });
    expect(revisionTwo.document.revisionNumber).toBe(2);
    expect(database.prepare(
      `SELECT current_binding, revision_binding
       FROM document_media_bindings
       WHERE workspace_id = ? AND document_id = ? AND media_id = ?`,
    ).get(workspace.id, revisionOne.id, mediaId)).toEqual({
      current_binding: 0,
      revision_binding: 1,
    });

    const agent = createAccountAgent(database, {
      userId: actor.userId,
      displayName: "Historical media restore agent",
    });
    assignAgentToWorkspace(database, {
      userId: actor.userId,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "custom",
      capabilities: ["documents.read", "documents.update", "revisions.restore"],
    });
    const credential = createAgentCredential(database, {
      userId: actor.userId,
      agentId: agent.id,
      name: "historical-media-restore-key",
      scopes: ["documents:read", "documents:write", "revisions:restore"],
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    const agentActor = {
      type: "agent" as const,
      userId: actor.userId,
      tokenId: credential.credential.id,
      principalId: agent.id,
      label: agent.displayName,
      source: "rollback" as const,
    };
    const restoreRequest = {
      workspaceId: workspace.id,
      documentId: revisionOne.id,
      actor: agentActor,
      revisionId: revisionOne.revisionId!,
      requestId: "historical-agent-media-restore-r1-001",
      expectedGeneration: revisionTwo.workingDocument.generation,
      expectedDraftVersion: revisionTwo.workingDocument.draftVersion,
      expectedBaseRevision: revisionTwo.workingDocument.baseRevisionNumber,
    };
    const before = storedDraftAtomicSnapshot(database, revisionOne.id);

    await expect(commands.resetWorking(restoreRequest)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { mediaId },
    });
    expect(storedDraftAtomicSnapshot(database, revisionOne.id)).toEqual(before);

    updateAgentWorkspaceMembership(database, {
      userId: actor.userId,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "custom",
      capabilities: [
        "documents.read",
        "documents.update",
        "revisions.read",
        "revisions.restore",
      ],
      rootDocumentId: null,
    });
    const restored = await commands.resetWorking(restoreRequest);

    expect(restored.workingDocument).toMatchObject({
      generation: revisionTwo.workingDocument.generation + 1,
      baseRevisionNumber: 2,
      hasUncommittedChanges: true,
      content: {
        schemaVersion: 2,
        blocks: [expect.objectContaining({
          id: "revision-one-image",
          type: "img",
          mediaId,
        })],
      },
    });
  });

  it("rejects a historical internal reference outside the current human scope atomically", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const target = createDocument(database, workspace.id, actor, {
      title: "복원 범위 밖 대상",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "target", type: "p", children: [{ text: "대상" }] }],
      }),
    });
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const referenceDraft = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: "historical-reference-draft-001",
      expectedDraftVersion: state.draftVersion,
      replacement: {
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [{
            id: "reference",
            type: "p",
            children: [{
              id: "target-reference",
              type: "doc_ref",
              documentId: target.document.id,
              children: [{ text: "범위 밖 문서" }],
            }],
          }],
        }),
      },
    });
    const referenceCommit = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId: "historical-reference-commit-001",
      expectedDraftVersion: referenceDraft.workingDocument.draftVersion,
    });
    const outsider = createTestUser(database, {
      name: "Historical Restore Direct Editor",
      email: "historical-restore-editor@example.com",
    }).user;
    setDocumentHumanGrant(database, {
      workspaceId: workspace.id,
      documentId: created.document.id,
      recipientUserId: outsider.id,
      role: "editor",
      actorUserId: actor.userId,
      actorLabel: actor.label,
    });
    const sharedActor = {
      type: "human" as const,
      userId: outsider.id,
      principalId: outsider.id,
      label: outsider.name,
      source: "rollback" as const,
    };
    const before = storedDraftAtomicSnapshot(database, created.document.id);
    const contributorsBefore = storedContributors(database, created.document.id);
    const requestId = "historical-reference-restore-denied-001";

    await expect(commands.resetWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor: sharedActor,
      revisionId: referenceCommit.document.revisionId!,
      requestId,
      expectedGeneration: referenceCommit.workingDocument.generation,
      expectedDraftVersion: referenceCommit.workingDocument.draftVersion,
      expectedBaseRevision: referenceCommit.workingDocument.baseRevisionNumber,
    })).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { targetDocumentId: target.document.id },
    });

    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(before);
    expect(storedContributors(database, created.document.id)).toEqual(contributorsBefore);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_idempotency_requests WHERE request_id = ?",
    ).get(requestId)).toEqual({ count: 0 });
  });

  it.each([
    { mode: "discard" as const, revision: false },
    { mode: "restore" as const, revision: true },
  ])("replays a lost human $mode response without incrementing generation twice", async ({ mode, revision }) => {
    const { database, workspace, actor, created, commands } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const dirty = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: `human-${mode}-lost-response-draft-001`,
      expectedDraftVersion: state.draftVersion,
      replacement: { title: `lost-response-${mode}` },
    });
    const requestId = `human-${mode}-lost-response-reset-001`;
    const request = {
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      ...(revision ? { revisionId: created.document.revisionId! } : {}),
      requestId,
      expectedGeneration: dirty.workingDocument.generation,
      expectedDraftVersion: dirty.workingDocument.draftVersion,
      expectedBaseRevision: dirty.workingDocument.baseRevisionNumber,
    };

    const first = await commands.resetWorking(request);
    const replayed = await commands.resetWorking(request);

    expect(first.workingDocument.generation).toBe(state.generation + 1);
    expect(replayed).toMatchObject({
      roomName: first.roomName,
      workingDocument: { generation: state.generation + 1 },
      mutationState: {
        replayed: true,
        receipt: { generation: state.generation + 1 },
        current: { generation: state.generation + 1 },
      },
    });
    expect(ensureCollaborationState(database, workspace.id, created.document.id).generation)
      .toBe(state.generation + 1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_idempotency_requests WHERE request_id = ?",
    ).get(requestId)).toEqual({ count: 1 });
  });

  it("rejects a human generation reset without requestId before changing state", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const before = storedDraftAtomicSnapshot(database, created.document.id);

    await expect(commands.resetWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      expectedGeneration: state.generation,
      expectedDraftVersion: state.draftVersion,
      expectedBaseRevision: state.baseRevisionNumber,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(before);
  });

  it("refuses a browser save until the submitted Yjs state vector is present", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const delayedClient = collaborationYDocFromState(state.state);
    replaceWorkingDocument(delayedClient, {
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "initial", type: "p", children: [{ text: "아직 전송되지 않은 입력" }] }],
      }),
    }, { context: { actor, recordedByEndpoint: false } });
    const stateVector = Buffer.from(Y.encodeStateVector(delayedClient)).toString("base64url");

    await expect(commands.commitWorking({
      roomName: state.roomName,
      actor,
      expectedDraftVersion: 0,
      synchronizationFence: {
        generation: state.generation,
        stateVector,
      },
    })).rejects.toMatchObject({
      code: "DRAFT_NOT_SYNCED",
      details: { generation: state.generation },
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);

    const persisted = persistCollaborationUpdate(
      database,
      state.roomName,
      delayedClient,
      actor,
    );
    const committed = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      expectedDraftVersion: persisted.draftVersion,
      synchronizationFence: {
        generation: state.generation,
        stateVector,
      },
    });
    expect(committed.document).toMatchObject({ revisionNumber: 2 });
    expect(committed.document.content.blocks[0].children[0]).toMatchObject({
      text: "아직 전송되지 않은 입력",
    });
  });

  it("does not acknowledge a save when Save-time Yjs updates arrive out of order", async () => {
    const { database, workspace, actor, created } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const serverDocument = collaborationYDocFromState(state.state);
    const clientDocument = collaborationYDocFromState(state.state);
    const updates: Uint8Array[] = [];
    clientDocument.on("update", (update, origin) => {
      if (origin === "save-fence-test") updates.push(update.slice());
    });

    const metadata = clientDocument.getMap<unknown>("metadata");
    clientDocument.transact(() => {
      metadata.set("tags", ["save-fence-tag"]);
    }, "save-fence-test");
    const content = clientDocument.get("content", Y.XmlText);
    clientDocument.transact(() => {
      content.applyDelta(slateNodesToInsertDelta([{
        id: "save-fence-added-block",
        type: "p",
        children: [{ text: "저장 호출 시점 본문" }],
      }] as never));
    }, "save-fence-test");
    expect(updates).toHaveLength(2);

    const stateVector = Buffer.from(Y.encodeStateVector(clientDocument)).toString("base64url");
    const liveCommands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          expect(roomName).toBe(state.roomName);
          return await callback(serverDocument);
        },
        closeConnections() {},
      },
    });

    // The second update is causally dependent on the first. Yjs keeps it
    // pending when the transport delivers it first, so the Save-time vector
    // must still fence the canonical commit.
    Y.applyUpdate(serverDocument, updates[1]!);
    await expect(liveCommands.commitWorking({
      roomName: state.roomName,
      actor,
      expectedDraftVersion: state.draftVersion,
      synchronizationFence: {
        generation: state.generation,
        stateVector,
      },
    })).rejects.toMatchObject({ code: "DRAFT_NOT_SYNCED" });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(1);

    Y.applyUpdate(serverDocument, updates[0]!);
    const acknowledged = persistCollaborationUpdate(
      database,
      state.roomName,
      serverDocument,
      actor,
    );
    const committed = await liveCommands.commitWorking({
      roomName: state.roomName,
      actor,
      expectedDraftVersion: acknowledged.draftVersion,
      synchronizationFence: {
        generation: state.generation,
        stateVector,
      },
    });

    expect(committed.document).toMatchObject({
      revisionNumber: 2,
      tags: ["save-fence-tag"],
    });
    expect(committed.document.content.blocks).toContainEqual(
      expect.objectContaining({
        id: "save-fence-added-block",
        children: [expect.objectContaining({ text: "저장 호출 시점 본문" })],
      }),
    );
    expect(committed.workingDocument.hasUncommittedChanges).toBe(false);
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);
  });

  it("refuses a save whose acknowledged draft version is stale", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const changed = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      expectedDraftVersion: state.draftVersion,
      replacement: { title: "새 제목" },
    });
    const current = collaborationYDocFromState(
      loadCollaborationStateByRoom(database, state.roomName).state,
    );

    await expect(commands.commitWorking({
      roomName: state.roomName,
      actor,
      expectedDraftVersion: state.draftVersion,
      synchronizationFence: {
        generation: state.generation,
        stateVector: Buffer.from(Y.encodeStateVector(current)).toString("base64url"),
      },
    })).rejects.toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
      details: {
        expectedDraftVersion: state.draftVersion,
        currentDraftVersion: changed.workingDocument.draftVersion,
      },
    });
  });

  it("rejects a parent move when a direct human share cannot edit the destination", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const destination = createDocument(database, workspace.id, actor, {
      title: "이동 대상",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "destination", type: "p", children: [{ text: "대상" }] }],
      }),
    });
    const outsider = createTestUser(database, {
      name: "Direct Share Editor",
      email: "direct-share@example.com",
    }).user;
    setDocumentHumanGrant(database, {
      workspaceId: workspace.id,
      documentId: created.document.id,
      recipientUserId: outsider.id,
      role: "editor",
      actorUserId: actor.userId,
      actorLabel: actor.label,
    });
    const sharedActor = {
      type: "human" as const,
      userId: outsider.id,
      principalId: outsider.id,
      label: outsider.name,
      source: "web" as const,
    };
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    await expect(commands.replaceWorking({
      roomName: state.roomName,
      actor: sharedActor,
      expectedDraftVersion: state.draftVersion,
      replacement: { parentDocumentId: destination.document.id },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const working = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });
    expect(working.workingDocument).toMatchObject({
      draftVersion: state.draftVersion,
      parentDocumentId: null,
    });
    expect(getDocument(database, workspace.id, created.document.id).parentDocumentId).toBeNull();
  });

  it("rechecks a stale agent draft against the current destination scope before commit", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const destination = createDocument(database, workspace.id, actor, {
      title: "에이전트 이동 대상",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "agent-destination", type: "p", children: [{ text: "대상" }] }],
      }),
    });
    const agent = createAccountAgent(database, {
      userId: actor.userId,
      displayName: "Move Agent",
    });
    assignAgentToWorkspace(database, {
      userId: actor.userId,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
    });
    const credential = createAgentCredential(database, {
      userId: actor.userId,
      agentId: agent.id,
      name: "move-agent-key",
      scopes: ["documents:read", "documents:write", "documents:commit"],
      defaultWorkspaceId: workspace.id,
      workspaceAllowlist: [workspace.id],
    });
    const agentActor = {
      type: "agent" as const,
      userId: actor.userId,
      tokenId: credential.credential.id,
      principalId: agent.id,
      label: agent.displayName,
      source: "mcp" as const,
    };
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const changed = await commands.replaceWorking({
      roomName: state.roomName,
      actor: agentActor,
      expectedDraftVersion: state.draftVersion,
      replacement: { parentDocumentId: destination.document.id },
    });
    updateAgentWorkspaceMembership(database, {
      userId: actor.userId,
      workspaceId: workspace.id,
      agentId: agent.id,
      accessProfile: "writer",
      rootDocumentId: created.document.id,
    });

    await expect(commands.commitWorking({
      roomName: state.roomName,
      actor: agentActor,
      expectedDraftVersion: changed.workingDocument.draftVersion,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getDocument(database, workspace.id, created.document.id).parentDocumentId).toBeNull();
  });

  it("allows a current workspace owner to commit a valid parent move", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const destination = createDocument(database, workspace.id, actor, {
      title: "소유자 이동 대상",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "owner-destination", type: "p", children: [{ text: "대상" }] }],
      }),
    });
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const changed = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      expectedDraftVersion: state.draftVersion,
      replacement: { parentDocumentId: destination.document.id },
    });

    const committed = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      expectedDraftVersion: changed.workingDocument.draftVersion,
    });
    expect(committed.document.parentDocumentId).toBe(destination.document.id);
  });

  it("closes only rooms whose provider callbacks ran when opening the subtree fails", async () => {
    const { database, workspace, actor, created } = fixture();
    const child = createDocument(database, workspace.id, actor, {
      title: "열기 실패 하위 문서",
      parentDocumentId: created.document.id,
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "open-failure-child", type: "p", children: [{ text: "하위" }] }],
      }),
    });
    createDocument(database, workspace.id, actor, {
      title: "열기 실패 생존 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "open-failure-survivor", type: "p", children: [{ text: "생존" }] }],
      }),
    });
    const states = [
      {
        id: created.document.id,
        state: ensureCollaborationState(database, workspace.id, created.document.id),
      },
      {
        id: child.document.id,
        state: ensureCollaborationState(database, workspace.id, child.document.id),
      },
    ].sort((left, right) => left.id.localeCompare(right.id));
    const liveByRoom = new Map(states.map(({ state }) => [
      state.roomName,
      collaborationYDocFromState(state.state),
    ]));
    const closedRooms: string[] = [];
    let openCalls = 0;
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          openCalls += 1;
          if (openCalls === 2) throw new Error("injected room opening failure");
          const document = liveByRoom.get(roomName);
          if (!document) throw new Error(`unexpected room ${roomName}`);
          return await callback(document);
        },
        closeConnections(roomName) {
          closedRooms.push(roomName);
        },
      },
    });

    await expect(commands.archiveWorkingTree({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      baseRevision: created.document.revisionNumber,
    })).rejects.toThrow("injected room opening failure");

    expect(openCalls).toBe(2);
    expect(closedRooms).toEqual([states[0]!.state.roomName]);
    expect(getDocument(database, workspace.id, created.document.id).status).toBe("active");
    expect(getDocument(database, workspace.id, child.document.id).status).toBe("active");
  });

  it("rechecks trash permission after every room opens and leaves drafts unflushed on revocation", async () => {
    const { database, workspace, actor, created } = fixture();
    const child = createDocument(database, workspace.id, actor, {
      title: "권한 경합 하위 문서",
      parentDocumentId: created.document.id,
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "race-child", type: "p", children: [{ text: "하위" }] }],
      }),
    });
    createDocument(database, workspace.id, actor, {
      title: "권한 경합 생존 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "race-survivor", type: "p", children: [{ text: "생존" }] }],
      }),
    });
    const rootState = ensureCollaborationState(database, workspace.id, created.document.id);
    const childState = ensureCollaborationState(database, workspace.id, child.document.id);
    const rootLive = collaborationYDocFromState(rootState.state);
    const childLive = collaborationYDocFromState(childState.state);
    replaceWorkingDocument(rootLive, { title: "권한 취소 전에 열린 루트" }, {
      context: { actor, recordedByEndpoint: false },
    });
    replaceWorkingDocument(childLive, { title: "권한 취소 전에 열린 하위" }, {
      context: { actor, recordedByEndpoint: false },
    });
    const beforeRoot = storedDraftAtomicSnapshot(database, created.document.id);
    const beforeChild = storedDraftAtomicSnapshot(database, child.document.id);
    const liveByRoom = new Map([
      [rootState.roomName, rootLive],
      [childState.roomName, childLive],
    ]);
    let opened = 0;
    const closedRooms: string[] = [];
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          const document = liveByRoom.get(roomName);
          if (!document) throw new Error(`unexpected room ${roomName}`);
          opened += 1;
          if (opened === 1) {
            database.prepare(
              "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
            ).run(workspace.id, actor.userId);
          }
          return await callback(document);
        },
        closeConnections(roomName) {
          closedRooms.push(roomName);
        },
      },
    });

    await expect(commands.archiveWorkingTree({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      baseRevision: created.document.revisionNumber,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(opened).toBe(2);
    expect(closedRooms.sort()).toEqual([rootState.roomName, childState.roomName].sort());
    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(beforeRoot);
    expect(storedDraftAtomicSnapshot(database, child.document.id)).toEqual(beforeChild);
    expect(getDocument(database, workspace.id, created.document.id).status).toBe("active");
    expect(getDocument(database, workspace.id, child.document.id).status).toBe("active");
    expect(database.prepare("SELECT COUNT(*) AS count FROM document_trash_batches").get())
      .toEqual({ count: 0 });
  });

  it("rejects archiving when a concurrent move adds an unopened document to the subtree", async () => {
    const { database, workspace, actor, created } = fixture();
    const child = createDocument(database, workspace.id, actor, {
      title: "기존 보관 하위 문서",
      parentDocumentId: created.document.id,
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "archive-existing-child", type: "p", children: [{ text: "기존" }] }],
      }),
    });
    const added = createDocument(database, workspace.id, actor, {
      title: "동시에 들어오는 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "archive-added-child", type: "p", children: [{ text: "추가" }] }],
      }),
    });
    const states = [created.document.id, child.document.id]
      .map((documentId) => ({
        documentId,
        state: ensureCollaborationState(database, workspace.id, documentId),
      }))
      .sort((left, right) => left.documentId.localeCompare(right.documentId));
    const beforeDrafts = new Map(states.map(({ documentId }) => [
      documentId,
      storedDraftAtomicSnapshot(database, documentId),
    ]));
    const liveByRoom = new Map(states.map(({ state }) => [
      state.roomName,
      collaborationYDocFromState(state.state),
    ]));
    const closedRooms: string[] = [];
    let opened = 0;
    let moved = false;
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          const document = liveByRoom.get(roomName);
          if (!document) throw new Error(`unexpected room ${roomName}`);
          opened += 1;
          const result = await callback(document);
          if (!moved && opened === states.length) {
            database.prepare(
              "UPDATE documents SET parent_document_id = ? WHERE workspace_id = ? AND id = ?",
            ).run(created.document.id, workspace.id, added.document.id);
            moved = true;
          }
          return result;
        },
        closeConnections(roomName) {
          closedRooms.push(roomName);
        },
      },
    });

    await expect(commands.archiveWorkingTree({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      baseRevision: created.document.revisionNumber,
    })).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

    expect(moved).toBe(true);
    expect(closedRooms.sort()).toEqual(states.map(({ state }) => state.roomName).sort());
    for (const { documentId } of states) {
      expect(storedDraftAtomicSnapshot(database, documentId)).toEqual(beforeDrafts.get(documentId));
      expect(getDocument(database, workspace.id, documentId).status).toBe("active");
    }
    expect(getDocument(database, workspace.id, added.document.id)).toMatchObject({
      status: "active",
      parentDocumentId: created.document.id,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM document_trash_batches").get())
      .toEqual({ count: 0 });
  });

  it("rejects archiving when a concurrent move removes an opened document from the subtree", async () => {
    const { database, workspace, actor, created } = fixture();
    const child = createDocument(database, workspace.id, actor, {
      title: "동시에 빠져나가는 문서",
      parentDocumentId: created.document.id,
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "archive-removed-child", type: "p", children: [{ text: "이동" }] }],
      }),
    });
    const states = [created.document.id, child.document.id]
      .map((documentId) => ({
        documentId,
        state: ensureCollaborationState(database, workspace.id, documentId),
      }))
      .sort((left, right) => left.documentId.localeCompare(right.documentId));
    const beforeDrafts = new Map(states.map(({ documentId }) => [
      documentId,
      storedDraftAtomicSnapshot(database, documentId),
    ]));
    const liveByRoom = new Map(states.map(({ state }) => [
      state.roomName,
      collaborationYDocFromState(state.state),
    ]));
    const closedRooms: string[] = [];
    let opened = 0;
    let moved = false;
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          const document = liveByRoom.get(roomName);
          if (!document) throw new Error(`unexpected room ${roomName}`);
          opened += 1;
          const result = await callback(document);
          if (!moved && opened === states.length) {
            database.prepare(
              "UPDATE documents SET parent_document_id = NULL WHERE workspace_id = ? AND id = ?",
            ).run(workspace.id, child.document.id);
            moved = true;
          }
          return result;
        },
        closeConnections(roomName) {
          closedRooms.push(roomName);
        },
      },
    });

    await expect(commands.archiveWorkingTree({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      baseRevision: created.document.revisionNumber,
    })).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

    expect(moved).toBe(true);
    expect(closedRooms.sort()).toEqual(states.map(({ state }) => state.roomName).sort());
    for (const { documentId } of states) {
      expect(storedDraftAtomicSnapshot(database, documentId)).toEqual(beforeDrafts.get(documentId));
      expect(getDocument(database, workspace.id, documentId).status).toBe("active");
    }
    expect(getDocument(database, workspace.id, child.document.id).parentDocumentId).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM document_trash_batches").get())
      .toEqual({ count: 0 });
  });

  it("rolls back every subtree draft flush when the archive transaction fails", async () => {
    const { database, workspace, actor, created } = fixture();
    const child = createDocument(database, workspace.id, actor, {
      title: "원자적 보관 하위 문서",
      parentDocumentId: created.document.id,
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "atomic-child", type: "p", children: [{ text: "하위" }] }],
      }),
    });
    createDocument(database, workspace.id, actor, {
      title: "원자적 보관 생존 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "atomic-survivor", type: "p", children: [{ text: "생존" }] }],
      }),
    });
    const rootState = ensureCollaborationState(database, workspace.id, created.document.id);
    const childState = ensureCollaborationState(database, workspace.id, child.document.id);
    const rootLive = collaborationYDocFromState(rootState.state);
    const childLive = collaborationYDocFromState(childState.state);
    replaceWorkingDocument(rootLive, { title: "아직 저장되지 않은 루트" }, {
      context: { actor, recordedByEndpoint: false },
    });
    replaceWorkingDocument(childLive, { title: "아직 저장되지 않은 하위" }, {
      context: { actor, recordedByEndpoint: false },
    });
    const rootLiveBefore = Buffer.from(Y.encodeStateAsUpdate(rootLive));
    const childLiveBefore = Buffer.from(Y.encodeStateAsUpdate(childLive));
    const beforeRoot = storedDraftAtomicSnapshot(database, created.document.id);
    const beforeChild = storedDraftAtomicSnapshot(database, child.document.id);
    const liveByRoom = new Map([
      [rootState.roomName, rootLive],
      [childState.roomName, childLive],
    ]);
    const closedRooms: string[] = [];
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          const document = liveByRoom.get(roomName);
          if (!document) throw new Error(`unexpected room ${roomName}`);
          return await callback(document);
        },
        closeConnections(roomName) {
          closedRooms.push(roomName);
        },
      },
    });
    database.exec(
      `CREATE TEMP TRIGGER inject_archive_atomicity_failure
       BEFORE UPDATE OF status ON documents
       WHEN NEW.status = 'archived'
       BEGIN
         SELECT RAISE(ABORT, 'injected archive atomicity failure');
       END;`,
    );
    try {
      await expect(commands.archiveWorkingTree({
        workspaceId: workspace.id,
        documentId: created.document.id,
        actor,
        baseRevision: created.document.revisionNumber,
      })).rejects.toThrow("injected archive atomicity failure");
    } finally {
      database.exec("DROP TRIGGER inject_archive_atomicity_failure");
    }

    expect(closedRooms.sort()).toEqual([rootState.roomName, childState.roomName].sort());
    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(beforeRoot);
    expect(storedDraftAtomicSnapshot(database, child.document.id)).toEqual(beforeChild);
    expect(Buffer.from(Y.encodeStateAsUpdate(rootLive))).toEqual(rootLiveBefore);
    expect(Buffer.from(Y.encodeStateAsUpdate(childLive))).toEqual(childLiveBefore);
    expect(getDocument(database, workspace.id, created.document.id).status).toBe("active");
    expect(getDocument(database, workspace.id, child.document.id).status).toBe("active");
    expect(database.prepare("SELECT COUNT(*) AS count FROM document_trash_batches").get())
      .toEqual({ count: 0 });
  });

  it("closes every opened room after a flush rejection without masking the primary error", async () => {
    const { database, workspace, actor, created } = fixture();
    const child = createDocument(database, workspace.id, actor, {
      title: "flush 실패 하위 문서",
      parentDocumentId: created.document.id,
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "flush-child", type: "p", children: [{ text: "하위" }] }],
      }),
    });
    createDocument(database, workspace.id, actor, {
      title: "flush 실패 생존 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "flush-survivor", type: "p", children: [{ text: "생존" }] }],
      }),
    });
    const rootState = ensureCollaborationState(database, workspace.id, created.document.id);
    const childState = ensureCollaborationState(database, workspace.id, child.document.id);
    const rootLive = collaborationYDocFromState(rootState.state);
    const childLive = collaborationYDocFromState(childState.state);
    replaceWorkingDocument(childLive, {
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [imageBlock(randomUUID(), "invalid-flush-media")],
      }),
    }, { context: { actor, recordedByEndpoint: false } });
    const beforeRoot = storedDraftAtomicSnapshot(database, created.document.id);
    const beforeChild = storedDraftAtomicSnapshot(database, child.document.id);
    const liveByRoom = new Map([
      [rootState.roomName, rootLive],
      [childState.roomName, childLive],
    ]);
    const closedRooms: string[] = [];
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          const document = liveByRoom.get(roomName);
          if (!document) throw new Error(`unexpected room ${roomName}`);
          return await callback(document);
        },
        closeConnections(roomName) {
          closedRooms.push(roomName);
          if (closedRooms.length === 1) throw new Error("secondary cleanup failure");
        },
      },
    });

    await expect(commands.archiveWorkingTree({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      baseRevision: created.document.revisionNumber,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(closedRooms.sort()).toEqual([rootState.roomName, childState.roomName].sort());
    expect(storedDraftAtomicSnapshot(database, created.document.id)).toEqual(beforeRoot);
    expect(storedDraftAtomicSnapshot(database, child.document.id)).toEqual(beforeChild);
    expect(getDocument(database, workspace.id, created.document.id).status).toBe("active");
    expect(getDocument(database, workspace.id, child.document.id).status).toBe("active");
  });

  it("unwinds direct provider callbacks before archiving and still closes the room on success", async () => {
    const { database, workspace, actor, created } = fixture();
    createDocument(database, workspace.id, actor, {
      title: "direct callback 생존 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "direct-survivor", type: "p", children: [{ text: "생존" }] }],
      }),
    });
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const liveDocument = collaborationYDocFromState(state.state);
    const lifecycle: string[] = [];
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          lifecycle.push(`open:${roomName}`);
          try {
            return await callback(liveDocument);
          } finally {
            const row = database.prepare(
              "SELECT status FROM documents WHERE workspace_id = ? AND id = ?",
            ).get(workspace.id, created.document.id) as { status: string };
            expect(row.status).toBe("active");
            lifecycle.push(`unwind:${roomName}`);
          }
        },
        closeConnections(roomName) {
          lifecycle.push(`close:${roomName}`);
        },
      },
    });

    const archived = await commands.archiveWorkingTree({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      baseRevision: created.document.revisionNumber,
    });

    expect(archived.archivedDocumentIds).toContain(created.document.id);
    expect(lifecycle).toEqual([
      `open:${state.roomName}`,
      `unwind:${state.roomName}`,
      `close:${state.roomName}`,
    ]);
  });

  it("seals open drafts and rejects updates from the pre-trash generation after restore", async () => {
    const { database, workspace, actor, created } = fixture();
    createDocument(database, workspace.id, actor, {
      title: "남아 있을 문서",
      content: parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: [{ id: "survivor", type: "p", children: [{ text: "유지" }] }],
      }),
    });
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const openDraft = collaborationYDocFromState(state.state);
    replaceWorkingDocument(openDraft, { title: "휴지통 직전의 열린 초안" }, {
      context: { actor, recordedByEndpoint: false },
    });
    const closedRooms: string[] = [];
    const storedProvider = createStoredCollaborationDocumentProvider(database);
    const commands = createCollaborationCommands({
      database,
      provider: {
        async withDocument(roomName, callback) {
          if (roomName === state.roomName) return await callback(openDraft);
          return storedProvider.withDocument(roomName, callback);
        },
        closeConnections(roomName) {
          closedRooms.push(roomName);
        },
      },
    });

    const archived = await commands.archiveWorkingTree({
      workspaceId: workspace.id,
      documentId: created.document.id,
      actor,
      baseRevision: created.document.revisionNumber,
    });
    expect(archived.archivedDocumentIds).toContain(created.document.id);
    expect(closedRooms).toEqual([state.roomName]);
    expect(() => loadCollaborationStateByRoom(database, state.roomName))
      .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));

    const sealed = database.prepare(
      `SELECT generation, draft_version
       FROM document_collaboration_states
       WHERE workspace_id = ? AND document_id = ?`,
    ).get(workspace.id, created.document.id) as {
      generation: number;
      draft_version: number;
    };
    expect(sealed.generation).toBe(state.generation + 1);
    const trashRoomName = collaborationRoomName(
      workspace.id,
      created.document.id,
      sealed.generation,
    );
    await expect(commands.replaceWorking({
      roomName: trashRoomName,
      actor,
      expectedDraftVersion: sealed.draft_version,
      replacement: { title: "휴지통에서 되살리려는 초안" },
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    restoreTrashedDocument(
      database,
      workspace.id,
      actor,
      created.document.id,
    );
    const restoredState = ensureCollaborationState(database, workspace.id, created.document.id);
    expect(restoredState.generation).toBe(state.generation + 2);
    const restored = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
    });
    expect(restored.workingDocument.title).toBe("휴지통 직전의 열린 초안");
    expect(() => persistCollaborationUpdate(
      database,
      state.roomName,
      openDraft,
      actor,
    )).toThrowError(expect.objectContaining({ code: "DRAFT_CONFLICT" }));
    await expect(commands.replaceWorking({
      roomName: trashRoomName,
      actor,
      expectedDraftVersion: sealed.draft_version,
      replacement: { title: "복구 뒤에도 되살리려는 초안" },
    })).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

    const changed = await commands.replaceWorking({
      roomName: restoredState.roomName,
      actor,
      expectedDraftVersion: restoredState.draftVersion,
      replacement: { title: "복구 뒤의 정상 편집" },
    });
    expect(changed.workingDocument).toMatchObject({
      generation: state.generation + 2,
      title: "복구 뒤의 정상 편집",
    });
  });

  it("loads history into a dirty draft and keeps canonical history fixed until commit", async () => {
    const { database, workspace, actor, created, commands } = fixture();
    const state = ensureCollaborationState(database, workspace.id, created.document.id);
    const changed = await commands.replaceWorking({
      roomName: state.roomName,
      actor,
      requestId: "draft-before-restore-001",
      expectedDraftVersion: 0,
      replacement: { title: "정본 2" },
    });
    const committedBeforeRestore = await commands.commitWorking({
      roomName: state.roomName,
      actor,
      requestId: "commit-before-restore-001",
      expectedDraftVersion: changed.workingDocument.draftVersion,
    });
    const revisionOne = getDocumentRevisionSnapshotByNumber(
      database,
      workspace.id,
      created.document.id,
      1,
    );

    const restored = await commands.resetWorking({
      workspaceId: workspace.id,
      documentId: created.document.id,
      revisionId: revisionOne.id,
      actor,
      requestId: "restore-to-draft-001",
      expectedGeneration: committedBeforeRestore.workingDocument.generation,
      expectedDraftVersion: committedBeforeRestore.workingDocument.draftVersion,
      expectedBaseRevision: committedBeforeRestore.workingDocument.baseRevisionNumber,
    });
    expect(restored.workingDocument).toMatchObject({
      title: "공유 초안 테스트",
      baseRevisionNumber: 2,
      draftVersion: 1,
      hasUncommittedChanges: true,
    });
    expect(getDocument(database, workspace.id, created.document.id)).toMatchObject({
      title: "정본 2",
      revisionNumber: 2,
    });
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);

    const committed = await commands.commitWorking({
      roomName: restored.roomName,
      actor,
      requestId: "commit-restored-draft-001",
      expectedDraftVersion: restored.workingDocument.draftVersion,
    });
    expect(committed.document).toMatchObject({
      title: "공유 초안 테스트",
      revisionNumber: 3,
    });
    expect(committed.workingDocument.hasUncommittedChanges).toBe(false);
  });
});
