import { afterEach, describe, expect, it } from "vitest";
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

describe("collaboration command engine", () => {
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

    expect(await commands.replaceWorking(input)).toEqual(changed);
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
    expect(await commands.commitWorking(commitInput)).toEqual(committed);
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_events WHERE document_id = ?",
    ).get(created.document.id)).toEqual({ count: initialEventCount.count + 1 });
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
    expect(await commands.replaceAndCommitWorking(input)).toEqual(committed);
    expect(listDocumentRevisions(database, workspace.id, created.document.id)).toHaveLength(2);
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
    expect(closedRooms).toContain(state.roomName);
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
    await commands.commitWorking({
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
