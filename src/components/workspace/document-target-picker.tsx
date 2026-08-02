"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderTree,
  Search,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DocumentSummary } from "@/lib/documents/types";
import { useI18n } from "@/lib/i18n/client";
import { buildTaskDocumentTree } from "./document-task-options";
import styles from "./workspace.module.css";

export function DocumentTargetPicker({
  ariaLabel,
  disabled = false,
  documents,
  onChange,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  documents: DocumentSummary[];
  onChange: (value: string) => void;
  value: string;
}) {
  const { locale } = useI18n();
  const copy = {
    en: {
      all: "Entire workspace · create a new document",
      noTarget: "New-document request without a specific target",
      topLevel: "Top-level document",
      search: "Search documents by name or path",
      clearSearch: "Clear search",
      collapse: "collapse",
      expand: "expand",
      children: "{title} child documents: {action}",
      empty: "No matching documents.",
      searchAria: "{label} search",
      treeAria: "{label} tree",
    },
    ko: {
      all: "워크스페이스 전체 · 새 문서 작성",
      noTarget: "특정 문서가 없는 새 문서 요청",
      topLevel: "최상위 문서",
      search: "문서 이름이나 경로 검색",
      clearSearch: "검색어 지우기",
      collapse: "접기",
      expand: "펼치기",
      children: "{title} 하위 문서 {action}",
      empty: "일치하는 문서가 없습니다.",
      searchAria: "{label} 검색",
      treeAria: "{label} 트리",
    },
    ja: {
      all: "ワークスペース全体 · 新規文書を作成",
      noTarget: "特定の文書を指定しない新規文書リクエスト",
      topLevel: "最上位の文書",
      search: "文書名またはパスを検索",
      clearSearch: "検索語を消去",
      collapse: "折りたたむ",
      expand: "展開する",
      children: "{title} の子文書を{action}",
      empty: "一致する文書がありません。",
      searchAria: "{label} を検索",
      treeAria: "{label} ツリー",
    },
  }[locale];
  const format = (message: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (output, [name, value]) => output.replaceAll(`{${name}}`, value),
      message,
    );
  const rootRef = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rows = useMemo(() => buildTaskDocumentTree(documents), [documents]);
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

  const selectedPath = selected?.path.join(" / ");

  return (
    <div className={styles.taskDocumentPicker} ref={rootRef}>
      <button
        type="button"
        className={styles.taskDocumentPickerButton}
        aria-controls={open ? treeId : undefined}
        aria-expanded={open}
        aria-haspopup="tree"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={openPicker}
      >
        <span>{selected?.document.title ?? copy.all}</span>
        <small>
          {selected
            ? selected.path.length > 1 ? selectedPath : copy.topLevel
            : copy.noTarget}
        </small>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className={styles.taskDocumentPickerMenu}>
          <div className={styles.taskDocumentSearch}>
            <Search size={15} />
            <input
              autoFocus
              aria-label={format(copy.searchAria, { label: ariaLabel })}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy.search}
            />
            {query && (
              <button type="button" aria-label={copy.clearSearch} onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </div>
          <div
            className={styles.taskDocumentTree}
            id={treeId}
            role="tree"
            aria-label={format(copy.treeAria, { label: ariaLabel })}
          >
            <button
              type="button"
              className={styles.taskDocumentAllOption}
              aria-selected={!value}
              role="treeitem"
              onClick={() => choose("")}
            >
              <span className={styles.taskDocumentTreeIcon}><FolderTree size={15} /></span>
              <span>
                <strong>{copy.all}</strong>
                <small>{copy.noTarget}</small>
              </span>
              {!value && <Check size={15} />}
            </button>
            {shownRows.map((row) => (
              <div
                className={styles.taskDocumentTreeRow}
                data-searching={Boolean(normalizedQuery)}
                key={row.document.id}
                role="treeitem"
                aria-expanded={row.hasChildren && !normalizedQuery
                  ? expanded.has(row.document.id)
                  : undefined}
                aria-level={row.depth + 1}
                aria-selected={row.document.id === value}
                style={{ "--task-document-depth": row.depth } as CSSProperties}
              >
                {row.hasChildren && !normalizedQuery ? (
                  <button
                    type="button"
                    className={styles.taskDocumentExpandButton}
                    aria-label={format(copy.children, {
                      title: row.document.title,
                      action: expanded.has(row.document.id) ? copy.collapse : copy.expand,
                    })}
                    onClick={() => toggleExpanded(row.document.id)}
                  >
                    <ChevronRight size={15} data-expanded={expanded.has(row.document.id)} />
                  </button>
                ) : <span className={styles.taskDocumentExpandSpacer} />}
                <button
                  type="button"
                  className={styles.taskDocumentOption}
                  onClick={() => choose(row.document.id)}
                  title={row.path.join(" / ")}
                >
                  <FileText size={15} />
                  <span>
                    <strong>{row.document.title}</strong>
                    <small>
                      {normalizedQuery
                        ? row.path.join(" / ")
                        : row.path.length > 1 ? row.path.slice(0, -1).join(" / ") : copy.topLevel}
                    </small>
                  </span>
                  {row.document.id === value && <Check size={15} />}
                </button>
              </div>
            ))}
            {shownRows.length === 0 && (
              <div className={styles.taskDocumentEmpty}>{copy.empty}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
