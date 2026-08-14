import { slateNodesToInsertDelta, yTextToSlateElement } from "@slate-yjs/core";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  collaborationDocumentFromYDoc,
  collaborationYDocFromState,
  createCollaborationYDoc,
  ensureCollaborationState,
  persistCollaborationUpdate,
  persistCollaborationYDoc,
  repairCollaborationYDocNodeIds,
  workingDocumentFromStoredState,
} from "@/lib/collaboration/drafts";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import {
  NYXDOC_CONTENT_SCHEMA_VERSION,
  parseNyxdocDocumentV2,
} from "@/lib/editor/schema";
import {
  authenticateApiToken,
  createWorkspaceToken,
  tokenDocumentActor,
} from "@/lib/tokens/service";
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
  const firstProcessActor = {
    type: "human" as const,
    userId: user.id,
    principalId: "process-a",
    label: "Process A",
    source: "web" as const,
  };
  const credential = createWorkspaceToken(database, {
    workspaceId: workspace.id,
    userId: user.id,
    name: "Process B",
    role: "admin",
    scopes: ["documents:read", "documents:write"],
  });
  const secondProcessActor = tokenDocumentActor(
    authenticateApiToken(database, `Bearer ${credential.token}`),
    "api",
  );
  return {
    database,
    workspace,
    created,
    state,
    firstProcessActor,
    secondProcessActor,
  };
}

const terminalTableContent = parseNyxdocDocumentV2({
  schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
  blocks: [{
    id: "terminal-table",
    type: "table",
    children: [{
      id: "terminal-row",
      type: "tr",
      children: [{
        id: "terminal-cell",
        type: "td",
        children: [{
          id: "terminal-cell-paragraph",
          type: "p",
          children: [{ text: "마지막 표" }],
        }],
      }],
    }],
  }],
});

function terminalTableDraftFixture() {
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
    title: "표로 끝나는 문서",
    content: terminalTableContent,
  });
  const state = ensureCollaborationState(database, workspace.id, created.document.id);
  return { database, workspace, created, state };
}

describe("synthetic trailing editor paragraph", () => {
  it("keeps an editable paragraph in the Y.Doc without projecting it into canonical content", () => {
    const ydoc = createCollaborationYDoc({
      title: "표로 끝나는 문서",
      parentDocumentId: null,
      documentType: null,
      workflowStatus: "draft",
      tags: [],
      content: terminalTableContent,
    });
    const slateRoot = yTextToSlateElement(ydoc.get("content", Y.XmlText)) as unknown as {
      children: Array<{ type: string; children: Array<{ text?: string }> }>;
    };

    expect(slateRoot.children).toHaveLength(2);
    expect(slateRoot.children.at(-1)).toMatchObject({
      type: "p",
      children: [{ text: "" }],
    });
    expect(collaborationDocumentFromYDoc(ydoc).content).toEqual(terminalTableContent);
  });

  it("promotes text entered into the editor paragraph to ordinary document content", () => {
    const ydoc = createCollaborationYDoc({
      title: "표 뒤에 쓰는 문서",
      parentDocumentId: null,
      documentType: null,
      workflowStatus: "draft",
      tags: [],
      content: terminalTableContent,
    });
    const shared = ydoc.get("content", Y.XmlText);
    const slateRoot = yTextToSlateElement(shared) as unknown as {
      children: Array<Record<string, unknown> & { children: Array<{ text: string }> }>;
    };
    const edited = structuredClone(slateRoot.children);
    edited.at(-1)!.children[0].text = "표 뒤에 사용자가 입력한 내용";
    ydoc.transact(() => {
      shared.delete(0, shared.length);
      shared.applyDelta(slateNodesToInsertDelta(edited as never));
    }, "test-type-in-editor-placeholder");

    expect(collaborationDocumentFromYDoc(ydoc).content.blocks).toEqual([
      terminalTableContent.blocks[0],
      expect.objectContaining({
        type: "p",
        children: [{ text: "표 뒤에 사용자가 입력한 내용" }],
      }),
    ]);
  });

  it("does not expose the editor-only paragraph through the working document read", () => {
    const { database, workspace, created } = terminalTableDraftFixture();

    const working = workingDocumentFromStoredState(
      database,
      workspace.id,
      created.document.id,
    );

    expect(working.content).toEqual(terminalTableContent);
    expect(working.hasUncommittedChanges).toBe(false);
  });

  it("treats a synthetic-placeholder-only state difference as clean", () => {
    const { database, workspace, created, state } = terminalTableDraftFixture();
    const committedWithoutPlaceholder = collaborationYDocFromState(state.committedState);
    const shared = committedWithoutPlaceholder.get("content", Y.XmlText);
    const slateRoot = yTextToSlateElement(shared) as unknown as { children: unknown[] };
    committedWithoutPlaceholder.transact(() => {
      shared.delete(0, shared.length);
      shared.applyDelta(slateNodesToInsertDelta(slateRoot.children.slice(0, -1) as never));
    }, "test-remove-editor-placeholder");
    database.prepare(
      `UPDATE document_collaboration_states SET committed_yjs_state = ?
       WHERE workspace_id = ? AND document_id = ?`,
    ).run(
      Buffer.from(Y.encodeStateAsUpdate(committedWithoutPlaceholder)),
      workspace.id,
      created.document.id,
    );

    const loaded = ensureCollaborationState(database, workspace.id, created.document.id);

    expect(loaded.hasUncommittedChanges).toBe(false);
  });
});

describe("shared draft node ID repair", () => {
  it("projects a Yjs table with fractional column widths without losing data", () => {
    const colSizes = Array.from({ length: 7 }, () => 102.85714285714286);
    const table = {
      id: "fractional-table",
      type: "table",
      colSizes,
      children: [{
        id: "fractional-row",
        type: "tr",
        children: colSizes.map((_, column) => ({
          id: `fractional-cell-${column}`,
          type: "td",
          children: [{
            id: `fractional-cell-paragraph-${column}`,
            type: "p",
            children: [{ text: `열 ${column + 1}` }],
          }],
        })),
      }],
    };
    const content = parseNyxdocDocumentV2({
      schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
      blocks: [table],
    });
    const ydoc = createCollaborationYDoc({
      title: "소수 열 너비 표",
      parentDocumentId: null,
      documentType: null,
      workflowStatus: "draft",
      tags: [],
      content,
    });

    expect(collaborationDocumentFromYDoc(ydoc).content.blocks[0]).toEqual(content.blocks[0]);
  });

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

  it("persists one legacy normalization winner across independent restarts without changing draft accounting", () => {
    const { database, workspace, created } = storedDraftFixture();
    const legacy = duplicateDraft();
    const legacyState = Buffer.from(Y.encodeStateAsUpdate(legacy));
    database.prepare(
      `UPDATE document_collaboration_states
       SET yjs_state = ?, committed_yjs_state = ?,
           draft_version = 7, committed_draft_version = 7
       WHERE workspace_id = ? AND document_id = ?`,
    ).run(legacyState, legacyState, workspace.id, created.document.id);

    const before = database.prepare(
      `SELECT draft_version, committed_draft_version, updated_at, committed_at,
              (SELECT COUNT(*) FROM document_draft_contributors contributor
               WHERE contributor.document_id = document_collaboration_states.document_id) AS contributor_count,
              (SELECT COUNT(*) FROM document_revisions revision
               WHERE revision.document_id = document_collaboration_states.document_id) AS revision_count
       FROM document_collaboration_states
       WHERE workspace_id = ? AND document_id = ?`,
    ).get(workspace.id, created.document.id) as {
      draft_version: number;
      committed_draft_version: number;
      updated_at: string;
      committed_at: string | null;
      contributor_count: number;
      revision_count: number;
    };

    const firstRestart = ensureCollaborationState(database, workspace.id, created.document.id);
    const storedWinner = database.prepare(
      `SELECT yjs_state, committed_yjs_state, draft_version, committed_draft_version,
              updated_at, committed_at
       FROM document_collaboration_states
       WHERE workspace_id = ? AND document_id = ?`,
    ).get(workspace.id, created.document.id) as {
      yjs_state: Buffer;
      committed_yjs_state: Buffer;
      draft_version: number;
      committed_draft_version: number;
      updated_at: string;
      committed_at: string | null;
    };
    const secondRestart = ensureCollaborationState(database, workspace.id, created.document.id);

    expect(storedWinner.yjs_state).not.toEqual(legacyState);
    expect(storedWinner.committed_yjs_state).not.toEqual(legacyState);
    expect(storedWinner.committed_yjs_state).toEqual(storedWinner.yjs_state);
    expect(Buffer.from(firstRestart.state)).toEqual(storedWinner.yjs_state);
    expect(Buffer.from(firstRestart.committedState)).toEqual(storedWinner.committed_yjs_state);
    expect(Buffer.from(secondRestart.state)).toEqual(storedWinner.yjs_state);
    expect(Buffer.from(secondRestart.committedState)).toEqual(storedWinner.committed_yjs_state);

    const firstProcess = collaborationYDocFromState(firstRestart.state);
    const restartedProcess = collaborationYDocFromState(secondRestart.state);
    expect(firstProcess.clientID).not.toBe(restartedProcess.clientID);
    const mergedAfterRestart = new Y.Doc();
    Y.applyUpdate(mergedAfterRestart, Y.encodeStateAsUpdate(firstProcess), "first-process");
    Y.applyUpdate(mergedAfterRestart, Y.encodeStateAsUpdate(restartedProcess), "restarted-process");
    const mergedBlocks = collaborationDocumentFromYDoc(mergedAfterRestart).content.blocks;
    expect(mergedBlocks).toHaveLength(2);
    expect(mergedBlocks.map((block) => block.id)).toEqual([
      "duplicate",
      expect.stringMatching(/^nyxdoc-repair-[0-9a-f]{64}$/),
    ]);
    expect(mergedBlocks.map((block) => block.children[0])).toEqual([
      { text: "보존할 첫 문단" },
      { text: "보존할 둘째 문단" },
    ]);

    expect(firstRestart).toMatchObject({
      draftVersion: 7,
      committedDraftVersion: 7,
      hasUncommittedChanges: false,
      updatedAt: before.updated_at,
      committedAt: before.committed_at,
    });
    expect(secondRestart).toMatchObject({
      draftVersion: 7,
      committedDraftVersion: 7,
      hasUncommittedChanges: false,
      updatedAt: before.updated_at,
      committedAt: before.committed_at,
    });
    expect(storedWinner).toMatchObject({
      draft_version: before.draft_version,
      committed_draft_version: before.committed_draft_version,
      updated_at: before.updated_at,
      committed_at: before.committed_at,
    });
    expect(database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM document_draft_contributors WHERE document_id = ?) AS contributor_count,
         (SELECT COUNT(*) FROM document_revisions WHERE document_id = ?) AS revision_count`,
    ).get(created.document.id, created.document.id)).toEqual({
      contributor_count: before.contributor_count,
      revision_count: before.revision_count,
    });
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

describe("collaboration update persistence", () => {
  it("ignores CRDT-only history when the projected document did not change", () => {
    const {
      database,
      created,
      state,
      firstProcessActor,
    } = storedDraftFixture();
    const ydoc = collaborationYDocFromState(state.state);
    const metadata = ydoc.getMap<unknown>("metadata");
    const originalTitle = metadata.get("title");

    // Editor initialization and normalization can produce Yjs structs even
    // though the document a person and an agent read is unchanged. Model that
    // CRDT-only history explicitly instead of relying on byte equality.
    ydoc.transact(() => {
      metadata.set("title", "temporary internal value");
      metadata.set("title", originalTitle);
    }, "test-editor-internal-roundtrip");

    expect(Buffer.from(Y.encodeStateAsUpdate(ydoc))).not.toEqual(Buffer.from(state.state));
    expect(collaborationDocumentFromYDoc(ydoc)).toEqual(
      collaborationDocumentFromYDoc(collaborationYDocFromState(state.state)),
    );

    const persisted = persistCollaborationUpdate(
      database,
      state.roomName,
      ydoc,
      firstProcessActor,
    );
    const stored = database.prepare(
      `SELECT yjs_state, draft_version, committed_draft_version, updated_at,
              last_actor_type, last_actor_principal_id
       FROM document_collaboration_states
       WHERE document_id = ?`,
    ).get(created.document.id) as {
      yjs_state: Buffer;
      draft_version: number;
      committed_draft_version: number;
      updated_at: string;
      last_actor_type: string | null;
      last_actor_principal_id: string | null;
    };

    expect(persisted).toMatchObject({
      draftVersion: state.draftVersion,
      committedDraftVersion: state.committedDraftVersion,
      hasUncommittedChanges: false,
      updatedAt: state.updatedAt,
    });
    expect(stored).toMatchObject({
      draft_version: state.draftVersion,
      committed_draft_version: state.committedDraftVersion,
      updated_at: state.updatedAt,
      last_actor_type: null,
      last_actor_principal_id: null,
    });
    expect(stored.yjs_state).toEqual(Buffer.from(state.state));
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM document_draft_contributors
       WHERE document_id = ? AND generation = ?`,
    ).get(created.document.id, state.generation)).toEqual({ count: 0 });
  });

  it("merges a stale full Y.Doc with changes already persisted by another process", () => {
    const { database, created, state, firstProcessActor } = storedDraftFixture();
    const first = collaborationYDocFromState(state.state);
    const staleSecond = collaborationYDocFromState(state.state);

    first.getMap<unknown>("metadata").set("title", "먼저 저장된 제목");
    staleSecond.getMap<unknown>("metadata").set("tags", ["stale-process-tag"]);

    persistCollaborationUpdate(
      database,
      state.roomName,
      first,
      firstProcessActor,
    );
    persistCollaborationYDoc(database, state.roomName, staleSecond);

    const stored = database.prepare(
      `SELECT yjs_state, draft_version
       FROM document_collaboration_states
       WHERE document_id = ?`,
    ).get(created.document.id) as {
      yjs_state: Buffer;
      draft_version: number;
    };
    const storedDocument = collaborationDocumentFromYDoc(
      collaborationYDocFromState(new Uint8Array(stored.yjs_state)),
    );

    expect(storedDocument).toMatchObject({
      title: "먼저 저장된 제목",
      metadata: { tags: ["stale-process-tag"] },
    });
    expect(collaborationDocumentFromYDoc(staleSecond)).toMatchObject({
      title: "먼저 저장된 제목",
      metadata: { tags: ["stale-process-tag"] },
    });
    expect(stored.draft_version).toBe(2);
  });

  it("merges disjoint edits from independently loaded Y.Docs", () => {
    const {
      database,
      created,
      state,
      firstProcessActor,
      secondProcessActor,
    } = storedDraftFixture();
    const first = collaborationYDocFromState(state.state);
    const second = collaborationYDocFromState(state.state);

    first.getMap<unknown>("metadata").set("title", "프로세스 A의 제목");
    second.getMap<unknown>("metadata").set("tags", ["process-b-tag"]);

    const persistedFirst = persistCollaborationUpdate(
      database,
      state.roomName,
      first,
      firstProcessActor,
    );
    const persistedSecond = persistCollaborationUpdate(
      database,
      state.roomName,
      second,
      secondProcessActor,
    );

    const stored = database.prepare(
      `SELECT yjs_state, draft_version, last_actor_type, last_actor_principal_id
       FROM document_collaboration_states
       WHERE document_id = ?`,
    ).get(created.document.id) as {
      yjs_state: Buffer;
      draft_version: number;
      last_actor_type: string;
      last_actor_principal_id: string | null;
    };
    const storedDocument = collaborationDocumentFromYDoc(
      collaborationYDocFromState(new Uint8Array(stored.yjs_state)),
    );

    expect(storedDocument.title).toBe("프로세스 A의 제목");
    expect(storedDocument.metadata.tags).toEqual(["process-b-tag"]);
    expect(persistedFirst.draftVersion).toBe(1);
    expect(persistedSecond.draftVersion).toBe(2);
    expect(stored).toMatchObject({
      draft_version: 2,
      last_actor_type: "agent",
      last_actor_principal_id: secondProcessActor.principalId,
    });
    expect(database.prepare(
      `SELECT contributor_key, update_count
       FROM document_draft_contributors
       WHERE document_id = ? AND generation = ?
       ORDER BY contributor_key`,
    ).all(created.document.id, state.generation)).toEqual([
      { contributor_key: `agent:${secondProcessActor.principalId}`, update_count: 1 },
      { contributor_key: "human:process-a", update_count: 1 },
    ]);
  });

  it("does not leak an uncommitted merge into the caller Y.Doc", () => {
    const {
      database,
      created,
      state,
      firstProcessActor,
      secondProcessActor,
    } = storedDraftFixture();
    const first = collaborationYDocFromState(state.state);
    const second = collaborationYDocFromState(state.state);
    first.getMap<unknown>("metadata").set("title", "먼저 저장된 제목");
    second.getMap<unknown>("metadata").set("tags", ["실패할 태그"]);
    persistCollaborationUpdate(
      database,
      state.roomName,
      first,
      firstProcessActor,
    );
    const secondBeforeFailure = Buffer.from(Y.encodeStateAsUpdate(second));

    database.exec(`CREATE TEMP TRIGGER inject_draft_merge_failure
      BEFORE UPDATE OF yjs_state ON document_collaboration_states
      BEGIN
        SELECT RAISE(ABORT, 'injected draft merge failure');
      END;`);
    try {
      expect(() => persistCollaborationUpdate(
        database,
        state.roomName,
        second,
        secondProcessActor,
      )).toThrow("injected draft merge failure");
    } finally {
      database.exec("DROP TRIGGER inject_draft_merge_failure");
    }

    expect(Buffer.from(Y.encodeStateAsUpdate(second))).toEqual(secondBeforeFailure);
    expect(collaborationDocumentFromYDoc(second)).toMatchObject({
      title: "저장 초안 복구",
      metadata: { tags: ["실패할 태그"] },
    });
    const stored = ensureCollaborationState(
      database,
      state.workspaceId,
      state.documentId,
    );
    expect(stored.draftVersion).toBe(1);
    expect(collaborationDocumentFromYDoc(
      collaborationYDocFromState(stored.state),
    )).toMatchObject({
      title: "먼저 저장된 제목",
      metadata: { tags: [] },
    });
    expect(database.prepare(
      `SELECT contributor_key, update_count
       FROM document_draft_contributors
       WHERE document_id = ? AND generation = ?`,
    ).all(created.document.id, state.generation)).toEqual([
      { contributor_key: "human:process-a", update_count: 1 },
    ]);
  });
});
