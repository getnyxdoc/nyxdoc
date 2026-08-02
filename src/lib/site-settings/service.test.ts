import { afterEach, describe, expect, it, vi } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import {
  claimInitialSetup,
  consumeSiteInvitesForUser,
  createPasswordRecoveryLink,
  createSiteInvite,
  emailAllowedBySitePolicy,
  ensureSiteAdministratorBootstrap,
  getSiteAdministratorRole,
  getSiteSettings,
  isSiteAdministrator,
  initialSetupRequired,
  listSiteAuditEvents,
  listSiteInvites,
  loadSiteAdminView,
  revokeSiteInvite,
  updateSiteSettings,
  validateSiteInvite,
} from "@/lib/site-settings/service";
import { SiteSettingsError } from "@/lib/site-settings/types";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  vi.unstubAllEnvs();
});

describe("site settings service", () => {
  it("opens only the first-owner setup when no account exists", () => {
    const database = createTestDatabase();
    databases.push(database);
    expect(initialSetupRequired(database)).toBe(true);
    expect(claimInitialSetup(database, "owner@example.com")).toBe(true);
    expect(claimInitialSetup(database, "other@example.com")).toBe(false);
    expect(claimInitialSetup(database, "owner@example.com")).toBe(true);
    createTestUser(database, { name: "First owner" });
    expect(initialSetupRequired(database)).toBe(false);
  });

  it("makes the first registered user the site owner even when a later user triggers bootstrap", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = createTestUser(database, { name: "First owner", createdAt: 100 });
    const second = createTestUser(database, { name: "Second owner", createdAt: 200 });

    ensureSiteAdministratorBootstrap(database, second.user);

    expect(isSiteAdministrator(database, first.user)).toBe(true);
    expect(isSiteAdministrator(database, second.user)).toBe(false);
    expect(database.prepare(
      "SELECT user_id, role FROM site_administrators ORDER BY created_at, user_id",
    ).all()).toEqual([{ user_id: first.user.id, role: "owner" }]);
  });

  it("uses an explicit owner override and retains the previous owner as an administrator", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = createTestUser(database, {
      name: "Bootstrap administrator",
      email: "bootstrap@example.com",
      createdAt: 100,
    });
    const intendedOwner = createTestUser(database, {
      name: "Intended owner",
      email: "owner@example.com",
      createdAt: 200,
    });
    ensureSiteAdministratorBootstrap(database, first.user);
    vi.stubEnv("NYXDOC_SITE_OWNER_EMAIL", intendedOwner.user.email);

    ensureSiteAdministratorBootstrap(database, intendedOwner.user);

    expect(getSiteAdministratorRole(database, intendedOwner.user)).toBe("owner");
    expect(getSiteAdministratorRole(database, first.user)).toBe("administrator");
    expect(database.prepare(
      "SELECT user_id, role FROM site_administrators ORDER BY role, user_id",
    ).all()).toEqual(expect.arrayContaining([
      { user_id: intendedOwner.user.id, role: "owner" },
      { user_id: first.user.id, role: "administrator" },
    ]));
    expect(listSiteAuditEvents(database)[0]).toMatchObject({
      action: "site.owner.reconciled",
      actorLabel: "Nyxdoc",
    });
  });

  it("persists non-secret settings, enforces versions, and records an audit event", () => {
    vi.stubEnv("SMTP_PASSWORD", "kept-outside-the-database");
    const database = createTestDatabase();
    databases.push(database);
    const { user } = createTestUser(database, { name: "Site owner" });
    ensureSiteAdministratorBootstrap(database, user);

    const initial = getSiteSettings(database);
    expect(initial).toMatchObject({ persisted: false, version: 0 });

    const updated = updateSiteSettings(database, user, {
      expectedVersion: 0,
      publicBaseUrl: "https://docs.example.com/",
      registrationMode: "invite",
      emailVerificationEnabled: true,
      emailDomainPolicy: "restricted",
      allowedEmailDomains: ["Example.com", "studio.example.com"],
      smtp: {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        user: "mailer@example.com",
        from: "Nyxdoc <mailer@example.com>",
      },
    });

    expect(updated).toMatchObject({
      publicBaseUrl: "https://docs.example.com",
      registrationMode: "invite",
      emailDomainPolicy: "restricted",
      allowedEmailDomains: ["example.com", "studio.example.com"],
      persisted: true,
      version: 1,
      smtp: {
        host: "smtp.example.com",
        passwordConfigured: true,
      },
    });
    expect(emailAllowedBySitePolicy(database, "person@studio.example.com")).toBe(true);
    expect(emailAllowedBySitePolicy(database, "person@outside.example")).toBe(false);
    expect(JSON.stringify(database.prepare(
      "SELECT * FROM site_settings WHERE id = 1",
    ).get())).not.toContain("kept-outside-the-database");
    expect(listSiteAuditEvents(database)).toMatchObject([{
      action: "site.settings.updated",
      actorLabel: "Site owner",
    }]);
    expect(loadSiteAdminView(database, user)).toMatchObject({
      administratorRole: "owner",
      counts: { users: 1 },
    });

    expect(() => updateSiteSettings(database, user, {
      expectedVersion: 0,
      publicBaseUrl: "https://stale.example.com",
      registrationMode: "open",
      emailVerificationEnabled: true,
      emailDomainPolicy: "any",
      allowedEmailDomains: [],
      smtp: {
        host: "",
        port: 587,
        secure: false,
        user: "",
        from: "",
      },
    })).toThrowError(SiteSettingsError);
  });

  it("rejects site-wide access from an ordinary user", () => {
    const database = createTestDatabase();
    databases.push(database);
    const administrator = createTestUser(database, { name: "Administrator" });
    const ordinary = createTestUser(database, { name: "Ordinary user" });
    ensureSiteAdministratorBootstrap(database, administrator.user);

    expect(() => loadSiteAdminView(database, ordinary.user)).toThrowError(
      /사이트 관리자/,
    );
  });

  it("creates one-time email-bound invitations and consumes them after sign-up", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user: owner } = createTestUser(database, { name: "Owner" });
    ensureSiteAdministratorBootstrap(database, owner);

    const created = createSiteInvite(database, owner, {
      email: "Invited@Example.com",
      expiresInHours: 24,
    });
    expect(created.token).toMatch(/^nyx_inv_/);
    expect(created.url).not.toContain(created.invite.id);
    expect(validateSiteInvite(database, "invited@example.com", created.token)).toMatchObject({
      id: created.invite.id,
    });
    expect(validateSiteInvite(database, "other@example.com", created.token)).toBeNull();

    const { user: invited } = createTestUser(database, {
      email: "invited@example.com",
      name: "Invited",
    });
    consumeSiteInvitesForUser(database, invited);
    expect(validateSiteInvite(database, invited.email, created.token)).toBeNull();
    expect(listSiteInvites(database)[0]).toMatchObject({ status: "used" });
  });

  it("revokes active invitations and lets only the site owner create recovery links", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user: owner } = createTestUser(database, { name: "Owner" });
    ensureSiteAdministratorBootstrap(database, owner);
    const { user: administrator } = createTestUser(database, { name: "Administrator" });
    database.prepare(
      `INSERT INTO site_administrators
       (user_id, granted_by_user_id, created_at, role)
       VALUES (?, ?, ?, 'administrator')`,
    ).run(administrator.id, owner.id, new Date().toISOString());

    const invitation = createSiteInvite(database, owner, {
      email: "invite@example.com",
    });
    revokeSiteInvite(database, owner, invitation.invite.id);
    expect(validateSiteInvite(database, "invite@example.com", invitation.token)).toBeNull();
    expect(listSiteInvites(database)[0]).toMatchObject({ status: "revoked" });

    expect(() => createPasswordRecoveryLink(
      database,
      administrator,
      owner.id,
    )).toThrowError(/사이트 소유자/);
    const recovery = createPasswordRecoveryLink(database, owner, owner.id);
    expect(recovery.url).toContain("/reset-password?token=");
    expect(database.prepare(
      "SELECT value FROM verification WHERE identifier LIKE 'reset-password:%'",
    ).get()).toEqual({ value: owner.id });
  });
});
