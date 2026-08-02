"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, ChevronRight, FileText, FolderTree, Search, X } from "lucide-react";
import type { DocumentSummary } from "@/lib/documents/types";
import { useI18n } from "@/lib/i18n/client";
import styles from "./settings.module.css";

type ScopeDocument = Pick<DocumentSummary, "id" | "parentDocumentId" | "title" | "treeOrder">;

type TreeRow = {
  document: ScopeDocument;
  ancestors: string[];
  depth: number;
  hasChildren: boolean;
  path: string[];
};

function documentTree(documents: ScopeDocument[]): TreeRow[] {
  const ids = new Set(documents.map((document) => document.id));
  const children = new Map<string | null, ScopeDocument[]>();
  for (const document of documents) {
    const parentId = document.parentDocumentId && ids.has(document.parentDocumentId)
      ? document.parentDocumentId
      : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(document);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.treeOrder - right.treeOrder || left.title.localeCompare(right.title));
  }

  const rows: TreeRow[] = [];
  const visited = new Set<string>();
  function visit(document: ScopeDocument, ancestors: string[], path: string[]) {
    if (visited.has(document.id)) return;
    visited.add(document.id);
    const descendants = children.get(document.id) ?? [];
    rows.push({
      document,
      ancestors,
      depth: ancestors.length,
      hasChildren: descendants.length > 0,
      path: [...path, document.title],
    });
    for (const child of descendants) visit(child, [...ancestors, document.id], [...path, document.title]);
  }
  for (const root of children.get(null) ?? []) visit(root, [], []);
  for (const orphan of documents) visit(orphan, [], []);
  return rows;
}

export function DocumentScopePicker({
  ariaLabel,
  disabled = false,
  documents,
  onChange,
  value,
  workspaceName,
}: {
  ariaLabel: string;
  disabled?: boolean;
  documents: ScopeDocument[];
  onChange: (value: string) => void;
  value: string;
  workspaceName: string;
}) {
  const { locale } = useI18n();
  const copy = {
    en: {
      whole: "{workspace} · all documents",
      subtree: "{workspace} / {path} and descendants",
      allDocuments: "All documents in this workspace",
      searchAria: "{label} search",
      search: "Search documents by name or path",
      clear: "Clear search",
      workspaceAll: "All workspace documents",
      collapse: "collapse",
      expand: "expand",
      children: "{title} child documents: {action}",
      title: "{path} and child documents",
      subtreeHint: "This document and all child documents",
      empty: "No matching documents.",
    },
    ko: {
      whole: "{workspace} 전체",
      subtree: "{workspace} / {path} 이하",
      allDocuments: "이 워크스페이스의 모든 문서",
      searchAria: "{label} 검색",
      search: "문서 이름이나 경로 검색",
      clear: "검색어 지우기",
      workspaceAll: "워크스페이스의 모든 문서",
      collapse: "접기",
      expand: "펼치기",
      children: "{title} 하위 문서 {action}",
      title: "{path} 및 하위 문서",
      subtreeHint: "이 문서와 모든 하위 문서",
      empty: "일치하는 문서가 없습니다.",
    },
    ja: {
      whole: "{workspace} · すべての文書",
      subtree: "{workspace} / {path} 以下",
      allDocuments: "このワークスペースのすべての文書",
      searchAria: "{label} を検索",
      search: "文書名またはパスを検索",
      clear: "検索語を消去",
      workspaceAll: "ワークスペースのすべての文書",
      collapse: "折りたたむ",
      expand: "展開する",
      children: "{title} の子文書を{action}",
      title: "{path} と子文書",
      subtreeHint: "この文書とすべての子文書",
      empty: "一致する文書がありません。",
    },
  }[locale];
  const format = (message: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (output, [name, value]) => output.replaceAll(`{${name}}`, value),
      message,
    );
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rows = useMemo(() => documentTree(documents), [documents]);
  const selected = rows.find((row) => row.document.id === value);
  const normalizedQuery = query.trim().toLocaleLowerCase("ko");
  const shownRows = normalizedQuery
    ? rows.filter((row) => row.path.join(" / ").toLocaleLowerCase("ko").includes(normalizedQuery))
    : rows.filter((row) => row.ancestors.every((ancestor) => expanded.has(ancestor)));

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function openPicker() {
    if (disabled) return;
    const initiallyExpanded = new Set(selected?.ancestors ?? []);
    if (selected?.hasChildren) initiallyExpanded.add(selected.document.id);
    setExpanded(initiallyExpanded);
    setQuery("");
    setOpen((current) => !current);
  }

  function choose(nextValue: string) {
    onChange(nextValue);
    setOpen(false);
    setQuery("");
  }

  function toggleExpanded(documentId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }

  return (
    <div className={styles.scopePicker} ref={rootRef}>
      <button
        type="button"
        className={styles.scopePickerButton}
        aria-controls={open ? `${ariaLabel.replaceAll(" ", "-")}-tree` : undefined}
        aria-expanded={open}
        aria-haspopup="tree"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={openPicker}
      >
        <span>{selected
          ? selected.document.title
          : format(copy.whole, { workspace: workspaceName })}</span>
        <small>{selected
          ? format(copy.subtree, {
            workspace: workspaceName,
            path: selected.path.join(" / "),
          })
          : copy.allDocuments}</small>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className={styles.scopePickerMenu}>
          <div className={styles.scopeSearch}>
            <Search size={15} />
            <input
              autoFocus
              aria-label={format(copy.searchAria, { label: ariaLabel })}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy.search}
            />
            {query && (
              <button type="button" aria-label={copy.clear} onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </div>
          <div className={styles.scopeTree} id={`${ariaLabel.replaceAll(" ", "-")}-tree`} role="tree">
            <button
              type="button"
              className={styles.scopeAllOption}
              aria-selected={!value}
              role="treeitem"
              onClick={() => choose("")}
            >
              <span className={styles.scopeTreeIcon}><FolderTree size={15} /></span>
              <span><strong>{workspaceName}</strong><small>{copy.workspaceAll}</small></span>
              {!value && <Check size={15} />}
            </button>
            {shownRows.map((row) => (
              <div
                className={styles.scopeTreeRow}
                data-searching={Boolean(normalizedQuery)}
                key={row.document.id}
                role="treeitem"
                aria-level={row.depth + 2}
                aria-selected={row.document.id === value}
                style={{ "--scope-depth": row.depth + 1 } as CSSProperties}
              >
                {row.hasChildren && !normalizedQuery ? (
                  <button
                    type="button"
                    className={styles.scopeExpandButton}
                    aria-label={format(copy.children, {
                      title: row.document.title,
                      action: expanded.has(row.document.id) ? copy.collapse : copy.expand,
                    })}
                    onClick={() => toggleExpanded(row.document.id)}
                  >
                    <ChevronRight size={15} data-expanded={expanded.has(row.document.id)} />
                  </button>
                ) : <span className={styles.scopeExpandSpacer} />}
                <button
                  type="button"
                  className={styles.scopeDocumentOption}
                  onClick={() => choose(row.document.id)}
                  title={format(copy.title, { path: row.path.join(" / ") })}
                >
                  <FileText size={15} />
                  <span>
                    <strong>{row.document.title}</strong>
                    <small>{normalizedQuery ? row.path.join(" / ") : copy.subtreeHint}</small>
                  </span>
                  {row.document.id === value && <Check size={15} />}
                </button>
              </div>
            ))}
            {shownRows.length === 0 && (
              <div className={styles.scopeEmpty}>{copy.empty}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
