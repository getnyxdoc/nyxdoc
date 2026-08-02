import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NyxdocMark } from "@/components/brand/nyxdoc-mark";
import { NyxdocRichEditor } from "@/components/editor/editor-lab";
import { sqlite } from "@/lib/db/client";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";
import { getRequestLocale } from "@/lib/i18n/server";
import { translate } from "@/lib/i18n/messages";
import {
  getPublicSharedDocument,
  PublicShareError,
} from "@/lib/sharing/service";
import styles from "./public-share.module.css";

export const dynamic = "force-dynamic";

function load(publicToken: string) {
  try {
    return getPublicSharedDocument(sqlite, publicToken);
  } catch (error) {
    if (error instanceof PublicShareError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

function publicContent(content: NyxdocDocumentV2, publicToken: string) {
  const next = structuredClone(content);
  function rewrite(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(rewrite);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "img" && typeof node.mediaId === "string") {
      node.url = `/s/${encodeURIComponent(publicToken)}/media/${encodeURIComponent(node.mediaId)}`;
    }
    if (Array.isArray(node.children)) node.children.forEach(rewrite);
  }
  rewrite(next.blocks);
  return next;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}): Promise<Metadata> {
  const { publicToken } = await params;
  const shared = load(publicToken);
  const locale = await getRequestLocale();
  return {
    title: `${shared.workspace.name} - ${shared.document.title}`,
    description: translate(locale, "document.publicDescription", {
      workspace: shared.workspace.name,
    }),
    robots: { index: false, follow: false, nocache: true },
  };
}

export default async function PublicSharedDocumentPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const shared = load(publicToken);
  const locale = await getRequestLocale();
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}><NyxdocMark size={34} />nyxdoc</span>
        <span className={styles.readOnly}>{translate(locale, "document.publicReadOnly")}</span>
      </header>
      <article className={styles.document}>
        <div className={styles.workspaceName}>{shared.workspace.name}</div>
        <h1>{shared.document.title}</h1>
        <NyxdocRichEditor
          ariaLabel={translate(locale, "document.publicAria", {
            title: shared.document.title,
          })}
          initialDocument={publicContent(shared.document.content, publicToken)}
          linkMode="public"
          readOnly
        />
      </article>
      <footer className={styles.footer}>{translate(locale, "document.sharedWith")}</footer>
    </main>
  );
}
