import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSession: vi.fn(),
  requireHumanWorkspacePermission: vi.fn(),
  humanDocumentActor: vi.fn(),
  reorderSiblingDocument: vi.fn(),
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
vi.mock("@/lib/documents/service", () => ({
  reorderSiblingDocument: mocks.reorderSiblingDocument,
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
    mocks.reorderSiblingDocument.mockReturnValue({
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
    expect(mocks.reorderSiblingDocument).toHaveBeenCalledWith(
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
});
