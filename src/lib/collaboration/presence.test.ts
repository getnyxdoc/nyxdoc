import { beforeEach, describe, expect, it } from "vitest";
import {
  endAgentPresence,
  listWorkspacePresence,
  PRESENCE_TTL_MS,
  presenceVersion,
  resetPresenceForTests,
  setAgentPresence,
} from "@/lib/collaboration/presence";

beforeEach(resetPresenceForTests);

describe("ephemeral agent presence", () => {
  it("keeps one stable session through heartbeats and expires it", () => {
    const start = Date.parse("2026-07-15T00:00:00.000Z");
    const first = setAgentPresence({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      displayName: "Gameroom",
      avatarMediaId: null,
      documentId: "document-1",
      state: "reading",
    }, start);
    const heartbeat = setAgentPresence({
      ...first,
      state: "drafting",
      progress: 40,
    }, start + 10_000);

    expect(heartbeat.sessionId).toBe(first.sessionId);
    expect(heartbeat.startedAt).toBe(first.startedAt);
    expect(listWorkspacePresence("workspace-1", start + 20_000)).toEqual([
      expect.objectContaining({ state: "drafting", progress: 40 }),
    ]);
    expect(listWorkspacePresence("workspace-1", start + 10_000 + PRESENCE_TTL_MS + 1)).toEqual([]);
  });

  it("only lets the owning agent end a session", () => {
    const entry = setAgentPresence({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      displayName: "Gameroom",
      avatarMediaId: null,
      documentId: "document-1",
      state: "editing",
    });
    const before = presenceVersion();
    expect(endAgentPresence("workspace-1", "agent-2", entry.sessionId)).toBe(false);
    expect(endAgentPresence("workspace-1", "agent-1", entry.sessionId)).toBe(true);
    expect(presenceVersion()).toBeGreaterThan(before);
  });
});
