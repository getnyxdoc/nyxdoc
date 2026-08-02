import { describe, expect, it, vi } from "vitest";
import {
  assertCollaborationTokenFresh,
  collaborationTokenExpiryDelay,
  type CollaborationTokenClaims,
} from "@/lib/collaboration/token";

function claims(expiresAt: number): CollaborationTokenClaims {
  return {
    version: 1,
    tokenId: "token-id",
    roomName: "nyxdoc:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:g1",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    documentId: "00000000-0000-4000-8000-000000000002",
    generation: 1,
    actor: {
      type: "human",
      userId: "user-id",
      label: "Tester",
      source: "web",
    },
    permissions: { read: true, write: true, commit: true },
    issuedAt: expiresAt - 300,
    expiresAt,
  };
}

describe("collaboration connection expiry", () => {
  it("computes the exact remaining lifetime for the connection timer", () => {
    expect(collaborationTokenExpiryDelay(claims(130), 100_000)).toBe(30_000);
    expect(collaborationTokenExpiryDelay(claims(100), 100_001)).toBe(0);
  });

  it("closes at expiry even when no further messages arrive", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const close = vi.fn();
      const tokenClaims = claims(101);
      setTimeout(close, collaborationTokenExpiryDelay(tokenClaims));
      vi.advanceTimersByTime(999);
      expect(close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a delayed update before any mutation callback can run", () => {
    const mutateYDocOrDatabase = vi.fn();
    const applyUpdate = () => {
      assertCollaborationTokenFresh(claims(100), 100_001);
      mutateYDocOrDatabase();
    };
    expect(applyUpdate).toThrow("협업 토큰이 만료되었습니다.");
    expect(mutateYDocOrDatabase).not.toHaveBeenCalled();
  });
});
