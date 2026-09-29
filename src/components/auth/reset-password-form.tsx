"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n/client";
import { AUTH_REQUEST_ERROR } from "./auth-request-error";
import styles from "./auth.module.css";

export function ResetPasswordForm({ token, invalid }: { token: string; invalid: boolean }) {
  const { locale, t } = useI18n();
  const [done, setDone] = useState(false);
  const [error, setError] = useState(invalid ? t("auth.reset.invalid") : "");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || invalid || !token) return;
    setError("");
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") || "");
    if (password !== String(data.get("confirm") || "")) { setError(t("auth.reset.mismatch")); return; }
    setPending(true);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) { setError(t("auth.reset.failed")); return; }
      setDone(true);
    } catch {
      setError(AUTH_REQUEST_ERROR[locale]);
    } finally {
      setPending(false);
    }
  }

  if (done) return <><div className={styles.success} role="status">{t("auth.reset.done")}</div><p className={styles.footer}><Link href="/sign-in">{t("auth.reset.signIn")}</Link></p></>;

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.field}><label htmlFor="password">{t("auth.reset.newPassword")}</label><input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required /></div>
      <div className={styles.field}><label htmlFor="confirm">{t("auth.reset.confirmPassword")}</label><input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required /></div>
      {error && <div className={styles.error} role="alert">{error}</div>}
      <button className={styles.submit} disabled={pending || invalid || !token}>{pending ? t("common.saving") : t("auth.reset.save")}</button>
    </form>
  );
}
