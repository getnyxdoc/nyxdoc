import { randomUUID } from "node:crypto";
import {
  getHumanWorkspacePrincipal,
  recordWorkspaceAuditEvent,
  type HumanWorkspaceRole,
} from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import type { AppLocale } from "@/lib/i18n/locales";
import {
  ensurePersonalWorkspace,
  workspaceStarterContent,
} from "@/lib/workspaces/bootstrap";
import {
  recordOrganizationAuditEvent,
  requireOrganizationPermission,
} from "@/lib/organizations/service";

export type WorkspaceOwnerNamespace =
  | { type: "personal"; id: string; name: string; icon: null }
  | { type: "organization"; id: string; name: string; icon: string | null };

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  role: HumanWorkspaceRole;
  accessSource: "membership" | "team" | "document_grant";
  owner: WorkspaceOwnerNamespace;
  lifecycleState: "active";
  createdAt: string;
  updatedAt: string;
};

export type TrashedWorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  role: HumanWorkspaceRole;
  owner: WorkspaceOwnerNamespace;
  lifecycleState: "trashed";
  trashedAt: string;
  purgeAfter: string;
  trashedByLabel: string;
  createdAt: string;
  updatedAt: string;
};

export class WorkspaceServiceError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceServiceError";
  }
}

type WorkspaceUser = { id: string; name: string; email: string };

type WorkspaceOwnerRow = {
  owner_type: "personal" | "organization";
  owner_user_id: string | null;
  personal_owner_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  organization_icon: string | null;
};

function ownerFromRow(row: WorkspaceOwnerRow): WorkspaceOwnerNamespace {
  if (row.owner_type === "organization" && row.organization_id && row.organization_name) {
    return {
      type: "organization",
      id: row.organization_id,
      name: row.organization_name,
      icon: row.organization_icon,
    };
  }
  if (!row.owner_user_id) {
    throw new WorkspaceServiceError("CONFLICT", "워크스페이스 소유 네임스페이스가 올바르지 않습니다.");
  }
  return {
    type: "personal",
    id: row.owner_user_id,
    name: row.personal_owner_name ?? "Personal",
    icon: null,
  };
}

export function listUserMembershipWorkspaces(
  database: NyxDatabase,
  userId: string,
): WorkspaceSummary[] {
  const rows = database.prepare(
    `SELECT DISTINCT workspace.id, workspace.name, workspace.slug,
            workspace.created_at, workspace.updated_at,
            ownership.owner_type, ownership.owner_user_id,
            personal_owner.name AS personal_owner_name,
            ownership.organization_id, organization.name AS organization_name,
            organization.icon AS organization_icon
     FROM workspaces workspace
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     LEFT JOIN user personal_owner ON personal_owner.id = ownership.owner_user_id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     WHERE workspace.lifecycle_state = 'active'
       AND (ownership.owner_type = 'personal' OR organization.lifecycle_state = 'active')
       AND (
         EXISTS (
           SELECT 1 FROM workspace_members member
           WHERE member.workspace_id = workspace.id AND member.user_id = ?
         )
         OR EXISTS (
           SELECT 1
           FROM workspace_team_grants team_grant
           JOIN team_members team_member
             ON team_member.team_id = team_grant.team_id
            AND team_member.organization_id = team_grant.organization_id
           JOIN organization_members organization_member
             ON organization_member.organization_id = team_grant.organization_id
            AND organization_member.user_id = team_member.user_id
           WHERE team_grant.workspace_id = workspace.id
             AND team_member.user_id = ?
         )
       )
     ORDER BY workspace.updated_at DESC, workspace.id ASC`,
  ).all(userId, userId) as Array<{
    id: string;
    name: string;
    slug: string;
    created_at: string;
    updated_at: string;
  } & WorkspaceOwnerRow>;
  return rows.map((value) => {
    const principal = getHumanWorkspacePrincipal(database, value.id, userId);
    if (!principal) {
      throw new WorkspaceServiceError("CONFLICT", "워크스페이스 권한 계산에 실패했습니다.");
    }
    return {
      id: value.id,
      name: value.name,
      slug: value.slug,
      role: principal.role,
      accessSource: principal.accessSource,
      owner: ownerFromRow(value),
      lifecycleState: "active",
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    };
  });
}

export function listUserWorkspaces(database: NyxDatabase, userId: string): WorkspaceSummary[] {
  const memberships = listUserMembershipWorkspaces(database, userId);
  const membershipIds = new Set(memberships.map((workspace) => workspace.id));
  const shared = (database.prepare(
    `SELECT workspace.id, workspace.name, workspace.slug,
            CASE WHEN MAX(CASE WHEN grant_entry.role = 'editor' THEN 1 ELSE 0 END) = 1
              THEN 'editor' ELSE 'viewer' END AS access_role,
            workspace.created_at, workspace.updated_at,
            ownership.owner_type, ownership.owner_user_id,
            personal_owner.name AS personal_owner_name,
            ownership.organization_id, organization.name AS organization_name,
            organization.icon AS organization_icon,
            MAX(grant_entry.updated_at) AS granted_updated_at
     FROM document_human_grants grant_entry
     JOIN documents document
       ON document.id = grant_entry.document_id
      AND document.workspace_id = grant_entry.workspace_id
     JOIN workspaces workspace ON workspace.id = grant_entry.workspace_id
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     LEFT JOIN user personal_owner ON personal_owner.id = ownership.owner_user_id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN organization_members organization_member
       ON organization_member.organization_id = ownership.organization_id
      AND organization_member.user_id = grant_entry.user_id
     JOIN user recipient ON recipient.id = grant_entry.user_id
     WHERE grant_entry.user_id = ?
       AND recipient.emailVerified = 1
       AND workspace.lifecycle_state = 'active'
       AND (ownership.owner_type = 'personal'
         OR (organization.lifecycle_state = 'active' AND organization_member.id IS NOT NULL))
       AND document.status = 'active'
       AND document.lifecycle_state = 'active'
     GROUP BY workspace.id, workspace.name, workspace.slug,
              workspace.created_at, workspace.updated_at,
              ownership.owner_type, ownership.owner_user_id, personal_owner.name,
              ownership.organization_id, organization.name, organization.icon
     ORDER BY granted_updated_at DESC, workspace.id`,
  ).all(userId) as Array<{
    id: string;
    name: string;
    slug: string;
    access_role: "editor" | "viewer";
    created_at: string;
    updated_at: string;
    granted_updated_at: string;
  } & WorkspaceOwnerRow>).filter((row) => !membershipIds.has(row.id)).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.access_role,
    accessSource: "document_grant" as const,
    owner: ownerFromRow(row),
    lifecycleState: "active" as const,
    createdAt: row.created_at,
    updatedAt: row.granted_updated_at || row.updated_at,
  }));
  return [...memberships, ...shared];
}

export function listUserTrashedWorkspaces(
  database: NyxDatabase,
  userId: string,
): TrashedWorkspaceSummary[] {
  return database.prepare(
    `SELECT workspace.id, workspace.name, workspace.slug, workspace.trashed_at,
            workspace.purge_after, workspace.trashed_by_label,
            workspace.created_at, workspace.updated_at,
            ownership.owner_type, ownership.owner_user_id,
            personal_owner.name AS personal_owner_name,
            ownership.organization_id, organization.name AS organization_name,
            organization.icon AS organization_icon,
            CASE
              WHEN ownership.owner_type = 'personal' THEN 'owner'
              WHEN organization_member.role IN ('owner', 'admin') THEN 'admin'
              ELSE 'viewer'
            END AS access_role
     FROM workspaces workspace
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     LEFT JOIN user personal_owner ON personal_owner.id = ownership.owner_user_id
     LEFT JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN organization_members organization_member
       ON organization_member.organization_id = ownership.organization_id
      AND organization_member.user_id = ?
     WHERE workspace.lifecycle_state = 'trashed'
       AND (
         (ownership.owner_type = 'personal' AND ownership.owner_user_id = ?)
         OR
         (ownership.owner_type = 'organization' AND organization_member.role IN ('owner', 'admin'))
       )
     ORDER BY workspace.trashed_at DESC, workspace.id ASC`,
  ).all(userId, userId).map((row) => {
    const value = row as {
      id: string;
      name: string;
      slug: string;
      trashed_at: string;
      purge_after: string;
      trashed_by_label: string;
      created_at: string;
      updated_at: string;
      access_role: HumanWorkspaceRole;
    } & WorkspaceOwnerRow;
    return {
      id: value.id,
      name: value.name,
      slug: value.slug,
      role: value.access_role,
      owner: ownerFromRow(value),
      lifecycleState: "trashed",
      trashedAt: value.trashed_at,
      purgeAfter: value.purge_after,
      trashedByLabel: value.trashed_by_label,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    };
  });
}

export function resolveUserWorkspace(
  database: NyxDatabase,
  user: WorkspaceUser,
  options: {
    selector?: string;
    documentId?: string;
    fallbackOnMissingSelector?: boolean;
    membershipOnly?: boolean;
    locale?: AppLocale;
  } = {},
): WorkspaceSummary {
  ensurePersonalWorkspace(database, user, options.locale);
  const workspaces = options.membershipOnly
    ? listUserMembershipWorkspaces(database, user.id)
    : listUserWorkspaces(database, user.id);
  // Document IDs are stable links. Resolve them first so bookmarks continue to
  // work after an explicit, audited workspace transfer.
  if (options.documentId) {
    const row = database.prepare(
      `SELECT document.workspace_id
       FROM documents document
       JOIN workspaces workspace ON workspace.id = document.workspace_id
       WHERE document.id = ? AND workspace.lifecycle_state = 'active'`,
    ).get(options.documentId) as { workspace_id: string } | undefined;
    const selected = row && workspaces.find((workspace) => workspace.id === row.workspace_id);
    if (selected) return selected;
  }
  const selector = options.selector?.trim();
  if (selector) {
    const selected = workspaces.find((workspace) =>
      workspace.id === selector || workspace.slug === selector,
    );
    if (!selected && options.fallbackOnMissingSelector) {
      const fallback = workspaces[0];
      if (fallback) return fallback;
    }
    if (!selected) throw new WorkspaceServiceError("NOT_FOUND", "워크스페이스를 찾을 수 없습니다.");
    return selected;
  }
  const first = workspaces[0];
  if (!first) throw new WorkspaceServiceError("NOT_FOUND", "워크스페이스를 찾을 수 없습니다.");
  return first;
}

function workspaceSlug(database: NyxDatabase, name: string) {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "workspace";
  let slug = `${normalized}-${randomUUID().slice(0, 8)}`;
  while (database.prepare("SELECT 1 FROM workspaces WHERE slug = ?").get(slug)) {
    slug = `${normalized}-${randomUUID().slice(0, 8)}`;
  }
  return slug;
}

export function createWorkspace(
  database: NyxDatabase,
  user: WorkspaceUser,
  requestedName: string,
  locale: AppLocale = "en",
  options: { organizationId?: string | null } = {},
): WorkspaceSummary {
  const name = requestedName.trim().replace(/\s+/g, " ");
  if (!name || name.length > 120) {
    throw new WorkspaceServiceError("INVALID_INPUT", "워크스페이스 이름은 1자 이상 120자 이하여야 합니다.");
  }
  const id = randomUUID();
  const slug = workspaceSlug(database, name);
  const now = new Date().toISOString();
  const starter = workspaceStarterContent(locale);
  const organizationId = options.organizationId?.trim() || null;
  if (organizationId) {
    requireOrganizationPermission(
      database,
      organizationId,
      user.id,
      "workspaces.manage",
    );
  }
  database.transaction(() => {
    database.prepare(
      `INSERT INTO workspaces
       (id, name, slug, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, slug, user.id, now, now);
    database.prepare(
      `INSERT INTO workspace_members
       (id, workspace_id, user_id, role, access_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      id,
      user.id,
      organizationId ? "member" : "owner",
      organizationId ? "admin" : "owner",
      now,
    );
    database.prepare(
      `INSERT INTO workspace_ownership
       (workspace_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      organizationId ? "organization" : "personal",
      organizationId ? null : user.id,
      organizationId,
      now,
      now,
    );
    createDocument(database, id, {
      type: "human",
      userId: user.id,
      principalId: user.id,
      label: user.name,
      source: "web",
    }, {
      title: starter.document.title,
      content: {
        schemaVersion: 2,
        blocks: starter.document.blocks.map((block) => ({
          id: randomUUID(),
          type: block.type,
          ...(block.listStyleType
            ? { listStyleType: block.listStyleType, indent: 1 }
            : {}),
          children: [{ text: block.content }],
        })),
      },
      summary: starter.revisionSummary,
    });
    recordWorkspaceAuditEvent(database, {
      workspaceId: id,
      action: "workspace.created",
      actorType: "human",
      actorUserId: user.id,
      actorLabel: user.name,
      targetType: "workspace",
      targetId: id,
      metadata: { name, slug },
      createdAt: now,
    });
    if (organizationId) {
      recordOrganizationAuditEvent(database, {
        organizationId,
        action: "organization.workspace_created",
        actorUserId: user.id,
        actorLabel: user.name,
        targetType: "workspace",
        targetId: id,
        metadata: { name, slug, creatorWorkspaceRole: "admin" },
        createdAt: now,
      });
    }
  })();
  return {
    id,
    name,
    slug,
    role: organizationId ? "admin" : "owner",
    accessSource: "membership",
    owner: organizationId
      ? {
          type: "organization",
          id: organizationId,
          name: (database.prepare("SELECT name FROM organizations WHERE id = ?").get(
            organizationId,
          ) as { name: string }).name,
          icon: (database.prepare("SELECT icon FROM organizations WHERE id = ?").get(
            organizationId,
          ) as { icon: string | null }).icon,
        }
      : { type: "personal", id: user.id, name: user.name, icon: null },
    lifecycleState: "active",
    createdAt: now,
    updatedAt: now,
  };
}

type WorkspaceLifecycleRow = {
  id: string;
  name: string;
  slug: string;
  created_by_user_id: string;
  lifecycle_state: "active" | "trashed";
  trashed_at: string | null;
  purge_after: string | null;
  trash_retention_days: number;
  owner_type: "personal" | "organization";
  owner_user_id: string | null;
  organization_id: string | null;
};

function workspaceLifecycleRow(database: NyxDatabase, workspaceId: string) {
  return database.prepare(
    `SELECT workspace.id, workspace.name, workspace.slug, workspace.created_by_user_id,
            workspace.lifecycle_state, workspace.trashed_at, workspace.purge_after,
            workspace.trash_retention_days, ownership.owner_type,
            ownership.owner_user_id, ownership.organization_id
     FROM workspaces workspace
     JOIN workspace_ownership ownership ON ownership.workspace_id = workspace.id
     WHERE workspace.id = ?`,
  ).get(workspaceId) as WorkspaceLifecycleRow | undefined;
}

function requireWorkspaceOwner(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
) {
  const ownership = database.prepare(
    `SELECT owner_type, owner_user_id, organization_id
     FROM workspace_ownership WHERE workspace_id = ?`,
  ).get(workspaceId) as {
    owner_type: "personal" | "organization";
    owner_user_id: string | null;
    organization_id: string | null;
  } | undefined;
  if (!ownership) {
    throw new WorkspaceServiceError("NOT_FOUND", "워크스페이스를 찾을 수 없습니다.");
  }
  if (ownership.owner_type === "personal") {
    if (ownership.owner_user_id !== userId) {
      throw new WorkspaceServiceError("FORBIDDEN", "워크스페이스 소유자만 이 작업을 수행할 수 있습니다.");
    }
    return ownership;
  }
  if (!ownership.organization_id) {
    throw new WorkspaceServiceError("CONFLICT", "워크스페이스 조직 소유권이 올바르지 않습니다.");
  }
  requireOrganizationPermission(
    database,
    ownership.organization_id,
    userId,
    "workspaces.manage",
    { includeTrashed: true },
  );
  return ownership;
}

function assertConfirmationName(workspace: WorkspaceLifecycleRow, confirmationName: string) {
  if (confirmationName.trim() !== workspace.name) {
    throw new WorkspaceServiceError("INVALID_INPUT", "워크스페이스 이름을 정확히 입력해주세요.");
  }
}

export function validateWorkspaceTrash(
  database: NyxDatabase,
  input: { workspaceId: string; userId: string; confirmationName: string },
) {
  const workspace = workspaceLifecycleRow(database, input.workspaceId);
  if (!workspace || workspace.lifecycle_state !== "active") {
    throw new WorkspaceServiceError("NOT_FOUND", "활성 워크스페이스를 찾을 수 없습니다.");
  }
  const ownership = requireWorkspaceOwner(database, input.workspaceId, input.userId);
  assertConfirmationName(workspace, input.confirmationName);
  const activeWorkspaces = listUserMembershipWorkspaces(database, input.userId);
  const personalActiveCount = activeWorkspaces.filter(
    (item) => item.owner.type === "personal" && item.owner.id === input.userId,
  ).length;
  if (ownership.owner_type === "personal" && personalActiveCount <= 1) {
    throw new WorkspaceServiceError(
      "CONFLICT",
      "마지막 워크스페이스는 삭제할 수 없습니다. 먼저 다른 워크스페이스를 만들어주세요.",
    );
  }
  const nextWorkspace = activeWorkspaces.find((item) => item.id !== input.workspaceId);
  if (!nextWorkspace) {
    throw new WorkspaceServiceError("CONFLICT", "이동할 다른 워크스페이스를 찾을 수 없습니다.");
  }
  return { workspace, nextWorkspace };
}

export function trashWorkspace(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    userId: string;
    actorLabel: string;
    confirmationName: string;
  },
) {
  return database.transaction(() => {
    const { workspace, nextWorkspace } = validateWorkspaceTrash(database, input);
    const trashedAt = new Date().toISOString();
    const purgeAfter = new Date(
      Date.parse(trashedAt) + workspace.trash_retention_days * 24 * 60 * 60 * 1000,
    ).toISOString();
    recordWorkspaceAuditEvent(database, {
      workspaceId: workspace.id,
      action: "workspace.trashed",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "workspace",
      targetId: workspace.id,
      metadata: {
        name: workspace.name,
        purgeAfter,
        retained: [
          "documents",
          "revisions",
          "drafts",
          "media",
          "memberships",
          "agent_assignments",
          "saved_views",
          "audit",
        ],
      },
      createdAt: trashedAt,
    });
    const result = database.prepare(
      `UPDATE workspaces
       SET lifecycle_state = 'trashed', trashed_at = ?, purge_after = ?,
           trashed_by_user_id = ?, trashed_by_label = ?, updated_at = ?
       WHERE id = ? AND lifecycle_state = 'active'`,
    ).run(
      trashedAt,
      purgeAfter,
      input.userId,
      input.actorLabel,
      trashedAt,
      workspace.id,
    );
    if (result.changes !== 1) {
      throw new WorkspaceServiceError("CONFLICT", "워크스페이스 상태가 바뀌었습니다. 새로고침 후 다시 시도해주세요.");
    }
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        lifecycleState: "trashed" as const,
        trashedAt,
        purgeAfter,
      },
      nextWorkspaceId: nextWorkspace.id,
    };
  }).immediate();
}

export function restoreWorkspace(
  database: NyxDatabase,
  input: { workspaceId: string; userId: string; actorLabel: string },
) {
  return database.transaction(() => {
    const workspace = workspaceLifecycleRow(database, input.workspaceId);
    if (!workspace || workspace.lifecycle_state !== "trashed") {
      throw new WorkspaceServiceError("NOT_FOUND", "휴지통 워크스페이스를 찾을 수 없습니다.");
    }
    requireWorkspaceOwner(database, input.workspaceId, input.userId);
    const restoredAt = new Date().toISOString();
    const result = database.prepare(
      `UPDATE workspaces
       SET lifecycle_state = 'active', trashed_at = NULL, purge_after = NULL,
           trashed_by_user_id = NULL, trashed_by_label = NULL, updated_at = ?
       WHERE id = ? AND lifecycle_state = 'trashed'`,
    ).run(restoredAt, workspace.id);
    if (result.changes !== 1) {
      throw new WorkspaceServiceError("CONFLICT", "워크스페이스 상태가 바뀌었습니다. 새로고침 후 다시 시도해주세요.");
    }
    recordWorkspaceAuditEvent(database, {
      workspaceId: workspace.id,
      action: "workspace.restored",
      actorType: "human",
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { name: workspace.name, trashedAt: workspace.trashed_at },
      createdAt: restoredAt,
    });
    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      lifecycleState: "active" as const,
      restoredAt,
    };
  }).immediate();
}

export function validateWorkspacePurge(
  database: NyxDatabase,
  input: { workspaceId: string; userId: string; confirmationName: string },
) {
  const workspace = workspaceLifecycleRow(database, input.workspaceId);
  if (!workspace || workspace.lifecycle_state !== "trashed") {
    throw new WorkspaceServiceError("NOT_FOUND", "휴지통 워크스페이스를 찾을 수 없습니다.");
  }
  requireWorkspaceOwner(database, input.workspaceId, input.userId);
  assertConfirmationName(workspace, input.confirmationName);
  return workspace;
}

export function purgeWorkspace(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    userId: string;
    actorLabel: string;
    confirmationName: string;
    backupGenerationId: string;
  },
) {
  return database.transaction(() => {
    const workspace = validateWorkspacePurge(database, input);
    const counts = {
      documents: Number((database.prepare(
        "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
      ).get(workspace.id) as { count: number }).count),
      members: Number((database.prepare(
        "SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ?",
      ).get(workspace.id) as { count: number }).count),
      agentMemberships: Number((database.prepare(
        "SELECT COUNT(*) AS count FROM workspace_agents WHERE workspace_id = ?",
      ).get(workspace.id) as { count: number }).count),
      media: Number((database.prepare(
        "SELECT COUNT(*) AS count FROM media_assets WHERE workspace_id = ?",
      ).get(workspace.id) as { count: number }).count),
    };
    const mediaAssets = database.prepare(
      "SELECT id, storage_key FROM media_assets WHERE workspace_id = ? ORDER BY storage_key",
    ).all(workspace.id) as Array<{ id: string; storage_key: string }>;
    const mediaStorageKeys = mediaAssets.map((row) => row.storage_key);
    let clearedProfileAvatars = 0;
    const userHasImageColumn = (database.prepare(
      `PRAGMA table_info("user")`,
    ).all() as Array<{ name: string }>).some((column) => column.name === "image");
    if (userHasImageColumn) {
      const clearProfileAvatar = database.prepare(
        `UPDATE "user" SET image = NULL WHERE image = ?`,
      );
      for (const media of mediaAssets) {
        clearedProfileAvatars += clearProfileAvatar.run(`/api/media/${media.id}`).changes;
      }
    }
    const purgedAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO workspace_purge_tombstones
       (id, workspace_id, name_snapshot, slug_snapshot, created_by_user_id,
        document_count, member_count, agent_membership_count, media_count,
        backup_generation_id, trashed_at, purged_at, purged_by_user_id, purged_by_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      workspace.id,
      workspace.name,
      workspace.slug,
      workspace.created_by_user_id,
      counts.documents,
      counts.members,
      counts.agentMemberships,
      counts.media,
      input.backupGenerationId,
      workspace.trashed_at,
      purgedAt,
      input.userId,
      input.actorLabel,
    );

    const credentials = database.prepare(
      "SELECT id, workspace_allowlist_json FROM agent_credentials",
    ).all() as Array<{ id: string; workspace_allowlist_json: string }>;
    const updateAllowlist = database.prepare(
      "UPDATE agent_credentials SET workspace_allowlist_json = ?, updated_at = ? WHERE id = ?",
    );
    for (const credential of credentials) {
      let allowlist: string[] = [];
      try {
        const parsed = JSON.parse(credential.workspace_allowlist_json) as unknown;
        if (Array.isArray(parsed)) {
          allowlist = parsed.filter((item): item is string => typeof item === "string");
        }
      } catch {
        // Invalid legacy allowlists are normalized while removing the workspace.
      }
      const next = allowlist.filter((workspaceId) => workspaceId !== workspace.id);
      if (next.length !== allowlist.length) {
        updateAllowlist.run(JSON.stringify(next), purgedAt, credential.id);
      }
    }

    const deleted = database.prepare(
      "DELETE FROM workspaces WHERE id = ? AND lifecycle_state = 'trashed'",
    ).run(workspace.id);
    if (deleted.changes !== 1) {
      throw new WorkspaceServiceError("CONFLICT", "워크스페이스 상태가 바뀌었습니다. 새로고침 후 다시 시도해주세요.");
    }
    return {
      id: workspace.id,
      name: workspace.name,
      lifecycleState: "purged" as const,
      purgedAt,
      backupGenerationId: input.backupGenerationId,
      counts,
      clearedProfileAvatars,
      mediaStorageKeys,
    };
  }).immediate();
}
