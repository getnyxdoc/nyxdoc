"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Building2, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { AppLocale } from "@/lib/i18n/locales";
import styles from "./organization-invite.module.css";

function copyFor(locale: AppLocale) {
  return {
    en: {
      eyebrow: "ORGANIZATION INVITATION",
      role: "Role",
      administrator: "Administrator",
      member: "Member",
      recipient: "Invited account",
      linkRecipient: "Whoever received this link",
      mismatch: "Sign in with the email account named in this invitation.",
      signIn: "Sign in to accept",
      signUp: "Create an account",
      accept: "Accept organization invitation",
      accepting: "Joining…",
      failed: "Could not accept the organization invitation.",
    },
    ko: {
      eyebrow: "조직 초대",
      role: "역할",
      administrator: "관리자",
      member: "멤버",
      recipient: "초대 대상",
      linkRecipient: "이 링크를 받은 사용자",
      mismatch: "이 초대에 지정된 이메일 계정으로 로그인해주세요.",
      signIn: "로그인해서 수락",
      signUp: "새 계정 만들기",
      accept: "조직 초대 수락",
      accepting: "참여하는 중…",
      failed: "조직 초대를 수락하지 못했습니다.",
    },
    ja: {
      eyebrow: "組織への招待",
      role: "役割",
      administrator: "管理者",
      member: "メンバー",
      recipient: "招待先",
      linkRecipient: "このリンクを受け取ったユーザー",
      mismatch: "この招待で指定されたメールアカウントでログインしてください。",
      signIn: "ログインして承認",
      signUp: "新しいアカウントを作成",
      accept: "組織への招待を承認",
      accepting: "参加中…",
      failed: "組織への招待を承認できませんでした。",
    },
  }[locale];
}

export function OrganizationInviteCard({
  authenticated,
  emailMismatch,
  invitation,
  token,
}: {
  authenticated: boolean;
  emailMismatch: boolean;
  invitation: { organizationId: string; organizationName: string; email: string | null; role: string };
  token: string;
}) {
  const { locale } = useI18n();
  const copy = copyFor(locale);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    if (pending) return;
    setPending(true);
    setError("");
    const response = await fetch("/api/organization-invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      setPending(false);
      setError(body.error || copy.failed);
      return;
    }
    router.push(`/settings/organization?organization=${encodeURIComponent(invitation.organizationId)}`);
    router.refresh();
  }

  const callbackURL = `/organization-invite?invite=${encodeURIComponent(token)}`;
  return (
    <section className={styles.card}>
      <span className={styles.icon}><Building2 size={24} /></span>
      <p>{copy.eyebrow}</p>
      <h1>{invitation.organizationName}</h1>
      <div className={styles.details}>
        <span><b>{copy.role}</b>{invitation.role === "admin" ? copy.administrator : copy.member}</span>
        <span><b>{copy.recipient}</b>{invitation.email ?? copy.linkRecipient}</span>
      </div>
      {emailMismatch ? (
        <div className={styles.error} role="alert">
          {copy.mismatch}
        </div>
      ) : !authenticated ? (
        <div className={styles.actions}>
          <Link href={`/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`}>
            {copy.signIn} <ArrowRight size={16} />
          </Link>
          <Link href={`/sign-up?invite=${encodeURIComponent(token)}`} data-secondary>
            {copy.signUp}
          </Link>
        </div>
      ) : (
        <button className={styles.accept} type="button" onClick={() => void accept()} disabled={pending}>
          <Check size={17} /> {pending ? copy.accepting : copy.accept}
        </button>
      )}
      {error && <div className={styles.error} role="alert">{error}</div>}
    </section>
  );
}
