import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSession: vi.fn(),
  requireHumanWorkspacePermission: vi.fn(),
  humanDocumentActor: vi.fn(),
  ensureCollaborationState: vi.fn(),
  moveWorkingDocumentTreeThroughGateway: vi.fn(),
  getDocument: vi.fn(),
  reorderDocumentTree: vi.fn(),
  listDocuments: vi.fn(),
  assertSameOrigin: vi.fn(),
}));

vi.mock("@/data/workspace-context", () => ({
  requireWorkspaceSession: mocks.requireWorkspaceSession,
}));
vi.mock("@/lib/authz/permissions", () => ({
  requireHumanWorkspacePermission: mocks.requireHumanWorkspacePermission,
}));
vi.mock("@/lib/db/client", () => ({ sqlite: {} }));
vi.mock("@/lib/documents/actors", () => ({
  humanDocumentActor: mocks.humanDocumentActor,
}));
vi.mock("@/lib/collaboration/drafts", () => ({
  ensureCollaborationState: mocks.ensureCollaborationState,
}));
vi.mock("@/lib/collaboration/gateway", () => ({
  moveWorkingDocumentTreeThroughGateway: mocks.moveWorkingDocumentTreeThroughGateway,
}));
vi.mock("@/lib/documents/service", () => ({
  getDocument: mocks.getDocument,
  reorderDocumentTree: mocks.reorderDocumentTree,
  listDocuments: mocks.listDocuments,
}));
vi.mock("@/lib/http/origin", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
}));
vi.mock("@/lib/http/errors", () => ({
  apiErrorResponse(error: unknown) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  },
}));

import { POST } from "@/app/api/documents/[documentId]/reorder/route";

const documentId = "5a2aa380-93d9-41a2-b150-55907652581c";
const targetDocumentId = "bc3e9a91-fcd0-4c05-87dd-527620fac5f5";

describe("document reorder route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceSession.mockResolvedValue({
      session: { user: { id: "user-1", name: "Writer" } },
      workspace: { id: "workspace-1" },
    });
    mocks.humanDocumentActor.mockReturnValue({
      type: "human",
      userId: "user-1",
      label: "Writer",
      source: "web",
    });
    mocks.getDocument.mockImplementation((_database, _workspaceId, id: string) => ({
      id,
      parentDocumentId: "3ad0a87a-5f5f-47f3-aabe-29087af55fef",
    }));
    mocks.ensureCollaborationState.mockReturnValue({
      roomName: `nyxdoc:workspace-1:${documentId}:g1`,
      generation: 1,
      draftVersion: 4,
      baseRevisionNumber: 2,
    });
    mocks.moveWorkingDocumentTreeThroughGateway.mockResolvedValue({
      document: { id: documentId, parentDocumentId: targetDocumentId, revisionNumber: 3 },
      tree: {
        documentId,
        parentDocumentId: targetDocumentId,
        targetDocumentId,
        position: "inside",
        treeOrder: 200,
        orderedDocumentIds: ["existing-child", documentId],
        eventCursor: 10,
        unchanged: false,
      },
      workingDocument: {
        documentId,
        parentDocumentId: targetDocumentId,
        draftVersion: 5,
        committedDraftVersion: 3,
        hasUncommittedChanges: true,
      },
    });
    mocks.reorderDocumentTree.mockReturnValue({
      documentId,
      targetDocumentId,
      position: "before",
      treeOrder: 100,
      orderedDocumentIds: [documentId, targetDocumentId],
      eventCursor: 9,
      unchanged: false,
    });
    mocks.listDocuments.mockReturnValue([{ id: documentId, treeOrder: 100 }]);
  });

  it("requires structure-update permission and returns the refreshed tree", async () => {
    const response = await POST(new Request(`http://localhost/api/documents/${documentId}/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "tree-reorder-same-parent-001",
        targetDocumentId,
        position: "before",
      }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(200);
    expect(mocks.requireHumanWorkspacePermission).toHaveBeenCalledWith(
      {},
      "workspace-1",
      "user-1",
      "documents.update",
    );
    expect(mocks.reorderDocumentTree).toHaveBeenCalledWith(
      {},
      "workspace-1",
      expect.objectContaining({ source: "web", userId: "user-1" }),
      documentId,
      {
        requestId: "tree-reorder-same-parent-001",
        targetDocumentId,
        position: "before",
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      documentId,
      documents: [{ id: documentId, treeOrder: 100 }],
    });
  });

  it("moves a document across parents through the draft-aware canonical path", async () => {
    mocks.getDocument.mockImplementation((_database, _workspaceId, id: string) => ({
      id,
      parentDocumentId: id === documentId
        ? "3ad0a87a-5f5f-47f3-aabe-29087af55fef"
        : null,
    }));

    const response = await POST(new Request(`http://localhost/api/documents/${documentId}/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "tree-reorder-cross-parent-001",
        targetDocumentId,
        position: "inside",
      }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(200);
    expect(mocks.requireHumanWorkspacePermission).toHaveBeenCalledTimes(1);
    expect(mocks.reorderDocumentTree).not.toHaveBeenCalled();
    expect(mocks.ensureCollaborationState).toHaveBeenCalledWith(
      {},
      "workspace-1",
      documentId,
    );
    expect(mocks.moveWorkingDocumentTreeThroughGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        roomName: `nyxdoc:workspace-1:${documentId}:g1`,
        expectedGeneration: 1,
        expectedDraftVersion: 4,
        expectedBaseRevision: 2,
        targetDocumentId,
        position: "inside",
        actor: expect.objectContaining({ source: "web", userId: "user-1" }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      document: { revisionNumber: 3 },
      workingDocument: { hasUncommittedChanges: true },
    });
  });

  it("uses a client requestId for retry-safe parent moves", async () => {
    const requestId = "2c7bf986-4aa6-4683-90df-ac6e3d43f757";
    mocks.getDocument.mockImplementation((_database, _workspaceId, id: string) => ({
      id,
      parentDocumentId: id === documentId
        ? "3ad0a87a-5f5f-47f3-aabe-29087af55fef"
        : null,
    }));
    const response = await POST(new Request(`http://localhost/api/documents/${documentId}/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDocumentId, position: "inside", requestId }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      documentId,
      targetDocumentId,
    });
    expect(mocks.moveWorkingDocumentTreeThroughGateway).toHaveBeenCalledWith(
      expect.objectContaining({ requestId }),
    );
  });
});
