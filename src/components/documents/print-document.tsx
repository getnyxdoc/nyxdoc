"use client";

import { useEffect } from "react";
import { NyxdocMark } from "@/components/brand/nyxdoc-mark";
import { NyxdocRichEditor } from "@/components/editor/editor-lab";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";
import { useI18n } from "@/lib/i18n/client";
import styles from "./print-document.module.css";

async function waitForImages() {
  const images = Array.from(document.images);
  await Promise.all(images.map((image) => {
    if (image.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    });
  }));
}

export function PrintDocument({
  autoprint,
  content,
  documentId,
  documentTitle,
  workspaceId,
  workspaceName,
}: {
  autoprint: boolean;
  content: NyxdocDocumentV2;
  documentId: string;
  documentTitle: string;
  workspaceId: string;
  workspaceName: string;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${workspaceName} - ${documentTitle}`;
    return () => {
      document.title = previousTitle;
    };
  }, [documentTitle, workspaceName]);

  useEffect(() => {
    if (!autoprint) return;
    let cancelled = false;
    void Promise.all([
      document.fonts?.ready ?? Promise.resolve(),
      waitForImages(),
    ]).then(() => {
      if (cancelled) return;
      window.setTimeout(() => window.print(), 80);
    });
    return () => {
      cancelled = true;
    };
  }, [autoprint]);

  return (
    <main className={styles.page}>
      <header className={styles.toolbar}>
        <span><NyxdocMark size={31} />nyxdoc</span>
        <div>
          <small>{t("document.savedRevision")}</small>
          <button type="button" onClick={() => window.print()}>{t("document.savePdf")}</button>
        </div>
      </header>
      <article className={styles.paper}>
        <div className={styles.workspaceName}>{workspaceName}</div>
        <h1>{documentTitle}</h1>
        <NyxdocRichEditor
          ariaLabel={t("document.printAria", { title: documentTitle })}
          documentId={documentId}
          initialDocument={content}
          readOnly
          workspaceId={workspaceId}
        />
      </article>
    </main>
  );
}
