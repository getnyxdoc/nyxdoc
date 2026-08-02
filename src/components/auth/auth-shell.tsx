"use client";

import Link from "next/link";
import { NyxdocMark } from "@/components/brand/nyxdoc-mark";
import { useI18n } from "@/lib/i18n/client";
import styles from "./auth.module.css";

export function AuthShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [storyLine1, storyLine2] = t("auth.story.title").split("\n");
  return (
    <main className={styles.page}>
      <aside className={styles.story}>
        <Link className={styles.brand} href="/">
          <span className={styles.mark}><NyxdocMark size={43} /></span>
          nyxdoc
        </Link>
        <div className={styles.storyCopy}>
          <p className={styles.kicker}>{t("auth.story.kicker")}</p>
          <h1>{storyLine1}<br />{storyLine2}</h1>
          <p>{t("auth.story.description")}</p>
        </div>
        <div className={styles.floatingNote}>{t("auth.story.note")}</div>
      </aside>
      <section className={styles.card}>
        <div className={styles.cardInner}>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h2>{title}</h2>
          <p className={styles.description}>{description}</p>
          {children}
        </div>
      </section>
    </main>
  );
}

export { styles as authStyles };
