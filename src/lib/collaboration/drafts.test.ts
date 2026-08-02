import { slateNodesToInsertDelta, yTextToSlateElement } from "@slate-yjs/core";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  collaborationDocumentFromYDoc,
  collaborationYDocFromState,
  createCollaborationYDoc,
  ensureCollaborationState,
  persistCollaborationYDoc,
  repairCollaborationYDocNodeIds,
} from "@/lib/collaboration/drafts";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import {
  NYXDOC_CONTENT_SCHEMA_VERSION,
  parseNyxdocDocumentV2,
} from "@/lib/editor/schema";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

const duplicatedBlocks = [
  { id: "duplicate", type: "p", children: [{ text: "보존할 첫 문단" }] },
  { id: "duplicate", type: "p", children: [{ text: "보존할 둘째 문단" }] },
] as const;

function duplicateDraft() {
  const ydoc = createCollaborationYDoc({
    title: "공유 초안 복구",
    parentDocumentId: null,
    documentType: null,
    workflowStatus: "draft",
    tags: [],
    content: {
      schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
      blocks: [{ id: "seed", type: "p", children: [{ text: "seed" }] }],
    },
  });
  const shared = ydoc.get("content", Y.XmlText);
  ydoc.transact(() => {
    shared.delete(0, shared.length);
    shared.applyDelta(slateNodesToInsertDelta(structuredClone(duplicatedBlocks) as never));
  }, "test-duplicate");
  return ydoc;
}

function missingIdLinkDraft() {
  const ydoc = createCollaborationYDoc({
    title: "외부 링크 복구",
    parentDocumentId: null,
    documentType: null,
    workflowStatus: "draft",
    tags: [],
    content: {
      schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
      blocks: [{ id: "seed", type: "p", children: [{ text: "seed" }] }],
    },
  });
  const shared = ydoc.get("content", Y.XmlText);
  ydoc.transact(() => {
    shared.delete(0, shared.length);
    shared.applyDelta(slateNodesToInsertDelta([
      {
        type: "p",
        children: [{
          type: "a",
          url: "https://example.com/guide",
          children: [{ text: "외부 문서" }],
        }],
      },
    ] as never));
  }, "test-missing-node-ids");
  return ydoc;
}

function storedDraftFixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const created = createDocument(database, workspace.id, {
    type: "human",
    userId: user.id,
    principalId: user.id,
    label: user.name,
    source: "web",
  }, {
    title: "저장 초안 복구",
    content: parseNyxdocDocumentV2({
      schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
      blocks: [{ id: "canonical", type: "p", children: [{ text: "정본" }] }],
    }),
  });
  const state = ensureCollaborationState(database, workspace.id, created.document.id);
  return { database, workspace, created, state };
}

describe("shared draft node ID repair", () => {
  it("keeps Slate-Yjs runtime IDs in the draft but removes them from canonical reads", () => {
    const ydoc = createCollaborationYDoc({
      title: "런타임 필드 투영",
      parentDocumentId: null,
      documentType: null,
      workflowStatus: "draft",
      tags: [],
      content: {
        schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
        blocks: [{ id: "seed", type: "p", children: [{ text: "seed" }] }],
      },
    });
    const shared = ydoc.get("content", Y.XmlText);
    ydoc.transact(() => {
      shared.delete(0, shared.length);
      shared.applyDelta(slateNodesToInsertDelta([
        {
          _id: "plate-runtime-block",
          id: "runtime-projection",
          type: "p",
          children: [{ _id: "plate-runtime-leaf", text: "내용은 그대로 보존됩니다." }],
        },
      ] as never));
    }, "test-runtime-fields");

    expect(collaborationDocumentFromYDoc(ydoc).content.blocks).toEqual([
      {
        id: "runtime-projection",
        type: "p",
        children: [{ text: "내용은 그대로 보존됩니다." }],
      },
    ]);

    const stored = yTextToSlateElement(shared) as unknown as {
      children: Array<{ _id?: string; children: Array<{ _id?: string }> }>;
    };
    expect(stored.children[0]._id).toBe("plate-runtime-block");
    expect(stored.children[0].children[0]._id).toBe("plate-runtime-leaf");
  });

  it("preserves every block and its text while replacing only later duplicate IDs", () => {
    const ydoc = duplicateDraft();
    const before = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    const document = collaborationDocumentFromYDoc(ydoc);

    expect(document.content.blocks).toHaveLength(2);
    expect(document.content.blocks.map((block) => block.id)).toEqual([
      "duplicate",
      expect.stringMatching(/^nyxdoc-repair-[0-9a-f]{64}$/),
    ]);
    expect(document.content.blocks.map((block) => block.children[0])).toEqual([
      { text: "보존할 첫 문단" },
      { text: "보존할 둘째 문단" },
    ]);

    const stored = yTextToSlateElement(ydoc.get("content", Y.XmlText)) as unknown as {
      children: Array<{ id: string }>;
    };
    expect(stored.children.map((block) => block.id)).toEqual(["duplicate", "duplicate"]);
    expect(Buffer.from(Y.encodeStateAsUpdate(ydoc))).toEqual(before);
  });

  it("is deterministic and idempotent across separately decoded copies", () => {
    const first = duplicateDraft();
    const second = duplicateDraft();

    expect(repairCollaborationYDocNodeIds(first)).toHaveLength(1);
    expect(repairCollaborationYDocNodeIds(second)).toHaveLength(1);
    expect(collaborationDocumentFromYDoc(first).content).toEqual(
      collaborationDocumentFromYDoc(second).content,
    );
    expect(repairCollaborationYDocNodeIds(first)).toEqual([]);
  });

  it("repairs missing element IDs while preserving an external document link", () => {
    const first = missingIdLinkDraft();
    const second = missingIdLinkDraft();

    const firstRepairs = repairCollaborationYDocNodeIds(first);
    const secondRepairs = repairCollaborationYDocNodeIds(second);
    expect(firstRepairs).toHaveLength(2);
    expect(firstRepairs.map((repair) => repair.reason)).toEqual(["missing", "missing"]);
    expect(secondRepairs).toEqual(firstRepairs);

    const firstDocument = collaborationDocumentFromYDoc(first);
    expect(firstDocument.content.blocks).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^nyxdoc-repair-[0-9a-f]{64}$/),
        type: "p",
        children: [{
          id: expect.stringMatching(/^nyxdoc-repair-[0-9a-f]{64}$/),
          type: "a",
          url: "https://example.com/guide",
          children: [{ text: "외부 문서" }],
        }],
      }),
    ]);
    expect(collaborationDocumentFromYDoc(second).content).toEqual(firstDocument.content);
    expect(repairCollaborationYDocNodeIds(first)).toEqual([]);
  });

  it("opens a stored draft with duplicate IDs and returns a normalized Yjs state", () => {
    const { database, workspace, created, state } = storedDraftFixture();
    const ydoc = duplicateDraft();
    const duplicatedState = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    database.prepare(
      `UPDATE document_collaboration_states SET yjs_state = ?, draft_version = 1
       WHERE workspace_id = ? AND document_id = ?`,
    ).run(duplicatedState, workspace.id, created.document.id);

    const loaded = ensureCollaborationState(database, workspace.id, created.document.id);

    expect(loaded.hasUncommittedChanges).toBe(true);
    expect(loaded.draftVersion).toBe(1);
    expect(collaborationDocumentFromYDoc(collaborationYDocFromState(loaded.state)).content.blocks)
      .toHaveLength(2);
    expect(Buffer.from(loaded.committedState)).toEqual(Buffer.from(state.committedState));
  });

  it("does not advance draftVersion when a read-only connection normalizes legacy IDs", () => {
    const { database, workspace, created, state } = storedDraftFixture();
    const legacy = duplicateDraft();
    const legacyState = Buffer.from(Y.encodeStateAsUpdate(legacy));
    database.prepare(
      `UPDATE document_collaboration_states SET yjs_state = ?, draft_version = 7
       WHERE workspace_id = ? AND document_id = ?`,
    ).run(legacyState, workspace.id, created.document.id);

    const opened = ensureCollaborationState(database, workspace.id, created.document.id);
    const projected = collaborationYDocFromState(opened.state);
    expect(collaborationDocumentFromYDoc(projected).content.blocks).toHaveLength(2);

    persistCollaborationYDoc(database, opened.roomName, projected);

    const stored = database.prepare(
      `SELECT yjs_state, draft_version FROM document_collaboration_states
       WHERE workspace_id = ? AND document_id = ?`,
    ).get(workspace.id, created.document.id) as { yjs_state: Buffer; draft_version: number };
    expect(stored.draft_version).toBe(7);
    expect(stored.yjs_state).toEqual(legacyState);
    expect(state.draftVersion).toBe(0);
  });

  it("allows an incomplete transient editor node to load but keeps strict document reads", () => {
    const { database, workspace, created, state } = storedDraftFixture();
    const ydoc = collaborationYDocFromState(state.state);
    const shared = ydoc.get("content", Y.XmlText);
    ydoc.transact(() => {
      shared.delete(0, shared.length);
      shared.applyDelta(slateNodesToInsertDelta([
        { type: "slash_input", children: [{ text: "/" }] },
      ] as never));
    }, "test-transient-input");
    database.prepare(
      `UPDATE document_collaboration_states SET yjs_state = ?, draft_version = 1
       WHERE workspace_id = ? AND document_id = ?`,
    ).run(Buffer.from(Y.encodeStateAsUpdate(ydoc)), workspace.id, created.document.id);

    const loaded = ensureCollaborationState(database, workspace.id, created.document.id);

    expect(loaded.hasUncommittedChanges).toBe(true);
    expect(() => collaborationDocumentFromYDoc(collaborationYDocFromState(loaded.state)))
      .toThrow("공유 초안의 문서 본문이 올바르지 않습니다.");
  });
});
