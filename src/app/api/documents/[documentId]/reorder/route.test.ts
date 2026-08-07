import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSession: vi.fn(),
  requireHumanWorkspacePermission: vi.fn(),
  readWorkingDocument: vi.fn(),
  replaceAndCommitWorkingDocumentThroughGateway: vi.fn(),
  humanDocumentActor: vi.fn(),
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
vi.mock("@/lib/collaboration/gateway", () => ({
  readWorkingDocument: mocks.readWorkingDocument,
  replaceAndCommitWorkingDocumentThroughGateway: mocks.replaceAndCommitWorkingDocumentThroughGateway,
}));
vi.mock("@/lib/db/client", () => ({ sqlite: {} }));
vi.mock("@/lib/documents/actors", () => ({
  humanDocumentActor: mocks.humanDocumentActor,
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
    mocks.getDocument.mockImplementation((_database: unknown, _workspaceId: string, id: string) => ({
      id,
      title: id === documentId ? "07-1" : "07. NyxDoc 문서 운영",
      parentDocumentId: null,
    }));
    mocks.readWorkingDocument.mockResolvedValue({
      workingDocument: {
        roomName: "nyxdoc:workspace-1:document-1:g1",
        draftVersion: 4,
        hasUncommittedChanges: false,
      },
    });
    mocks.replaceAndCommitWorkingDocumentThroughGateway.mockResolvedValue({});
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
      body: JSON.stringify({ targetDocumentId, position: "before" }),
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
      { targetDocumentId, position: "before" },
    );
    await expect(response.json()).resolves.toMatchObject({
      documentId,
      documents: [{ id: documentId, treeOrder: 100 }],
    });
  });

  it("commits a clean structural revision before moving a document inside another document", async () => {
    mocks.reorderDocumentTree.mockReturnValue({
      documentId,
      parentDocumentId: targetDocumentId,
      targetDocumentId,
      position: "inside",
      treeOrder: 200,
      orderedDocumentIds: ["existing-child", documentId],
      eventCursor: null,
      unchanged: true,
    });

    const response = await POST(new Request(`http://localhost/api/documents/${documentId}/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDocumentId, position: "inside" }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(200);
    expect(mocks.requireHumanWorkspacePermission).toHaveBeenCalledWith(
      {},
      "workspace-1",
      "user-1",
      "documents.commit",
    );
    expect(mocks.replaceAndCommitWorkingDocumentThroughGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ source: "web", userId: "user-1" }),
        expectedDraftVersion: 4,
        replacement: { parentDocumentId: targetDocumentId },
      }),
    );
    expect(mocks.reorderDocumentTree).toHaveBeenCalledWith(
      {},
      "workspace-1",
      expect.objectContaining({ source: "web", userId: "user-1" }),
      documentId,
      { targetDocumentId, position: "inside" },
    );
  });

  it("refuses a cross-parent move while the shared draft has uncommitted changes", async () => {
    mocks.readWorkingDocument.mockResolvedValue({
      workingDocument: {
        roomName: "nyxdoc:workspace-1:document-1:g1",
        draftVersion: 5,
        hasUncommittedChanges: true,
      },
    });

    const response = await POST(new Request(`http://localhost/api/documents/${documentId}/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDocumentId, position: "inside" }),
    }), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("저장하지 않은 초안"),
    });
    expect(mocks.replaceAndCommitWorkingDocumentThroughGateway).not.toHaveBeenCalled();
    expect(mocks.reorderDocumentTree).not.toHaveBeenCalled();
  });
});
