import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { NyxdocMark } from "@/components/brand/nyxdoc-mark";
import { getCurrentSession, sessionEmailIsAccepted } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { getSiteSettings } from "@/lib/site-settings/service";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { t } = await getServerI18n();
  const session = await getCurrentSession();
  if (session && sessionEmailIsAccepted(session)) redirect("/app");
  const siteSettings = getSiteSettings(sqlite);

  return (
    <main className="welcome-page">
      <div className="welcome-orb welcome-orb-mint" />
      <div className="welcome-orb welcome-orb-yellow" />
      <section className="welcome-card">
        <div className="brand-lockup">
          <span className="brand-symbol"><NyxdocMark size={44} /></span>
          <span>nyxdoc</span>
        </div>
        <p className="welcome-kicker">{t("home.kicker")}</p>
        <h1>{t("home.title.line1")}<br /><em>{t("home.title.line2")}</em></h1>
        <p className="welcome-copy">{t("home.description")}</p>
        <div className="welcome-actions">
          <Link className="primary-button" href="/sign-in">
            {t("home.openWorkspace")} <ArrowRight size={17} />
          </Link>
          <Link className="quiet-button" href="/sign-up">{t("home.firstTime")}</Link>
        </div>
        <div className="welcome-trust">
          <span><Check size={14} /> {t("home.reviewBeforeChange")}</span>
          <span><Check size={14} /> {t("home.revisionHistory")}</span>
          <span><Check size={14} /> {siteSettings.emailDomainPolicy === "any"
            ? siteSettings.registrationMode === "open"
              ? t("home.emailSignUp")
              : t("home.inviteOnly")
            : t("home.domainOnly", {
                domains: siteSettings.allowedEmailDomains
                  .map((domain) => `@${domain}`)
                  .join(", "),
              })}</span>
        </div>
      </section>
    </main>
  );
}
