import { randomUUID } from "node:crypto";
import {
  getHumanWorkspacePrincipal,
  humanWorkspaceRoleRank,
  recordWorkspaceAuditEvent,
  type HumanDocumentGrantRole,
  type HumanWorkspaceRole,
} from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import { getDocument } from "@/lib/documents/service";
import type { DocumentSummary } from "@/lib/documents/types";
import { DocumentServiceError } from "@/lib/documents/types";
import { syncDocumentMediaBindingsFromHistory } from "@/lib/media/bindings";
import {
  emailAllowedBySitePolicy,
  getSiteSettings,
} from "@/lib/site-settings/service";

export type DocumentHumanAccessEntry = {
  userId: string;
  name: string;
  email: string;
  role: HumanWorkspaceRole | HumanDocumentGrantRole;
  source: "workspace" | "document_grant";
  grantedAt: string | null;
};

export type DocumentShareCandidate = {
  userId: string;
  name: string;
  email: string;
};

type WorkspaceMemberRow = {
  user_id: string;
  name: string;
  email: string;
  membership_role: string;
  access_role: string | null;
};

function normalizeWorkspaceRole(row: WorkspaceMemberRow): HumanWorkspaceRole {
  if (row.membership_role === "owner") return "owner";
  if (row.access_role === "admin" || row.access_role === "editor" || row.access_role === "viewer") {
    return row.access_role;
  }
  return "editor";
}

function assertGrantRole(value: unknown): asserts value is HumanDocumentGrantRole {
  if (value !== "viewer" && value !== "editor") {
    throw new DocumentServiceError("INVALID_INPUT", "문서 권한은 뷰어 또는 편집자여야 합니다.");
  }
}

function assertShareRecipient(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  userId: string,
) {
  getDocument(database, workspaceId, documentId);
  const recipient = database.prepare(
    `SELECT id, name, email, emailVerified
     FROM user
     WHERE id = ?`,
  ).get(userId) as {
    id: string;
    name: string;
    email: string;
    emailVerified: number;
  } | undefined;
  if (!recipient || recipient.emailVerified !== 1) {
    throw new DocumentServiceError("NOT_FOUND", "공유할 인증 사용자를 찾을 수 없습니다.");
  }
  if (!emailAllowedBySitePolicy(database, recipient.email)) {
    throw new DocumentServiceError(
      "FORBIDDEN",
      "사이트의 가입 도메인 정책에서 허용된 사용자에게만 공유할 수 있습니다.",
    );
  }
  const ownership = database.prepare(
    `SELECT owner.owner_type, member.id AS organization_member_id
     FROM workspace_ownership owner
     LEFT JOIN organization_members member
       ON member.organization_id = owner.organization_id
      AND member.user_id = ?
     WHERE owner.workspace_id = ?`,
  ).get(userId, workspaceId) as {
    owner_type: "personal" | "organization";
    organization_member_id: string | null;
  } | undefined;
  if (ownership?.owner_type === "organization" && !ownership.organization_member_id) {
    throw new DocumentServiceError(
      "FORBIDDEN",
      "조직 워크스페이스 문서는 해당 조직의 멤버에게만 공유할 수 있습니다.",
    );
  }
  if (getHumanWorkspacePrincipal(database, workspaceId, userId)) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "이 사용자는 이미 워크스페이스 권한을 상속받고 있습니다.",
    );
  }
  return recipient;
}

function listInheritedWorkspaceAccess(
  database: NyxDatabase,
  workspaceId: string,
): DocumentHumanAccessEntry[] {
  const rows = database.prepare(
    `SELECT membership.user_id, recipient.name, recipient.email,
            membership.role AS membership_role, membership.access_role
     FROM workspace_members membership
     JOIN user recipient ON recipient.id = membership.user_id
     WHERE membership.workspace_id = ? AND recipient.emailVerified = 1
     UNION ALL
     SELECT team_member.user_id, recipient.name, recipient.email,
            'member' AS membership_role, team_grant.access_role
     FROM workspace_team_grants team_grant
     JOIN workspaces workspace ON workspace.id = team_grant.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     JOIN organizations organization ON organization.id = ownership.organization_id
     JOIN team_members team_member
       ON team_member.organization_id = team_grant.organization_id
      AND team_member.team_id = team_grant.team_id
     JOIN organization_members organization_member
       ON organization_member.organization_id = team_grant.organization_id
      AND organization_member.user_id = team_member.user_id
     JOIN user recipient ON recipient.id = team_member.user_id
     WHERE team_grant.workspace_id = ?
       AND ownership.owner_type = 'organization'
       AND ownership.organization_id = team_grant.organization_id
       AND workspace.lifecycle_state = 'active'
       AND organization.lifecycle_state = 'active'
       AND recipient.emailVerified = 1`,
  ).all(workspaceId, workspaceId) as WorkspaceMemberRow[];
  const highestByUser = new Map<string, DocumentHumanAccessEntry>();
  for (const row of rows) {
    const role = normalizeWorkspaceRole(row);
    const current = highestByUser.get(row.user_id);
    if (!current || humanWorkspaceRoleRank(role) > humanWorkspaceRoleRank(current.role as HumanWorkspaceRole)) {
      highestByUser.set(row.user_id, {
        userId: row.user_id,
        name: row.name,
        email: row.email,
        role,
        source: "workspace",
        grantedAt: null,
      });
    }
  }
  return [...highestByUser.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      || left.email.localeCompare(right.email, undefined, { sensitivity: "base" })
      || left.userId.localeCompare(right.userId));
}

export function listDocumentHumanAccess(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
): DocumentHumanAccessEntry[] {
  getDocument(database, workspaceId, documentId);
  const inherited = listInheritedWorkspaceAccess(database, workspaceId);
  const inheritedUserIds = new Set(inherited.map((entry) => entry.userId));
  const direct = (database.prepare(
    `SELECT grant_entry.user_id, recipient.name, recipient.email,
            grant_entry.role, grant_entry.created_at
     FROM document_human_grants grant_entry
     JOIN user recipient ON recipient.id = grant_entry.user_id
     WHERE grant_entry.workspace_id = ?
       AND grant_entry.document_id = ?
       AND recipient.emailVerified = 1
      ORDER BY LOWER(recipient.name), LOWER(recipient.email), recipient.id`,
  ).all(workspaceId, documentId) as Array<{
    user_id: string;
    name: string;
    email: string;
    role: HumanDocumentGrantRole;
    created_at: string;
  }>).filter((row) => !inheritedUserIds.has(row.user_id)).map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    source: "document_grant" as const,
    grantedAt: row.created_at,
  }));
  return [...inherited, ...direct];
}

export function listDocumentShareCandidates(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    documentId: string;
    currentUserId: string;
    query?: string;
    limit?: number;
  },
): DocumentShareCandidate[] {
  getDocument(database, input.workspaceId, input.documentId);
  const query = input.query?.trim().normalize("NFC").toLowerCase().slice(0, 120) ?? "";
  const limit = Math.min(30, Math.max(1, input.limit ?? 12));
  const siteSettings = getSiteSettings(database);
  const restrictedDomains = siteSettings.emailDomainPolicy === "restricted"
    ? siteSettings.allowedEmailDomains
    : [];
  const domainClause = restrictedDomains.length > 0
    ? `AND LOWER(SUBSTR(recipient.email, INSTR(recipient.email, '@') + 1))
         IN (${restrictedDomains.map(() => "?").join(", ")})`
    : "";
  return (database.prepare(
    `SELECT recipient.id, recipient.name, recipient.email
     FROM user recipient
     JOIN workspace_ownership ownership ON ownership.workspace_id = ?
     LEFT JOIN organization_members organization_member
       ON organization_member.organization_id = ownership.organization_id
      AND organization_member.user_id = recipient.id
     WHERE recipient.emailVerified = 1
       AND recipient.id <> ?
       AND (ownership.owner_type = 'personal' OR organization_member.id IS NOT NULL)
       ${domainClause}
       AND (? = ''
         OR INSTR(LOWER(recipient.name), ?) > 0
         OR INSTR(LOWER(recipient.email), ?) > 0)
       AND NOT EXISTS (
         SELECT 1 FROM workspace_members membership
         WHERE membership.workspace_id = ? AND membership.user_id = recipient.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM workspace_team_grants team_grant
         JOIN workspaces workspace ON workspace.id = team_grant.workspace_id
         JOIN workspace_ownership team_ownership ON team_ownership.workspace_id = workspace.id
         JOIN organizations organization ON organization.id = team_ownership.organization_id
         JOIN team_members team_member
           ON team_member.organization_id = team_grant.organization_id
          AND team_member.team_id = team_grant.team_id
         WHERE team_grant.workspace_id = ?
           AND team_member.user_id = recipient.id
           AND team_ownership.owner_type = 'organization'
           AND team_ownership.organization_id = team_grant.organization_id
           AND workspace.lifecycle_state = 'active'
           AND organization.lifecycle_state = 'active'
       )
       AND NOT EXISTS (
         SELECT 1 FROM document_human_grants grant_entry
         WHERE grant_entry.document_id = ? AND grant_entry.user_id = recipient.id
       )
     ORDER BY LOWER(recipient.name), LOWER(recipient.email), recipient.id
     LIMIT ?`,
  ).all(
    input.workspaceId,
    input.currentUserId,
    ...restrictedDomains,
    query,
    query,
    query,
    input.workspaceId,
    input.workspaceId,
    input.documentId,
    limit,
  ) as Array<{ id: string; name: string; email: string }>).map((row) => ({
    userId: row.id,
    name: row.name,
    email: row.email,
  }));
}

export function setDocumentHumanGrant(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    documentId: string;
    recipientUserId: string;
    role: HumanDocumentGrantRole;
    actorUserId: string;
    actorLabel: string;
  },
) {
  assertGrantRole(input.role);
  const recipient = assertShareRecipient(
    database,
    input.workspaceId,
    input.documentId,
    input.recipientUserId,
  );
  if (input.recipientUserId === input.actorUserId) {
    throw new DocumentServiceError("INVALID_INPUT", "자신에게 문서 권한을 추가할 필요가 없습니다.");
  }
  const existing = database.prepare(
    `SELECT id, role
     FROM document_human_grants
     WHERE document_id = ? AND user_id = ?`,
  ).get(input.documentId, input.recipientUserId) as {
    id: string;
    role: HumanDocumentGrantRole;
  } | undefined;
  const now = new Date().toISOString();

  database.transaction(() => {
    syncDocumentMediaBindingsFromHistory(
      database,
      input.workspaceId,
      input.documentId,
      now,
    );
    if (existing) {
      database.prepare(
        `UPDATE document_human_grants
         SET role = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.role, now, existing.id);
    } else {
      database.prepare(
        `INSERT INTO document_human_grants
         (id, workspace_id, document_id, user_id, role, created_by_user_id,
          created_by_label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.workspaceId,
        input.documentId,
        input.recipientUserId,
        input.role,
        input.actorUserId,
        input.actorLabel,
        now,
        now,
      );
    }
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: existing ? "document.human_grant.updated" : "document.human_grant.created",
      actorType: "human",
      actorUserId: input.actorUserId,
      actorLabel: input.actorLabel,
      targetType: "document",
      targetId: input.documentId,
      metadata: {
        recipientUserId: recipient.id,
        role: input.role,
        previousRole: existing?.role ?? null,
      },
      createdAt: now,
    });
  })();
  return listDocumentHumanAccess(database, input.workspaceId, input.documentId)
    .find((entry) => entry.userId === input.recipientUserId)!;
}

export function revokeDocumentHumanGrant(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    documentId: string;
    recipientUserId: string;
    actorUserId: string;
    actorLabel: string;
  },
) {
  getDocument(database, input.workspaceId, input.documentId);
  const existing = database.prepare(
    `SELECT id, role
     FROM document_human_grants
     WHERE workspace_id = ? AND document_id = ? AND user_id = ?`,
  ).get(
    input.workspaceId,
    input.documentId,
    input.recipientUserId,
  ) as { id: string; role: HumanDocumentGrantRole } | undefined;
  if (!existing) {
    throw new DocumentServiceError("NOT_FOUND", "이 문서의 직접 공유 권한을 찾을 수 없습니다.");
  }
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare("DELETE FROM document_human_grants WHERE id = ?").run(existing.id);
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: "document.human_grant.revoked",
      actorType: "human",
      actorUserId: input.actorUserId,
      actorLabel: input.actorLabel,
      targetType: "document",
      targetId: input.documentId,
      metadata: {
        recipientUserId: input.recipientUserId,
        previousRole: existing.role,
      },
      createdAt: now,
    });
  })();
}

export function listHumanGrantedDocuments(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
): DocumentSummary[] {
  return (database.prepare(
    `SELECT document.id, document.title, document.slug, document.status,
            document.parent_document_id, document.tree_order,
            document.current_revision_id, document.updated_at,
            document.document_type, document.workflow_status, document.tags_json,
            document.created_at, revision.revision_number
     FROM document_human_grants grant_entry
     JOIN documents document
       ON document.id = grant_entry.document_id
      AND document.workspace_id = grant_entry.workspace_id
     JOIN document_revisions revision ON revision.id = document.current_revision_id
     JOIN workspaces workspace ON workspace.id = document.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN organization_members organization_member
       ON organization_member.organization_id = ownership.organization_id
      AND organization_member.user_id = grant_entry.user_id
     WHERE grant_entry.workspace_id = ?
       AND grant_entry.user_id = ?
       AND workspace.lifecycle_state = 'active'
       AND (ownership.owner_type = 'personal'
         OR (organization.lifecycle_state = 'active' AND organization_member.id IS NOT NULL))
       AND document.status = 'active'
       AND document.lifecycle_state = 'active'
     ORDER BY document.tree_order, LOWER(document.title), document.id`,
  ).all(workspaceId, userId) as Array<{
    id: string;
    title: string;
    slug: string;
    status: "active" | "archived";
    parent_document_id: string | null;
    tree_order: number;
    current_revision_id: string;
    updated_at: string;
    document_type: string | null;
    workflow_status: "draft" | "review" | "final";
    tags_json: string;
    created_at: string;
    revision_number: number;
  }>).map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    parentDocumentId: row.parent_document_id,
    treeOrder: row.tree_order,
    revisionId: row.current_revision_id,
    revisionNumber: row.revision_number,
    documentType: row.document_type,
    workflowStatus: row.workflow_status,
    tags: (() => {
      try {
        const parsed = JSON.parse(row.tags_json) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((tag): tag is string => typeof tag === "string")
          : [];
      } catch {
        return [];
      }
    })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
