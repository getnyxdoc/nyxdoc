import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireVerifiedSession: vi.fn(),
  validateAccountAgentPurge: vi.fn(),
  purgeAccountAgent: vi.fn(),
  withDestructiveOperationBackup: vi.fn(),
  assertSameOrigin: vi.fn(),
}));

vi.mock("@/data/session", () => ({
  requireVerifiedSession: mocks.requireVerifiedSession,
}));
vi.mock("@/lib/agents/service", () => ({
  validateAccountAgentPurge: mocks.validateAccountAgentPurge,
  purgeAccountAgent: mocks.purgeAccountAgent,
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
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  },
}));

import { DELETE } from "@/app/api/account/agents/[agentId]/purge/route";

const backup = {
  generationPath: "C:/backups/generation-1",
  manifest: { generationId: "generation-1" },
};

function purgeRequest() {
  return new Request("http://localhost/api/account/agents/agent-1/purge", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmationName: "Agent One" }),
  });
}

describe("account agent purge route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireVerifiedSession.mockResolvedValue({
      user: { id: "user-1", name: "Owner" },
    });
    mocks.purgeAccountAgent.mockReturnValue({
      id: "agent-1",
      displayName: "Agent One",
      lifecycleState: "purged",
    });
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => ({
      backup,
      result: await operation(backup),
      warnings: [],
    }));
  });

  it("keeps the barrier held through the agent purge and preserves its response metadata", async () => {
    const order: string[] = [];
    mocks.validateAccountAgentPurge.mockImplementation(() => order.push("validate"));
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => {
      order.push("barrier");
      return { backup, result: await operation(backup), warnings: [] };
    });
    mocks.purgeAccountAgent.mockImplementation((...args) => {
      order.push("purge");
      return {
        id: args[1].agentId,
        displayName: "Agent One",
        lifecycleState: "purged",
      };
    });

    const response = await DELETE(purgeRequest(), {
      params: Promise.resolve({ agentId: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(order).toEqual(["validate", "barrier", "purge"]);
    expect(mocks.purgeAccountAgent).toHaveBeenCalledWith({}, {
      userId: "user-1",
      agentId: "agent-1",
      confirmationName: "Agent One",
      actorLabel: "Owner",
      backupGenerationId: "generation-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      agent: { id: "agent-1", lifecycleState: "purged" },
      backupGenerationId: "generation-1",
    });
  });

  it("fails closed without invoking the purge when the barrier is unavailable", async () => {
    mocks.withDestructiveOperationBackup.mockRejectedValue(
      new Error("Verified backup requires a live collaboration barrier"),
    );

    const response = await DELETE(purgeRequest(), {
      params: Promise.resolve({ agentId: "agent-1" }),
    });

    expect(response.status).toBe(500);
    expect(mocks.purgeAccountAgent).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Verified backup requires a live collaboration barrier",
    });
  });

  it("returns the operation error without retrying the agent purge", async () => {
    mocks.purgeAccountAgent.mockImplementation(() => {
      throw new Error("agent purge mutation failed");
    });

    const response = await DELETE(purgeRequest(), {
      params: Promise.resolve({ agentId: "agent-1" }),
    });

    expect(response.status).toBe(500);
    expect(mocks.withDestructiveOperationBackup).toHaveBeenCalledOnce();
    expect(mocks.purgeAccountAgent).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({ error: "agent purge mutation failed" });
  });

  it("treats a lost release response as warning success without repeating the purge", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.withDestructiveOperationBackup.mockImplementation(async (operation) => ({
      backup,
      result: await operation(backup),
      warnings: ["collaboration barrier release response was lost"],
    }));

    try {
      const response = await DELETE(purgeRequest(), {
        params: Promise.resolve({ agentId: "agent-1" }),
      });

      expect(response.status).toBe(200);
      expect(mocks.purgeAccountAgent).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        "[nyxdoc] agent purge completed with backup barrier warnings",
        expect.objectContaining({
          agentId: "agent-1",
          warnings: ["collaboration barrier release response was lost"],
        }),
      );
    } finally {
      warning.mockRestore();
    }
  });
});
