import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NyxDatabase } from "@/lib/db/client";
import {
  getAllowedEmailDomains,
  getAuthBaseUrl,
  getCollaborationPublicUrl,
  getEmailDomainPolicy,
  getEmailVerificationEnabled,
  getRegistrationMode,
} from "@/lib/config";
import type {
  EmailDomainPolicy,
  RegistrationMode,
  SiteAdministratorRole,
  SiteAdminView,
  SiteAuditEvent,
  SiteInviteSummary,
  SiteSettings,
  SiteUserSummary,
} from "@/lib/site-settings/types";
import { SiteSettingsError } from "@/lib/site-settings/types";

type SiteSettingsRow = {
  public_base_url: string;
  registration_mode: RegistrationMode;
  email_verification_enabled: number;
  email_domain_policy: EmailDomainPolicy;
  allowed_email_domains_json: string;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: number;
  smtp_user: string | null;
  email_from: string | null;
  updated_at: string;
  version: number;
};

type SiteAuditRow = {
  cursor: number;
  id: string;
  action: string;
  actor_label: string;
  metadata_json: string;
  created_at: string;
};

const runtimeState = globalThis as typeof globalThis & {
  __nyxdocSiteSettingsVersion?: number;
};

function parseDomains(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseMetadata(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return { unreadable: true };
  }
}

function tableExists(database: NyxDatabase, table: string) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function columnExists(database: NyxDatabase, table: string, column: string) {
  return Boolean(database.prepare(
    `SELECT 1 FROM pragma_table_info(?) WHERE name = ?`,
  ).get(table, column));
}

function environmentSettings(): SiteSettings {
  const smtpUser = process.env.SMTP_USER?.trim() ?? "";
  return {
    publicBaseUrl: getAuthBaseUrl().replace(/\/$/, ""),
    registrationMode: getRegistrationMode(),
    emailVerificationEnabled: getEmailVerificationEnabled(),
    emailDomainPolicy: getEmailDomainPolicy(),
    allowedEmailDomains: getAllowedEmailDomains(),
    smtp: {
      host: process.env.SMTP_HOST?.trim() ?? "",
      port: Number(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      user: smtpUser,
      from: process.env.EMAIL_FROM?.trim() || (smtpUser ? `Nyxdoc <${smtpUser}>` : ""),
      passwordConfigured: Boolean(process.env.SMTP_PASSWORD),
    },
    version: 0,
    persisted: false,
    restartRequired: false,
    updatedAt: null,
  };
}

function rowSettings(row: SiteSettingsRow): SiteSettings {
  return {
    publicBaseUrl: row.public_base_url.replace(/\/$/, ""),
    registrationMode: row.registration_mode,
    emailVerificationEnabled: Boolean(row.email_verification_enabled),
    emailDomainPolicy: row.email_domain_policy,
    allowedEmailDomains: parseDomains(row.allowed_email_domains_json),
    smtp: {
      host: row.smtp_host ?? "",
      port: Number(row.smtp_port ?? 587),
      secure: Boolean(row.smtp_secure),
      user: row.smtp_user ?? "",
      from: row.email_from ?? "",
      passwordConfigured: Boolean(process.env.SMTP_PASSWORD),
    },
    version: Number(row.version),
    persisted: true,
    restartRequired: runtimeState.__nyxdocSiteSettingsVersion !== undefined
      && runtimeState.__nyxdocSiteSettingsVersion !== Number(row.version),
    updatedAt: row.updated_at,
  };
}

export function getSiteSettings(database: NyxDatabase) {
  if (!tableExists(database, "site_settings")) return environmentSettings();
  const registrationModeExpression = columnExists(
    database,
    "site_settings",
    "registration_mode",
  )
    ? "registration_mode"
    : "'invite' AS registration_mode";
  const row = database.prepare(
    `SELECT public_base_url, ${registrationModeExpression}, email_verification_enabled, email_domain_policy,
            allowed_email_domains_json, smtp_host, smtp_port, smtp_secure,
            smtp_user, email_from, updated_at, version
     FROM site_settings WHERE id = 1`,
  ).get() as SiteSettingsRow | undefined;
  const settings = row ? rowSettings(row) : environmentSettings();
  if (
    runtimeState.__nyxdocSiteSettingsVersion !== undefined
    && runtimeState.__nyxdocSiteSettingsVersion !== settings.version
  ) {
    settings.restartRequired = true;
  }
  return settings;
}

export function markSiteSettingsLoadedAtRuntime(settings: SiteSettings) {
  runtimeState.__nyxdocSiteSettingsVersion = settings.version;
}

export function ensureSiteAdministratorBootstrap(
  database: NyxDatabase,
  fallbackUser?: { id: string },
) {
  if (!tableExists(database, "site_administrators")) return;
  const configuredOwnerEmail = process.env.NYXDOC_SITE_OWNER_EMAIL?.trim().toLowerCase() ?? "";
  const configuredOwner = configuredOwnerEmail
    ? database.prepare(
        `SELECT id FROM user
         WHERE lower(email) = ?
         ORDER BY createdAt ASC, id ASC
         LIMIT 1`,
      ).get(configuredOwnerEmail) as { id: string } | undefined
    : undefined;
  if (configuredOwnerEmail && !configuredOwner) return;
  const firstRegisteredUser = configuredOwnerEmail
    ? configuredOwner
    : database.prepare(
        `SELECT id FROM user
         ORDER BY createdAt ASC, id ASC
         LIMIT 1`,
      ).get() as { id: string } | undefined;
  const targetOwner = firstRegisteredUser ?? fallbackUser;
  if (!targetOwner) return;

  const currentOwner = database.prepare(
    `SELECT user_id FROM site_administrators
     WHERE role = 'owner'
     LIMIT 1`,
  ).get() as { user_id: string } | undefined;
  if (currentOwner?.user_id === targetOwner.id) return;

  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(
      `UPDATE site_administrators
       SET role = 'administrator'
       WHERE role = 'owner' AND user_id <> ?`,
    ).run(targetOwner.id);
    database.prepare(
      `INSERT INTO site_administrators
       (user_id, granted_by_user_id, created_at, role)
       VALUES (?, ?, ?, 'owner')
       ON CONFLICT(user_id) DO UPDATE SET role = 'owner'`,
    ).run(targetOwner.id, targetOwner.id, now);
    if (currentOwner && tableExists(database, "site_audit_events")) {
      database.prepare(
        `INSERT INTO site_audit_events
         (id, action, actor_user_id, actor_label, metadata_json, created_at)
         VALUES (?, 'site.owner.reconciled', NULL, 'Nyxdoc', ?, ?)`,
      ).run(
        randomUUID(),
        JSON.stringify({
          previousOwnerUserId: currentOwner.user_id,
          ownerUserId: targetOwner.id,
          configuredOwner: Boolean(configuredOwnerEmail),
        }),
        now,
      );
    }
  })();
}

export function getSiteAdministratorRole(
  database: NyxDatabase,
  user: { id: string; email?: string },
): SiteAdministratorRole | null {
  const row = database.prepare(
    "SELECT role FROM site_administrators WHERE user_id = ?",
  ).get(user.id) as { role: SiteAdministratorRole } | undefined;
  if (row) return row.role;
  const configured = new Set(
    (process.env.NYXDOC_SITE_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  return user.email && configured.has(user.email.trim().toLowerCase())
    ? "administrator"
    : null;
}

export function isSiteAdministrator(
  database: NyxDatabase,
  user: { id: string; email?: string },
) {
  return getSiteAdministratorRole(database, user) !== null;
}

export function requireSiteAdministrator(
  database: NyxDatabase,
  user: { id: string; email?: string },
) {
  ensureSiteAdministratorBootstrap(database, user);
  const role = getSiteAdministratorRole(database, user);
  if (!role) {
    throw new SiteSettingsError("FORBIDDEN", "사이트 관리자만 이 설정을 볼 수 있습니다.");
  }
  return role;
}

export function emailAllowedBySitePolicy(database: NyxDatabase, email: string) {
  const settings = getSiteSettings(database);
  if (settings.emailDomainPolicy === "any") return true;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  const domain = at > 0 ? normalized.slice(at + 1) : "";
  return settings.allowedEmailDomains.includes(domain);
}

export function initialSetupRequired(database: NyxDatabase) {
  return Number((database.prepare("SELECT COUNT(*) AS count FROM user").get() as {
    count: number;
  }).count) === 0;
}

export function claimInitialSetup(database: NyxDatabase, email: string) {
  if (!tableExists(database, "site_setup_claims")) return initialSetupRequired(database);
  const normalizedEmail = email.trim().toLowerCase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  return database.transaction(() => {
    if (!initialSetupRequired(database)) return false;
    database.prepare(
      "DELETE FROM site_setup_claims WHERE expires_at <= ?",
    ).run(now.toISOString());
    const claim = database.prepare(
      "SELECT email FROM site_setup_claims WHERE id = 1",
    ).get() as { email: string } | undefined;
    if (claim && claim.email !== normalizedEmail) return false;
    database.prepare(
      `INSERT INTO site_setup_claims (id, email, expires_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         expires_at = excluded.expires_at`,
    ).run(normalizedEmail, expiresAt);
    return true;
  })();
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function siteInviteStatus(row: {
  used_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}): SiteInviteSummary["status"] {
  if (row.used_at) return "used";
  if (row.revoked_at) return "revoked";
  return Date.parse(row.expires_at) <= Date.now() ? "expired" : "active";
}

export function validateSiteInvite(
  database: NyxDatabase,
  email: string,
  token: string,
) {
  const invite = getActiveSiteInvite(database, token);
  return invite?.email === email.trim().toLowerCase() ? invite : null;
}

export function getActiveSiteInvite(
  database: NyxDatabase,
  token: string,
) {
  if (!token) return null;
  const row = database.prepare(
    `SELECT id, email, expires_at, used_at, revoked_at
     FROM site_invites
     WHERE token_hash = ?`,
  ).get(tokenHash(token)) as {
    id: string;
    email: string;
    expires_at: string;
    used_at: string | null;
    revoked_at: string | null;
  } | undefined;
  if (!row || row.used_at || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
    return null;
  }
  return { id: row.id, email: row.email };
}

export function consumeSiteInvitesForUser(
  database: NyxDatabase,
  user: { id: string; email: string },
) {
  const now = new Date().toISOString();
  if (tableExists(database, "site_invites")) {
    database.prepare(
      `UPDATE site_invites
       SET used_at = ?, used_by_user_id = ?
       WHERE email = ?
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > ?`,
    ).run(now, user.id, user.email.trim().toLowerCase(), now);
  }
  if (tableExists(database, "site_setup_claims")) {
    database.prepare(
      "DELETE FROM site_setup_claims WHERE email = ?",
    ).run(user.email.trim().toLowerCase());
  }
}

export function listSiteInvites(database: NyxDatabase): SiteInviteSummary[] {
  if (!tableExists(database, "site_invites")) return [];
  const rows = database.prepare(
    `SELECT id, email, token_prefix, created_by_label, created_at, expires_at,
            used_at, revoked_at
     FROM site_invites
     ORDER BY created_at DESC
     LIMIT 100`,
  ).all() as Array<{
    id: string;
    email: string;
    token_prefix: string;
    created_by_label: string;
    created_at: string;
    expires_at: string;
    used_at: string | null;
    revoked_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    tokenPrefix: row.token_prefix,
    createdByLabel: row.created_by_label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    status: siteInviteStatus(row),
  }));
}

export function createSiteInvite(
  database: NyxDatabase,
  actor: { id: string; name: string; email?: string },
  input: { email: string; expiresInHours?: number },
) {
  requireSiteAdministrator(database, actor);
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new SiteSettingsError("INVALID_INPUT", "올바른 이메일 주소를 입력해주세요.");
  }
  const existing = database.prepare(
    "SELECT 1 FROM user WHERE lower(email) = ? LIMIT 1",
  ).get(email);
  if (existing) {
    throw new SiteSettingsError("CONFLICT", "이미 가입한 이메일입니다.");
  }
  const hours = Math.max(1, Math.min(24 * 30, Math.trunc(input.expiresInHours ?? 24 * 7)));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
  const rawToken = `nyx_inv_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  database.transaction(() => {
    database.prepare(
      `UPDATE site_invites
       SET revoked_at = ?
       WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL`,
    ).run(now.toISOString(), email);
    database.prepare(
      `INSERT INTO site_invites
       (id, email, token_prefix, token_hash, created_by_user_id, created_by_label,
        created_at, expires_at, used_at, used_by_user_id, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(
      id,
      email,
      rawToken.slice(0, 16),
      tokenHash(rawToken),
      actor.id,
      actor.name,
      now.toISOString(),
      expiresAt.toISOString(),
    );
    database.prepare(
      `INSERT INTO site_audit_events
       (id, action, actor_user_id, actor_label, metadata_json, created_at)
       VALUES (?, 'site.invite.created', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      actor.id,
      actor.name,
      JSON.stringify({ inviteId: id, email, expiresAt: expiresAt.toISOString() }),
      now.toISOString(),
    );
  })();
  return {
    invite: listSiteInvites(database).find((invite) => invite.id === id)!,
    token: rawToken,
    url: `${getSiteSettings(database).publicBaseUrl}/sign-up?invite=${encodeURIComponent(rawToken)}`,
  };
}

export function revokeSiteInvite(
  database: NyxDatabase,
  actor: { id: string; name: string; email?: string },
  inviteId: string,
) {
  requireSiteAdministrator(database, actor);
  const now = new Date().toISOString();
  const result = database.prepare(
    `UPDATE site_invites SET revoked_at = ?
     WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
  ).run(now, inviteId);
  if (result.changes !== 1) {
    throw new SiteSettingsError("CONFLICT", "취소할 수 있는 초대가 아닙니다.");
  }
  database.prepare(
    `INSERT INTO site_audit_events
     (id, action, actor_user_id, actor_label, metadata_json, created_at)
     VALUES (?, 'site.invite.revoked', ?, ?, ?, ?)`,
  ).run(randomUUID(), actor.id, actor.name, JSON.stringify({ inviteId }), now);
}

export function listSiteUsers(database: NyxDatabase): SiteUserSummary[] {
  const hasLocale = database.prepare(
    `SELECT 1 FROM pragma_table_info('user') WHERE name = 'locale'`,
  ).get();
  const rows = database.prepare(
    `SELECT u.id, u.name, u.email, u.image,
            ${hasLocale ? "u.locale" : "NULL"} AS locale,
            u.createdAt AS created_at, a.role AS site_role
     FROM user u
     LEFT JOIN site_administrators a ON a.user_id = u.id
     ORDER BY u.createdAt ASC, u.id ASC`,
  ).all() as Array<{
    id: string;
    name: string;
    email: string;
    image: string | null;
    locale: "en" | "ko" | "ja" | null;
    created_at: string;
    site_role: SiteAdministratorRole | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    locale: row.locale,
    siteRole: row.site_role,
    createdAt: row.created_at,
  }));
}

export function createPasswordRecoveryLink(
  database: NyxDatabase,
  actor: { id: string; name: string; email?: string },
  userId: string,
) {
  const actorRole = requireSiteAdministrator(database, actor);
  if (actorRole !== "owner") {
    throw new SiteSettingsError("FORBIDDEN", "사이트 소유자만 복구 링크를 만들 수 있습니다.");
  }
  const user = database.prepare(
    "SELECT id FROM user WHERE id = ?",
  ).get(userId) as { id: string } | undefined;
  if (!user) throw new SiteSettingsError("INVALID_INPUT", "사용자를 찾을 수 없습니다.");
  const token = randomBytes(24).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
  database.transaction(() => {
    database.prepare(
      "DELETE FROM verification WHERE identifier LIKE 'reset-password:%' AND value = ?",
    ).run(user.id);
    database.prepare(
      `INSERT INTO verification
       (id, identifier, value, expiresAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomBytes(24).toString("base64url"),
      `reset-password:${token}`,
      user.id,
      expiresAt.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
    database.prepare(
      `INSERT INTO site_audit_events
       (id, action, actor_user_id, actor_label, metadata_json, created_at)
       VALUES (?, 'site.password_recovery.created', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      actor.id,
      actor.name,
      JSON.stringify({ userId: user.id, expiresAt: expiresAt.toISOString() }),
      now.toISOString(),
    );
  })();
  return {
    expiresAt: expiresAt.toISOString(),
    url: `${getSiteSettings(database).publicBaseUrl}/reset-password?token=${encodeURIComponent(token)}`,
  };
}

export function updateSiteSettings(
  database: NyxDatabase,
  actor: { id: string; name: string; email?: string },
  input: {
    expectedVersion: number;
    publicBaseUrl: string;
    registrationMode: RegistrationMode;
    emailVerificationEnabled: boolean;
    emailDomainPolicy: EmailDomainPolicy;
    allowedEmailDomains: string[];
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user: string;
      from: string;
    };
  },
) {
  requireSiteAdministrator(database, actor);
  const current = getSiteSettings(database);
  if (current.version !== input.expectedVersion) {
    throw new SiteSettingsError(
      "CONFLICT",
      "사이트 설정이 먼저 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도해주세요.",
      { expectedVersion: input.expectedVersion, currentVersion: current.version },
    );
  }
  const now = new Date().toISOString();
  const domains = [...new Set(input.allowedEmailDomains.map((domain) =>
    domain.trim().toLowerCase()).filter(Boolean))];
  database.transaction(() => {
    database.prepare(
      `INSERT INTO site_settings
       (id, public_base_url, registration_mode, email_verification_enabled, email_domain_policy,
        allowed_email_domains_json, smtp_host, smtp_port, smtp_secure,
        smtp_user, email_from, updated_by_user_id, updated_at, version)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         public_base_url = excluded.public_base_url,
         registration_mode = excluded.registration_mode,
         email_verification_enabled = excluded.email_verification_enabled,
         email_domain_policy = excluded.email_domain_policy,
         allowed_email_domains_json = excluded.allowed_email_domains_json,
         smtp_host = excluded.smtp_host,
         smtp_port = excluded.smtp_port,
         smtp_secure = excluded.smtp_secure,
         smtp_user = excluded.smtp_user,
         email_from = excluded.email_from,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at,
         version = site_settings.version + 1
       WHERE site_settings.version = ?`,
    ).run(
      input.publicBaseUrl.replace(/\/$/, ""),
      input.registrationMode,
      input.emailVerificationEnabled ? 1 : 0,
      input.emailDomainPolicy,
      JSON.stringify(domains),
      input.smtp.host.trim() || null,
      input.smtp.port,
      input.smtp.secure ? 1 : 0,
      input.smtp.user.trim() || null,
      input.smtp.from.trim() || null,
      actor.id,
      now,
      input.expectedVersion,
    );
    const next = database.prepare("SELECT version FROM site_settings WHERE id = 1")
      .get() as { version: number };
    const expectedNextVersion = input.expectedVersion === 0 ? 1 : input.expectedVersion + 1;
    if (Number(next.version) !== expectedNextVersion) {
      throw new SiteSettingsError("CONFLICT", "사이트 설정을 저장하는 동안 충돌이 발생했습니다.");
    }
    database.prepare(
      `INSERT INTO site_audit_events
       (id, action, actor_user_id, actor_label, metadata_json, created_at)
       VALUES (?, 'site.settings.updated', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      actor.id,
      actor.name,
      JSON.stringify({
        publicBaseUrl: input.publicBaseUrl.replace(/\/$/, ""),
        registrationMode: input.registrationMode,
        emailVerificationEnabled: input.emailVerificationEnabled,
        emailDomainPolicy: input.emailDomainPolicy,
        allowedEmailDomains: domains,
        smtpConfigured: Boolean(input.smtp.host && input.smtp.user),
        smtpSecure: input.smtp.secure,
      }),
      now,
    );
  })();
  return getSiteSettings(database);
}

export function listSiteAuditEvents(database: NyxDatabase, limit = 40): SiteAuditEvent[] {
  const rows = database.prepare(
    `SELECT cursor, id, action, actor_label, metadata_json, created_at
     FROM site_audit_events
     ORDER BY cursor DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(200, Math.trunc(limit)))) as SiteAuditRow[];
  return rows.map((row) => ({
    cursor: Number(row.cursor),
    id: row.id,
    action: row.action,
    actorLabel: row.actor_label,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  }));
}

function count(database: NyxDatabase, sql: string) {
  return Number((database.prepare(sql).get() as { count: number }).count);
}

export function loadSiteAdminView(
  database: NyxDatabase,
  user: { id: string; name: string; email: string },
): SiteAdminView {
  const administratorRole = requireSiteAdministrator(database, user);
  const settings = getSiteSettings(database);
  return {
    administratorRole,
    settings,
    runtime: {
      sourceRevision: process.env.NYXDOC_SOURCE_REVISION?.trim() || "unknown",
      environment: process.env.NODE_ENV || "development",
      httpsEnabled: new URL(settings.publicBaseUrl).protocol === "https:",
      certificateManagement: "reverse-proxy",
      databaseConfigured: Boolean(process.env.NYXDOC_DB_PATH),
      mediaStorageConfigured: Boolean(process.env.NYXDOC_MEDIA_ROOT),
      backupStorageConfigured: Boolean(process.env.NYXDOC_BACKUP_ROOT),
      collaborationPublicUrl: getCollaborationPublicUrl(),
    },
    counts: {
      users: count(database, `SELECT COUNT(*) AS count FROM user`),
      activeWorkspaces: count(database, `SELECT COUNT(*) AS count FROM workspaces WHERE lifecycle_state = 'active'`),
      activeAgents: count(database, `SELECT COUNT(*) AS count FROM agents WHERE status = 'active' AND deleted_at IS NULL AND purged_at IS NULL`),
      activeDocuments: count(database, `SELECT COUNT(*) AS count FROM documents WHERE lifecycle_state = 'active'`),
    },
    invites: listSiteInvites(database),
    users: listSiteUsers(database),
    auditEvents: listSiteAuditEvents(database),
  };
}
