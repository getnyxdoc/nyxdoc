import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSession: vi.fn(),
  requireHumanDocumentPermission: vi.fn(),
  ensureCollaborationState: vi.fn(),
  replaceAndCommitWorkingDocumentThroughGateway: vi.fn(),
  humanDocumentActor: vi.fn(),
  getDocument: vi.fn(),
  assertSameOrigin: vi.fn(),
}));

vi.mock("@/data/workspace-context", () => ({
  requireWorkspaceSession: mocks.requireWorkspaceSession,
}));
vi.mock("@/lib/authz/permissions", () => ({
  requireHumanDocumentPermission: mocks.requireHumanDocumentPermission,
  requireHumanWorkspacePermission: vi.fn(),
}));
vi.mock("@/lib/collaboration/drafts", () => ({
  ensureCollaborationState: mocks.ensureCollaborationState,
}));
vi.mock("@/lib/collaboration/gateway", () => ({
  archiveWorkingTree: vi.fn(),
  replaceAndCommitWorkingDocumentThroughGateway:
    mocks.replaceAndCommitWorkingDocumentThroughGateway,
}));
vi.mock("@/lib/db/client", () => ({ sqlite: {} }));
vi.mock("@/lib/documents/actors", () => ({
  humanDocumentActor: mocks.humanDocumentActor,
}));
vi.mock("@/lib/documents/service", () => ({
  getDocument: mocks.getDocument,
}));
vi.mock("@/lib/http/origin", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
}));
vi.mock("@/lib/http/errors", () => ({
  apiErrorResponse(error: unknown) {
    const serviceError = error as {
      code?: string;
      details?: Record<string, unknown>;
    };
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
      ...(serviceError.code ? { code: serviceError.code } : {}),
      ...(serviceError.details ? { details: serviceError.details } : {}),
    }, {
      status: serviceError.code === "DRAFT_CONFLICT" ? 409 : 500,
    });
  },
}));

import { GET, PUT } from "@/app/api/documents/[documentId]/route";

const documentId = "5a2aa380-93d9-41a2-b150-55907652581c";

type SimulatedDraft = {
  content: unknown;
  hasUncommittedChanges: boolean;
};

function simulateGatewayDraftCas(currentDraftVersion: number, draft: SimulatedDraft) {
  mocks.replaceAndCommitWorkingDocumentThroughGateway.mockImplementationOnce(async (input: {
    expectedDraftVersion?: number;
    replacement: { content?: unknown };
  }) => {
    if (input.expectedDraftVersion !== currentDraftVersion) {
      throw Object.assign(
        new Error("공유 초안이 이미 변경되었습니다."),
        {
          code: "DRAFT_CONFLICT",
          details: {
            expectedDraftVersion: input.expectedDraftVersion,
            currentDraftVersion,
          },
        },
      );
    }
    if (input.replacement.content !== undefined) {
      draft.content = input.replacement.content;
    }
    draft.hasUncommittedChanges = false;
    return {
      document: { id: documentId, revisionNumber: 5 },
      workingDocument: {
        draftVersion: currentDraftVersion + 1,
        hasUncommittedChanges: false,
      },
      eventCursor: 12,
      unchanged: false,
    };
  });
}

describe("human document PUT route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceSession.mockResolvedValue({
      session: { user: { id: "user-1", name: "Writer" } },
      workspace: { id: "workspace-1" },
    });
    mocks.requireHumanDocumentPermission.mockReturnValue({ source: "workspace" });
    mocks.getDocument.mockReturnValue({ revisionNumber: 4 });
    mocks.ensureCollaborationState.mockReturnValue({
      roomName: "nyxdoc:workspace-1:document-1:g2",
      generation: 2,
      draftVersion: 8,
      committedDraftVersion: 8,
      hasUncommittedChanges: false,
    });
    mocks.humanDocumentActor.mockReturnValue({
      type: "human",
      userId: "user-1",
      principalId: "user-1",
      label: "Writer",
      source: "web",
    });
    mocks.replaceAndCommitWorkingDocumentThroughGateway.mockResolvedValue({
      document: { id: documentId, revisionNumber: 5 },
      workingDocument: { draftVersion: 9, hasUncommittedChanges: false },
      eventCursor: 12,
      unchanged: false,
    });
  });

  it("returns the current draft CAS for a browser metadata mutation", async () => {
    mocks.getDocument.mockReturnValue({ id: documentId, revisionNumber: 4, title: "문서" });

    const response = await GET(
      new Request(`http://localhost/api/documents/${documentId}`),
      { params: Promise.resolve({ documentId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.requireHumanDocumentPermission).toHaveBeenCalledWith(
      {},
      "workspace-1",
      documentId,
      "user-1",
      "documents.read",
    );
    await expect(response.json()).resolves.toMatchObject({
      document: { id: documentId, revisionNumber: 4 },
      workingDocument: {
        generation: 2,
        draftVersion: 8,
        committedDraftVersion: 8,
        hasUncommittedChanges: false,
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("sends replace and commit through the single combined command", async () => {
    const content = {
      schemaVersion: 2,
      blocks: [{ id: "body", type: "p", children: [{ text: "원자적 본문" }] }],
    };
    const response = await PUT(new Request(`http://localhost/api/documents/${documentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "human-put-atomic-001",
        baseRevision: 4,
        expectedDraftVersion: 8,
        title: "원자적 제목",
        content,
        summary: "한 번에 저장",
      }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(200);
    expect(mocks.replaceAndCommitWorkingDocumentThroughGateway).toHaveBeenCalledTimes(1);
    expect(mocks.replaceAndCommitWorkingDocumentThroughGateway).toHaveBeenCalledWith({
      roomName: "nyxdoc:workspace-1:document-1:g2",
      actor: expect.objectContaining({ source: "api", userId: "user-1" }),
      requestId: "human-put-atomic-001",
      expectedDraftVersion: 8,
      replacement: {
        title: "원자적 제목",
        content,
      },
      summary: "한 번에 저장",
    });
    await expect(response.json()).resolves.toMatchObject({
      document: { id: documentId, revisionNumber: 5 },
      workingDocument: { hasUncommittedChanges: false },
    });
  });

  it("does not silently commit a dirty body from a stale title-only PUT", async () => {
    const dirtyContent = {
      schemaVersion: 2,
      blocks: [{ id: "other-writer", type: "p", children: [{ text: "다른 작성자의 미저장 본문" }] }],
    };
    mocks.ensureCollaborationState.mockReturnValue({
      roomName: "nyxdoc:workspace-1:document-1:g2",
      draftVersion: 9,
      committedDraftVersion: 8,
      hasUncommittedChanges: true,
    });

    const response = await PUT(new Request(`http://localhost/api/documents/${documentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 4,
        expectedDraftVersion: 8,
        title: "정본 제목만 변경",
      }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "DRAFT_CONFLICT",
      details: { expectedDraftVersion: 8, currentDraftVersion: 9 },
    });
    expect(mocks.replaceAndCommitWorkingDocumentThroughGateway).not.toHaveBeenCalled();
    expect(dirtyContent).toEqual({
      schemaVersion: 2,
      blocks: [{ id: "other-writer", type: "p", children: [{ text: "다른 작성자의 미저장 본문" }] }],
    });
  });

  it("rejects a current title-only PUT while another writer has a dirty body", async () => {
    mocks.ensureCollaborationState.mockReturnValue({
      roomName: "nyxdoc:workspace-1:document-1:g2",
      generation: 2,
      draftVersion: 9,
      committedDraftVersion: 8,
      hasUncommittedChanges: true,
    });

    const response = await PUT(new Request(`http://localhost/api/documents/${documentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "human-rename-current-001",
        baseRevision: 4,
        expectedDraftVersion: 9,
        title: "다른 작성자의 초안을 확정하지 않는 제목",
      }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "DRAFT_CONFLICT",
      details: { expectedDraftVersion: 9, currentDraftVersion: 9 },
    });
    expect(mocks.replaceAndCommitWorkingDocumentThroughGateway).not.toHaveBeenCalled();
  });

  it("conflicts a stale content PUT instead of erasing another writer", async () => {
    const otherWriterContent = {
      schemaVersion: 2,
      blocks: [{ id: "newer", type: "p", children: [{ text: "더 최신인 다른 작성자 본문" }] }],
    };
    const staleContent = {
      schemaVersion: 2,
      blocks: [{ id: "stale", type: "p", children: [{ text: "오래된 클라이언트 본문" }] }],
    };
    const draft = { content: otherWriterContent, hasUncommittedChanges: true };
    mocks.ensureCollaborationState.mockReturnValue({
      roomName: "nyxdoc:workspace-1:document-1:g2",
      draftVersion: 10,
      committedDraftVersion: 8,
      hasUncommittedChanges: true,
    });
    simulateGatewayDraftCas(10, draft);

    const response = await PUT(new Request(`http://localhost/api/documents/${documentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 4,
        expectedDraftVersion: 8,
        content: staleContent,
      }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "DRAFT_CONFLICT",
      details: { expectedDraftVersion: 8, currentDraftVersion: 10 },
    });
    expect(draft).toEqual({
      content: otherWriterContent,
      hasUncommittedChanges: true,
    });
  });

  it("preserves no-op behavior when the observed draft is uncontended", async () => {
    mocks.replaceAndCommitWorkingDocumentThroughGateway.mockResolvedValueOnce({
      document: { id: documentId, revisionNumber: 4 },
      workingDocument: { draftVersion: 8, hasUncommittedChanges: false },
      eventCursor: null,
      unchanged: true,
    });

    const response = await PUT(new Request(`http://localhost/api/documents/${documentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 4,
        expectedDraftVersion: 8,
        title: "이미 같은 제목",
      }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      document: { revisionNumber: 4 },
      workingDocument: { draftVersion: 8, hasUncommittedChanges: false },
      unchanged: true,
    });
    expect(mocks.replaceAndCommitWorkingDocumentThroughGateway).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDraftVersion: 8 }),
    );
  });
});
