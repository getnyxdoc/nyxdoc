import path from "node:path";
import { getDiagnosticsEnabled } from "@/lib/diagnostics/config";

const LOCAL_AUTH_SECRET =
  "nyxdoc-local-development-secret-change-before-production";

export function getDatabasePath() {
  const configured = process.env.NYXDOC_DB_PATH?.trim();
  if (!configured) {
    return path.resolve(process.cwd(), "data", "nyxdoc-dev.db");
  }

  if (configured === ":memory:") {
    return configured;
  }

  return path.isAbsolute(configured)
    ? configured
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

export function getMediaRoot() {
  const configured = process.env.NYXDOC_MEDIA_ROOT?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  }

  const databasePath = getDatabasePath();
  return databasePath === ":memory:"
    ? path.resolve(process.cwd(), "data", "media")
    : path.join(path.dirname(databasePath), "media");
}

export function getBackupRoot() {
  const configured = process.env.NYXDOC_BACKUP_ROOT?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  }

  const databasePath = getDatabasePath();
  return databasePath === ":memory:"
    ? path.resolve(process.cwd(), "data", "backups")
    : path.join(path.dirname(databasePath), "backups");
}

export function getAuthBaseUrl() {
  return process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3100";
}

export function getAuthSecret() {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  return secret || LOCAL_AUTH_SECRET;
}

export function getCollaborationSecret() {
  return process.env.NYXDOC_COLLABORATION_SECRET?.trim() || getAuthSecret();
}

export function getCollaborationPort() {
  const configured = Number(process.env.NYXDOC_COLLABORATION_PORT || 3101);
  if (!Number.isInteger(configured) || configured < 1 || configured > 65_535) {
    throw new Error("NYXDOC_COLLABORATION_PORT must be a valid TCP port.");
  }
  return configured;
}

export function getCollaborationInternalUrl() {
  return process.env.NYXDOC_COLLABORATION_INTERNAL_URL?.trim() || "http://127.0.0.1:3101";
}

export function getCollaborationPublicUrl(requestUrl?: string) {
  const configured = process.env.NYXDOC_COLLABORATION_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV !== "production") return "ws://127.0.0.1:3101";
  if (requestUrl) {
    const url = new URL(requestUrl);
    return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/collaboration`;
  }
  const publicUrl = new URL(getAuthBaseUrl());
  return `${publicUrl.protocol === "https:" ? "wss:" : "ws:"}//${publicUrl.host}/collaboration`;
}

export function assertRuntimeConfiguration() {
  getDiagnosticsEnabled();
  if (process.env.NODE_ENV === "production" && !process.env.BETTER_AUTH_SECRET?.trim()) {
    throw new Error("BETTER_AUTH_SECRET is required in production.");
  }
  if (
    process.env.NODE_ENV === "production"
    && !process.env.NYXDOC_COLLABORATION_SECRET?.trim()
  ) {
    throw new Error("NYXDOC_COLLABORATION_SECRET is required in production.");
  }
}

export function getAllowedEmailDomain() {
  return getAllowedEmailDomains()[0] ?? "";
}

export function getAllowedEmailDomains() {
  const configured = process.env.ALLOWED_EMAIL_DOMAINS
    || process.env.ALLOWED_EMAIL_DOMAIN
    || "";
  return [...new Set(configured
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean))];
}

export function getEmailDomainPolicy() {
  return process.env.EMAIL_DOMAIN_POLICY?.trim().toLowerCase() === "restricted"
    ? "restricted" as const
    : "any" as const;
}

export function getEmailVerificationEnabled() {
  return process.env.EMAIL_VERIFICATION_ENABLED?.trim().toLowerCase() === "true";
}

export function getRegistrationMode() {
  return process.env.REGISTRATION_MODE?.trim().toLowerCase() === "open"
    ? "open" as const
    : "invite" as const;
}

export function getTrustedOrigins() {
  const origins = new Set([
    getAuthBaseUrl(),
    "http://localhost:3100",
  ]);

  for (const origin of (process.env.AUTH_TRUSTED_ORIGINS || "").split(",")) {
    if (origin.trim()) origins.add(origin.trim());
  }

  return [...origins];
}
