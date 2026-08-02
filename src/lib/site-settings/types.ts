export type EmailDomainPolicy = "restricted" | "any";
export type RegistrationMode = "invite" | "open";
export type SiteAdministratorRole = "owner" | "administrator";

export type SiteSettings = {
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
    passwordConfigured: boolean;
  };
  version: number;
  persisted: boolean;
  restartRequired: boolean;
  updatedAt: string | null;
};

export type SiteAuditEvent = {
  cursor: number;
  id: string;
  action: string;
  actorLabel: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SiteAdminView = {
  administratorRole: SiteAdministratorRole;
  settings: SiteSettings;
  runtime: {
    sourceRevision: string;
    environment: string;
    httpsEnabled: boolean;
    certificateManagement: "reverse-proxy";
    databaseConfigured: boolean;
    mediaStorageConfigured: boolean;
    backupStorageConfigured: boolean;
    collaborationPublicUrl: string;
  };
  counts: {
    users: number;
    activeWorkspaces: number;
    activeAgents: number;
    activeDocuments: number;
  };
  invites: SiteInviteSummary[];
  users: SiteUserSummary[];
  auditEvents: SiteAuditEvent[];
};

export type SiteInviteSummary = {
  id: string;
  email: string;
  tokenPrefix: string;
  createdByLabel: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  status: "active" | "used" | "expired" | "revoked";
};

export type SiteUserSummary = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  locale: "en" | "ko" | "ja" | null;
  siteRole: SiteAdministratorRole | null;
  createdAt: string;
};

export class SiteSettingsError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "FORBIDDEN"
      | "CONFLICT",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SiteSettingsError";
  }
}
