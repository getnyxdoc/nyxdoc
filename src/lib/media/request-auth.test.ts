import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSession: vi.fn(),
  getHumanDocumentPrincipal: vi.fn(),
  humanDocumentPrincipalAllows: vi.fn(),
  requireHumanDocumentPermission: vi.fn(),
  requireHumanWorkspacePermission: vi.fn(),
  mediaAssetWasUploadedByUser: vi.fn(),
  resolveAuthorizedMediaDocumentBinding: vi.fn(),
  assertSameOrigin: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/workspace-context", () => ({
  requireWorkspaceSession: mocks.requireWorkspaceSession,
}));
vi.mock("@/lib/authz/permissions", () => ({
  getHumanDocumentPrincipal: mocks.getHumanDocumentPrincipal,
  humanDocumentPrincipalAllows: mocks.humanDocumentPrincipalAllows,
  requireHumanDocumentPermission: mocks.requireHumanDocumentPermission,
  requireHumanWorkspacePermission: mocks.requireHumanWorkspacePermission,
}));
vi.mock("@/lib/db/client", () => ({ sqlite: {} }));
vi.mock("@/lib/http/origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));
vi.mock("@/lib/http/client-ip", () => ({ requestClientIp: vi.fn() }));
vi.mock("@/lib/media/bindings", () => ({
  mediaAssetWasUploadedByUser: mocks.mediaAssetWasUploadedByUser,
  resolveAuthorizedMediaDocumentBinding: mocks.resolveAuthorizedMediaDocumentBinding,
}));
vi.mock("@/lib/tokens/service", () => ({
  ApiTokenError: class ApiTokenError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  authenticateApiToken: vi.fn(),
  requireTokenDocumentAccess: vi.fn(),
  requireTokenPermission: vi.fn(),
  tokenCanAccessDocument: vi.fn(),
}));

import { requireMediaRequestIdentity } from "@/lib/media/request-auth";

describe("media request authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceSession.mockResolvedValue({
      session: { user: { id: "human-1" } },
      workspace: { id: "workspace-1" },
    });
  });

  it("lets a human read their own unbound upload without widening workspace access", async () => {
    mocks.mediaAssetWasUploadedByUser.mockReturnValue(true);

    await expect(requireMediaRequestIdentity(
      new Request("http://localhost/api/media/media-1"),
      "documents:read",
      { mediaId: "media-1", workspaceId: "workspace-1" },
    )).resolves.toEqual({
      tokenId: undefined,
      userId: "human-1",
      workspaceId: "workspace-1",
    });

    expect(mocks.mediaAssetWasUploadedByUser).toHaveBeenCalledWith(
      {},
      "workspace-1",
      "media-1",
      "human-1",
    );
    expect(mocks.resolveAuthorizedMediaDocumentBinding).not.toHaveBeenCalled();
  });

  it("still rejects another human's unbound media", async () => {
    mocks.mediaAssetWasUploadedByUser.mockReturnValue(false);
    mocks.resolveAuthorizedMediaDocumentBinding.mockReturnValue(null);

    await expect(requireMediaRequestIdentity(
      new Request("http://localhost/api/media/media-1"),
      "documents:read",
      { mediaId: "media-1", workspaceId: "workspace-1" },
    )).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "이미지를 찾을 수 없습니다.",
    });
  });
});
