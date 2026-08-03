"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState, useSyncExternalStore } from "react";
import { ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import styles from "./auth.module.css";

const subscribeToHydration = () => () => undefined;

function useHydrated() {
  return useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
}

export function SignUpForm({
  allowedEmailDomains,
  domainRestricted,
  emailVerificationEnabled,
  initialEmail,
  inviteToken,
  registrationBlocked,
  setup,
  signInHref = "/sign-in",
}: {
  allowedEmailDomains: string[];
  domainRestricted: boolean;
  emailVerificationEnabled: boolean;
  initialEmail: string;
  inviteToken: string;
  registrationBlocked: boolean;
  setup: boolean;
  signInHref?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [error, setError] = useState("");
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") || "").trim().toLowerCase();
    const response = await fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(inviteToken ? { "x-nyxdoc-invite-token": inviteToken } : {}),
      },
      body: JSON.stringify({
        name: String(data.get("name") || "").trim(),
        email,
        password: String(data.get("password") || ""),
        callbackURL: "/app",
      }),
    });
    const result = await response.json().catch(() => ({})) as {
      code?: string;
      error?: { message?: string };
      message?: string;
    };
    setPending(false);
    if (!response.ok) {
      const errorMessage = result.code === "REGISTRATION_CLOSED"
        ? t("auth.registrationClosed")
        : result.code === "SETUP_IN_PROGRESS"
          ? t("auth.setupInProgress")
          : result.code === "EMAIL_DOMAIN_NOT_ALLOWED"
            ? t("auth.emailDomainNotAllowed")
            : t("auth.signUpError");
      setError(errorMessage);
      return;
    }
    router.push(emailVerificationEnabled
      ? `/verify-email?email=${encodeURIComponent(email)}`
      : "/app");
  }

  return (
    <>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.field}>
          <label htmlFor="name">{t("auth.name")}</label>
          <input id="name" name="name" autoComplete="name" required minLength={2} placeholder={t("auth.namePlaceholder")} />
        </div>
        <div className={styles.field}>
          <label htmlFor="email">{t("auth.companyEmail")}</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={initialEmail}
            readOnly={Boolean(initialEmail)}
            placeholder={domainRestricted && allowedEmailDomains[0]
              ? `name@${allowedEmailDomains[0]}`
              : "name@example.com"}
          />
          <span className={styles.hint}>
            {initialEmail
              ? t("auth.invitedEmailHint")
              : setup
                ? t("auth.ownerEmailHint")
                : domainRestricted
                  ? t("auth.allowedDomains", {
                    domains: allowedEmailDomains.map((domain) => `@${domain}`).join(", "),
                  })
                  : t("auth.emailHint")}
          </span>
        </div>
        <div className={styles.field}>
          <label htmlFor="password">{t("auth.password")}</label>
          <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} placeholder={t("auth.passwordHint")} />
        </div>
        {error && <div className={styles.error} role="alert">{error}</div>}
        {registrationBlocked && (
          <div className={styles.error} role="alert">
            {t("auth.registrationClosed")}
          </div>
        )}
        <button
          className={styles.submit}
          type="submit"
          disabled={!hydrated || pending || registrationBlocked}
        >
          {pending
            ? t("auth.preparingWorkspace")
            : setup
              ? t("auth.startSite")
              : t("auth.signUp")} <ArrowRight size={17} />
        </button>
      </form>
      <p className={styles.footer}>{t("auth.alreadyAccount")} <Link href={signInHref}>{t("auth.signIn")}</Link></p>
    </>
  );
}
