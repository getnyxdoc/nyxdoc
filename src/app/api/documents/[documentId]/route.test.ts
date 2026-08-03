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
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  },
}));

import { PUT } from "@/app/api/documents/[documentId]/route";

const documentId = "5a2aa380-93d9-41a2-b150-55907652581c";

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
      draftVersion: 8,
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
});
