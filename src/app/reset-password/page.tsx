import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { getServerI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.resetPassword") };
}

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token = "", error } = await searchParams;
  const { t } = await getServerI18n();
  return <AuthShell
    eyebrow={t("auth.reset.eyebrow")}
    title={t("auth.reset.title")}
    description={t("auth.reset.description")}
  ><ResetPasswordForm token={token} invalid={Boolean(error)} /></AuthShell>;
}
