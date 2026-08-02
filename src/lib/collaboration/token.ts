import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getCollaborationSecret } from "@/lib/config";
import type { DraftActor } from "@/lib/collaboration/drafts";

const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 5 * 60;

export type CollaborationTokenClaims = {
  version: typeof TOKEN_VERSION;
  tokenId: string;
  roomName: string;
  workspaceId: string;
  documentId: string;
  generation: number;
  actor: DraftActor;
  permissions: {
    read: true;
    write: boolean;
    commit: boolean;
  };
  issuedAt: number;
  expiresAt: number;
};

export function assertCollaborationTokenFresh(
  claims: CollaborationTokenClaims,
  nowMs = Date.now(),
) {
  if (claims.expiresAt * 1_000 <= nowMs) {
    throw new Error("협업 토큰이 만료되었습니다.");
  }
}

export function collaborationTokenExpiryDelay(
  claims: CollaborationTokenClaims,
  nowMs = Date.now(),
) {
  return Math.max(0, claims.expiresAt * 1_000 - nowMs);
}

function encodeJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signature(payload: string) {
  return createHmac("sha256", getCollaborationSecret())
    .update(payload, "utf8")
    .digest("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseClaims(value: unknown): CollaborationTokenClaims {
  if (!isRecord(value) || value.version !== TOKEN_VERSION) {
    throw new Error("지원하지 않는 협업 토큰입니다.");
  }
  const permissions = value.permissions;
  const actor = value.actor;
  if (
    typeof value.tokenId !== "string"
    || typeof value.roomName !== "string"
    || typeof value.workspaceId !== "string"
    || typeof value.documentId !== "string"
    || !Number.isInteger(value.generation)
    || typeof value.issuedAt !== "number"
    || typeof value.expiresAt !== "number"
    || !isRecord(permissions)
    || permissions.read !== true
    || typeof permissions.write !== "boolean"
    || typeof permissions.commit !== "boolean"
    || !isRecord(actor)
    || (actor.type !== "human" && actor.type !== "agent" && actor.type !== "system")
    || typeof actor.label !== "string"
    || !["web", "mcp", "api", "rollback", "migration", "seed"].includes(String(actor.source))
  ) {
    throw new Error("협업 토큰의 내용이 올바르지 않습니다.");
  }
  return value as CollaborationTokenClaims;
}

export function createCollaborationToken(input: Omit<
  CollaborationTokenClaims,
  "version" | "tokenId" | "issuedAt" | "expiresAt"
>) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: CollaborationTokenClaims = {
    ...input,
    version: TOKEN_VERSION,
    tokenId: randomUUID(),
    issuedAt,
    expiresAt: issuedAt + TOKEN_TTL_SECONDS,
  };
  const payload = encodeJson(claims);
  return `${payload}.${signature(payload)}`;
}

export function verifyCollaborationToken(token: string): CollaborationTokenClaims {
  if (!token || token.length > 8_192) throw new Error("협업 토큰이 필요합니다.");
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) throw new Error("협업 토큰 형식이 올바르지 않습니다.");
  const expected = Buffer.from(signature(payload), "utf8");
  const supplied = Buffer.from(suppliedSignature, "utf8");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("협업 토큰 서명을 확인할 수 없습니다.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("협업 토큰을 읽을 수 없습니다.");
  }
  const claims = parseClaims(decoded);
  const now = Math.floor(Date.now() / 1000);
  assertCollaborationTokenFresh(claims, Date.now());
  if (claims.issuedAt > now + 30) {
    throw new Error("협업 토큰이 만료되었습니다.");
  }
  if (claims.expiresAt - claims.issuedAt > TOKEN_TTL_SECONDS + 30) {
    throw new Error("협업 토큰 유효 시간이 올바르지 않습니다.");
  }
  return claims;
}
