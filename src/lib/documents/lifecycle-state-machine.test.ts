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
  archiveDocument,
  createDocument,
  getDocument,
  getDocumentRevisionSnapshotByNumber,
  purgeTrashedDocument,
  reorderDocumentTree,
  restoreDocumentRevision,
  restoreTrashedDocument,
  updateDocument,
} from "@/lib/documents/service";
import type { DocumentActor } from "@/lib/documents/types";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import { createWorkspaceToken } from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function content(text: string) {
  return parseNyxdocDocumentV2({
    schemaVersion: 2,
    blocks: [{ id: randomUUID(), type: "p", children: [{ text }] }],
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
  return { database, user, workspace, actor, commands };
}

type DocumentRow = {
  id: string;
  workspace_id: string;
  status: "active" | "archived";
  lifecycle_state: "active" | "trashed";
  parent_document_id: string | null;
  current_revision_id: string;
  revision_number: number;
};

type CollaborationRow = {
  document_id: string;
  workspace_id: string;
  yjs_state: Buffer;
  committed_yjs_state: Buffer;
  base_revision_id: string;
  base_revision_number: number;
  draft_version: number;
  committed_draft_version: number;
};

function documentRows(database: NyxDatabase) {
  return database.prepare(
    `SELECT document.id, document.workspace_id, document.status,
            document.lifecycle_state, document.parent_document_id,
            document.current_revision_id, revision.revision_number
     FROM documents document
     JOIN document_revisions revision ON revision.id = document.current_revision_id
     ORDER BY document.workspace_id, document.id`,
  ).all() as DocumentRow[];
}

/**
 * Model-independent invariants that must hold after every lifecycle command.
 * The revision watermark makes a later state prove monotonicity rather than
 * merely checking that the current rows happen to be internally consistent.
 */
function assertLifecycleInvariants(
  database: NyxDatabase,
  revisionWatermark: Map<string, number>,
) {
  const rows = documentRows(database);
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const row of rows) {
    const previousRevision = revisionWatermark.get(row.id) ?? 0;
    expect(Number(row.revision_number)).toBeGreaterThanOrEqual(previousRevision);
    revisionWatermark.set(row.id, Number(row.revision_number));

    const revisions = database.prepare(
      `SELECT id, revision_number
       FROM document_revisions
       WHERE document_id = ?
       ORDER BY revision_number`,
    ).all(row.id) as Array<{ id: string; revision_number: number }>;
    expect(revisions.map((revision) => Number(revision.revision_number))).toEqual(
      Array.from({ length: Number(row.revision_number) }, (_, index) => index + 1),
    );
    expect(revisions.at(-1)?.id).toBe(row.current_revision_id);

    if (row.parent_document_id) {
      const parent = byId.get(row.parent_document_id);
      expect(parent).toBeDefined();
      expect(parent?.workspace_id).toBe(row.workspace_id);
      if (row.lifecycle_state === "active") {
        expect(parent).toMatchObject({ status: "active", lifecycle_state: "active" });
      }
    }

    const visited = new Set<string>();
    let cursor: DocumentRow | undefined = row;
    while (cursor?.parent_document_id) {
      expect(visited.has(cursor.id)).toBe(false);
      visited.add(cursor.id);
      cursor = byId.get(cursor.parent_document_id);
    }
  }

  const collaborationRows = database.prepare(
    `SELECT document_id, workspace_id, yjs_state, committed_yjs_state,
            base_revision_id, base_revision_number, draft_version,
            committed_draft_version
     FROM document_collaboration_states
     ORDER BY document_id`,
  ).all() as CollaborationRow[];

  for (const state of collaborationRows) {
    const document = byId.get(state.document_id);
    expect(document).toBeDefined();
    expect(state.workspace_id).toBe(document?.workspace_id);
    expect(state.base_revision_id).toBe(document?.current_revision_id);
    expect(Number(state.base_revision_number)).toBe(Number(document?.revision_number));
    expect(Number(state.committed_draft_version)).toBeLessThanOrEqual(Number(state.draft_version));

    const baseRevision = database.prepare(
      `SELECT document_id, revision_number
       FROM document_revisions
       WHERE id = ?`,
    ).get(state.base_revision_id) as {
      document_id: string;
      revision_number: number;
    } | undefined;
    expect(baseRevision).toEqual({
      document_id: state.document_id,
      revision_number: Number(state.base_revision_number),
    });

    const canonical = getDocumentRevisionSnapshotByNumber(
      database,
      state.workspace_id,
      state.document_id,
      Number(state.base_revision_number),
    );
    const committed = collaborationDocumentFromYDoc(
      collaborationYDocFromState(new Uint8Array(state.committed_yjs_state)),
    );
    expect(committed).toMatchObject({
      title: canonical.title,
      parentDocumentId: canonical.parentDocumentId,
      metadata: canonical.metadata,
      content: canonical.content,
    });

    const working = collaborationDocumentFromYDoc(
      collaborationYDocFromState(new Uint8Array(state.yjs_state)),
    );
    if (JSON.stringify(working) === JSON.stringify(committed)) {
      expect(working).toEqual(committed);
    }
  }
}

function expectPurged(database: NyxDatabase, workspaceId: string, documentIds: string[]) {
  for (const documentId of documentIds) {
    expect(database.prepare("SELECT 1 FROM documents WHERE id = ?").get(documentId)).toBeUndefined();
    expect(database.prepare(
      "SELECT 1 FROM document_collaboration_states WHERE document_id = ?",
    ).get(documentId)).toBeUndefined();
    expect(database.prepare(
      `SELECT workspace_id
       FROM document_purge_tombstones
       WHERE document_id = ?`,
    ).get(documentId)).toEqual({ workspace_id: workspaceId });
  }
}

describe("document lifecycle state machine", () => {
  it.each([0x11, 0x2f, 0x5d])(
    "preserves tree, revision, and collaboration invariants through trace seed %i",
    async (seed) => {
      const { database, user, workspace, actor, commands } = fixture();
      const revisionWatermark = new Map<string, number>();
      const other = createTestUser(database, { name: `Other ${seed}` });
      const foreign = createDocument(database, other.workspace.id, {
        type: "human",
        userId: other.user.id,
        principalId: other.user.id,
        label: other.user.name,
        source: "web",
      }, {
        title: `foreign-${seed}`,
        content: content("다른 워크스페이스"),
      });

      const roots = [0, 1, 2].map((index) => createDocument(database, workspace.id, actor, {
        title: `root-${seed}-${index}`,
        content: content(`root ${index}`),
      }));
      const children = [0, 1, 2].map((index) => createDocument(database, workspace.id, actor, {
        title: `child-${seed}-${index}`,
        parentDocumentId: roots[0]!.document.id,
        content: content(`child ${index}`),
      }));
      const grandchild = createDocument(database, workspace.id, actor, {
        title: `grandchild-${seed}`,
        parentDocumentId: children[0]!.document.id,
        content: content("grandchild"),
      });
      assertLifecycleInvariants(database, revisionWatermark);

      expect(() => createDocument(database, workspace.id, actor, {
        title: "cross-workspace-parent",
        parentDocumentId: foreign.document.id,
        content: content("must fail"),
      })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(() => purgeTrashedDocument(
        database,
        workspace.id,
        actor,
        roots[0]!.document.id,
      )).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      assertLifecycleInvariants(database, revisionWatermark);

      const reorderSource = children[seed % children.length]!;
      const reorderTarget = children[(seed + 1) % children.length]!;
      const revisionBeforeReorder = getDocument(
        database,
        workspace.id,
        reorderSource.document.id,
      ).revisionNumber;
      reorderDocumentTree(database, workspace.id, actor, reorderSource.document.id, {
        targetDocumentId: reorderTarget.document.id,
        position: seed % 2 === 0 ? "before" : "after",
      });
      expect(getDocument(database, workspace.id, reorderSource.document.id).revisionNumber)
        .toBe(revisionBeforeReorder);
      assertLifecycleInvariants(database, revisionWatermark);

      const moving = children[(seed + 2) % children.length]!;
      const movingState = ensureCollaborationState(database, workspace.id, moving.document.id);
      const dirty = await commands.replaceWorking({
        roomName: movingState.roomName,
        actor,
        requestId: `trace-${seed}-dirty`,
        expectedDraftVersion: movingState.draftVersion,
        replacement: {
          title: `${moving.document.title}-dirty`,
          content: content(`dirty ${seed}`),
        },
      });
      expect(dirty.workingDocument.hasUncommittedChanges).toBe(true);
      assertLifecycleInvariants(database, revisionWatermark);

      const moved = await commands.moveWorkingDocumentTree({
        roomName: movingState.roomName,
        actor,
        requestId: `trace-${seed}-move`,
        targetDocumentId: roots[1]!.document.id,
        position: "inside",
        expectedGeneration: dirty.workingDocument.generation,
        expectedDraftVersion: dirty.workingDocument.draftVersion,
        expectedBaseRevision: dirty.workingDocument.baseRevisionNumber,
        summary: "dirty draft를 유지한 채 다른 부모로 이동",
      });
      expect(moved.document.parentDocumentId).toBe(roots[1]!.document.id);
      expect(moved.workingDocument.hasUncommittedChanges).toBe(true);
      assertLifecycleInvariants(database, revisionWatermark);

      const commitRequest = {
        roomName: moved.workingDocument.roomName,
        actor,
        requestId: `trace-${seed}-commit`,
        expectedDraftVersion: moved.workingDocument.draftVersion,
        summary: "이동한 초안을 명시적으로 저장",
      };
      const committed = await commands.commitWorking(commitRequest);
      const replayedCommit = await commands.commitWorking(commitRequest);
      expect(replayedCommit.document).toEqual(committed.document);
      expect(replayedCommit.workingDocument.hasUncommittedChanges).toBe(false);
      expect(getDocument(database, workspace.id, moving.document.id).revisionNumber)
        .toBe(committed.document.revisionNumber);
      assertLifecycleInvariants(database, revisionWatermark);

      const rootOne = getDocument(database, workspace.id, roots[1]!.document.id);
      await commands.archiveWorkingTree({
        workspaceId: workspace.id,
        documentId: rootOne.id,
        actor,
        baseRevision: rootOne.revisionNumber,
      });
      expect(() => getDocument(database, workspace.id, moving.document.id))
        .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      assertLifecycleInvariants(database, revisionWatermark);

      const restoredTree = restoreTrashedDocument(database, workspace.id, actor, rootOne.id);
      expect(restoredTree.documentIds).toContain(moving.document.id);
      expect(() => restoreTrashedDocument(database, workspace.id, actor, rootOne.id))
        .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      assertLifecycleInvariants(database, revisionWatermark);

      const historicalState = ensureCollaborationState(database, workspace.id, moving.document.id);
      const historical = getDocumentRevisionSnapshotByNumber(
        database,
        workspace.id,
        moving.document.id,
        1,
      );
      const restoredDraft = await commands.resetWorking({
        workspaceId: workspace.id,
        documentId: moving.document.id,
        revisionId: historical.id,
        actor,
        requestId: `trace-${seed}-historical-draft`,
        expectedGeneration: historicalState.generation,
        expectedDraftVersion: historicalState.draftVersion,
        expectedBaseRevision: historicalState.baseRevisionNumber,
      });
      expect(restoredDraft.workingDocument.hasUncommittedChanges).toBe(true);
      expect(restoredDraft.workingDocument.baseRevisionNumber).toBe(
        getDocument(database, workspace.id, moving.document.id).revisionNumber,
      );
      const restoredCommit = await commands.commitWorking({
        roomName: restoredDraft.roomName,
        actor,
        requestId: `trace-${seed}-historical-commit`,
        expectedDraftVersion: restoredDraft.workingDocument.draftVersion,
      });
      expect(restoredCommit.document.revisionNumber).toBeGreaterThan(historical.number);
      assertLifecycleInvariants(database, revisionWatermark);

      const detachedParent = createDocument(database, workspace.id, actor, {
        title: `detached-parent-${seed}`,
        content: content("parent"),
      });
      const detachedChild = createDocument(database, workspace.id, actor, {
        title: `detached-child-${seed}`,
        parentDocumentId: detachedParent.document.id,
        content: content("child"),
      });
      ensureCollaborationState(database, workspace.id, detachedChild.document.id);
      archiveDocument(database, workspace.id, actor, detachedChild.document.id, {
        baseRevision: detachedChild.document.revisionNumber,
      });
      archiveDocument(database, workspace.id, actor, detachedParent.document.id, {
        baseRevision: detachedParent.document.revisionNumber,
      });
      restoreTrashedDocument(database, workspace.id, actor, detachedChild.document.id);
      expect(getDocument(database, workspace.id, detachedChild.document.id)).toMatchObject({
        parentDocumentId: null,
        revisionNumber: 2,
      });
      restoreTrashedDocument(database, workspace.id, actor, detachedParent.document.id);
      assertLifecycleInvariants(database, revisionWatermark);

      const token = createWorkspaceToken(database, {
        workspaceId: workspace.id,
        userId: user.id,
        name: `lifecycle-${seed}`,
      });
      const agent: DocumentActor = {
        type: "agent",
        userId: user.id,
        tokenId: token.summary.id,
        label: `lifecycle-${seed}`,
        source: "mcp",
      };
      const createInput = {
        requestId: `trace-${seed}-agent-create`,
        title: `purge-root-${seed}`,
        content: content("purge root"),
      };
      const purgeRoot = createDocument(database, workspace.id, agent, createInput);
      expect(createDocument(database, workspace.id, agent, createInput)).toEqual(purgeRoot);
      const updateInput = {
        requestId: `trace-${seed}-agent-update`,
        baseRevision: purgeRoot.document.revisionNumber,
        title: `purge-root-${seed}-updated`,
      };
      const updatedPurgeRoot = updateDocument(
        database,
        workspace.id,
        agent,
        purgeRoot.document.id,
        updateInput,
      );
      expect(updateDocument(
        database,
        workspace.id,
        agent,
        purgeRoot.document.id,
        updateInput,
      )).toEqual(updatedPurgeRoot);
      expect(updatedPurgeRoot.document.revisionNumber).toBe(2);
      const revisionOne = getDocumentRevisionSnapshotByNumber(
        database,
        workspace.id,
        purgeRoot.document.id,
        1,
      );
      const revisionRestored = restoreDocumentRevision(
        database,
        workspace.id,
        agent,
        purgeRoot.document.id,
        revisionOne.id,
        2,
        `trace-${seed}-agent-restore`,
      );
      expect(restoreDocumentRevision(
        database,
        workspace.id,
        agent,
        purgeRoot.document.id,
        revisionOne.id,
        2,
        `trace-${seed}-agent-restore`,
      )).toEqual(revisionRestored);
      expect(revisionRestored.document.revisionNumber).toBe(3);
      const purgeChild = createDocument(database, workspace.id, actor, {
        title: `purge-child-${seed}`,
        parentDocumentId: purgeRoot.document.id,
        content: content("purge child"),
      });
      ensureCollaborationState(database, workspace.id, purgeRoot.document.id);
      ensureCollaborationState(database, workspace.id, purgeChild.document.id);
      assertLifecycleInvariants(database, revisionWatermark);

      archiveDocument(database, workspace.id, actor, purgeRoot.document.id, {
        baseRevision: revisionRestored.document.revisionNumber,
      });
      const purgedIds = [purgeRoot.document.id, purgeChild.document.id];
      const purged = purgeTrashedDocument(database, workspace.id, actor, purgeRoot.document.id);
      expect(purged.documentIds.sort()).toEqual([...purgedIds].sort());
      expectPurged(database, workspace.id, purgedIds);
      expect(() => restoreTrashedDocument(database, workspace.id, actor, purgeRoot.document.id))
        .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(() => purgeTrashedDocument(database, workspace.id, actor, purgeRoot.document.id))
        .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(() => ensureCollaborationState(database, workspace.id, purgeRoot.document.id))
        .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));

      // An idempotency receipt may still be replayed for auditability, but it
      // must never recreate the purged row or its collaboration state.
      expect(createDocument(database, workspace.id, agent, createInput).document.id)
        .toBe(purgeRoot.document.id);
      expectPurged(database, workspace.id, purgedIds);
      assertLifecycleInvariants(database, revisionWatermark);

      expect(() => updateDocument(
        database,
        workspace.id,
        actor,
        grandchild.document.id,
        {
          baseRevision: getDocument(database, workspace.id, grandchild.document.id).revisionNumber,
          parentDocumentId: foreign.document.id,
        },
      )).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      assertLifecycleInvariants(database, revisionWatermark);
    },
  );
});
