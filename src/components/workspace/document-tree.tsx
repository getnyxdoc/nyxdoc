"use client";

import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronRight, Ellipsis, FileText, PencilLine, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { formatCopy } from "@/lib/i18n/copy";
import { localeTag, type AppLocale } from "@/lib/i18n/locales";
import type { DocumentSummary } from "@/lib/documents/types";
import styles from "./workspace.module.css";

type DocumentTreeNode = DocumentSummary & {
  children: DocumentTreeNode[];
};

function buildTree(documents: DocumentSummary[], locale: AppLocale) {
  const nodes = new Map<string, DocumentTreeNode>(
    documents.map((document) => [document.id, { ...document, children: [] }]),
  );
  const roots: DocumentTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentDocumentId ? nodes.get(node.parentDocumentId) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items: DocumentTreeNode[]) => {
    items.sort((left, right) => left.treeOrder - right.treeOrder || left.title.localeCompare(right.title, localeTag(locale)));
    items.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}

export function DocumentTree({
  userId,
  workspaceId,
  documents,
  activeDocumentId,
  expandedDocumentIds,
  onExpandedDocumentIdsChange,
  navigationStateKey,
  onCreateChild,
  onNavigate,
  onRename,
  onDelete,
  onDiagnostic,
}: {
  userId: string;
  workspaceId: string;
  documents: DocumentSummary[];
  activeDocumentId: string;
  expandedDocumentIds: readonly string[];
  onExpandedDocumentIdsChange: (documentIds: string[]) => void;
  navigationStateKey?: string;
  onCreateChild?: (parentDocumentId: string) => void;
  onNavigate?: (documentId: string) => void;
  onRename?: (documentId: string) => void;
  onDelete?: (documentId: string) => void;
  onDiagnostic?: (event: {
    action: "expand" | "collapse" | "navigate" | "active_revealed" | "storage_fallback";
  }) => void;
}) {
  const { locale } = useI18n();
  const copy = {
    en: {
      collapse: "Collapse {title}",
      expand: "Expand {title}",
      createChild: "Create a document under {title}",
      createChildTitle: "Create child document",
      menu: "{title} menu",
      menuTitle: "Document menu",
      tree: "Document tree",
      rename: "Rename document",
      delete: "Delete document",
    },
    ko: {
      collapse: "{title} 접기",
      expand: "{title} 펼치기",
      createChild: "{title} 아래 새 문서",
      createChildTitle: "하위 문서 만들기",
      menu: "{title} 메뉴",
      menuTitle: "문서 메뉴",
      tree: "문서 트리",
      rename: "문서 이름 변경",
      delete: "문서 삭제",
    },
    ja: {
      collapse: "{title}を折りたたむ",
      expand: "{title}を展開",
      createChild: "{title}の下に文書を作成",
      createChildTitle: "子文書を作成",
      menu: "{title}のメニュー",
      menuTitle: "文書メニュー",
      tree: "文書ツリー",
      rename: "文書名を変更",
      delete: "文書を削除",
    },
  }[locale];
  const tree = useMemo(() => buildTree(documents, locale), [documents, locale]);
  const [menu, setMenu] = useState<{ documentId: string; top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLElement>(null);
  const storageKey = navigationStateKey
    ? `nyxdoc:document-tree:${userId}:${workspaceId}:${navigationStateKey}`
    : null;
  const documentIds = useMemo(
    () => new Set(documents.map((document) => document.id)),
    [documents],
  );
  const expanded = useMemo(
    () => new Set(expandedDocumentIds.filter((id) => documentIds.has(id))),
    [documentIds, expandedDocumentIds],
  );

  useLayoutEffect(() => {
    const treeElement = treeRef.current;
    if (!treeElement) return;
    if (storageKey) {
      const storedScrollTop = Number(window.sessionStorage.getItem(`${storageKey}:scroll-top`));
      if (Number.isFinite(storedScrollTop) && storedScrollTop >= 0) {
        treeElement.scrollTop = storedScrollTop;
      }
    }
    const activeRow = treeElement.querySelector<HTMLElement>("[data-active-document='true']");
    if (!activeRow) return;
    const treeRect = treeElement.getBoundingClientRect();
    const rowRect = activeRow.getBoundingClientRect();
    if (rowRect.top < treeRect.top || rowRect.bottom > treeRect.bottom) {
      activeRow.scrollIntoView({ block: "nearest" });
    }
  }, [activeDocumentId, expanded, storageKey]);

  useEffect(() => {
    if (!menu) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if ((target as Element).closest?.("[data-document-menu-trigger]")) return;
      setMenu(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenu(null);
    }
    function closeOnViewportChange() {
      setMenu(null);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [menu]);

  function toggle(documentId: string) {
    const next = new Set(expanded);
    if (next.has(documentId)) {
      next.delete(documentId);
      onDiagnostic?.({ action: "collapse" });
    } else {
      next.add(documentId);
      onDiagnostic?.({ action: "expand" });
    }
    onExpandedDocumentIdsChange([...next]);
  }

  function rememberScrollPosition() {
    if (!storageKey || !treeRef.current) return;
    try {
      window.sessionStorage.setItem(`${storageKey}:scroll-top`, String(treeRef.current.scrollTop));
    } catch {
      // Browsing still works when storage is unavailable.
      onDiagnostic?.({ action: "storage_fallback" });
    }
  }

  function toggleMenu(event: React.MouseEvent<HTMLButtonElement>, documentId: string) {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 210;
    const height = 90;
    const gap = 6;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + gap;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - gap);
    setMenu((current) => current?.documentId === documentId ? null : { documentId, top, left });
  }

  function renderNode(node: DocumentTreeNode, depth: number) {
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.id);
    const isActive = node.id === activeDocumentId;
    return (
      <div className={styles.pageTreeBranch} key={node.id}>
        <div
          className={`${styles.pageTreeRow} ${onRename || onDelete ? styles.pageTreeRowWithMenu : ""} ${isActive ? styles.pageTreeActive : ""}`}
          data-active-document={isActive ? "true" : undefined}
          style={{ paddingLeft: `${6 + depth * 15}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              className={styles.pageTreeToggle}
              onClick={() => toggle(node.id)}
              aria-label={formatCopy(isExpanded ? copy.collapse : copy.expand, { title: node.title })}
              aria-expanded={isExpanded}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : <span className={styles.pageTreeTogglePlaceholder} />}
          {onNavigate ? (
            <button
              type="button"
              className={`${styles.pageTreeLink} ${styles.pageTreeNavigationButton}`}
              onClick={() => {
                rememberScrollPosition();
                onDiagnostic?.({ action: "navigate" });
                onNavigate(node.id);
              }}
              aria-current={isActive ? "page" : undefined}
              title={node.title}
            >
              <FileText size={14} />
              <span>{node.title}</span>
            </button>
          ) : (
            <Link
              href={`/app?workspace=${encodeURIComponent(workspaceId)}&document=${encodeURIComponent(node.id)}`}
              className={styles.pageTreeLink}
              aria-current={isActive ? "page" : undefined}
              title={node.title}
              onClick={() => {
                rememberScrollPosition();
                onDiagnostic?.({ action: "navigate" });
              }}
            >
              <FileText size={14} />
              <span>{node.title}</span>
            </Link>
          )}
          {onCreateChild && (
            <button
              type="button"
              className={styles.pageTreeAdd}
              onClick={() => onCreateChild(node.id)}
              aria-label={formatCopy(copy.createChild, { title: node.title })}
              title={copy.createChildTitle}
            >
              <Plus size={14} />
            </button>
          )}
          {(onRename || onDelete) && (
            <button
              type="button"
              className={styles.pageTreeMore}
              data-document-menu-trigger
              onClick={(event) => toggleMenu(event, node.id)}
              aria-label={formatCopy(copy.menu, { title: node.title })}
              aria-expanded={menu?.documentId === node.id}
              title={copy.menuTitle}
            >
              <Ellipsis size={15} />
            </button>
          )}
        </div>
        {hasChildren && isExpanded && (
          <div>
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <nav
        ref={treeRef}
        className={styles.pageTree}
        aria-label={copy.tree}
        onScroll={rememberScrollPosition}
      >
        {tree.map((node) => renderNode(node, 0))}
      </nav>
      {menu && (onRename || onDelete) && (
        <div
          ref={menuRef}
          className={styles.pageTreeMenuDropdown}
          role="menu"
          style={{ top: menu.top, left: menu.left }}
        >
          {onRename && (
            <button type="button" role="menuitem" onClick={() => {
              const documentId = menu.documentId;
              setMenu(null);
              onRename(documentId);
            }}><PencilLine size={15} /><span>{copy.rename}</span></button>
          )}
          {onDelete && (
            <button type="button" role="menuitem" className={styles.pageTreeMenuDanger} onClick={() => {
              const documentId = menu.documentId;
              setMenu(null);
              onDelete(documentId);
            }}><Trash2 size={15} /><span>{copy.delete}</span></button>
          )}
        </div>
      )}
    </>
  );
}
