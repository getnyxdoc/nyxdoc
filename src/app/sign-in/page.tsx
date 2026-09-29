import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignInForm } from "@/components/auth/sign-in-form";
import { getServerI18n } from "@/lib/i18n/server";
import { normalizeAuthCallbackURL } from "@/components/auth/auth-navigation";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.signIn") };
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackURL?: string }>;
}) {
  const { t } = await getServerI18n();
  const callbackURL = normalizeAuthCallbackURL((await searchParams).callbackURL);
  return <AuthShell
    eyebrow={t("auth.signIn.eyebrow")}
    title={t("auth.signIn.title")}
    description={t("auth.signIn.description")}
  ><SignInForm callbackURL={callbackURL} /></AuthShell>;
}
