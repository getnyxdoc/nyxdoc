import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireVerifiedSession: vi.fn(),
  validateWorkspacePurge: vi.fn(),
  purgeWorkspace: vi.fn(),
  withDestructiveOperationBackup: vi.fn(),
  processWorkspaceMediaCleanupQueue: vi.fn(),
  assertSameOrigin: vi.fn(),
}));

vi.mock("@/data/session", () => ({
  requireVerifiedSession: mocks.requireVerifiedSession,
}));
vi.mock("@/lib/db/client", () => ({ sqlite: {} }));
vi.mock("@/lib/db/safety-backup", () => ({
  withDestructiveOperationBackup: mocks.withDestructiveOperationBackup,
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
  processWorkspaceMediaCleanupQueue: mocks.processWorkspaceMediaCleanupQueue,
}));
vi.mock("@/lib/workspaces/service", () => ({
  validateWorkspacePurge: mocks.validateWorkspacePurge,
  purgeWorkspace: mocks.purgeWorkspace,
}));

import { DELETE } from "@/app/api/workspaces/[workspaceId]/purge/route";

describe("workspace purge route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireVerifiedSession.mockResolvedValue({
      user: { id: "user-1", name: "Owner" },
    });
    mocks.purgeWorkspace.mockReturnValue({
      id: "workspace-1",
      name: "Workspace",
      lifecycleState: "purged",
      purgedAt: "2026-08-09T00:00:00.000Z",
      counts: { documents: 2 },
      mediaCleanupPending: 1,
      backupGenerationId: "generation-1",
    });
    mocks.processWorkspaceMediaCleanupQueue.mockResolvedValue({
      processed: 1,
      completed: 1,
      failed: [],
      pending: 0,
    });
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => {
      const backup = {
        generationPath: "C:/backups/generation-1",
        manifest: { generationId: "generation-1" },
      };
      return { backup, result: await operation(backup), warnings: [] };
    });
  });

  it("keeps the verified barrier held through the workspace database purge", async () => {
    const order: string[] = [];
    mocks.validateWorkspacePurge.mockImplementation(() => order.push("validate"));
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => {
      order.push("barrier");
      const backup = {
        generationPath: "C:/backups/generation-1",
        manifest: { generationId: "generation-1" },
      };
      return { backup, result: await operation(backup), warnings: [] };
    });
    mocks.purgeWorkspace.mockImplementation((...args) => {
      order.push("purge");
      return {
        id: "workspace-1",
        name: "Workspace",
        lifecycleState: "purged",
        purgedAt: "2026-08-09T00:00:00.000Z",
        counts: { documents: 2 },
        mediaCleanupPending: 0,
        backupGenerationId: args[1].backupGenerationId,
      };
    });
    mocks.processWorkspaceMediaCleanupQueue.mockImplementation(async () => {
      order.push("cleanup");
      return { processed: 0, completed: 0, failed: [], pending: 0 };
    });

    const response = await DELETE(new Request("http://localhost/api/workspaces/workspace-1/purge", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmationName: "Workspace" }),
    }), { params: Promise.resolve({ workspaceId: "workspace-1" }) });

    expect(response.status).toBe(200);
    expect(order).toEqual(["validate", "barrier", "purge", "cleanup"]);
    expect(mocks.purgeWorkspace).toHaveBeenCalledWith({}, expect.objectContaining({
      backupGenerationId: "generation-1",
    }));
    await expect(response.json()).resolves.toMatchObject({
      backupGenerationId: "generation-1",
      mediaCleanupPending: 0,
    });
  });

  it("returns a successful purge with durable cleanup pending when unlink fails", async () => {
    mocks.processWorkspaceMediaCleanupQueue.mockResolvedValue({
      processed: 1,
      completed: 0,
      failed: [{ storageKey: "ab/media.webp", error: "injected unlink failure" }],
      pending: 1,
    });

    const response = await DELETE(new Request("http://localhost/api/workspaces/workspace-1/purge", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmationName: "Workspace" }),
    }), { params: Promise.resolve({ workspaceId: "workspace-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.processWorkspaceMediaCleanupQueue).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-1",
    });
    await expect(response.json()).resolves.toMatchObject({ mediaCleanupPending: 1 });
  });

  it("does not purge when the collaboration barrier cannot be acquired", async () => {
    mocks.withDestructiveOperationBackup.mockRejectedValue(
      new Error("Verified backup requires a live collaboration barrier"),
    );

    const response = await DELETE(new Request("http://localhost/api/workspaces/workspace-1/purge", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmationName: "Workspace" }),
    }), { params: Promise.resolve({ workspaceId: "workspace-1" }) });

    expect(response.status).toBe(500);
    expect(mocks.purgeWorkspace).not.toHaveBeenCalled();
  });
});
