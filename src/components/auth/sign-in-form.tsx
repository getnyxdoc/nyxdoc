"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState, useSyncExternalStore } from "react";
import { ArrowRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";
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

export function SignInForm({ callbackURL = "/app" }: { callbackURL?: string }) {
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
    const result = await authClient.signIn.email({
      email,
      password: String(data.get("password") || ""),
      callbackURL,
    });
    setPending(false);
    if (result.error) {
      if (result.error.code === "EMAIL_NOT_VERIFIED") {
        router.push(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      }
      setError(t("auth.invalidCredentials"));
      return;
    }
    await fetch("/api/settings/profile", { cache: "no-store" }).catch(() => null);
    router.push(callbackURL);
    router.refresh();
  }

  return (
    <>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.field}>
          <label htmlFor="email">{t("auth.email")}</label>
          <input id="email" name="email" type="email" autoComplete="email" required placeholder="name@example.com" />
        </div>
        <div className={styles.field}>
          <div className={styles.row}>
            <label htmlFor="password">{t("auth.password")}</label>
            <Link className={styles.textButton} href="/forgot-password">{t("auth.forgotPassword")}</Link>
          </div>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {error && <div className={styles.error} role="alert">{error}</div>}
        <button className={styles.submit} type="submit" disabled={!hydrated || pending}>
          {pending ? t("auth.checking") : t("auth.openWorkspace")} <ArrowRight size={17} />
        </button>
      </form>
      <p className={styles.footer}>{t("auth.newHere")} <Link href="/sign-up">{t("auth.createAccount")}</Link></p>
    </>
  );
}
