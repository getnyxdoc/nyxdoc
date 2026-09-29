import { notFound } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { VerifyEmailForm } from "@/components/auth/verify-email-form";

export default async function AuthE2EPage({
  searchParams,
}: {
  searchParams: Promise<{ form?: string; blocked?: string; noMail?: string; invalid?: string; callbackURL?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const params = await searchParams;
  return <AuthShell eyebrow="AUTH TEST" title="인증 흐름 검증" description="실제 인증 폼을 합성 입력으로 검증합니다.">
    {params.form === "sign-up" ? <SignUpForm
      allowedEmailDomains={[]}
      domainRestricted={false}
      emailVerificationEnabled={true}
      initialEmail=""
      inviteToken=""
      registrationBlocked={params.blocked === "1"}
      setup={false}
      callbackURL={params.callbackURL}
    /> : params.form === "forgot" ? <ForgotPasswordForm mailAvailable={params.noMail !== "1"} />
      : params.form === "reset" ? <ResetPasswordForm token="synthetic-reset-token" invalid={params.invalid === "1"} />
        : params.form === "verify" ? <VerifyEmailForm email="auth-fixture@example.com" callbackURL={params.callbackURL} />
          : <SignInForm callbackURL={params.callbackURL ?? "/app?workspace=synthetic-workspace&document=synthetic-document"} />}
  </AuthShell>;
}
