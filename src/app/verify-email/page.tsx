import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { VerifyEmailForm } from "@/components/auth/verify-email-form";
import { getServerI18n } from "@/lib/i18n/server";
import { normalizeAuthCallbackURL } from "@/components/auth/auth-navigation";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.verifyEmail") };
}

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ email?: string; callbackURL?: string }> }) {
  const { email = "", callbackURL } = await searchParams;
  const { t } = await getServerI18n();
  return <AuthShell
    eyebrow={t("auth.verify.eyebrow")}
    title={t("auth.verify.title")}
    description={t("auth.verify.description")}
  ><VerifyEmailForm email={email} callbackURL={normalizeAuthCallbackURL(callbackURL)} /></AuthShell>;
}
