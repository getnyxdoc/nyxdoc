import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { sqlite } from "@/lib/db/client";
import {
  getActiveSiteInvite,
  getSiteSettings,
  initialSetupRequired,
} from "@/lib/site-settings/service";
import { getActiveOrganizationInvitation } from "@/lib/organizations/service";
import { getServerI18n } from "@/lib/i18n/server";
import { buildAuthPageHref, normalizeAuthCallbackURL } from "@/components/auth/auth-navigation";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.signUp") };
}
export const dynamic = "force-dynamic";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; callbackURL?: string }>;
}) {
  const { invite = "", callbackURL } = await searchParams;
  const destination = normalizeAuthCallbackURL(callbackURL);
  const { t } = await getServerI18n();
  const settings = getSiteSettings(sqlite);
  const setup = initialSetupRequired(sqlite);
  const activeSiteInvite = getActiveSiteInvite(sqlite, invite);
  const activeOrganizationInvite = getActiveOrganizationInvitation(sqlite, invite);
  const activeInvite = activeSiteInvite ?? activeOrganizationInvite;
  const registrationBlocked = !setup
    && settings.registrationMode === "invite"
    && !activeInvite;
  return (
    <AuthShell
      eyebrow={setup
        ? t("auth.signUp.setupEyebrow")
        : activeInvite
          ? t("auth.signUp.inviteEyebrow")
          : t("auth.signUp.defaultEyebrow")}
      title={setup
        ? t("auth.signUp.setupTitle")
        : activeInvite
          ? t("auth.signUp.inviteTitle")
          : t("auth.signUp.defaultTitle")}
      description={registrationBlocked
        ? t("auth.signUp.closedDescription")
        : settings.emailVerificationEnabled
          ? t("auth.signUp.verifiedDescription")
          : t("auth.signUp.directDescription")}
    >
      <SignUpForm
        allowedEmailDomains={settings.allowedEmailDomains}
        domainRestricted={settings.emailDomainPolicy === "restricted"}
        emailVerificationEnabled={settings.emailVerificationEnabled}
        initialEmail={activeInvite?.email ?? ""}
        inviteToken={activeInvite ? invite : ""}
        registrationBlocked={registrationBlocked}
        setup={setup}
        callbackURL={destination}
        signInHref={activeOrganizationInvite
          ? buildAuthPageHref("/sign-in", { callbackURL: `/organization-invite?invite=${encodeURIComponent(invite)}` })
          : buildAuthPageHref("/sign-in", { callbackURL: destination })}
      />
    </AuthShell>
  );
}
