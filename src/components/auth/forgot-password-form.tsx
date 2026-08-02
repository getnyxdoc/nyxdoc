"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n/client";
import styles from "./auth.module.css";

export function ForgotPasswordForm({ mailAvailable }: { mailAvailable: boolean }) {
  const { t } = useI18n();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setMessage("");
    const email = String(new FormData(event.currentTarget).get("email") || "").trim().toLowerCase();
    const result = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setPending(false);
    if (result.error) { setError(t("auth.forgot.failed")); return; }
    setMessage(t("auth.forgot.sent"));
  }

  return (
    <>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.field}>
          <label htmlFor="email">{t("auth.forgot.email")}</label>
          <input id="email" name="email" type="email" autoComplete="email" required placeholder="name@example.com" disabled={!mailAvailable} />
        </div>
        {message && <div className={styles.success}>{message}</div>}
        {error && <div className={styles.error} role="alert">{error}</div>}
        <button className={styles.submit} disabled={pending || !mailAvailable}>{pending ? t("auth.forgot.sending") : t("auth.forgot.send")}</button>
      </form>
      <p className={styles.footer}><Link href="/sign-in">{t("auth.backToSignIn")}</Link></p>
    </>
  );
}
