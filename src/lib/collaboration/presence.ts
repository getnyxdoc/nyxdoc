import { randomUUID } from "node:crypto";

export const PRESENCE_TTL_MS = 45_000;

export type AgentPresence = {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  displayName: string;
  avatarMediaId: string | null;
  documentId: string;
  blockId: string | null;
  state: "reading" | "editing" | "drafting" | "reviewing";
  progress: number | null;
  message: string | null;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
};

type PresenceStore = {
  entries: Map<string, AgentPresence>;
  version: number;
};

export class PresenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresenceError";
  }
}

declare global {
  var __nyxdocPresenceStore: PresenceStore | undefined;
}

function store() {
  globalThis.__nyxdocPresenceStore ??= { entries: new Map(), version: 0 };
  return globalThis.__nyxdocPresenceStore;
}

function key(workspaceId: string, sessionId: string) {
  return `${workspaceId}:${sessionId}`;
}

function expireEntries(now = Date.now()) {
  const current = store();
  let changed = false;
  for (const [entryKey, entry] of current.entries) {
    if (Date.parse(entry.expiresAt) <= now) {
      current.entries.delete(entryKey);
      changed = true;
    }
  }
  if (changed) current.version += 1;
}

export function setAgentPresence(input: {
  sessionId?: string;
  workspaceId: string;
  agentId: string;
  displayName: string;
  avatarMediaId: string | null;
  documentId: string;
  blockId?: string | null;
  state: AgentPresence["state"];
  progress?: number | null;
  message?: string | null;
}, now = Date.now()) {
  expireEntries(now);
  const current = store();
  const sessionId = input.sessionId ?? randomUUID();
  const entryKey = key(input.workspaceId, sessionId);
  const previous = current.entries.get(entryKey);
  if (previous && previous.agentId !== input.agentId) {
    throw new PresenceError("다른 에이전트의 작업 세션은 갱신할 수 없습니다.");
  }
  const updatedAt = new Date(now).toISOString();
  const entry: AgentPresence = {
    sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    displayName: input.displayName,
    avatarMediaId: input.avatarMediaId,
    documentId: input.documentId,
    blockId: input.blockId ?? null,
    state: input.state,
    progress: input.progress ?? null,
    message: input.message?.trim() || null,
    startedAt: previous?.startedAt ?? updatedAt,
    updatedAt,
    expiresAt: new Date(now + PRESENCE_TTL_MS).toISOString(),
  };
  current.entries.set(entryKey, entry);
  current.version += 1;
  return entry;
}

export function endAgentPresence(
  workspaceId: string,
  agentId: string,
  sessionId: string,
) {
  const current = store();
  const entryKey = key(workspaceId, sessionId);
  const entry = current.entries.get(entryKey);
  if (!entry || entry.agentId !== agentId) return false;
  current.entries.delete(entryKey);
  current.version += 1;
  return true;
}

export function listWorkspacePresence(workspaceId: string, now = Date.now()) {
  expireEntries(now);
  return Array.from(store().entries.values())
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt)
      || left.agentId.localeCompare(right.agentId));
}

export function presenceVersion(now = Date.now()) {
  expireEntries(now);
  return store().version;
}

export function resetPresenceForTests() {
  globalThis.__nyxdocPresenceStore = { entries: new Map(), version: 0 };
}
