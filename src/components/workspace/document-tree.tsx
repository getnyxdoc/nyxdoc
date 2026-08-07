"use client";

import Link from "next/link";
import {
  type PointerEvent as ReactPointerEvent,
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
import type {
  DocumentSummary,
  DocumentTreeDropPosition,
} from "@/lib/documents/types";
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
  onReorder,
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
  onReorder?: (
    documentId: string,
    targetDocumentId: string,
    position: DocumentTreeDropPosition,
  ) => Promise<void>;
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
      dragToReorder: "Drag {title} to move or reorder it",
      reorderFailed: "Could not move the document.",
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
      dragToReorder: "{title} 문서를 드래그하여 이동 또는 순서 변경",
      reorderFailed: "문서를 이동하지 못했습니다.",
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
      dragToReorder: "{title}をドラッグして移動または並べ替え",
      reorderFailed: "文書を移動できませんでした。",
    },
  }[locale];
  const tree = useMemo(() => buildTree(documents, locale), [documents, locale]);
  const [menu, setMenu] = useState<{ documentId: string; top: number; left: number } | null>(null);
  const [draggingDocumentId, setDraggingDocumentId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    documentId: string;
    position: DocumentTreeDropPosition;
  } | null>(null);
  const [reorderPending, setReorderPending] = useState(false);
  const [reorderError, setReorderError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLElement>(null);
  const dropTargetRef = useRef<{
    documentId: string;
    position: DocumentTreeDropPosition;
  } | null>(null);
  const suppressNavigationRef = useRef(false);
  const storageKey = navigationStateKey
    ? `nyxdoc:document-tree:${userId}:${workspaceId}:${navigationStateKey}`
    : null;
  const documentIds = useMemo(
    () => new Set(documents.map((document) => document.id)),
    [documents],
  );
  const documentsById = useMemo(
    () => new Map(documents.map((document) => [document.id, document])),
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

  function clearDragState() {
    dropTargetRef.current = null;
    setDraggingDocumentId(null);
    setDropTarget(null);
  }

  function resolveDropTarget(
    sourceDocumentId: string,
    targetDocumentId: string,
    clientY: number,
    targetElement: HTMLElement,
  ) {
    if (!onReorder || sourceDocumentId === targetDocumentId) return null;
    const source = documentsById.get(sourceDocumentId);
    const target = documentsById.get(targetDocumentId);
    if (!source || !target) return null;
    const rect = targetElement.getBoundingClientRect();
    const verticalRatio = (clientY - rect.top) / Math.max(rect.height, 1);
    const position: DocumentTreeDropPosition = verticalRatio < 0.27
      ? "before"
      : verticalRatio > 0.73
        ? "after"
        : "inside";
    const destinationParentDocumentId = position === "inside"
      ? target.id
      : target.parentDocumentId;
    let ancestorId = destinationParentDocumentId;
    const visited = new Set<string>();
    while (ancestorId && !visited.has(ancestorId)) {
      if (ancestorId === source.id) return null;
      visited.add(ancestorId);
      ancestorId = documentsById.get(ancestorId)?.parentDocumentId ?? null;
    }
    return { documentId: targetDocumentId, position };
  }

  function autoScrollTree(clientY: number) {
    const treeElement = treeRef.current;
    if (!treeElement) return;
    const treeRect = treeElement.getBoundingClientRect();
    const edge = 36;
    if (clientY < treeRect.top + edge) treeElement.scrollTop -= 18;
    else if (clientY > treeRect.bottom - edge) treeElement.scrollTop += 18;
  }

  async function commitReorder(
    sourceDocumentId: string,
    target: { documentId: string; position: DocumentTreeDropPosition } | null,
  ) {
    clearDragState();
    if (!onReorder || !target) return;
    setReorderPending(true);
    setReorderError("");
    try {
      await onReorder(sourceDocumentId, target.documentId, target.position);
      if (target.position === "inside" && !expanded.has(target.documentId)) {
        onExpandedDocumentIdsChange([...expanded, target.documentId]);
      }
    } catch (error) {
      setReorderError(error instanceof Error && error.message ? error.message : copy.reorderFailed);
    } finally {
      setReorderPending(false);
    }
  }

  function startPointerReorder(
    event: ReactPointerEvent<HTMLDivElement>,
    documentId: string,
  ) {
    if (!onReorder || reorderPending || !event.isPrimary || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest("[data-document-tree-action]")) return;

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;

    const removeListeners = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return;
      if (!active) {
        active = true;
        suppressNavigationRef.current = true;
        setDraggingDocumentId(documentId);
        setDropTarget(null);
        setReorderError("");
      }
      moveEvent.preventDefault();
      const targetElement = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>("[data-document-id]");
      const nextTarget = targetElement
        ? resolveDropTarget(documentId, targetElement.dataset.documentId ?? "", moveEvent.clientY, targetElement)
        : null;
      dropTargetRef.current = nextTarget;
      setDropTarget((current) => current && nextTarget
        && current.documentId === nextTarget.documentId
        && current.position === nextTarget.position
        ? current
        : nextTarget);
      autoScrollTree(moveEvent.clientY);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      removeListeners();
      if (!active) return;
      finishEvent.preventDefault();
      const finalTarget = dropTargetRef.current;
      window.setTimeout(() => {
        suppressNavigationRef.current = false;
      }, 0);
      void commitReorder(documentId, finalTarget);
    };
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      removeListeners();
      suppressNavigationRef.current = false;
      clearDragState();
    };

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish, { passive: false });
    window.addEventListener("pointercancel", cancel);
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
          data-document-id={node.id}
          data-reorderable={onReorder ? "true" : undefined}
          data-dragging={draggingDocumentId === node.id ? "true" : undefined}
          data-drop-position={dropTarget?.documentId === node.id ? dropTarget.position : undefined}
          aria-grabbed={onReorder ? draggingDocumentId === node.id : undefined}
          onPointerDown={(event) => startPointerReorder(event, node.id)}
          style={{ paddingLeft: `${6 + depth * 15}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              className={styles.pageTreeToggle}
              data-document-tree-action
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
                if (suppressNavigationRef.current) return;
                rememberScrollPosition();
                onDiagnostic?.({ action: "navigate" });
                onNavigate(node.id);
              }}
              aria-current={isActive ? "page" : undefined}
              title={onReorder ? formatCopy(copy.dragToReorder, { title: node.title }) : node.title}
            >
              <FileText size={14} />
              <span>{node.title}</span>
            </button>
          ) : (
            <Link
              href={`/app?workspace=${encodeURIComponent(workspaceId)}&document=${encodeURIComponent(node.id)}`}
              className={styles.pageTreeLink}
              draggable={false}
              aria-current={isActive ? "page" : undefined}
              title={onReorder ? formatCopy(copy.dragToReorder, { title: node.title }) : node.title}
              onClick={(event) => {
                if (suppressNavigationRef.current) {
                  event.preventDefault();
                  return;
                }
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
              data-document-tree-action
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
              data-document-tree-action
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
        {reorderError && <p className={styles.pageTreeError} role="alert">{reorderError}</p>}
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
