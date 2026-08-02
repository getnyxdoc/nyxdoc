import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { sqlite } from "@/lib/db/client";
import { getServerI18n } from "@/lib/i18n/server";
import { getSiteSettings } from "@/lib/site-settings/service";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.forgotPassword") };
}

export default async function ForgotPasswordPage() {
  const { t } = await getServerI18n();
  const settings = getSiteSettings(sqlite);
  const mailAvailable = Boolean(
    settings.smtp.host && settings.smtp.user && settings.smtp.passwordConfigured,
  );
  return <AuthShell
    eyebrow={t("auth.forgot.eyebrow")}
    title={t("auth.forgot.title")}
    description={mailAvailable
      ? t("auth.forgot.description")
      : t("auth.forgot.noMail")}
  ><ForgotPasswordForm mailAvailable={mailAvailable} /></AuthShell>;
}
