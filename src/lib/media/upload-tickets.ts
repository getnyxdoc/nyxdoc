import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  agentPrincipalAllows,
  WORKSPACE_PERMISSIONS,
  type AgentWorkspaceRole,
  type WorkspacePermission,
} from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import { bindMediaAssetToDocument } from "@/lib/media/bindings";
import {
  MAX_MEDIA_BYTES,
  MediaServiceError,
  storeMediaAsset,
  SUPPORTED_IMAGE_MIME_TYPES,
  type SupportedImageMimeType,
} from "@/lib/media/service";
import {
  requireTokenDocumentAccess,
  requireTokenScope,
  type ApiTokenIdentity,
  type ApiTokenScope,
} from "@/lib/tokens/service";

export const AGENT_MEDIA_UPLOAD_TICKET_TTL_SECONDS = 5 * 60;
export const AGENT_MEDIA_UPLOAD_AUTH_SCHEME = "NyxUpload";

type UploadTicketRow = {
  alt_text: string | null;
  consumed_at: string | null;
  credential_id: string;
  document_id: string | null;
  expected_byte_size: number | null;
  expected_mime_type: SupportedImageMimeType | null;
  expected_sha256: string | null;
  expires_at: string;
  id: string;
  original_filename: string;
  token_hash: string;
  workspace_agent_id: string;
  workspace_id: string;
};

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function secureHashMatches(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  return expectedBytes.length === actualBytes.length
    && timingSafeEqual(expectedBytes, actualBytes);
}

function normalizeFilename(value: string) {
  const normalized = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!normalized) {
    throw new MediaServiceError("INVALID_INPUT", "이미지 파일 이름이 필요합니다.");
  }
  return normalized.slice(0, 255);
}

function parseStringList<T extends string>(raw: string, allowed?: readonly T[]) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is T => (
      typeof value === "string" && (!allowed || allowed.includes(value as T))
    ));
  } catch {
    return [];
  }
}

function workspacePrincipal(identity: ApiTokenIdentity) {
  return {
    type: "agent" as const,
    workspaceId: identity.workspaceId,
    membershipId: identity.agentId,
    agentId: identity.globalAgentId,
    role: identity.role,
    displayName: identity.name,
    avatarMediaId: identity.avatarMediaId,
    permissionAllow: identity.permissionAllow,
    permissionDeny: identity.permissionDeny,
  };
}

function requireDocumentBoundary(
  database: NyxDatabase,
  identity: ApiTokenIdentity,
  documentId: string,
) {
  const document = database.prepare(
    "SELECT workspace_id, status FROM documents WHERE id = ?",
  ).get(documentId) as { workspace_id: string; status: string } | undefined;
  if (
    !document
    || document.status !== "active"
    || document.workspace_id !== identity.workspaceId
  ) {
    throw new MediaServiceError("NOT_FOUND", "이미지를 연결할 문서를 찾을 수 없습니다.");
  }
  requireTokenDocumentAccess(database, identity, documentId);
}

export function createAgentMediaUploadTicket(
  database: NyxDatabase,
  identity: ApiTokenIdentity,
  input: {
    alt?: string;
    byteSize?: number;
    documentId?: string;
    filename: string;
    mimeType?: SupportedImageMimeType;
    sha256?: string;
  },
  options: { now?: Date; ttlSeconds?: number } = {},
) {
  requireTokenScope(identity, "documents:write");
  if (!agentPrincipalAllows(workspacePrincipal(identity), "media.upload")) {
    throw new MediaServiceError("UNAUTHORIZED", "이 에이전트에는 이미지 업로드 권한이 없습니다.");
  }
  if (input.documentId) requireDocumentBoundary(database, identity, input.documentId);

  const filename = normalizeFilename(input.filename);
  if (
    input.byteSize !== undefined
    && (!Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_MEDIA_BYTES)
  ) {
    throw new MediaServiceError("INVALID_INPUT", "이미지 크기는 1바이트 이상 15MB 이하여야 합니다.");
  }
  if (
    input.mimeType !== undefined
    && !SUPPORTED_IMAGE_MIME_TYPES.includes(input.mimeType)
  ) {
    throw new MediaServiceError("UNSUPPORTED_TYPE", "PNG, JPEG, GIF, WebP 이미지만 업로드할 수 있습니다.");
  }
  const expectedSha256 = input.sha256?.trim().toLowerCase();
  if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new MediaServiceError("INVALID_INPUT", "SHA-256은 64자리 16진수여야 합니다.");
  }
  const alt = input.alt?.trim().slice(0, 1_000) || null;
  const now = options.now ?? new Date();
  const ttlSeconds = options.ttlSeconds ?? AGENT_MEDIA_UPLOAD_TICKET_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 15 * 60) {
    throw new MediaServiceError("INVALID_INPUT", "업로드 권한 유효 시간이 올바르지 않습니다.");
  }
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();
  const id = randomUUID();
  const secret = `nyx_upload_${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashSecret(secret);

  const staleBefore = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  database.prepare(
    `DELETE FROM agent_media_upload_tickets
     WHERE expires_at < ? AND (consumed_at IS NOT NULL OR created_at < ?)`,
  ).run(staleBefore, staleBefore);

  database.prepare(
    `INSERT INTO agent_media_upload_tickets
     (id, credential_id, workspace_agent_id, workspace_id, document_id,
      token_prefix, token_hash, original_filename, expected_mime_type,
      expected_byte_size, expected_sha256, alt_text, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    identity.id,
    identity.agentId,
    identity.workspaceId,
    input.documentId ?? null,
    secret.slice(0, 20),
    tokenHash,
    filename,
    input.mimeType ?? null,
    input.byteSize ?? null,
    expectedSha256 ?? null,
    alt,
    createdAt,
    expiresAt,
  );

  return {
    id,
    workspaceId: identity.workspaceId,
    documentId: input.documentId ?? null,
    method: "PUT" as const,
    path: `/api/media/agent-uploads/${id}`,
    authorization: `${AGENT_MEDIA_UPLOAD_AUTH_SCHEME} ${secret}`,
    expiresAt,
    expiresInSeconds: ttlSeconds,
    maxBytes: MAX_MEDIA_BYTES,
    singleUse: true,
  };
}

function readTicket(database: NyxDatabase, ticketId: string) {
  const row = database.prepare(
    `SELECT id, credential_id, workspace_agent_id, workspace_id, document_id,
            token_hash, original_filename, expected_mime_type,
            expected_byte_size, expected_sha256, alt_text, expires_at, consumed_at
     FROM agent_media_upload_tickets
     WHERE id = ?`,
  ).get(ticketId) as UploadTicketRow | undefined;
  if (!row) throw new MediaServiceError("NOT_FOUND", "업로드 권한을 찾을 수 없습니다.");
  return row;
}

function requireCurrentTicketAccess(database: NyxDatabase, ticket: UploadTicketRow, now: string) {
  const current = database.prepare(
    `SELECT credential.scopes_json, credential.created_by_user_id,
            credential.expires_at AS credential_expires_at,
            credential.revoked_at, agent.status AS agent_status,
            membership.status AS membership_status, membership.role,
            membership.permission_allow_json, membership.permission_deny_json,
            workspace.lifecycle_state,
            ownership.owner_type, ownership.owner_user_id,
            ownership.organization_id, agent_owner.owner_type AS agent_owner_type,
            agent_owner.owner_user_id AS agent_owner_user_id,
            agent_owner.organization_id AS agent_organization_id,
            organization.lifecycle_state AS organization_lifecycle_state,
            approval.id AS approval_id, organization_member.id AS organization_member_id
     FROM agent_credentials credential
     JOIN agents agent ON agent.id = credential.agent_id
     JOIN workspace_agents membership
       ON membership.id = ?
      AND membership.workspace_id = ?
      AND membership.agent_identity_id = credential.agent_id
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     JOIN agent_ownership agent_owner ON agent_owner.agent_id = credential.agent_id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN organization_agent_approvals approval
       ON approval.organization_id = ownership.organization_id
      AND approval.agent_id = credential.agent_id
      AND approval.revoked_at IS NULL
     LEFT JOIN organization_members organization_member
       ON organization_member.organization_id = ownership.organization_id
      AND organization_member.user_id = agent_owner.owner_user_id
     WHERE credential.id = ?`,
  ).get(ticket.workspace_agent_id, ticket.workspace_id, ticket.credential_id) as {
    agent_organization_id: string | null;
    agent_owner_type: "personal" | "organization";
    agent_owner_user_id: string | null;
    agent_status: string;
    approval_id: string | null;
    credential_expires_at: string | null;
    created_by_user_id: string;
    lifecycle_state: string;
    membership_status: string;
    organization_id: string | null;
    organization_lifecycle_state: string | null;
    organization_member_id: string | null;
    owner_type: "personal" | "organization";
    owner_user_id: string | null;
    permission_allow_json: string;
    permission_deny_json: string;
    revoked_at: string | null;
    role: AgentWorkspaceRole;
    scopes_json: string;
  } | undefined;

  const namespaceAllowed = current?.owner_type === "personal"
    ? current.agent_owner_type === "personal"
      && current.agent_owner_user_id === current.owner_user_id
    : current?.agent_owner_type === "organization"
      ? current.agent_organization_id === current.organization_id
      : Boolean(current?.approval_id && current.organization_member_id);
  if (
    !current
    || current.revoked_at
    || (current.credential_expires_at && current.credential_expires_at <= now)
    || current.agent_status !== "active"
    || current.membership_status !== "active"
    || current.lifecycle_state !== "active"
    || (current.owner_type === "organization" && current.organization_lifecycle_state !== "active")
    || !namespaceAllowed
  ) {
    throw new MediaServiceError("UNAUTHORIZED", "업로드 권한을 발급한 연결이 더 이상 유효하지 않습니다.");
  }

  const scopes = parseStringList<ApiTokenScope>(current.scopes_json);
  const permissionAllow = parseStringList<WorkspacePermission>(
    current.permission_allow_json,
    WORKSPACE_PERMISSIONS,
  );
  const permissionDeny = parseStringList<WorkspacePermission>(
    current.permission_deny_json,
    WORKSPACE_PERMISSIONS,
  );
  if (
    !scopes.includes("documents:write")
    || !agentPrincipalAllows({ role: current.role, permissionAllow, permissionDeny }, "documents.update")
    || !agentPrincipalAllows({ role: current.role, permissionAllow, permissionDeny }, "media.upload")
  ) {
    throw new MediaServiceError("UNAUTHORIZED", "이미지 업로드 권한이 더 이상 유효하지 않습니다.");
  }
  return current;
}

export async function consumeAgentMediaUploadTicket(
  database: NyxDatabase,
  input: {
    authorization: string | null;
    bytes: ArrayBuffer | Uint8Array;
    ticketId: string;
  },
  options: { mediaRoot?: string; now?: Date } = {},
) {
  if (!/^[0-9a-f-]{36}$/i.test(input.ticketId)) {
    throw new MediaServiceError("NOT_FOUND", "업로드 권한을 찾을 수 없습니다.");
  }
  const match = input.authorization?.match(/^NyxUpload\s+([^\s]+)$/i);
  if (!match || match[1].length > 200) {
    throw new MediaServiceError("NOT_FOUND", "업로드 권한을 찾을 수 없습니다.");
  }
  const ticket = readTicket(database, input.ticketId);
  if (!secureHashMatches(ticket.token_hash, hashSecret(match[1]))) {
    throw new MediaServiceError("NOT_FOUND", "업로드 권한을 찾을 수 없습니다.");
  }

  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  if (ticket.consumed_at) {
    throw new MediaServiceError("CONFLICT", "이미 사용된 일회용 업로드 권한입니다.");
  }
  if (ticket.expires_at <= nowIso) {
    throw new MediaServiceError("EXPIRED", "이미지 업로드 권한이 만료되었습니다.");
  }
  const currentAccess = requireCurrentTicketAccess(database, ticket, nowIso);
  if (ticket.document_id) {
    const document = database.prepare(
      "SELECT workspace_id, status FROM documents WHERE id = ?",
    ).get(ticket.document_id) as { workspace_id: string; status: string } | undefined;
    if (
      !document
      || document.workspace_id !== ticket.workspace_id
      || document.status !== "active"
    ) {
      throw new MediaServiceError("NOT_FOUND", "이미지를 연결할 문서를 찾을 수 없습니다.");
    }
  }

  const consumed = database.prepare(
    `UPDATE agent_media_upload_tickets
     SET consumed_at = ?
     WHERE id = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).run(nowIso, ticket.id, ticket.token_hash, nowIso);
  if (consumed.changes !== 1) {
    throw new MediaServiceError("CONFLICT", "이미 사용되었거나 만료된 업로드 권한입니다.");
  }

  const media = await storeMediaAsset(database, {
    bytes: input.bytes,
    originalFilename: ticket.original_filename,
    expectedByteSize: ticket.expected_byte_size ?? undefined,
    expectedMimeType: ticket.expected_mime_type ?? undefined,
    expectedSha256: ticket.expected_sha256 ?? undefined,
    tokenId: ticket.credential_id,
    userId: currentAccess.created_by_user_id,
    workspaceId: ticket.workspace_id,
  }, options.mediaRoot);
  if (ticket.document_id) {
    bindMediaAssetToDocument(database, {
      workspaceId: ticket.workspace_id,
      documentId: ticket.document_id,
      mediaId: media.id,
      createdAt: nowIso,
    });
  }
  database.prepare(
    "UPDATE agent_media_upload_tickets SET media_id = ? WHERE id = ?",
  ).run(media.id, ticket.id);

  return {
    media,
    documentId: ticket.document_id,
    imageBlock: {
      id: randomUUID(),
      type: "img" as const,
      mediaId: media.id,
      url: media.url,
      ...(ticket.alt_text ? { alt: ticket.alt_text } : {}),
      ...(media.originalFilename ? { name: media.originalFilename } : {}),
      children: [{ text: "" }],
    },
  };
}
