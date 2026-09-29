"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n/client";
import { AUTH_REQUEST_ERROR } from "./auth-request-error";
import styles from "./auth.module.css";

export function ForgotPasswordForm({ mailAvailable }: { mailAvailable: boolean }) {
  const { locale, t } = useI18n();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !mailAvailable) return;
    setPending(true);
    setError("");
    setMessage("");
    const email = String(new FormData(event.currentTarget).get("email") || "").trim().toLowerCase();
    try {
      const result = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
      if (result.error) { setError(t("auth.forgot.failed")); return; }
      setMessage(t("auth.forgot.sent"));
    } catch {
      setError(AUTH_REQUEST_ERROR[locale]);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.field}>
          <label htmlFor="email">{t("auth.forgot.email")}</label>
          <input id="email" name="email" type="email" autoComplete="email" required placeholder="name@example.com" disabled={!mailAvailable} />
        </div>
        {message && <div className={styles.success} role="status">{message}</div>}
        {error && <div className={styles.error} role="alert">{error}</div>}
        <button className={styles.submit} disabled={pending || !mailAvailable}>{pending ? t("auth.forgot.sending") : t("auth.forgot.send")}</button>
      </form>
      <p className={styles.footer}><Link href="/sign-in">{t("auth.backToSignIn")}</Link></p>
    </>
  );
}
