"use client";

import {
  Activity,
  Check,
  ClipboardCopy,
  Cloud,
  Database,
  Globe2,
  HardDrive,
  KeyRound,
  LockKeyhole,
  Mail,
  RefreshCw,
  Save,
  ServerCog,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import type { SiteAdminView } from "@/lib/site-settings/types";
import { useI18n } from "@/lib/i18n/client";
import type { AppLocale } from "@/lib/i18n/locales";
import styles from "./settings.module.css";

type SiteApiBody = {
  error?: string;
  site?: SiteAdminView;
};

function shortDate(value: string, locale: AppLocale) {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function SiteAdministrationPanel({
  initialSite,
}: {
  initialSite: SiteAdminView;
}) {
  const { locale, t } = useI18n();
  const copy = {
    en: {
      saveFailed: "Could not save site settings.",
      inviteFailed: "Could not create the invitation link.",
      revokeFailed: "Could not revoke the invitation.",
      recoveryFailed: "Could not create the recovery link.",
      restartTitle: "Restart the app to apply every saved setting.",
      restartHint: "Registration domains and SMTP are read immediately; the public URL and email verification flow are finalized after restart.",
      users: "Users",
      activeWorkspaces: "Active workspaces",
      activeAgents: "Active agents",
      activeDocuments: "Active documents",
      myRole: "My role",
      owner: "Site owner",
      administrator: "Site administrator",
      runtime: "Runtime",
      sourceRevision: "Source revision",
      settingsVersion: "Settings version",
      publicUrl: "Public site URL",
      publicUrlHint: "Enter only the scheme and domain, without a path. Restart the app after changing it.",
      httpsActive: "Enabled on the public URL",
      httpConfigured: "Configured with HTTP",
      certificate: "Certificate",
      reverseProxy: "Managed by the reverse proxy",
      tlsBoundary: "Nyxdoc does not store certificate private keys. Manage TLS termination and automatic certificate renewal in a reverse proxy such as Nginx, Caddy, or Traefik.",
      allowedDomains: "Allowed email domains",
      allowedDomainsHint: "Separate values with commas or line breaks. Add subdomains explicitly.",
      smtpHost: "SMTP host",
      port: "Port",
      smtpUser: "SMTP user",
      secureConnection: "Secure connection",
      from: "From",
      smtpPassword: "SMTP password",
      configuredInEnvironment: "Configured in the environment",
      configurationRequired: "Configuration required",
      smtpSecretHint: "Secret values are not stored in the UI or database. Manage them with the server’s SMTP_PASSWORD environment variable.",
      dataHint: "Paths and secrets are managed in the server environment; this screen only reports whether they are configured.",
      database: "Database",
      mediaStorage: "Media storage",
      backupStorage: "Backup storage",
      realtime: "Realtime collaboration",
      configured: "Configured",
      auditHint: "Site-wide setting changes are recorded separately from workspace audit logs.",
      noAudit: "No site setting changes have been recorded yet.",
    },
    ko: {
      saveFailed: "사이트 설정을 저장하지 못했습니다.",
      inviteFailed: "초대 링크를 만들지 못했습니다.",
      revokeFailed: "초대를 취소하지 못했습니다.",
      recoveryFailed: "복구 링크를 만들지 못했습니다.",
      restartTitle: "저장된 설정을 완전히 적용하려면 앱을 재시작해주세요.",
      restartHint: "가입 도메인 정책과 SMTP는 즉시 읽지만, 공개 주소와 이메일 인증 흐름은 재시작 후 확정됩니다.",
      users: "사용자",
      activeWorkspaces: "활성 워크스페이스",
      activeAgents: "활성 에이전트",
      activeDocuments: "활성 문서",
      myRole: "내 권한",
      owner: "사이트 소유자",
      administrator: "사이트 관리자",
      runtime: "실행 환경",
      sourceRevision: "소스 리비전",
      settingsVersion: "설정 버전",
      publicUrl: "사이트 공개 주소",
      publicUrlHint: "경로 없이 스킴과 도메인까지만 입력합니다. 변경 후 앱 재시작이 필요합니다.",
      httpsActive: "공개 주소에서 사용 중",
      httpConfigured: "HTTP로 구성됨",
      certificate: "인증서",
      reverseProxy: "리버스 프록시에서 관리",
      tlsBoundary: "Nyxdoc은 인증서 개인키를 저장하지 않습니다. Nginx, Caddy, Traefik 같은 리버스 프록시에서 TLS 종료와 인증서 자동 갱신을 관리하세요.",
      allowedDomains: "허용 이메일 도메인",
      allowedDomainsHint: "쉼표나 줄바꿈으로 구분합니다. 하위 도메인은 명시적으로 추가해야 합니다.",
      smtpHost: "SMTP 호스트",
      port: "포트",
      smtpUser: "SMTP 사용자",
      secureConnection: "보안 연결",
      from: "보내는 사람",
      smtpPassword: "SMTP 비밀번호",
      configuredInEnvironment: "환경 변수에 설정됨",
      configurationRequired: "설정 필요",
      smtpSecretHint: "비밀값은 화면이나 데이터베이스에 저장하지 않습니다. 서버의 SMTP_PASSWORD 환경 변수로 관리합니다.",
      dataHint: "경로와 비밀값은 서버 환경에서 관리하며 이 화면은 구성 여부만 확인합니다.",
      database: "데이터베이스",
      mediaStorage: "미디어 저장소",
      backupStorage: "백업 저장소",
      realtime: "실시간 협업",
      configured: "정상 구성",
      auditHint: "사이트 전체 설정 변경은 워크스페이스 감사 기록과 별도로 남습니다.",
      noAudit: "아직 사이트 설정 변경 기록이 없습니다.",
    },
    ja: {
      saveFailed: "サイト設定を保存できませんでした。",
      inviteFailed: "招待リンクを作成できませんでした。",
      revokeFailed: "招待を取り消せませんでした。",
      recoveryFailed: "復旧リンクを作成できませんでした。",
      restartTitle: "保存済み設定を完全に反映するにはアプリを再起動してください。",
      restartHint: "登録ドメインとSMTPは直ちに反映されますが、公開URLとメール認証フローは再起動後に確定します。",
      users: "ユーザー",
      activeWorkspaces: "有効なワークスペース",
      activeAgents: "有効なエージェント",
      activeDocuments: "有効な文書",
      myRole: "自分の権限",
      owner: "サイト所有者",
      administrator: "サイト管理者",
      runtime: "実行環境",
      sourceRevision: "ソースリビジョン",
      settingsVersion: "設定バージョン",
      publicUrl: "サイト公開URL",
      publicUrlHint: "パスを含めず、スキームとドメインだけを入力します。変更後はアプリを再起動してください。",
      httpsActive: "公開URLで有効",
      httpConfigured: "HTTPで構成",
      certificate: "証明書",
      reverseProxy: "リバースプロキシで管理",
      tlsBoundary: "Nyxdocは証明書の秘密鍵を保存しません。Nginx、Caddy、TraefikなどのリバースプロキシでTLS終端と証明書の自動更新を管理してください。",
      allowedDomains: "許可するメールドメイン",
      allowedDomainsHint: "カンマまたは改行で区切ります。サブドメインは明示的に追加してください。",
      smtpHost: "SMTPホスト",
      port: "ポート",
      smtpUser: "SMTPユーザー",
      secureConnection: "安全な接続",
      from: "送信者",
      smtpPassword: "SMTPパスワード",
      configuredInEnvironment: "環境変数に設定済み",
      configurationRequired: "設定が必要",
      smtpSecretHint: "秘密値は画面やデータベースへ保存しません。サーバーのSMTP_PASSWORD環境変数で管理します。",
      dataHint: "パスと秘密値はサーバー環境で管理され、この画面では構成状況だけを確認します。",
      database: "データベース",
      mediaStorage: "メディアストレージ",
      backupStorage: "バックアップストレージ",
      realtime: "リアルタイム共同編集",
      configured: "構成済み",
      auditHint: "サイト全体の設定変更は、ワークスペース監査ログとは別に記録されます。",
      noAudit: "サイト設定の変更記録はまだありません。",
    },
  }[locale];
  const [site, setSite] = useState(initialSite);
  const [publicBaseUrl, setPublicBaseUrl] = useState(initialSite.settings.publicBaseUrl);
  const [registrationMode, setRegistrationMode] = useState(
    initialSite.settings.registrationMode,
  );
  const [emailVerificationEnabled, setEmailVerificationEnabled] = useState(
    initialSite.settings.emailVerificationEnabled,
  );
  const [emailDomainPolicy, setEmailDomainPolicy] = useState(
    initialSite.settings.emailDomainPolicy,
  );
  const [allowedDomains, setAllowedDomains] = useState(
    initialSite.settings.allowedEmailDomains.join(", "),
  );
  const [smtp, setSmtp] = useState({
    host: initialSite.settings.smtp.host,
    port: initialSite.settings.smtp.port,
    secure: initialSite.settings.smtp.secure,
    user: initialSite.settings.smtp.user,
    from: initialSite.settings.smtp.from,
  });
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [invites, setInvites] = useState(initialSite.invites);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePending, setInvitePending] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [revealedInviteUrl, setRevealedInviteUrl] = useState("");
  const [recoveryPendingId, setRecoveryPendingId] = useState<string | null>(null);
  const [recoveryUrl, setRecoveryUrl] = useState("");
  const normalizedDomains = useMemo(() => [...new Set(
    allowedDomains
      .split(/[\s,]+/)
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  )], [allowedDomains]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setSaved(false);
    setError("");
    try {
      const response = await fetch("/api/settings/site", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: site.settings.version,
          publicBaseUrl,
          registrationMode,
          emailVerificationEnabled,
          emailDomainPolicy,
          allowedEmailDomains: emailDomainPolicy === "restricted" ? normalizedDomains : [],
          smtp,
        }),
      });
      const body = await response.json().catch(() => ({})) as SiteApiBody;
      if (!response.ok || !body.site) {
        throw new Error(body.error || copy.saveFailed);
      }
      setSite(body.site);
      setPublicBaseUrl(body.site.settings.publicBaseUrl);
      setRegistrationMode(body.site.settings.registrationMode);
      setAllowedDomains(body.site.settings.allowedEmailDomains.join(", "));
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.saveFailed);
    } finally {
      setPending(false);
    }
  }

  async function createInvite() {
    if (invitePending || !inviteEmail.trim()) return;
    setInvitePending(true);
    setInviteError("");
    setRevealedInviteUrl("");
    try {
      const response = await fetch("/api/settings/site/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), expiresInHours: 24 * 7 }),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        invite?: SiteAdminView["invites"][number];
        url?: string;
      };
      if (!response.ok || !body.invite || !body.url) {
        throw new Error(body.error || copy.inviteFailed);
      }
      setInvites((current) => [body.invite!, ...current.filter(
        (invite) => invite.email !== body.invite!.email || invite.status !== "active",
      )]);
      setRevealedInviteUrl(body.url);
      setInviteEmail("");
    } catch (reason) {
      setInviteError(reason instanceof Error ? reason.message : copy.inviteFailed);
    } finally {
      setInvitePending(false);
    }
  }

  async function revokeInvite(inviteId: string) {
    setInviteError("");
    try {
      const response = await fetch(`/api/settings/site/invites/${encodeURIComponent(inviteId)}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        invites?: SiteAdminView["invites"];
      };
      if (!response.ok || !body.invites) {
        throw new Error(body.error || copy.revokeFailed);
      }
      setInvites(body.invites);
    } catch (reason) {
      setInviteError(reason instanceof Error ? reason.message : copy.revokeFailed);
    }
  }

  async function createRecoveryLink(userId: string) {
    if (recoveryPendingId) return;
    setRecoveryPendingId(userId);
    setRecoveryUrl("");
    setError("");
    try {
      const response = await fetch("/api/settings/site/recovery-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        url?: string;
      };
      if (!response.ok || !body.url) {
        throw new Error(body.error || copy.recoveryFailed);
      }
      setRecoveryUrl(body.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoveryFailed);
    } finally {
      setRecoveryPendingId(null);
    }
  }

  return (
    <form className={styles.siteSettingsForm} onSubmit={save}>
      {site.settings.restartRequired && (
        <div className={styles.siteRestartNotice} role="status">
          <RefreshCw size={18} />
          <div>
            <strong>{copy.restartTitle}</strong>
            <span>{copy.restartHint}</span>
          </div>
        </div>
      )}

      <section className={styles.settingsCard}>
        <div className={styles.sectionHeading}>
          <span><Activity size={18} /></span>
          <div>
            <h2>{t("site.status")}</h2>
            <p>{t("site.status.description")}</p>
          </div>
        </div>
        <div className={styles.siteMetricGrid}>
          <article><Users size={17} /><strong>{site.counts.users}</strong><span>{copy.users}</span></article>
          <article><Cloud size={17} /><strong>{site.counts.activeWorkspaces}</strong><span>{copy.activeWorkspaces}</span></article>
          <article><ServerCog size={17} /><strong>{site.counts.activeAgents}</strong><span>{copy.activeAgents}</span></article>
          <article><Database size={17} /><strong>{site.counts.activeDocuments}</strong><span>{copy.activeDocuments}</span></article>
        </div>
        <div className={styles.siteRuntimeRow}>
          <span>{copy.myRole} <strong>{site.administratorRole === "owner" ? copy.owner : copy.administrator}</strong></span>
          <span>{copy.runtime} <strong>{site.runtime.environment}</strong></span>
          <span>{copy.sourceRevision} <code>{site.runtime.sourceRevision.slice(0, 12)}</code></span>
          <span>{copy.settingsVersion} <strong>{site.settings.version}</strong></span>
        </div>
      </section>

      <section className={styles.settingsCard}>
        <div className={styles.sectionHeading}>
          <span><Globe2 size={18} /></span>
          <div>
            <h2>{t("site.publicUrl")}</h2>
            <p>{t("site.publicUrl.description")}</p>
          </div>
        </div>
        <div className={styles.siteFieldGrid}>
          <label className={styles.siteWideField}>
            <span>{copy.publicUrl}</span>
            <input
              type="url"
              value={publicBaseUrl}
              maxLength={500}
              required
              placeholder="https://app.example.com"
              onChange={(event) => setPublicBaseUrl(event.target.value)}
            />
            <small>{copy.publicUrlHint}</small>
          </label>
        </div>
        <div className={styles.siteStatusGrid}>
          <article data-ready={site.runtime.httpsEnabled}>
            <LockKeyhole size={17} />
            <div><strong>HTTPS</strong><span>{site.runtime.httpsEnabled ? copy.httpsActive : copy.httpConfigured}</span></div>
          </article>
          <article data-ready={site.runtime.httpsEnabled}>
            <ShieldCheck size={17} />
            <div><strong>{copy.certificate}</strong><span>{copy.reverseProxy}</span></div>
          </article>
        </div>
        <p className={styles.siteBoundaryNote}>
          {copy.tlsBoundary}
        </p>
      </section>

      <section className={styles.settingsCard}>
        <div className={styles.sectionHeading}>
          <span><Users size={18} /></span>
          <div>
            <h2>{t("site.registration")}</h2>
            <p>{t("site.registration.description")}</p>
          </div>
        </div>
        <div className={styles.siteFieldGrid}>
          <label>
            <span>{t("site.registrationMode")}</span>
            <select
              value={registrationMode}
              onChange={(event) => setRegistrationMode(
                event.target.value as "invite" | "open",
              )}
            >
              <option value="invite">{t("site.registration.invite")}</option>
              <option value="open">{t("site.registration.open")}</option>
            </select>
            <small>{t("site.registration.firstOwnerHint")}</small>
          </label>
          <label className={styles.siteSwitchField}>
            <input
              type="checkbox"
              checked={emailVerificationEnabled}
              onChange={(event) => setEmailVerificationEnabled(event.target.checked)}
            />
            <span><strong>{t("site.emailVerification")}</strong><small>{t("site.emailVerificationHint")}</small></span>
          </label>
          <label>
            <span>{t("site.domainScope")}</span>
            <select
              value={emailDomainPolicy}
              onChange={(event) => setEmailDomainPolicy(
                event.target.value as "restricted" | "any",
              )}
            >
              <option value="restricted">{t("site.domainRestricted")}</option>
              <option value="any">{t("site.domainAny")}</option>
            </select>
          </label>
          <label className={styles.siteWideField}>
            <span>{copy.allowedDomains}</span>
            <input
              value={allowedDomains}
              disabled={emailDomainPolicy === "any"}
              required={emailDomainPolicy === "restricted"}
              placeholder="example.com, subsidiary.example.com"
              onChange={(event) => setAllowedDomains(event.target.value)}
            />
            <small>{copy.allowedDomainsHint}</small>
          </label>
        </div>
      </section>

      <section className={styles.settingsCard}>
        <div className={styles.sectionHeading}>
          <span><UserPlus size={18} /></span>
          <div>
            <h2>{t("site.invites")}</h2>
            <p>{t("site.invites.description")}</p>
          </div>
        </div>
        <div className={styles.siteFieldGrid}>
          <label className={styles.siteWideField}>
            <span>{t("site.invites.email")}</span>
            <div className={styles.siteInlineAction}>
              <input
                type="email"
                value={inviteEmail}
                placeholder="person@example.com"
                onChange={(event) => setInviteEmail(event.target.value)}
              />
              <button type="button" disabled={invitePending || !inviteEmail.trim()} onClick={createInvite}>
                <UserPlus size={15} /> {invitePending ? t("site.invites.creating") : t("site.invites.create")}
              </button>
            </div>
          </label>
        </div>
        {inviteError && <p className={styles.profileError} role="alert">{inviteError}</p>}
        {revealedInviteUrl && (
          <div className={styles.siteRevealBox}>
            <div>
              <strong>{t("site.invites.once")}</strong>
              <code>{revealedInviteUrl}</code>
            </div>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(revealedInviteUrl)}
            >
              <ClipboardCopy size={15} /> {t("common.copy")}
            </button>
          </div>
        )}
        <div className={styles.siteCompactList}>
          {invites.length === 0 ? (
            <p>{t("site.invites.none")}</p>
          ) : invites.map((invite) => (
            <article key={invite.id}>
              <div>
                <strong>{invite.email}</strong>
                <small>{invite.tokenPrefix}… · {shortDate(invite.createdAt, locale)} · {t(`site.invites.${invite.status}`)}</small>
              </div>
              {invite.status === "active" && (
                <button type="button" onClick={() => revokeInvite(invite.id)}>{t("site.invites.revoke")}</button>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className={styles.settingsCard}>
        <div className={styles.sectionHeading}>
          <span><KeyRound size={18} /></span>
          <div>
            <h2>{t("site.recovery")}</h2>
            <p>{t("site.recovery.description")}</p>
          </div>
        </div>
        {recoveryUrl && (
          <div className={styles.siteRevealBox}>
            <div>
              <strong>{t("site.recovery.expires")}</strong>
              <code>{recoveryUrl}</code>
            </div>
            <button type="button" onClick={() => navigator.clipboard.writeText(recoveryUrl)}>
              <ClipboardCopy size={15} /> {t("common.copy")}
            </button>
          </div>
        )}
        <div className={styles.siteCompactList}>
          {site.users.map((user) => (
            <article key={user.id}>
              <div>
                <strong>{user.name}</strong>
                <small>{user.email}{user.siteRole ? ` · ${user.siteRole}` : ""}</small>
              </div>
              <button
                type="button"
                disabled={site.administratorRole !== "owner" || Boolean(recoveryPendingId)}
                onClick={() => createRecoveryLink(user.id)}
              >
                {recoveryPendingId === user.id ? t("site.invites.creating") : t("site.recovery.create")}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.settingsCard}>
        <div className={styles.sectionHeading}>
          <span><Mail size={18} /></span>
          <div>
            <h2>{t("site.smtp")}</h2>
            <p>{t("site.smtp.description")}</p>
          </div>
        </div>
        <div className={styles.siteFieldGrid}>
          <label>
            <span>{copy.smtpHost}</span>
            <input
              value={smtp.host}
              placeholder="smtp.example.com"
              onChange={(event) => setSmtp((current) => ({ ...current, host: event.target.value }))}
            />
          </label>
          <label>
            <span>{copy.port}</span>
            <input
              type="number"
              min={1}
              max={65_535}
              value={smtp.port}
              onChange={(event) => setSmtp((current) => ({
                ...current,
                port: Number(event.target.value),
              }))}
            />
          </label>
          <label>
            <span>{copy.smtpUser}</span>
            <input
              value={smtp.user}
              autoComplete="off"
              onChange={(event) => setSmtp((current) => ({ ...current, user: event.target.value }))}
            />
          </label>
          <label>
            <span>{copy.secureConnection}</span>
            <select
              value={smtp.secure ? "implicit" : "starttls"}
              onChange={(event) => setSmtp((current) => ({
                ...current,
                secure: event.target.value === "implicit",
              }))}
            >
              <option value="starttls">STARTTLS</option>
              <option value="implicit">Implicit TLS</option>
            </select>
          </label>
          <label className={styles.siteWideField}>
            <span>{copy.from}</span>
            <input
              value={smtp.from}
              placeholder="Nyxdoc <no-reply@example.com>"
              onChange={(event) => setSmtp((current) => ({ ...current, from: event.target.value }))}
            />
          </label>
        </div>
        <div className={styles.siteSecretNotice} data-ready={site.settings.smtp.passwordConfigured}>
          <KeyRound size={17} />
          <div>
            <strong>{copy.smtpPassword} · {site.settings.smtp.passwordConfigured ? copy.configuredInEnvironment : copy.configurationRequired}</strong>
            <span>{copy.smtpSecretHint}</span>
          </div>
        </div>
      </section>

      <section className={styles.settingsCard}>
        <div className={styles.sectionHeading}>
          <span><HardDrive size={18} /></span>
          <div>
            <h2>{t("site.dataBoundary")}</h2>
            <p>{copy.dataHint}</p>
          </div>
        </div>
        <div className={styles.siteStatusGrid}>
          <article data-ready={site.runtime.databaseConfigured}>
            <Database size={17} />
            <div><strong>{copy.database}</strong><span>{site.runtime.databaseConfigured ? copy.configured : copy.configurationRequired}</span></div>
          </article>
          <article data-ready={site.runtime.mediaStorageConfigured}>
            <HardDrive size={17} />
            <div><strong>{copy.mediaStorage}</strong><span>{site.runtime.mediaStorageConfigured ? copy.configured : copy.configurationRequired}</span></div>
          </article>
          <article data-ready={site.runtime.backupStorageConfigured}>
            <ShieldCheck size={17} />
            <div><strong>{copy.backupStorage}</strong><span>{site.runtime.backupStorageConfigured ? copy.configured : copy.configurationRequired}</span></div>
          </article>
          <article data-ready={Boolean(site.runtime.collaborationPublicUrl)}>
            <Cloud size={17} />
            <div><strong>{copy.realtime}</strong><span>{site.runtime.collaborationPublicUrl}</span></div>
          </article>
        </div>
      </section>

      <section className={styles.settingsCard}>
        <div className={styles.sectionHeading}>
          <span><ShieldCheck size={18} /></span>
          <div>
            <h2>{t("site.audit")}</h2>
            <p>{copy.auditHint}</p>
          </div>
        </div>
        <div className={styles.siteAuditList}>
          {site.auditEvents.length === 0 ? (
            <p>{copy.noAudit}</p>
          ) : site.auditEvents.map((event) => (
            <article key={event.id}>
              <span />
              <div><strong>{event.action}</strong><small>{event.actorLabel}</small></div>
              <time dateTime={event.createdAt}>{shortDate(event.createdAt, locale)}</time>
            </article>
          ))}
        </div>
      </section>

      <footer className={styles.siteSaveBar}>
        <div aria-live="polite">
          {error && <span className={styles.profileError} role="alert">{error}</span>}
          {saved && <span className={styles.profileSaved}><Check size={14} /> {t("site.saved")}</span>}
        </div>
        <button type="submit" disabled={pending}>
          <Save size={15} /> {pending ? t("common.saving") : t("site.save")}
        </button>
      </footer>
    </form>
  );
}
