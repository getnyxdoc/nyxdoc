import { APIError, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { mcp } from "better-auth/plugins";
import { getAuthSecret, getTrustedOrigins } from "@/lib/config";
import { sqlite } from "@/lib/db/client";
import { sendPasswordResetMessage, sendVerificationMessage } from "@/lib/email";
import { normalizeEmail } from "@/lib/auth/domain";
import { ensurePersonalWorkspace } from "@/lib/workspaces/bootstrap";
import { detectLocale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/messages";
import { getUserLocalePreference } from "@/lib/i18n/preferences";
import {
  claimInitialSetup,
  consumeSiteInvitesForUser,
  emailAllowedBySitePolicy,
  ensureSiteAdministratorBootstrap,
  getSiteSettings,
  initialSetupRequired,
  markSiteSettingsLoadedAtRuntime,
  validateSiteInvite,
} from "@/lib/site-settings/service";
import {
  acceptOrganizationInvitation,
  validateOrganizationInvitation,
} from "@/lib/organizations/service";
import {
  MCP_OAUTH_DEFAULT_SCOPE,
  MCP_OAUTH_SCOPES,
} from "@/lib/mcp/oauth";

function reportBackgroundEmailFailure(kind: string, error: unknown) {
  console.error(`[nyxdoc] ${kind} email failed`, error instanceof Error ? error.message : "unknown error");
}

function authMessageLocale(userId: string, request?: Request) {
  return getUserLocalePreference(sqlite, userId)
    ?? detectLocale(request?.headers.get("accept-language"));
}

const runtimeSiteSettings = getSiteSettings(sqlite);
markSiteSettingsLoadedAtRuntime(runtimeSiteSettings);

export const auth = betterAuth({
  appName: "Nyxdoc",
  baseURL: runtimeSiteSettings.publicBaseUrl,
  secret: getAuthSecret(),
  database: sqlite,
  trustedOrigins: [...new Set([...getTrustedOrigins(), runtimeSiteSettings.publicBaseUrl])],
  user: {
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: runtimeSiteSettings.emailVerificationEnabled,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }, request) => {
      void sendPasswordResetMessage(
        user.email,
        url,
        authMessageLocale(user.id, request),
      ).catch((error) =>
        reportBackgroundEmailFailure("password reset", error),
      );
    },
  },
  emailVerification: {
    sendOnSignUp: runtimeSiteSettings.emailVerificationEnabled,
    sendOnSignIn: runtimeSiteSettings.emailVerificationEnabled,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }, request) => {
      void sendVerificationMessage(
        user.email,
        url,
        authMessageLocale(user.id, request),
      ).catch((error) =>
        reportBackgroundEmailFailure("verification", error),
      );
    },
    afterEmailVerification: async (user, request) => {
      ensurePersonalWorkspace(sqlite, {
        id: user.id,
        name: user.name,
        email: user.email,
      }, detectLocale(request?.headers.get("accept-language")));
      ensureSiteAdministratorBootstrap(sqlite, user);
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user, context) => {
          consumeSiteInvitesForUser(sqlite, user);
          const organizationInviteToken = context?.request?.headers
            .get("x-nyxdoc-invite-token")?.trim() ?? "";
          if (
            organizationInviteToken
            && validateOrganizationInvitation(sqlite, user.email, organizationInviteToken)
          ) {
            acceptOrganizationInvitation(sqlite, {
              token: organizationInviteToken,
              user: { id: user.id, name: user.name, email: user.email },
            });
          }
          if (runtimeSiteSettings.emailVerificationEnabled) return;
          ensurePersonalWorkspace(sqlite, {
            id: user.id,
            name: user.name,
            email: user.email,
          }, detectLocale(context?.request?.headers.get("accept-language")));
          ensureSiteAdministratorBootstrap(sqlite, user);
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (context.path !== "/sign-up/email") return;

      const email = typeof context.body?.email === "string" ? normalizeEmail(context.body.email) : "";
      const settings = getSiteSettings(sqlite);
      const inviteToken = context.request?.headers.get("x-nyxdoc-invite-token")?.trim() ?? "";
      const invite = inviteToken ? validateSiteInvite(sqlite, email, inviteToken) : null;
      const organizationInvite = inviteToken
        ? validateOrganizationInvitation(sqlite, email, inviteToken)
        : null;
      const firstOwnerSetup = initialSetupRequired(sqlite);
      const locale = detectLocale(context.request?.headers.get("accept-language"));
      if (firstOwnerSetup && !claimInitialSetup(sqlite, email)) {
        throw APIError.from("CONFLICT", {
          code: "SETUP_IN_PROGRESS",
          message: translate(locale, "auth.setupInProgress"),
        });
      }
      if (!firstOwnerSetup && settings.registrationMode !== "open" && !invite && !organizationInvite) {
        throw APIError.from("FORBIDDEN", {
          code: "REGISTRATION_CLOSED",
          message: translate(locale, "auth.registrationClosed"),
        });
      }
      if (!firstOwnerSetup && !invite && !organizationInvite && !emailAllowedBySitePolicy(sqlite, email)) {
        throw APIError.from("BAD_REQUEST", {
          code: "EMAIL_DOMAIN_NOT_ALLOWED",
          message: translate(locale, "auth.emailDomainNotAllowed"),
        });
      }

      context.body.email = email;
    }),
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-up/email": { window: 60 * 10, max: 5 },
      "/sign-in/email": { window: 60, max: 10 },
      "/request-password-reset": { window: 60 * 10, max: 5 },
    },
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
    cookiePrefix: "nyxdoc",
  },
  plugins: [
    mcp({
      loginPage: "/sign-in",
      resource: `${runtimeSiteSettings.publicBaseUrl.replace(/\/$/, "")}/mcp`,
      oidcConfig: {
        loginPage: "/sign-in",
        consentPage: "/oauth/authorize",
        allowDynamicClientRegistration: true,
        requirePKCE: true,
        allowPlainCodeChallengeMethod: false,
        storeClientSecret: "hashed",
        accessTokenExpiresIn: 60 * 60,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        scopes: [...MCP_OAUTH_SCOPES],
        defaultScope: MCP_OAUTH_DEFAULT_SCOPE,
        metadata: {
          scopes_supported: [...MCP_OAUTH_SCOPES],
        },
      },
    }),
    nextCookies(),
  ],
  telemetry: { enabled: false },
});
