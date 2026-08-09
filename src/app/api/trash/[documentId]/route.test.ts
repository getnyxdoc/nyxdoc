import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSession: vi.fn(),
  requireHumanWorkspacePermission: vi.fn(),
  humanDocumentActor: vi.fn(),
  purgeTrashedDocument: vi.fn(),
  withDestructiveOperationBackup: vi.fn(),
  assertSameOrigin: vi.fn(),
  transaction: vi.fn(),
  immediate: vi.fn(),
}));

vi.mock("@/data/workspace-context", () => ({
  requireWorkspaceSession: mocks.requireWorkspaceSession,
}));
vi.mock("@/lib/authz/permissions", () => ({
  requireHumanWorkspacePermission: mocks.requireHumanWorkspacePermission,
}));
vi.mock("@/lib/db/client", () => ({
  sqlite: { transaction: mocks.transaction },
}));
vi.mock("@/lib/db/safety-backup", () => ({
  withDestructiveOperationBackup: mocks.withDestructiveOperationBackup,
}));
vi.mock("@/lib/documents/actors", () => ({
  humanDocumentActor: mocks.humanDocumentActor,
}));
vi.mock("@/lib/documents/service", () => ({
  purgeTrashedDocument: mocks.purgeTrashedDocument,
}));
vi.mock("@/lib/http/origin", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
}));
vi.mock("@/lib/http/errors", () => ({
  apiErrorResponse(error: unknown) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        ...(code ? { code } : {}),
      },
      { status: code === "FORBIDDEN" ? 403 : 500 },
    );
  },
}));

import { DELETE } from "@/app/api/trash/[documentId]/route";

const backup = {
  generationPath: "C:/backups/generation-1",
  manifest: { generationId: "generation-1" },
};

describe("single trashed document purge route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireWorkspaceSession.mockResolvedValue({
      session: { user: { id: "user-1", name: "Owner" } },
      workspace: { id: "workspace-1" },
    });
    mocks.humanDocumentActor.mockReturnValue({
      type: "human",
      userId: "user-1",
      label: "Owner",
      source: "web",
    });
    mocks.purgeTrashedDocument.mockReturnValue({
      rootDocumentId: "document-1",
      documentIds: ["document-1", "document-2"],
      documentCount: 2,
    });
    mocks.transaction.mockImplementation((operation) => Object.assign(
      () => operation(),
      {
        immediate: () => {
          mocks.immediate();
          return operation();
        },
      },
    ));
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => ({
      backup,
      result: await operation(backup),
      warnings: [],
    }));
  });

  it("keeps the barrier held through the document purge and preserves its response", async () => {
    const order: string[] = [];
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => {
      order.push("barrier");
      return { backup, result: await operation(backup), warnings: [] };
    });
    mocks.purgeTrashedDocument.mockImplementation(() => {
      order.push("purge");
      return {
        rootDocumentId: "document-1",
        documentIds: ["document-1", "document-2"],
        documentCount: 2,
      };
    });

    const response = await DELETE(new Request("http://localhost/api/trash/document-1", {
      method: "DELETE",
    }), { params: Promise.resolve({ documentId: "document-1" }) });

    expect(response.status).toBe(200);
    expect(order).toEqual(["barrier", "purge"]);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.immediate).toHaveBeenCalledOnce();
    expect(mocks.requireHumanWorkspacePermission).toHaveBeenCalledTimes(2);
    expect(mocks.requireHumanWorkspacePermission).toHaveBeenCalledWith(
      expect.objectContaining({ transaction: mocks.transaction }),
      "workspace-1",
      "user-1",
      "documents.purge",
    );
    expect(mocks.purgeTrashedDocument).toHaveBeenCalledWith(
      expect.objectContaining({ transaction: mocks.transaction }),
      "workspace-1",
      expect.objectContaining({ userId: "user-1", label: "Owner" }),
      "document-1",
    );
    await expect(response.json()).resolves.toEqual({
      rootDocumentId: "document-1",
      documentIds: ["document-1", "document-2"],
      documentCount: 2,
      backupGenerationId: "generation-1",
    });
  });

  it("rechecks purge permission after backup and leaves the document and tombstones untouched after revocation", async () => {
    const persisted = {
      documentIds: new Set(["document-1", "document-2"]),
      tombstoneIds: new Set<string>(),
    };
    let permissionRevoked = false;
    mocks.requireHumanWorkspacePermission.mockImplementation(() => {
      if (permissionRevoked) {
        throw Object.assign(new Error("Purge permission was revoked during backup"), {
          code: "FORBIDDEN",
        });
      }
    });
    mocks.purgeTrashedDocument.mockImplementation(() => {
      persisted.documentIds.clear();
      persisted.tombstoneIds.add("document-1");
      return {
        rootDocumentId: "document-1",
        documentIds: ["document-1", "document-2"],
        documentCount: 2,
      };
    });
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => {
      permissionRevoked = true;
      return { backup, result: await operation(backup), warnings: [] };
    });

    const response = await DELETE(new Request("http://localhost/api/trash/document-1", {
      method: "DELETE",
    }), { params: Promise.resolve({ documentId: "document-1" }) });

    expect(response.status).toBe(403);
    expect(mocks.requireHumanWorkspacePermission).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.immediate).toHaveBeenCalledOnce();
    expect(mocks.purgeTrashedDocument).not.toHaveBeenCalled();
    expect([...persisted.documentIds]).toEqual(["document-1", "document-2"]);
    expect([...persisted.tombstoneIds]).toEqual([]);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed without invoking the purge when the barrier is unavailable", async () => {
    mocks.withDestructiveOperationBackup.mockRejectedValue(
      new Error("Verified backup requires a live collaboration barrier"),
    );

    const response = await DELETE(new Request("http://localhost/api/trash/document-1", {
      method: "DELETE",
    }), { params: Promise.resolve({ documentId: "document-1" }) });

    expect(response.status).toBe(500);
    expect(mocks.purgeTrashedDocument).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Verified backup requires a live collaboration barrier",
    });
  });

  it("returns the operation error without retrying the document purge", async () => {
    mocks.purgeTrashedDocument.mockImplementation(() => {
      throw new Error("document purge mutation failed");
    });

    const response = await DELETE(new Request("http://localhost/api/trash/document-1", {
      method: "DELETE",
    }), { params: Promise.resolve({ documentId: "document-1" }) });

    expect(response.status).toBe(500);
    expect(mocks.withDestructiveOperationBackup).toHaveBeenCalledOnce();
    expect(mocks.purgeTrashedDocument).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({ error: "document purge mutation failed" });
  });

  it("treats a lost release response as warning success without repeating the purge", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => ({
      backup,
      result: await operation(backup),
      warnings: ["collaboration barrier release response was lost"],
    }));

    try {
      const response = await DELETE(new Request("http://localhost/api/trash/document-1", {
        method: "DELETE",
      }), { params: Promise.resolve({ documentId: "document-1" }) });

      expect(response.status).toBe(200);
      expect(mocks.purgeTrashedDocument).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        "[nyxdoc] document purge completed with backup barrier warnings",
        expect.objectContaining({
          workspaceId: "workspace-1",
          documentId: "document-1",
          warnings: ["collaboration barrier release response was lost"],
        }),
      );
    } finally {
      warning.mockRestore();
    }
  });
});
