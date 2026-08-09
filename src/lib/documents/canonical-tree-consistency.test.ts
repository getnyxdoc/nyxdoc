import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCollaborationCommands,
  createStoredCollaborationDocumentProvider,
} from "@/lib/collaboration/commands";
import {
  collaborationDocumentFromYDoc,
  collaborationYDocFromState,
  ensureCollaborationState,
} from "@/lib/collaboration/drafts";
import type { NyxDatabase } from "@/lib/db/client";
import {
  createDocument,
  getDocument,
  getDocumentRevisionSnapshotByNumber,
  listDocumentRevisions,
  reorderDocumentTree,
} from "@/lib/documents/service";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function content(id: string, text: string) {
  return parseNyxdocDocumentV2({
    schemaVersion: 2,
    blocks: [{ id, type: "p", children: [{ text }] }],
  });
}

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
  const commands = createCollaborationCommands({
    database,
    provider: createStoredCollaborationDocumentProvider(database),
  });
  return { database, workspace, actor, commands };
}

function decodedParents(database: NyxDatabase, workspaceId: string, documentId: string) {
  const document = getDocument(database, workspaceId, documentId);
  const revision = getDocumentRevisionSnapshotByNumber(
    database,
    workspaceId,
    documentId,
    document.revisionNumber,
  );
  const row = database.prepare(
    `SELECT parent_document_id, current_revision_id
     FROM documents
     WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, documentId) as {
    parent_document_id: string | null;
    current_revision_id: string;
  };
  const state = ensureCollaborationState(database, workspaceId, documentId);
  const working = collaborationDocumentFromYDoc(
    collaborationYDocFromState(state.state),
  );
  const committed = collaborationDocumentFromYDoc(
    collaborationYDocFromState(state.committedState),
  );

  expect(row.current_revision_id).toBe(document.revisionId);
  expect(state.baseRevisionId).toBe(document.revisionId);
  expect(state.baseRevisionNumber).toBe(document.revisionNumber);

  return {
    document,
    revision,
    state,
    rowParentDocumentId: row.parent_document_id,
    working,
    committed,
  };
}

function expectParentConsistency(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  expectedParentDocumentId: string | null,
) {
  const snapshot = decodedParents(database, workspaceId, documentId);
  expect({
    document: snapshot.document.parentDocumentId,
    currentRevision: snapshot.revision.parentDocumentId,
    row: snapshot.rowParentDocumentId,
    committedYjs: snapshot.committed.parentDocumentId,
    workingYjs: snapshot.working.parentDocumentId,
  }).toEqual({
    document: expectedParentDocumentId,
    currentRevision: expectedParentDocumentId,
    row: expectedParentDocumentId,
    committedYjs: expectedParentDocumentId,
    workingYjs: expectedParentDocumentId,
  });
  return snapshot;
}

describe("canonical document tree consistency", () => {
  it("keeps the document row, current revision, and both Yjs snapshots on one canonical parent", async () => {
    const { database, workspace, actor, commands } = fixture();
    const originalParent = createDocument(database, workspace.id, actor, {
      title: "원래 부모",
      content: content(randomUUID(), "원래 부모 본문"),
    });
    const destinationParent = createDocument(database, workspace.id, actor, {
      title: "새 부모",
      content: content(randomUUID(), "새 부모 본문"),
    });
    const source = createDocument(database, workspace.id, actor, {
      title: "이동할 문서",
      parentDocumentId: originalParent.document.id,
      content: content("canonical-body", "기존 정본 본문"),
    });
    const sibling = createDocument(database, workspace.id, actor, {
      title: "같은 부모의 형제",
      parentDocumentId: originalParent.document.id,
      content: content(randomUUID(), "형제 본문"),
    });

    ensureCollaborationState(database, workspace.id, source.document.id);
    const beforeReorder = expectParentConsistency(
      database,
      workspace.id,
      source.document.id,
      originalParent.document.id,
    );
    const revisionsBeforeReorder = listDocumentRevisions(
      database,
      workspace.id,
      source.document.id,
    );

    reorderDocumentTree(database, workspace.id, actor, source.document.id, {
      targetDocumentId: sibling.document.id,
      position: "after",
    });

    const afterReorder = expectParentConsistency(
      database,
      workspace.id,
      source.document.id,
      originalParent.document.id,
    );
    expect(afterReorder.document.revisionId).toBe(beforeReorder.document.revisionId);
    expect(afterReorder.document.revisionNumber).toBe(beforeReorder.document.revisionNumber);
    expect(listDocumentRevisions(database, workspace.id, source.document.id))
      .toHaveLength(revisionsBeforeReorder.length);

    const initialWorking = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: source.document.id,
    });
    const dirtyBody = content("dirty-body", "아직 저장하지 않은 작업 본문");
    const dirty = await commands.replaceWorking({
      roomName: initialWorking.workingDocument.roomName,
      actor,
      requestId: "canonical-tree-dirty-edit-001",
      expectedDraftVersion: initialWorking.workingDocument.draftVersion,
      replacement: { content: dirtyBody },
    });
    const revisionCountBeforeMove = listDocumentRevisions(
      database,
      workspace.id,
      source.document.id,
    ).length;

    const moved = await commands.moveWorkingDocumentTree({
      roomName: dirty.workingDocument.roomName,
      actor,
      requestId: "canonical-tree-dirty-move-001",
      expectedGeneration: dirty.workingDocument.generation,
      expectedDraftVersion: dirty.workingDocument.draftVersion,
      expectedBaseRevision: dirty.workingDocument.baseRevisionNumber,
      targetDocumentId: destinationParent.document.id,
      position: "inside",
      summary: "더티 초안을 보존한 메타데이터 이동",
    });

    expect(listDocumentRevisions(database, workspace.id, source.document.id))
      .toHaveLength(revisionCountBeforeMove + 1);
    const afterMove = expectParentConsistency(
      database,
      workspace.id,
      source.document.id,
      destinationParent.document.id,
    );
    expect(afterMove.revision.content).toEqual(source.document.content);
    expect(afterMove.committed.content).toEqual(source.document.content);
    expect(afterMove.working.content).toEqual(dirtyBody);
    expect(afterMove.state.hasUncommittedChanges).toBe(true);
    expect(moved.workingDocument).toMatchObject({
      parentDocumentId: destinationParent.document.id,
      hasUncommittedChanges: true,
    });

    const committed = await commands.commitWorking({
      roomName: moved.workingDocument.roomName,
      actor,
      requestId: "canonical-tree-dirty-commit-001",
      expectedDraftVersion: moved.workingDocument.draftVersion,
      summary: "이동 뒤 보존된 초안 본문 저장",
    });

    expect(committed.document.revisionNumber).toBe(afterMove.document.revisionNumber + 1);
    const afterCommit = expectParentConsistency(
      database,
      workspace.id,
      source.document.id,
      destinationParent.document.id,
    );
    expect(afterCommit.document.content).toEqual(dirtyBody);
    expect(afterCommit.revision.content).toEqual(dirtyBody);
    expect(afterCommit.committed.content).toEqual(dirtyBody);
    expect(afterCommit.working.content).toEqual(dirtyBody);
    expect(afterCommit.state.hasUncommittedChanges).toBe(false);
  });

  it("records a root fallback when a historical revision parent is trashed", async () => {
    const { database, workspace, actor, commands } = fixture();
    const historicalParent = createDocument(database, workspace.id, actor, {
      title: "과거 부모",
      content: content(randomUUID(), "과거 부모 본문"),
    });
    const child = createDocument(database, workspace.id, actor, {
      title: "과거 위치를 복원할 문서",
      parentDocumentId: historicalParent.document.id,
      content: content("historical-body", "과거 정본 본문"),
    });
    const rootAnchor = createDocument(database, workspace.id, actor, {
      title: "루트 기준 문서",
      content: content(randomUUID(), "루트 기준 본문"),
    });
    const historicalRevision = getDocumentRevisionSnapshotByNumber(
      database,
      workspace.id,
      child.document.id,
      1,
    );
    const initial = await commands.readWorking({
      workspaceId: workspace.id,
      documentId: child.document.id,
    });

    const movedToRoot = await commands.moveWorkingDocumentTree({
      roomName: initial.workingDocument.roomName,
      actor,
      requestId: "historical-root-move-001",
      expectedGeneration: initial.workingDocument.generation,
      expectedDraftVersion: initial.workingDocument.draftVersion,
      expectedBaseRevision: initial.workingDocument.baseRevisionNumber,
      targetDocumentId: rootAnchor.document.id,
      position: "before",
    });
    const changed = await commands.replaceWorking({
      roomName: movedToRoot.workingDocument.roomName,
      actor,
      requestId: "historical-root-edit-001",
      expectedDraftVersion: movedToRoot.workingDocument.draftVersion,
      replacement: { content: content("newer-body", "현재 정본 본문") },
    });
    const newerCanonical = await commands.commitWorking({
      roomName: changed.workingDocument.roomName,
      actor,
      requestId: "historical-root-commit-001",
      expectedDraftVersion: changed.workingDocument.draftVersion,
      summary: "루트에서 현재 본문 저장",
    });
    expectParentConsistency(database, workspace.id, child.document.id, null);

    await commands.archiveWorkingTree({
      workspaceId: workspace.id,
      documentId: historicalParent.document.id,
      actor,
      baseRevision: historicalParent.document.revisionNumber,
    });

    const stateBeforeRestore = ensureCollaborationState(database, workspace.id, child.document.id);
    const restoredDraft = await commands.resetWorking({
      workspaceId: workspace.id,
      documentId: child.document.id,
      revisionId: historicalRevision.id,
      actor,
      requestId: "historical-root-restore-001",
      expectedGeneration: stateBeforeRestore.generation,
      expectedDraftVersion: stateBeforeRestore.draftVersion,
      expectedBaseRevision: stateBeforeRestore.baseRevisionNumber,
    });
    expect(restoredDraft.workingDocument).toMatchObject({
      parentDocumentId: null,
      hasUncommittedChanges: true,
    });
    expect(restoredDraft.workingDocument.content).toEqual(historicalRevision.content);
    expect(getDocument(database, workspace.id, child.document.id).revisionNumber)
      .toBe(newerCanonical.document.revisionNumber);

    const revisionCountBeforeRestoreCommit = listDocumentRevisions(
      database,
      workspace.id,
      child.document.id,
    ).length;
    const restored = await commands.commitWorking({
      roomName: restoredDraft.workingDocument.roomName,
      actor,
      requestId: "historical-root-restore-commit-001",
      expectedDraftVersion: restoredDraft.workingDocument.draftVersion,
      summary: "사용할 수 없는 과거 부모를 루트로 보정해 복원",
    });

    expect(listDocumentRevisions(database, workspace.id, child.document.id))
      .toHaveLength(revisionCountBeforeRestoreCommit + 1);
    expect(restored.document.revisionNumber).toBe(newerCanonical.document.revisionNumber + 1);
    const afterRestore = expectParentConsistency(
      database,
      workspace.id,
      child.document.id,
      null,
    );
    expect(afterRestore.revision.content).toEqual(historicalRevision.content);
    expect(afterRestore.committed.content).toEqual(historicalRevision.content);
    expect(afterRestore.working.content).toEqual(historicalRevision.content);
    expect(afterRestore.state.hasUncommittedChanges).toBe(false);
  });
});
