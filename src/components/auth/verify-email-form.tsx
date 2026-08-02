"use client";

import Link from "next/link";
import { useState } from "react";
import { Mail } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n/client";
import styles from "./auth.module.css";

export function VerifyEmailForm({ email }: { email: string }) {
  const { t } = useI18n();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function resend() {
    if (!email) { setError(t("auth.verify.missingEmail")); return; }
    setPending(true); setError(""); setMessage("");
    const result = await authClient.sendVerificationEmail({ email, callbackURL: "/app" });
    setPending(false);
    if (result.error) { setError(t("auth.verify.failed")); return; }
    setMessage(t("auth.verify.sent"));
  }

  return (
    <>
      <div className={styles.mailBadge}><Mail size={20} /><span>{email || t("auth.verify.fallbackEmail")}</span></div>
      <div className={styles.form}>
        {message && <div className={styles.success}>{message}</div>}
        {error && <div className={styles.error} role="alert">{error}</div>}
        <button className={styles.submit} type="button" onClick={resend} disabled={pending}>
          {pending ? t("auth.verify.sending") : t("auth.verify.resend")}
        </button>
      </div>
      <p className={styles.footer}>{t("auth.verify.done")} <Link href="/sign-in">{t("auth.signIn")}</Link></p>
    </>
  );
}
