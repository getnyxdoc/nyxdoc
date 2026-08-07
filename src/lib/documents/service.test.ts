import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCollaborationState } from "@/lib/collaboration/drafts";
import type { NyxDatabase } from "@/lib/db/client";
import {
  archiveDocument,
  batchGetDocuments,
  createDocument,
  diffDocumentRevisions,
  getChanges,
  getDocument,
  getDocumentBacklinks,
  getDocumentRevisionSnapshot,
  getDocumentRevisionSnapshotByNumber,
  listDocuments,
  listTrashBatches,
  patchDocument,
  purgeTrashedDocument,
  queryDocuments,
  reorderDocumentTree,
  restoreDocumentRevision,
  restoreTrashedDocument,
  searchDocumentContents,
  updateDocument,
} from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import { nyxdocBlockText, parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import { createWorkspaceToken } from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

function textContent(blocks: Array<{
  id?: string;
  type?: "p" | "h1" | "h2" | "h3" | "blockquote" | "callout";
  text: string;
  indent?: number;
  listStyleType?: "disc" | "decimal" | "todo";
  checked?: boolean;
}>) {
  return parseNyxdocDocumentV2({
    schemaVersion: 2,
    blocks: blocks.map(({ text, ...block }) => ({
      id: block.id ?? randomUUID(),
      type: block.type ?? "p",
      ...block,
      children: [{ text }],
    })),
  });
}

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  return { database, user, workspace };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("document command service", () => {
  it("stores and reloads a long imported document without dropping blocks", () => {
    const { database, user, workspace } = fixture();
    const actor = {
      type: "human" as const,
      userId: user.id,
      label: user.name,
      source: "web" as const,
    };
    const content = textContent(Array.from({ length: 945 }, (_, index) => ({
      id: `imported-block-${index}`,
      text: `가져온 원문 문단 ${index + 1}`,
    })));

    const created = createDocument(database, workspace.id, actor, {
      title: "가져온 장문 문서",
      content,
    });
    const reloaded = getDocument(database, workspace.id, created.document.id);

    expect(reloaded.content.blocks).toHaveLength(945);
    expect(reloaded.content.blocks.map((block) => block.id)).toEqual(
      content.blocks.map((block) => block.id),
    );
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_blocks WHERE document_id = ? AND deleted_at IS NULL",
    ).get(created.document.id)).toEqual({ count: 945 });
  });

  it("replays retry-safe agent writes and rejects requestId reuse with a different payload", () => {
    const { database, user, workspace } = fixture();
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "OpenClaw",
    });
    const actor = {
      type: "agent" as const,
      userId: user.id,
      tokenId: token.summary.id,
      label: "OpenClaw",
      source: "mcp" as const,
    };
    const input = {
      requestId: "create-game-note-001",
      title: "게임 조사",
      content: textContent([{ text: "첫 조사 결과" }]),
      summary: "게임 조사 문서를 만들었습니다.",
    };

    const first = createDocument(database, workspace.id, actor, input);
    const replayed = createDocument(database, workspace.id, actor, input);
    expect(replayed).toEqual(first);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ? AND title = ?")
        .get(workspace.id, input.title),
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM document_revisions WHERE document_id = ?")
        .get(first.document.id),
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM agent_write_requests WHERE token_id = ?")
        .get(token.summary.id),
    ).toEqual({ count: 1 });

    expect(() => createDocument(database, workspace.id, actor, {
      ...input,
      title: "다른 게임 조사",
    })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("rejects direct agent document writes after the credential grant binding is revoked", () => {
    const { database, user, workspace } = fixture();
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Unbound writer",
    });
    database.prepare(
      `UPDATE agent_credential_grant_bindings
       SET status = 'revoked', revoked_at = ?
       WHERE credential_id = ?`,
    ).run("2026-08-03T00:00:00.000Z", token.summary.id);

    expect(() => createDocument(database, workspace.id, {
      type: "agent",
      userId: user.id,
      tokenId: token.summary.id,
      label: "Unbound writer",
      source: "mcp",
    }, {
      requestId: "unbound-document-write-001",
      title: "Should not be created",
      content: textContent([{ text: "Denied" }]),
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("applies ordered block patches as one revision, replays retries, and reports conflicting blocks", () => {
    const { database, user, workspace } = fixture();
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "OpenClaw",
    });
    const agent = {
      type: "agent" as const,
      userId: user.id,
      tokenId: token.summary.id,
      label: "OpenClaw",
      source: "mcp" as const,
    };
    const human = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const created = createDocument(database, workspace.id, human, {
      title: "부분 수정",
      content: textContent([
        { type: "h1", text: "A" },
        { text: "B" },
        { text: "C" },
      ],
    )});
    const [a, b, c] = created.document.content.blocks;
    const input = {
      baseRevision: 1,
      requestId: "patch-game-note-001",
      summary: "필요한 블록만 정리했습니다.",
      operations: [
        { op: "replace_block" as const, blockId: a.id, block: { type: "h2", children: [{ text: "A2" }] } },
        { op: "insert_after" as const, anchorBlockId: a.id, blocks: [{ type: "p", children: [{ text: "D" }] }] },
        { op: "move_before" as const, blockId: c.id, anchorBlockId: b.id },
        { op: "delete_block" as const, blockId: b.id },
      ],
    };

    const patched = patchDocument(database, workspace.id, agent, created.document.id, input);
    expect(patched.document.revisionNumber).toBe(2);
    expect(patched.document.content.blocks.map((block) => block.id)).toEqual([
      a.id,
      expect.any(String),
      c.id,
    ]);
    expect(patched.document.content.blocks.map(nyxdocBlockText)).toEqual(["A2", "D", "C"]);
    expect(patchDocument(database, workspace.id, agent, created.document.id, input)).toEqual(patched);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM document_revisions WHERE document_id = ?")
        .get(created.document.id),
    ).toEqual({ count: 2 });

    const humanContent = structuredClone(patched.document.content);
    const changed = humanContent.blocks.find((block) => block.id === c.id);
    expect(changed && "children" in changed).toBe(true);
    if (changed && "children" in changed && changed.type === "p") {
      changed.children = [{ text: "사람이 바꾼 C" }];
    }
    updateDocument(database, workspace.id, human, created.document.id, {
      baseRevision: 2,
      content: humanContent,
      summary: "사람이 C를 수정했습니다.",
    });

    try {
      patchDocument(database, workspace.id, agent, created.document.id, {
        baseRevision: 2,
        requestId: "patch-game-note-002",
        operations: [{
          op: "replace_block",
          blockId: c.id,
          block: { type: "p", children: [{ text: "에이전트가 바꾼 C" }] },
        }],
      });
      throw new Error("revision conflict expected");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentServiceError);
      expect(error).toMatchObject({
        code: "REVISION_CONFLICT",
        details: expect.objectContaining({
          baseRevision: 2,
          currentRevision: 3,
          changedBlockIds: expect.arrayContaining([c.id]),
          conflictingBlockIds: [c.id],
        }),
      });
    }
  });

  it("returns document paths, matched block context, batch reads, and block-level revision diffs", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const parent = createDocument(database, workspace.id, actor, {
      title: "게임 프로젝트",
      content: textContent([{ text: "게임 자료의 정본입니다." }]),
    });
    const child = createDocument(database, workspace.id, actor, {
      title: "추천 기록",
      parentDocumentId: parent.document.id,
      content: textContent([
        { text: "전략 게임을 우선 추천합니다." },
        { text: "보류 항목" },
        { text: "마지막 검토" },
      ],
    )});
    const [first, removed, moved] = child.document.content.blocks;

    const listed = queryDocuments(database, workspace.id, {
      withinDocumentId: parent.document.id,
      titlePrefix: "추천",
    });
    expect(listed).toMatchObject({ total: 1, nextOffset: null });
    expect(listed.documents[0].path).toEqual([
      { id: parent.document.id, title: "게임 프로젝트" },
      { id: child.document.id, title: "추천 기록" },
    ]);

    const searched = searchDocumentContents(database, workspace.id, "전략 게임", {
      withinDocumentId: parent.document.id,
    });
    expect(searched).toHaveLength(1);
    expect(searched[0]).toMatchObject({
      documentId: child.document.id,
      revisionNumber: 1,
      matches: [{ kind: "body", blockId: first.id, nodeType: "p", snippet: expect.stringContaining("전략 게임") }],
    });

    const batch = batchGetDocuments(database, workspace.id, [child.document.id, randomUUID()]);
    expect(batch.documents.map((document) => document.id)).toEqual([child.document.id]);
    expect(batch.missingDocumentIds).toHaveLength(1);

    const nextContent = structuredClone(child.document.content);
    const firstBlock = nextContent.blocks.find((block) => block.id === first.id);
    if (firstBlock?.type === "p") firstBlock.children = [{ text: "전략 게임과 퍼즐을 추천합니다." }];
    nextContent.blocks = [
      nextContent.blocks.find((block) => block.id === moved.id)!,
      nextContent.blocks.find((block) => block.id === first.id)!,
      { id: "new-recommendation", type: "p", children: [{ text: "새 추천" }] },
    ];
    updateDocument(database, workspace.id, actor, child.document.id, {
      baseRevision: 1,
      content: nextContent,
      summary: "추천 기록을 재정리했습니다.",
    });

    const diff = diffDocumentRevisions(database, workspace.id, child.document.id, 1, 2);
    expect(diff.added).toMatchObject([{ blockId: "new-recommendation", index: 2 }]);
    expect(diff.removed).toMatchObject([{ blockId: removed.id, index: 1 }]);
    expect(diff.modified).toMatchObject([{ blockId: first.id }]);
    expect(diff.moved).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: moved.id })]));
  });

  it("normalizes Unicode search across NFC and NFD text", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const nfdTitle = "한글 제목".normalize("NFD");
    const nfdBody = "에이전트 협업 문서".normalize("NFD");
    const created = createDocument(database, workspace.id, actor, {
      title: nfdTitle,
      content: textContent([{ text: nfdBody }]),
    });

    expect(searchDocumentContents(database, workspace.id, "한글 제목")).toMatchObject([
      { documentId: created.document.id, matches: [{ kind: "title" }] },
    ]);
    expect(searchDocumentContents(database, workspace.id, "에이전트 협업")).toMatchObject([
      { documentId: created.document.id, matches: [{ kind: "body" }] },
    ]);
  });

  it("returns a stable depth-first document tree even when descendant orders are smaller", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const parent = createDocument(database, workspace.id, actor, {
      title: "QA 루트",
      content: textContent([{ text: "루트" }]),
    });
    const child = createDocument(database, workspace.id, actor, {
      title: "QA 자식",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "자식" }]),
    });
    const grandchild = createDocument(database, workspace.id, actor, {
      title: "QA 손자",
      parentDocumentId: child.document.id,
      content: textContent([{ text: "손자" }]),
    });
    const sibling = createDocument(database, workspace.id, actor, {
      title: "QA 형제",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "형제" }]),
    });
    database.prepare("UPDATE documents SET tree_order = 10 WHERE id = ?").run(grandchild.document.id);
    database.prepare("UPDATE documents SET tree_order = 200 WHERE id = ?").run(sibling.document.id);

    const ids = new Set([parent.document.id, child.document.id, grandchild.document.id, sibling.document.id]);
    expect(listDocuments(database, workspace.id).filter((document) => ids.has(document.id)).map((document) => document.id))
      .toEqual([parent.document.id, child.document.id, grandchild.document.id, sibling.document.id]);
  });

  it("reorders sibling branches without creating a document revision", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const parent = createDocument(database, workspace.id, actor, {
      title: "날짜별 글",
      content: textContent([{ text: "상위 문서" }]),
    });
    const zero = createDocument(database, workspace.id, actor, {
      title: "00",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "첫 글" }]),
    });
    const one = createDocument(database, workspace.id, actor, {
      title: "01",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "둘째 글" }]),
    });
    const two = createDocument(database, workspace.id, actor, {
      title: "02",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "셋째 글" }]),
    });
    const revisionCountBefore = database.prepare(
      "SELECT COUNT(*) AS count FROM document_revisions WHERE document_id = ?",
    ).get(two.document.id);
    const cursorBefore = getChanges(database, workspace.id, 0, 100).headCursor;

    const result = reorderDocumentTree(database, workspace.id, actor, two.document.id, {
      targetDocumentId: zero.document.id,
      position: "before",
    });

    expect(result).toMatchObject({
      documentId: two.document.id,
      parentDocumentId: parent.document.id,
      targetDocumentId: zero.document.id,
      treeOrder: 100,
      unchanged: false,
    });
    expect(result.orderedDocumentIds).toEqual([
      two.document.id,
      zero.document.id,
      one.document.id,
    ]);
    expect(listDocuments(database, workspace.id)
      .filter((document) => document.parentDocumentId === parent.document.id)
      .map((document) => [document.title, document.treeOrder]))
      .toEqual([["02", 100], ["00", 200], ["01", 300]]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_revisions WHERE document_id = ?",
    ).get(two.document.id)).toEqual(revisionCountBefore);
    expect(getDocument(database, workspace.id, two.document.id)).toMatchObject({
      revisionId: two.document.revisionId,
      revisionNumber: 1,
    });
    expect(getChanges(database, workspace.id, cursorBefore, 10).events).toMatchObject([{
      documentId: two.document.id,
      revisionId: two.document.revisionId,
      eventType: "updated",
    }]);

    expect(() => reorderDocumentTree(database, workspace.id, actor, two.document.id, {
      targetDocumentId: parent.document.id,
      position: "after",
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("appends an existing child when it is dropped inside its parent", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const parent = createDocument(database, workspace.id, actor, {
      title: "07. NyxDoc 문서 운영",
      content: textContent([{ text: "상위 문서" }]),
    });
    const first = createDocument(database, workspace.id, actor, {
      title: "07-1",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "첫째" }]),
    });
    const second = createDocument(database, workspace.id, actor, {
      title: "07-2",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "둘째" }]),
    });
    const revisionCountBefore = database.prepare(
      "SELECT COUNT(*) AS count FROM document_revisions WHERE document_id = ?",
    ).get(first.document.id);

    const result = reorderDocumentTree(database, workspace.id, actor, first.document.id, {
      targetDocumentId: parent.document.id,
      position: "inside",
    });

    expect(result).toMatchObject({
      parentDocumentId: parent.document.id,
      position: "inside",
      treeOrder: 200,
      unchanged: false,
    });
    expect(result.orderedDocumentIds).toEqual([second.document.id, first.document.id]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_revisions WHERE document_id = ?",
    ).get(first.document.id)).toEqual(revisionCountBefore);
  });

  it("clamps future change cursors to the workspace head without losing later events", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const clamped = getChanges(database, workspace.id, 999_999_999, 20);
    expect(clamped).toMatchObject({
      nextCursor: clamped.headCursor,
      cursorClamped: true,
      events: [],
    });

    const created = createDocument(database, workspace.id, actor, {
      title: "커서 이후 변경",
      content: textContent([{ text: "놓치면 안 되는 변경" }]),
    });
    expect(getChanges(database, workspace.id, clamped.nextCursor, 20).events).toMatchObject([
      { documentId: created.document.id },
    ]);
  });

  it("creates agent and human revisions with one ordered event each", () => {
    const { database, user, workspace } = fixture();
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Codex",
    });
    const created = createDocument(
      database,
      workspace.id,
      {
        type: "agent",
        userId: user.id,
        tokenId: token.summary.id,
        principalId: "agent-for-test",
        avatarMediaId: "avatar-for-test",
        label: "Codex",
        source: "mcp",
      },
      {
        title: "출시 준비",
        summary: "Codex가 출시 준비 문서를 작성했습니다.",
        content: textContent([
          { type: "h1", text: "출시 준비" },
          { text: "이번 주에 범위를 정합니다." },
        ]),
      },
    );
    expect(created.document.revisionNumber).toBe(1);
    expect(created.eventCursor).toBeGreaterThan(0);

    const firstBlock = created.document.content.blocks[0];
    const updated = updateDocument(
      database,
      workspace.id,
      { type: "human", userId: user.id, label: user.name, source: "web" },
      created.document.id,
      {
        baseRevision: 1,
        summary: "사람이 출시 일정을 구체화했습니다.",
        content: textContent([
          { id: firstBlock.id, type: "h1", text: "출시 준비" },
          { type: "callout", text: "금요일까지 초안을 확인합니다." },
        ]),
      },
    );

    expect(updated.document.revisionNumber).toBe(2);
    expect(updated.document.content.blocks).toHaveLength(2);
    expect(updated.document.content.blocks[0]).toMatchObject({ id: firstBlock.id, type: "h1" });
    expect(updated.document.content.blocks[1]).toMatchObject({ type: "callout" });

    const events = getChanges(database, workspace.id, created.eventCursor!, 20);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      documentId: created.document.id,
      revisionNumber: 2,
      actorType: "human",
      actorLabel: user.name,
      source: "web",
    });
    expect(
      database
        .prepare(
          `SELECT actor_token_id, actor_principal_id, actor_avatar_media_id, actor_label, source
           FROM document_revisions WHERE id = ?`,
        )
        .get(created.document.revisionId),
    ).toEqual({
      actor_token_id: token.summary.id,
      actor_principal_id: "agent-for-test",
      actor_avatar_media_id: "avatar-for-test",
      actor_label: "Codex",
      source: "mcp",
    });
  });

  it("rejects stale updates and leaves the accepted revision untouched", () => {
    const { database, user, workspace } = fixture();
    const documentId = (
      database
        .prepare("SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at LIMIT 1")
        .get(workspace.id) as { id: string }
    ).id;
    const current = getDocument(database, workspace.id, documentId);
    updateDocument(
      database,
      workspace.id,
      { type: "human", userId: user.id, label: user.name, source: "web" },
      documentId,
      { baseRevision: current.revisionNumber, title: "먼저 저장된 제목", summary: "첫 저장" },
    );

    expect(() =>
      updateDocument(
        database,
        workspace.id,
        { type: "agent", userId: user.id, label: "Codex", source: "mcp" },
        documentId,
        { baseRevision: current.revisionNumber, title: "오래된 에이전트 제목", summary: "늦은 저장" },
      ),
    ).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    expect(getDocument(database, workspace.id, documentId).title).toBe("먼저 저장된 제목");
    expect(
      (database
        .prepare("SELECT COUNT(*) AS count FROM document_revisions WHERE document_id = ?")
        .get(documentId) as { count: number }).count,
    ).toBe(2);
  });

  it("persists nested lists, todos, dividers, and structured tables in revisions", () => {
    const { database, user, workspace } = fixture();
    const created = createDocument(
      database,
      workspace.id,
      { type: "human", userId: user.id, label: user.name, source: "web" },
      {
        title: "풍부한 블록",
        content: parseNyxdocDocumentV2({
          schemaVersion: 2,
          blocks: [
            { id: "rich-heading", type: "h2", children: [{ text: "준비 항목" }] },
            { id: "rich-list-1", type: "p", indent: 1, listStyleType: "disc", children: [{ text: "출시 범위를 정합니다." }] },
            { id: "rich-list-2", type: "p", indent: 2, listStyleType: "disc", children: [{ text: "고객 공지를 준비합니다." }] },
            { id: "rich-todo", type: "p", indent: 2, listStyleType: "todo", checked: true, children: [{ text: "담당자 확인" }] },
            { id: "rich-divider", type: "hr", children: [{ text: "" }] },
            {
              id: "rich-table",
              type: "table",
              children: [
                {
                  id: "rich-row-1",
                  type: "tr",
                  children: [
                    { id: "rich-head-1", type: "th", children: [{ id: "rich-head-p-1", type: "p", children: [{ text: "항목" }] }] },
                    { id: "rich-head-2", type: "th", children: [{ id: "rich-head-p-2", type: "p", children: [{ text: "담당" }] }] },
                  ],
                },
                {
                  id: "rich-row-2",
                  type: "tr",
                  children: [
                    { id: "rich-cell-1", type: "td", children: [{ id: "rich-cell-p-1", type: "p", children: [{ text: "공지" }] }] },
                    { id: "rich-cell-2", type: "td", children: [{ id: "rich-cell-p-2", type: "p", children: [{ text: "민지" }] }] },
                  ],
                },
              ],
            },
          ],
        }),
      },
    );

    expect(created.document.content.blocks[2]).toMatchObject({ type: "p", indent: 2, listStyleType: "disc" });
    expect(created.document.content.blocks[3]).toMatchObject({ type: "p", indent: 2, listStyleType: "todo", checked: true });
    expect(created.document.content.blocks[4]).toMatchObject({ type: "hr" });
    expect(created.document.content.blocks[5]).toMatchObject({ type: "table" });

    const snapshot = JSON.parse(
      (database
        .prepare("SELECT snapshot_json FROM document_revisions WHERE id = ?")
        .get(created.document.revisionId) as { snapshot_json: string }).snapshot_json,
    ) as { schemaVersion: number; blocks: Array<Record<string, unknown>> };
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.blocks[2]).toMatchObject({ type: "p", indent: 2, listStyleType: "disc" });
    expect(snapshot.blocks[5]).toMatchObject({ type: "table" });
  });

  it("persists canonical AST v2 without losing rich text or a trailing paragraph", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const created = createDocument(database, workspace.id, actor, {
      title: "AST v2 저장",
      content: textContent([{ id: "initial-v2", text: "기존 본문" }]),
    });
    const firstId = created.document.content.blocks[0].id;
    const content = {
      schemaVersion: 2 as const,
      blocks: [
        {
          id: firstId,
          type: "p" as const,
          align: "center" as const,
          children: [{ text: "서식이 " }, { text: "보존됩니다.", bold: true, fontSize: "24px" as const }],
        },
        {
          id: "table-v2",
          type: "table" as const,
          colSizes: [180, 220],
          children: [{
            id: "row-v2",
            type: "tr" as const,
            children: [
              { id: "cell-v2-1", type: "th" as const, children: [{ id: "cell-v2-p-1", type: "p" as const, children: [{ text: "항목" }] }] },
              { id: "cell-v2-2", type: "th" as const, children: [{ id: "cell-v2-p-2", type: "p" as const, children: [{ text: "결과" }] }] },
            ],
          }],
        },
        { id: "trailing-v2", type: "p" as const, children: [{ text: "" }] },
      ],
    };

    const updated = updateDocument(database, workspace.id, actor, created.document.id, {
      baseRevision: 1,
      content,
      summary: "새 편집기로 저장",
    });

    expect(updated.document.content).toEqual(content);
    expect(updated.document.content.blocks.at(-1)).toMatchObject({ id: "trailing-v2", type: "p" });
    expect(
      (database.prepare(
        "SELECT COUNT(*) AS count FROM document_blocks WHERE document_id = ? AND deleted_at IS NULL AND content_json IS NOT NULL",
      ).get(created.document.id) as { count: number }).count,
    ).toBe(3);
    expect(JSON.parse(
      (database.prepare("SELECT snapshot_json FROM document_revisions WHERE id = ?")
        .get(updated.document.revisionId) as { snapshot_json: string }).snapshot_json,
    )).toEqual(content);

  });

  it("reads an old snapshot without changing the current revision or event stream", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const created = createDocument(database, workspace.id, actor, {
      title: "조회 테스트",
      content: textContent([{ id: "read-revision", text: "처음 본문" }]),
    });
    const updated = updateDocument(database, workspace.id, actor, created.document.id, {
      baseRevision: 1,
      content: textContent([{ id: created.document.content.blocks[0].id, text: "수정된 본문" }]),
      summary: "본문 수정",
    });

    const snapshot = getDocumentRevisionSnapshot(
      database,
      workspace.id,
      created.document.id,
      created.document.revisionId!,
    );

    expect(snapshot).toMatchObject({
      id: created.document.revisionId,
      number: 1,
      content: { schemaVersion: 2, blocks: [{ children: [{ text: "처음 본문" }] }] },
    });
    expect(getDocument(database, workspace.id, created.document.id)).toMatchObject({
      revisionId: updated.document.revisionId,
      revisionNumber: 2,
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM document_revisions WHERE document_id = ?")
        .get(created.document.id),
    ).toEqual({ count: 2 });
    expect(
      getChanges(database, workspace.id, 0, 20).events
        .filter((event) => event.documentId === created.document.id),
    ).toHaveLength(2);
  });

  it("restores an old snapshot as a new rollback revision and event", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const created = createDocument(database, workspace.id, actor, {
      title: "복원 테스트",
      content: textContent([{ id: "restore-revision", text: "처음 본문" }]),
    });
    const updated = updateDocument(database, workspace.id, actor, created.document.id, {
      baseRevision: 1,
      content: textContent([{ id: created.document.content.blocks[0].id, text: "수정된 본문" }]),
      summary: "본문 수정",
    });

    const restored = restoreDocumentRevision(
      database,
      workspace.id,
      actor,
      created.document.id,
      created.document.revisionId!,
      updated.document.revisionNumber,
    );

    expect(restored.document).toMatchObject({ revisionNumber: 3 });
    expect(restored.document.content.blocks.map(nyxdocBlockText)).toEqual(["처음 본문"]);
    expect(
      database
        .prepare("SELECT origin, source FROM document_revisions WHERE id = ?")
        .get(restored.document.revisionId),
    ).toEqual({ origin: "rollback", source: "rollback" });
    expect(getChanges(database, workspace.id, updated.eventCursor!, 10).events).toMatchObject([
      { eventType: "restored", revisionNumber: 3, source: "rollback" },
    ]);
  });

  it("versions document metadata and restores it together with title and content", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const created = createDocument(database, workspace.id, actor, {
      title: "초기 기획",
      documentType: "plan",
      workflowStatus: "draft",
      tags: ["agent", "mvp"],
      content: textContent([{ text: "초기 본문" }]),
    });
    const updated = updateDocument(database, workspace.id, actor, created.document.id, {
      baseRevision: 1,
      title: "검토 기획",
      workflowStatus: "review",
      tags: ["agent", "review"],
      summary: "기획을 검토 상태로 전환했습니다.",
    });

    expect(queryDocuments(database, workspace.id, {
      documentType: "plan",
      workflowStatus: "review",
      tag: "review",
    }).documents).toMatchObject([{ id: created.document.id }]);
    const first = getDocumentRevisionSnapshotByNumber(database, workspace.id, created.document.id, 1);
    expect(first).toMatchObject({
      title: "초기 기획",
      metadata: { documentType: "plan", workflowStatus: "draft", tags: ["agent", "mvp"] },
    });
    expect(diffDocumentRevisions(database, workspace.id, created.document.id, 1, 2)).toMatchObject({
      document: { titleChanged: true, parentChanged: false, metadataChanged: true },
    });

    const restored = restoreDocumentRevision(
      database,
      workspace.id,
      actor,
      created.document.id,
      first.id,
      updated.document.revisionNumber,
    );
    expect(restored.document).toMatchObject({
      title: "초기 기획",
      revisionNumber: 3,
      documentType: "plan",
      workflowStatus: "draft",
      tags: ["agent", "mvp"],
    });
  });

  it("creates child documents, moves whole branches, and rejects hierarchy cycles", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const parent = createDocument(database, workspace.id, actor, {
      title: "프로젝트",
      content: textContent([{ text: "계층 테스트" }]),
    });
    const child = createDocument(database, workspace.id, actor, {
      title: "기획",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "계층 테스트" }]),
    });
    const grandchild = createDocument(database, workspace.id, actor, {
      title: "요구사항",
      parentDocumentId: child.document.id,
      content: textContent([{ text: "계층 테스트" }]),
    });

    expect(child.document.parentDocumentId).toBe(parent.document.id);
    expect(grandchild.document.parentDocumentId).toBe(child.document.id);
    expect(listDocuments(database, workspace.id).find((document) => document.id === child.document.id))
      .toMatchObject({ parentDocumentId: parent.document.id, treeOrder: 100 });

    expect(() =>
      updateDocument(database, workspace.id, actor, parent.document.id, {
        baseRevision: 1,
        parentDocumentId: grandchild.document.id,
        summary: "순환 이동 시도",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(getDocument(database, workspace.id, parent.document.id)).toMatchObject({
      parentDocumentId: null,
      revisionNumber: 1,
    });

    const moved = updateDocument(database, workspace.id, actor, child.document.id, {
      baseRevision: 1,
      parentDocumentId: null,
      summary: "기획 문서 묶음을 최상위로 옮겼습니다.",
    });
    expect(moved.document).toMatchObject({ parentDocumentId: null, revisionNumber: 2 });
    expect(getDocument(database, workspace.id, grandchild.document.id).parentDocumentId).toBe(child.document.id);
  });

  it("archives a document branch while preserving blocks, revisions, and ordered events", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const parent = createDocument(database, workspace.id, actor, {
      title: "삭제할 프로젝트",
      content: textContent([{ text: "삭제 전에도 기록은 남아야 합니다." }]),
    });
    const child = createDocument(database, workspace.id, actor, {
      title: "함께 삭제할 기획",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "하위 문서 본문" }]),
    });

    const archived = archiveDocument(database, workspace.id, actor, parent.document.id, {
      baseRevision: parent.document.revisionNumber,
    });

    expect(archived.archivedDocumentIds).toEqual([parent.document.id, child.document.id]);
    expect(archived.archivedCount).toBe(2);
    expect(archived.nextDocumentId).toBeTruthy();
    expect(listDocuments(database, workspace.id).map((document) => document.id)).not.toContain(parent.document.id);
    expect(() => getDocument(database, workspace.id, parent.document.id)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(
      database
        .prepare("SELECT status, lifecycle_state FROM documents WHERE id IN (?, ?) ORDER BY id")
        .all(parent.document.id, child.document.id),
    ).toEqual([
      { status: "archived", lifecycle_state: "trashed" },
      { status: "archived", lifecycle_state: "trashed" },
    ]);
    expect(
      (database
        .prepare("SELECT COUNT(*) AS count FROM document_blocks WHERE document_id IN (?, ?)")
        .get(parent.document.id, child.document.id) as { count: number }).count,
    ).toBe(2);
    expect(
      (database
        .prepare("SELECT COUNT(*) AS count FROM document_revisions WHERE document_id IN (?, ?)")
        .get(parent.document.id, child.document.id) as { count: number }).count,
    ).toBe(2);
    expect(
      database
        .prepare(
          `SELECT document_id, revision_id, event_type
           FROM document_events
           WHERE cursor > ?
           ORDER BY cursor ASC`,
        )
        .all(child.eventCursor),
    ).toEqual([
      { document_id: parent.document.id, revision_id: parent.document.revisionId, event_type: "archived" },
      { document_id: child.document.id, revision_id: child.document.revisionId, event_type: "archived" },
    ]);
  });

  it("lets an agent trash only document trees whose first revisions it created", () => {
    const { database, user, workspace } = fixture();
    const agentId = randomUUID();
    const agent = {
      type: "agent" as const,
      userId: user.id,
      principalId: agentId,
      label: "Document agent",
      source: "mcp" as const,
    };
    const ownParent = createDocument(database, workspace.id, agent, {
      title: "에이전트가 만든 묶음",
      content: textContent([{ text: "부모 문서" }]),
    });
    const ownChild = createDocument(database, workspace.id, agent, {
      title: "에이전트가 만든 하위 문서",
      parentDocumentId: ownParent.document.id,
      content: textContent([{ text: "하위 문서" }]),
    });

    expect(archiveDocument(database, workspace.id, agent, ownParent.document.id, {
      baseRevision: ownParent.document.revisionNumber,
      createdByAgentId: agentId,
    })).toMatchObject({
      archivedDocumentIds: [ownParent.document.id, ownChild.document.id],
      archivedCount: 2,
    });

    const mixedParent = createDocument(database, workspace.id, agent, {
      title: "공동 문서 묶음",
      content: textContent([{ text: "에이전트가 만든 부모" }]),
    });
    const human = {
      type: "human" as const,
      userId: user.id,
      principalId: user.id,
      label: user.name,
      source: "web" as const,
    };
    createDocument(database, workspace.id, human, {
      title: "사람이 만든 하위 문서",
      parentDocumentId: mixedParent.document.id,
      content: textContent([{ text: "사람이 만든 문서는 보호합니다." }]),
    });

    expect(() => archiveDocument(database, workspace.id, agent, mixedParent.document.id, {
      baseRevision: mixedParent.document.revisionNumber,
      createdByAgentId: agentId,
    })).toThrowError(expect.objectContaining({
      code: "FORBIDDEN",
      details: {
        documentCount: 2,
        otherCreatorCount: 1,
      },
    }));
    expect(getDocument(database, workspace.id, mixedParent.document.id).status).toBe("active");
  });

  it("restores and purges a trashed document tree as one batch", () => {
    const { database, user, workspace } = fixture();
    const actor = {
      type: "human" as const,
      userId: user.id,
      principalId: user.id,
      label: user.name,
      source: "web" as const,
    };
    const parent = createDocument(database, workspace.id, actor, {
      title: "복구할 프로젝트",
      content: textContent([{ text: "부모" }]),
    });
    const child = createDocument(database, workspace.id, actor, {
      title: "복구할 하위 문서",
      parentDocumentId: parent.document.id,
      content: textContent([{ text: "자식" }]),
    });
    const parentDraft = ensureCollaborationState(database, workspace.id, parent.document.id);
    const childDraft = ensureCollaborationState(database, workspace.id, child.document.id);

    archiveDocument(database, workspace.id, actor, parent.document.id, { baseRevision: 1 });
    expect(database.prepare(
      `SELECT document_id, generation
       FROM document_collaboration_states
       WHERE document_id IN (?, ?)
       ORDER BY document_id`,
    ).all(parent.document.id, child.document.id)).toEqual([
      { document_id: child.document.id, generation: childDraft.generation + 1 },
      { document_id: parent.document.id, generation: parentDraft.generation + 1 },
    ].sort((left, right) => left.document_id.localeCompare(right.document_id)));
    expect(listTrashBatches(database, workspace.id)).toMatchObject([{
      rootDocumentId: parent.document.id,
      documentCount: 2,
      actorLabel: user.name,
    }]);

    const restored = restoreTrashedDocument(database, workspace.id, actor, parent.document.id);
    expect(restored.documentIds).toEqual([parent.document.id, child.document.id]);
    expect(getDocument(database, workspace.id, parent.document.id).revisionNumber).toBe(1);
    expect(getDocument(database, workspace.id, child.document.id).parentDocumentId).toBe(parent.document.id);
    expect(listTrashBatches(database, workspace.id)).toEqual([]);
    expect(ensureCollaborationState(database, workspace.id, parent.document.id).generation)
      .toBe(parentDraft.generation + 2);
    expect(ensureCollaborationState(database, workspace.id, child.document.id).generation)
      .toBe(childDraft.generation + 2);

    archiveDocument(database, workspace.id, actor, parent.document.id, { baseRevision: 1 });
    const purged = purgeTrashedDocument(database, workspace.id, actor, parent.document.id);
    expect(purged.documentCount).toBe(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE id IN (?, ?)",
    ).get(parent.document.id, child.document.id)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_purge_tombstones WHERE document_id IN (?, ?)",
    ).get(parent.document.id, child.document.id)).toEqual({ count: 2 });
  });

  it("does not allow a workspace to read another workspace's document", () => {
    const { database, workspace } = fixture();
    const other = createTestUser(database, { name: "Other" });
    const otherDocument = database
      .prepare("SELECT id FROM documents WHERE workspace_id = ? LIMIT 1")
      .get(other.workspace.id) as { id: string };
    expect(() => getDocument(database, workspace.id, otherDocument.id)).toThrowError(
      DocumentServiceError,
    );
    expect(() =>
      createDocument(
        database,
        workspace.id,
        { type: "human", userId: other.user.id, label: other.user.name, source: "web" },
        {
          title: "잘못된 하위 문서",
          parentDocumentId: otherDocument.id,
          content: textContent([{ text: "다른 워크스페이스 아래에는 만들 수 없습니다." }]),
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("indexes internal document references and returns backlinks with source blocks", () => {
    const { database, user, workspace } = fixture();
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const target = createDocument(database, workspace.id, actor, {
      title: "대상 문서",
      content: textContent([{ text: "참조 대상" }]),
    });
    const source = createDocument(database, workspace.id, actor, {
      title: "출처 문서",
      content: {
        schemaVersion: 2,
        blocks: [{
          id: "source-paragraph",
          type: "p",
          children: [
            { text: "자세한 내용은 " },
            {
              id: "reference-inline",
              type: "doc_ref",
              documentId: target.document.id,
              children: [{ text: "대상 문서" }],
            },
            { text: "를 참고하세요." },
          ],
        }],
      },
    });

    expect(getDocumentBacklinks(database, workspace.id, target.document.id)).toEqual([{
      document: expect.objectContaining({
        id: source.document.id,
        path: [{ id: source.document.id, title: "출처 문서" }],
      }),
      blockIds: ["source-paragraph"],
    }]);

    updateDocument(database, workspace.id, actor, source.document.id, {
      baseRevision: source.document.revisionNumber,
      content: {
        schemaVersion: 2,
        blocks: [{ id: "source-paragraph", type: "p", children: [{ text: "참조를 제거했습니다." }] }],
      },
      summary: "내부 문서 참조를 제거했습니다.",
    });
    expect(getDocumentBacklinks(database, workspace.id, target.document.id)).toEqual([]);
  });

  it("enforces a scoped agent connection inside the document service", () => {
    const { database, user, workspace } = fixture();
    const human = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const root = createDocument(database, workspace.id, human, {
      title: "허용 루트",
      content: textContent([{ text: "허용 범위" }]),
    });
    const outside = createDocument(database, workspace.id, human, {
      title: "범위 밖",
      content: textContent([{ text: "비공개 범위" }]),
    });
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Scoped OpenClaw",
      rootDocumentId: root.document.id,
    });
    const agent = {
      type: "agent" as const,
      userId: user.id,
      tokenId: token.summary.id,
      label: "Scoped OpenClaw",
      source: "mcp" as const,
    };

    const child = createDocument(database, workspace.id, agent, {
      requestId: "scoped-create-001",
      title: "범위 안 새 문서",
      parentDocumentId: null,
      content: textContent([{ text: "루트 아래에 자동 생성" }]),
    });
    expect(child.document.parentDocumentId).toBe(root.document.id);

    expect(() => updateDocument(database, workspace.id, agent, child.document.id, {
      baseRevision: child.document.revisionNumber,
      parentDocumentId: outside.document.id,
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => updateDocument(database, workspace.id, agent, outside.document.id, {
      baseRevision: outside.document.revisionNumber,
      title: "접근 시도",
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => updateDocument(database, workspace.id, agent, child.document.id, {
      baseRevision: child.document.revisionNumber,
      content: {
        schemaVersion: 2,
        blocks: [{
          id: "scoped-reference",
          type: "p",
          children: [{
            type: "doc_ref",
            documentId: outside.document.id,
            children: [{ text: "범위 밖 링크" }],
          }],
        }],
      },
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});
