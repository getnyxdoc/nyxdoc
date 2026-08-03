import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSession: vi.fn(),
  requireHumanDocumentPermission: vi.fn(),
  resetWorkingDocument: vi.fn(),
  humanDocumentActor: vi.fn(),
  getDocumentRevisionSnapshot: vi.fn(),
  assertSameOrigin: vi.fn(),
}));

vi.mock("@/data/workspace-context", () => ({
  requireWorkspaceSession: mocks.requireWorkspaceSession,
}));
vi.mock("@/lib/authz/permissions", () => ({
  requireHumanDocumentPermission: mocks.requireHumanDocumentPermission,
}));
vi.mock("@/lib/collaboration/gateway", () => ({
  resetWorkingDocument: mocks.resetWorkingDocument,
}));
vi.mock("@/lib/db/client", () => ({ sqlite: {} }));
vi.mock("@/lib/documents/actors", () => ({
  humanDocumentActor: mocks.humanDocumentActor,
}));
vi.mock("@/lib/documents/service", () => ({
  getDocumentRevisionSnapshot: mocks.getDocumentRevisionSnapshot,
}));
vi.mock("@/lib/http/origin", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
}));
vi.mock("@/lib/http/errors", () => ({
  apiErrorResponse(error: unknown) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  },
}));

import { POST } from "@/app/api/documents/[documentId]/revisions/[revisionId]/restore/route";

const documentId = "5a2aa380-93d9-41a2-b150-55907652581c";
const revisionId = "814a99ed-fd82-4e21-b292-8996034419bd";

describe("human revision restore route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceSession.mockResolvedValue({
      session: { user: { id: "user-1", name: "Writer" } },
      workspace: { id: "workspace-1" },
    });
    mocks.humanDocumentActor.mockReturnValue({
      type: "human",
      userId: "user-1",
      principalId: "user-1",
      label: "Writer",
    });
    mocks.resetWorkingDocument.mockResolvedValue({
      roomName: "nyxdoc:workspace-1:document-1:g4",
      workingDocument: { generation: 4, draftVersion: 1 },
    });
  });

  it("uses the observed generation, draft version, and base revision as the restore CAS", async () => {
    const response = await POST(new Request(
      `http://localhost/api/documents/${documentId}/revisions/${revisionId}/restore`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 12,
          expectedGeneration: 3,
          expectedDraftVersion: 8,
        }),
      },
    ), {
      params: Promise.resolve({ documentId, revisionId }),
    });

    expect(response.status).toBe(200);
    expect(mocks.resetWorkingDocument).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      documentId,
      revisionId,
      expectedGeneration: 3,
      expectedDraftVersion: 8,
      expectedBaseRevision: 12,
      actor: expect.objectContaining({
        type: "human",
        userId: "user-1",
        source: "rollback",
      }),
    });
  });
});
