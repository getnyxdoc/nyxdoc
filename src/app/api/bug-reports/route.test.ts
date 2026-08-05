import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSession: vi.fn(),
  requireHumanDocumentPermission: vi.fn(),
  createAppBugReport: vi.fn(),
  storeMediaAsset: vi.fn(),
  removeUnreferencedDiagnosticMedia: vi.fn(),
  assertSameOrigin: vi.fn(),
}));

vi.mock("@/data/workspace-context", () => ({
  requireWorkspaceSession: mocks.requireWorkspaceSession,
}));
vi.mock("@/lib/authz/permissions", () => ({
  requireHumanDocumentPermission: mocks.requireHumanDocumentPermission,
}));
vi.mock("@/lib/db/client", () => ({
  sqlite: {
    prepare: () => ({ get: () => ({ active: 1 }) }),
  },
}));
vi.mock("@/lib/diagnostics/bug-reports", () => ({
  BugReportError: class BugReportError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
  createAppBugReport: mocks.createAppBugReport,
}));
vi.mock("@/lib/diagnostics/config", () => ({
  diagnosticsDisabledResponse: () => null,
}));
vi.mock("@/lib/http/origin", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
}));
vi.mock("@/lib/http/errors", () => ({
  apiErrorResponse(error: unknown) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  },
}));
vi.mock("@/lib/media/service", () => ({
  removeUnreferencedDiagnosticMedia: mocks.removeUnreferencedDiagnosticMedia,
  storeMediaAsset: mocks.storeMediaAsset,
}));

import { POST } from "@/app/api/bug-reports/route";

describe("bug report multipart route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceSession.mockResolvedValue({
      session: { user: { id: "user-1" } },
      workspace: { id: "workspace-1" },
    });
    mocks.storeMediaAsset.mockResolvedValue({ id: "media-1" });
    mocks.createAppBugReport.mockResolvedValue({
      id: "report-1",
      reportCode: "BUG-20260805-ABCDEF123456",
      trigger: "manual",
      category: "save_sync",
      categorySource: "suggested",
      detector: null,
      reasonCode: "manual_report",
      capturedAt: "2026-08-05T00:00:00.000Z",
      createdAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-09-04T00:00:00.000Z",
      occurrenceCount: 1,
      createdNew: true,
    });
  });

  it("decodes an explicit image and binds it to the stored report", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const report = {
      schemaVersion: 1,
      clientReportId: randomUUID(),
      sessionId: randomUUID(),
      trigger: "manual",
      category: "save_sync",
      categorySource: "suggested",
      suggestedCategory: "save_sync",
      reasonCode: "manual_report",
      capturedAt: "2026-08-05T00:00:00.000Z",
      clientBuildSha: "development",
      documentId: "f3d3fa2d-5b7b-4c1c-945d-9fb22340ad9f",
      environment: {
        browser: "edge",
        browserMajor: 140,
        platform: "windows",
        viewportClass: "wide",
        locale: "ko",
        online: true,
      },
      snapshot: {
        surface: "editor",
        editorMode: "edit",
        canonicalRevision: 4,
        generation: 2,
        draftVersion: 10,
        committedDraftVersion: 7,
        dirty: true,
        syncState: "synced",
        validationState: "valid",
        visibility: "visible",
        accessKind: "membership",
        workspaceRole: "owner",
        canRead: true,
        canEdit: true,
        canCommit: true,
        canShare: true,
        blockCount: "eleven_to_hundred",
        textLength: "hundred_one_to_thousand",
        nodeTypeCount: "one_to_ten",
        documentCount: "one_to_ten",
        sidebarWidth: "standard",
      },
      events: [],
    };
    const form = new FormData();
    form.set("report", JSON.stringify(report));
    form.append("attachment", new File([png], "save-error.png", { type: "image/png" }));

    const response = await POST(new Request("http://localhost/api/bug-reports", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(201);
    expect(mocks.storeMediaAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        originalFilename: "save-error.png",
        expectedByteSize: png.length,
        expectedMimeType: "image/png",
        purpose: "diagnostic",
        userId: "user-1",
        workspaceId: "workspace-1",
      }),
    );
    const uploaded = mocks.storeMediaAsset.mock.calls[0][1] as { bytes: ArrayBuffer };
    expect(Buffer.from(uploaded.bytes)).toEqual(png);
    expect(mocks.createAppBugReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attachmentMediaIds: ["media-1"] }),
    );
    expect(mocks.removeUnreferencedDiagnosticMedia).not.toHaveBeenCalled();
  });
});
