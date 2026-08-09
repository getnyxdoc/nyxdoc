import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createCollaborationCommands,
  createStoredCollaborationDocumentProvider,
  type CollaborationDocumentProvider,
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
  getDocumentRevisionSnapshotByNumber,
  listDocumentRevisions,
} from "@/lib/documents/service";
import { parseNyxdocDocumentV2, type NyxdocDocumentV2 } from "@/lib/editor/schema";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

type ExpectedSnapshot = {
  title: string;
  text: string;
};

type ExpectedState = {
  canonical: ExpectedSnapshot;
  working: ExpectedSnapshot;
  history: ExpectedSnapshot[];
  generation: number;
  draftVersion: number;
  committedDraftVersion: number;
  baseRevisionNumber: number;
  dirty: boolean;
};

function content(text: string): NyxdocDocumentV2 {
  return parseNyxdocDocumentV2({
    schemaVersion: 2,
    blocks: [{ id: "body", type: "p", children: [{ text }] }],
  });
}

function bodyText(documentContent: NyxdocDocumentV2) {
  const block = documentContent.blocks[0];
  if (!block || block.type !== "p") throw new Error("state-machine fixture lost its paragraph");
  const leaf = block.children[0];
  if (!leaf || !("text" in leaf)) throw new Error("state-machine fixture lost its text leaf");
  return leaf.text;
}

function sameSnapshot(left: ExpectedSnapshot, right: ExpectedSnapshot) {
  return left.title === right.title && left.text === right.text;
}

function fixture(providerFactory?: (
  database: NyxDatabase,
  roomName: string,
  initialState: Uint8Array,
) => CollaborationDocumentProvider) {
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
  const initial = { title: "canonical-1", text: "body-1" };
  const created = createDocument(database, workspace.id, actor, {
    title: initial.title,
    content: content(initial.text),
  });
  const state = ensureCollaborationState(database, workspace.id, created.document.id);
  const provider = providerFactory
    ? providerFactory(database, state.roomName, state.state)
    : createStoredCollaborationDocumentProvider(database);
  const commands = createCollaborationCommands({ database, provider });
  return { database, user, workspace, actor, created, state, commands, initial, provider };
}

function receiptCount(database: NyxDatabase, requestId: string) {
  return Number((database.prepare(
    `SELECT COUNT(*) AS count
     FROM collaboration_idempotency_requests
     WHERE request_id = ?`,
  ).get(requestId) as { count: number }).count);
}

function storedRow(database: NyxDatabase, documentId: string) {
  const row = database.prepare(
    `SELECT generation, draft_version, committed_draft_version,
            base_revision_number, yjs_state, committed_yjs_state
     FROM document_collaboration_states
     WHERE document_id = ?`,
  ).get(documentId) as {
    generation: number;
    draft_version: number;
    committed_draft_version: number;
    base_revision_number: number;
    yjs_state: Buffer;
    committed_yjs_state: Buffer;
  } | undefined;
  if (!row) throw new Error("state-machine fixture lost its collaboration row");
  return {
    generation: Number(row.generation),
    draftVersion: Number(row.draft_version),
    committedDraftVersion: Number(row.committed_draft_version),
    baseRevisionNumber: Number(row.base_revision_number),
    state: Buffer.from(row.yjs_state),
    committedState: Buffer.from(row.committed_yjs_state),
  };
}

async function expectState(
  input: ReturnType<typeof fixture>,
  expected: ExpectedState,
) {
  const canonical = getDocument(
    input.database,
    input.workspace.id,
    input.created.document.id,
  );
  const working = (await input.commands.readWorking({
    workspaceId: input.workspace.id,
    documentId: input.created.document.id,
  })).workingDocument;
  const stored = storedRow(input.database, input.created.document.id);

  expect({ title: canonical.title, text: bodyText(canonical.content) }).toEqual(
    expected.canonical,
  );
  expect({ title: working.title, text: bodyText(working.content) }).toEqual(
    expected.working,
  );
  expect(working).toMatchObject({
    generation: expected.generation,
    draftVersion: expected.draftVersion,
    committedDraftVersion: expected.committedDraftVersion,
    baseRevisionNumber: expected.baseRevisionNumber,
    hasUncommittedChanges: expected.dirty,
  });
  expect(stored).toMatchObject({
    generation: expected.generation,
    draftVersion: expected.draftVersion,
    committedDraftVersion: expected.committedDraftVersion,
    baseRevisionNumber: expected.baseRevisionNumber,
  });
  expect(listDocumentRevisions(
    input.database,
    input.workspace.id,
    input.created.document.id,
  )).toHaveLength(expected.history.length);

  if (!expected.dirty) {
    expect({ title: working.title, text: bodyText(working.content) }).toEqual(
      expected.canonical,
    );
  }
}

function nextRandom(seed: number) {
  return (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
}

describe("document collaboration state-machine hardening invariants", () => {
  it("matches a deterministic model through edit, replay, commit, discard, and historical restore", async () => {
    const input = fixture();
    const expected: ExpectedState = {
      canonical: input.initial,
      working: input.initial,
      history: [input.initial],
      generation: input.state.generation,
      draftVersion: input.state.draftVersion,
      committedDraftVersion: input.state.committedDraftVersion,
      baseRevisionNumber: 1,
      dirty: false,
    };
    let seed = 0x5eed_1234;

    await expectState(input, expected);

    for (let step = 0; step < 40; step += 1) {
      seed = nextRandom(seed);
      const operation = seed % 4;
      const requestId = `sm-${operation}-${String(step).padStart(3, "0")}-request`;

      if (operation === 0) {
        const replacement = {
          title: `draft-${step}`,
          content: content(`body-${step}`),
        };
        const request = {
          roomName: (await input.commands.readWorking({
            workspaceId: input.workspace.id,
            documentId: input.created.document.id,
          })).workingDocument.roomName,
          actor: input.actor,
          requestId,
          expectedDraftVersion: expected.draftVersion,
          replacement,
        };
        const changed = await input.commands.replaceWorking(request);
        expected.working = { title: replacement.title, text: `body-${step}` };
        expected.draftVersion += 1;
        expected.dirty = !sameSnapshot(expected.working, expected.canonical);
        expect(changed.mutationState).toMatchObject({ replayed: false });

        const replay = await input.commands.replaceWorking(request);
        expect(replay.mutationState).toMatchObject({
          replayed: true,
          receipt: { draftVersion: expected.draftVersion },
          current: { draftVersion: expected.draftVersion },
        });
        expect(receiptCount(input.database, requestId)).toBe(1);
      } else if (operation === 1) {
        const workingBefore = (await input.commands.readWorking({
          workspaceId: input.workspace.id,
          documentId: input.created.document.id,
        })).workingDocument;
        const request = {
          roomName: workingBefore.roomName,
          actor: input.actor,
          requestId,
          expectedDraftVersion: expected.draftVersion,
          summary: `model commit ${step}`,
        };
        const changedCanonical = !sameSnapshot(expected.working, expected.canonical);
        const committed = await input.commands.commitWorking(request);
        if (changedCanonical) {
          expected.canonical = { ...expected.working };
          expected.history.push({ ...expected.working });
          expected.baseRevisionNumber += 1;
        }
        expected.committedDraftVersion = expected.draftVersion;
        expected.dirty = false;
        expect(committed.unchanged).toBe(!changedCanonical);

        const revisionCount = expected.history.length;
        const replay = await input.commands.commitWorking(request);
        expect(replay.mutationState).toMatchObject({ replayed: true });
        expect(listDocumentRevisions(
          input.database,
          input.workspace.id,
          input.created.document.id,
        )).toHaveLength(revisionCount);
        expect(receiptCount(input.database, requestId)).toBe(1);
      } else {
        const before = (await input.commands.readWorking({
          workspaceId: input.workspace.id,
          documentId: input.created.document.id,
        })).workingDocument;
        const restoreHistory = operation === 3;
        const historyIndex = restoreHistory ? seed % expected.history.length : -1;
        const revision = restoreHistory
          ? getDocumentRevisionSnapshotByNumber(
              input.database,
              input.workspace.id,
              input.created.document.id,
              historyIndex + 1,
            )
          : null;
        const request = {
          workspaceId: input.workspace.id,
          documentId: input.created.document.id,
          ...(revision ? { revisionId: revision.id } : {}),
          actor: input.actor,
          requestId,
          expectedGeneration: expected.generation,
          expectedDraftVersion: expected.draftVersion,
          expectedBaseRevision: expected.baseRevisionNumber,
        };
        const reset = await input.commands.resetWorking(request);
        expected.generation += 1;
        expected.working = revision
          ? { ...expected.history[historyIndex]! }
          : { ...expected.canonical };
        expected.draftVersion = revision ? 1 : 0;
        expected.committedDraftVersion = 0;
        expected.dirty = !sameSnapshot(expected.working, expected.canonical);
        expect(reset.roomName).not.toBe(before.roomName);

        const replay = await input.commands.resetWorking(request);
        expect(replay.mutationState).toMatchObject({ replayed: true });
        expect(replay.workingDocument.generation).toBe(expected.generation);
        expect(receiptCount(input.database, requestId)).toBe(1);
      }

      await expectState(input, expected);
    }
  });

  it("merges independent stale-process updates but rejects a stale in-memory commit", async () => {
    const input = fixture();
    const original = loadCollaborationStateByRoom(input.database, input.state.roomName);
    const processA = collaborationYDocFromState(original.state);
    const processB = collaborationYDocFromState(original.state);

    replaceWorkingDocument(processA, { title: "process-a-title" }, {
      context: { actor: input.actor, recordedByEndpoint: true },
    });
    const afterA = persistCollaborationUpdate(
      input.database,
      original.roomName,
      processA,
      input.actor,
    );
    expect(afterA.draftVersion).toBe(1);

    const processBActor = {
      ...input.actor,
      principalId: "state-machine-process-b",
      label: "State machine process B",
      source: "api" as const,
    };
    replaceWorkingDocument(processB, { tags: ["process-b-tag"] }, {
      context: { actor: processBActor, recordedByEndpoint: true },
    });
    const afterB = persistCollaborationUpdate(
      input.database,
      original.roomName,
      processB,
      processBActor,
    );
    expect(afterB.draftVersion).toBe(2);

    expect(workingDocumentFromStoredState(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toMatchObject({
      title: "process-a-title",
      metadata: { tags: ["process-b-tag"] },
      draftVersion: 2,
      hasUncommittedChanges: true,
    });

    const staleCommands = createCollaborationCommands({
      database: input.database,
      provider: {
        async withDocument(roomName, callback) {
          expect(roomName).toBe(original.roomName);
          return await callback(processA);
        },
        closeConnections() {},
      },
    });
    const failedRequestId = "sm-stale-commit-rejected-001";
    const storedBefore = storedRow(input.database, input.created.document.id);

    await expect(staleCommands.commitWorking({
      roomName: original.roomName,
      actor: input.actor,
      requestId: failedRequestId,
      expectedDraftVersion: afterB.draftVersion,
    })).rejects.toMatchObject({ code: "DRAFT_VERSION_CONFLICT" });

    expect(storedRow(input.database, input.created.document.id)).toEqual(storedBefore);
    expect(listDocumentRevisions(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toHaveLength(1);
    expect(receiptCount(input.database, failedRequestId)).toBe(0);

    const committed = await input.commands.commitWorking({
      roomName: original.roomName,
      actor: input.actor,
      requestId: "sm-merged-commit-accepted-001",
      expectedDraftVersion: afterB.draftVersion,
    });
    expect(committed.document).toMatchObject({
      title: "process-a-title",
      tags: ["process-b-tag"],
      revisionNumber: 2,
    });
    expect(committed.workingDocument).toMatchObject({
      hasUncommittedChanges: false,
      draftVersion: 2,
      committedDraftVersion: 2,
    });
    expect(listDocumentRevisions(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toHaveLength(2);
  });

  it("rolls back every canonical effect when commit bookkeeping fails, then retries exactly once", async () => {
    let liveDocument: Y.Doc | null = null;
    const input = fixture((_database, _roomName, initialState) => {
      liveDocument = collaborationYDocFromState(initialState);
      return {
        async withDocument(_roomName, callback) {
          return await callback(liveDocument!);
        },
        closeConnections() {},
      };
    });
    const changed = await input.commands.replaceWorking({
      roomName: input.state.roomName,
      actor: input.actor,
      requestId: "sm-fault-draft-change-001",
      expectedDraftVersion: input.state.draftVersion,
      replacement: { title: "commit-fault-draft", content: content("commit-fault-body") },
    });
    const beforeStored = storedRow(input.database, input.created.document.id);
    const beforeLive = Buffer.from(Y.encodeStateAsUpdate(liveDocument!));
    const requestId = "sm-fault-commit-rollback-001";

    input.database.exec(
      `CREATE TEMP TRIGGER inject_state_machine_commit_failure
       BEFORE UPDATE OF base_revision_id ON document_collaboration_states
       WHEN NEW.base_revision_number = 2
       BEGIN
         SELECT RAISE(ABORT, 'injected state-machine commit failure');
       END;`,
    );
    try {
      await expect(input.commands.commitWorking({
        roomName: input.state.roomName,
        actor: input.actor,
        requestId,
        expectedDraftVersion: changed.workingDocument.draftVersion,
      })).rejects.toThrow("injected state-machine commit failure");
    } finally {
      input.database.exec("DROP TRIGGER inject_state_machine_commit_failure");
    }

    expect(storedRow(input.database, input.created.document.id)).toEqual(beforeStored);
    expect(Buffer.from(Y.encodeStateAsUpdate(liveDocument!))).toEqual(beforeLive);
    expect(getDocument(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toMatchObject({ title: input.initial.title, revisionNumber: 1 });
    expect(listDocumentRevisions(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toHaveLength(1);
    expect(receiptCount(input.database, requestId)).toBe(0);

    const retried = await input.commands.commitWorking({
      roomName: input.state.roomName,
      actor: input.actor,
      requestId,
      expectedDraftVersion: changed.workingDocument.draftVersion,
    });
    expect(retried.document).toMatchObject({
      title: "commit-fault-draft",
      revisionNumber: 2,
    });
    expect(retried.workingDocument.hasUncommittedChanges).toBe(false);
    expect(receiptCount(input.database, requestId)).toBe(1);
    expect(listDocumentRevisions(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toHaveLength(2);
  });

  it.each([
    { mode: "discard" as const, restoreRevision: false },
    { mode: "restore" as const, restoreRevision: true },
  ])("rolls back a failed $mode generation reset and permits a clean retry", async ({ mode, restoreRevision }) => {
    const input = fixture();
    const firstEdit = await input.commands.replaceWorking({
      roomName: input.state.roomName,
      actor: input.actor,
      requestId: `sm-${mode}-seed-edit-001`,
      expectedDraftVersion: input.state.draftVersion,
      replacement: { title: "canonical-2", content: content("body-2") },
    });
    const canonicalTwo = await input.commands.commitWorking({
      roomName: input.state.roomName,
      actor: input.actor,
      requestId: `sm-${mode}-seed-commit-001`,
      expectedDraftVersion: firstEdit.workingDocument.draftVersion,
    });
    const dirty = await input.commands.replaceWorking({
      roomName: input.state.roomName,
      actor: input.actor,
      requestId: `sm-${mode}-dirty-edit-001`,
      expectedDraftVersion: canonicalTwo.workingDocument.draftVersion,
      replacement: { title: "uncommitted-3", content: content("body-3") },
    });
    const revisionOne = getDocumentRevisionSnapshotByNumber(
      input.database,
      input.workspace.id,
      input.created.document.id,
      1,
    );
    const requestId = `sm-${mode}-fault-reset-001`;
    const request = {
      workspaceId: input.workspace.id,
      documentId: input.created.document.id,
      ...(restoreRevision ? { revisionId: revisionOne.id } : {}),
      actor: input.actor,
      requestId,
      expectedGeneration: dirty.workingDocument.generation,
      expectedDraftVersion: dirty.workingDocument.draftVersion,
      expectedBaseRevision: dirty.workingDocument.baseRevisionNumber,
    };
    const before = storedRow(input.database, input.created.document.id);

    input.database.exec(
      `CREATE TEMP TRIGGER inject_state_machine_reset_failure
       BEFORE UPDATE OF generation ON document_collaboration_states
       BEGIN
         SELECT RAISE(ABORT, 'injected state-machine reset failure');
       END;`,
    );
    try {
      await expect(input.commands.resetWorking(request)).rejects.toThrow(
        "injected state-machine reset failure",
      );
    } finally {
      input.database.exec("DROP TRIGGER inject_state_machine_reset_failure");
    }

    expect(storedRow(input.database, input.created.document.id)).toEqual(before);
    expect(workingDocumentFromStoredState(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toMatchObject({
      title: "uncommitted-3",
      hasUncommittedChanges: true,
      generation: dirty.workingDocument.generation,
      draftVersion: dirty.workingDocument.draftVersion,
    });
    expect(getDocument(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toMatchObject({ title: "canonical-2", revisionNumber: 2 });
    expect(listDocumentRevisions(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toHaveLength(2);
    expect(receiptCount(input.database, requestId)).toBe(0);

    const retried = await input.commands.resetWorking(request);
    expect(retried.workingDocument).toMatchObject(restoreRevision
      ? {
          title: input.initial.title,
          generation: dirty.workingDocument.generation + 1,
          draftVersion: 1,
          committedDraftVersion: 0,
          baseRevisionNumber: 2,
          hasUncommittedChanges: true,
        }
      : {
          title: "canonical-2",
          generation: dirty.workingDocument.generation + 1,
          draftVersion: 0,
          committedDraftVersion: 0,
          baseRevisionNumber: 2,
          hasUncommittedChanges: false,
        });
    expect(receiptCount(input.database, requestId)).toBe(1);
    expect(listDocumentRevisions(
      input.database,
      input.workspace.id,
      input.created.document.id,
    )).toHaveLength(2);
  });
});
