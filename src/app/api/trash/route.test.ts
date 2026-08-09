import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSession: vi.fn(),
  requireHumanWorkspacePermission: vi.fn(),
  humanDocumentActor: vi.fn(),
  listTrashBatches: vi.fn(),
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
  listTrashBatches: mocks.listTrashBatches,
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

import { DELETE } from "@/app/api/trash/route";

describe("trash purge route", () => {
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
    mocks.listTrashBatches.mockReturnValue([
      { rootDocumentId: "document-1" },
      { rootDocumentId: "document-2" },
    ]);
    mocks.purgeTrashedDocument
      .mockReturnValueOnce({ documentCount: 2 })
      .mockReturnValueOnce({ documentCount: 1 });
    mocks.transaction.mockImplementation((operation) => Object.assign(
      () => operation(),
      {
        immediate: () => {
          mocks.immediate();
          return operation();
        },
      },
    ));
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => {
      const backup = {
        generationPath: "C:/backups/generation-1",
        manifest: { generationId: "generation-1" },
      };
      return { backup, result: await operation(backup), warnings: [] };
    });
  });

  it("purges every batch inside the live backup barrier", async () => {
    const response = await DELETE(new Request("http://localhost/api/trash?workspace=workspace-1", {
      method: "DELETE",
    }));

    expect(response.status).toBe(200);
    expect(mocks.withDestructiveOperationBackup).toHaveBeenCalledOnce();
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.immediate).toHaveBeenCalledOnce();
    expect(mocks.requireHumanWorkspacePermission).toHaveBeenCalledTimes(2);
    expect(mocks.purgeTrashedDocument).toHaveBeenCalledTimes(2);
    await expect(response.json()).resolves.toMatchObject({
      documentCount: 3,
      backupGenerationId: "generation-1",
    });
  });

  it("rechecks purge permission after backup and leaves documents and tombstones untouched after revocation", async () => {
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
      return { documentCount: 2 };
    });
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => {
      const backup = {
        generationPath: "C:/backups/generation-1",
        manifest: { generationId: "generation-1" },
      };
      permissionRevoked = true;
      return { backup, result: await operation(backup), warnings: [] };
    });

    const response = await DELETE(new Request("http://localhost/api/trash?workspace=workspace-1", {
      method: "DELETE",
    }));

    expect(response.status).toBe(403);
    expect(mocks.requireHumanWorkspacePermission).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.immediate).toHaveBeenCalledOnce();
    expect(mocks.purgeTrashedDocument).not.toHaveBeenCalled();
    expect([...persisted.documentIds]).toEqual(["document-1", "document-2"]);
    expect([...persisted.tombstoneIds]).toEqual([]);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not delete a batch when the live collaboration barrier is unavailable", async () => {
    mocks.withDestructiveOperationBackup.mockRejectedValue(
      new Error("Verified backup requires a live collaboration barrier"),
    );

    const response = await DELETE(new Request("http://localhost/api/trash?workspace=workspace-1", {
      method: "DELETE",
    }));

    expect(response.status).toBe(500);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.purgeTrashedDocument).not.toHaveBeenCalled();
  });

  it("skips the barrier entirely when there is nothing to purge", async () => {
    mocks.listTrashBatches.mockReturnValue([]);

    const response = await DELETE(new Request("http://localhost/api/trash?workspace=workspace-1", {
      method: "DELETE",
    }));

    expect(response.status).toBe(200);
    expect(mocks.withDestructiveOperationBackup).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ documentCount: 0, results: [] });
  });
});
