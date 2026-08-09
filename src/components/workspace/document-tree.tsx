"use client";

import Link from "next/link";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  FileText,
  GripVertical,
  IndentDecrease,
  IndentIncrease,
  PencilLine,
  Plus,
  Trash2,
} from "lucide-react";
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
      moveUp: "Move up",
      moveDown: "Move down",
      moveIntoPrevious: "Move into previous document",
      moveOut: "Move out one level",
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
      moveUp: "위로 이동",
      moveDown: "아래로 이동",
      moveIntoPrevious: "이전 문서 아래로 이동",
      moveOut: "한 단계 밖으로 이동",
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
      moveUp: "上へ移動",
      moveDown: "下へ移動",
      moveIntoPrevious: "前の文書の下へ移動",
      moveOut: "1階層外へ移動",
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
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const treeRef = useRef<HTMLElement>(null);
  const dropTargetRef = useRef<{
    documentId: string;
    position: DocumentTreeDropPosition;
  } | null>(null);
  const suppressNavigationRef = useRef(false);
  const dragInputRef = useRef<"mouse" | "pointer" | null>(null);
  const activeDragCleanupRef = useRef<(() => void) | null>(null);
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

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenu(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => menuTriggerRef.current?.focus());
    }
  }, []);

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

  useLayoutEffect(() => {
    if (!menu) return;
    const firstEnabledItem = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    (firstEnabledItem ?? menuRef.current)?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if ((target as Element).closest?.("[data-document-menu-trigger]")) return;
      closeMenu();
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    }
    function closeOnViewportChange() {
      closeMenu();
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
  }, [closeMenu, menu]);

  useEffect(() => () => {
    activeDragCleanupRef.current?.();
    activeDragCleanupRef.current = null;
    dragInputRef.current = null;
    suppressNavigationRef.current = false;
  }, []);

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

  function toggleMenu(event: ReactMouseEvent<HTMLButtonElement>, documentId: string) {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 210;
    const itemCount = (onReorder ? 4 : 0) + (onRename ? 1 : 0) + (onDelete ? 1 : 0);
    const height = itemCount * 41 + 12;
    const gap = 6;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + gap;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - gap);
    menuTriggerRef.current = event.currentTarget;
    setMenu((current) => current?.documentId === documentId ? null : { documentId, top, left });
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ) ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? (activeIndex <= 0 ? items.length - 1 : activeIndex - 1)
          : (activeIndex + 1) % items.length;
    items[nextIndex]?.focus();
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

  function resolveDropTargetAtPoint(
    sourceDocumentId: string,
    clientX: number,
    clientY: number,
  ) {
    const targetElement = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-document-id]");
    if (targetElement) {
      return resolveDropTarget(
        sourceDocumentId,
        targetElement.dataset.documentId ?? "",
        clientY,
        targetElement,
      );
    }

    // Auto-scrolling can move the row out from under a stationary pointer
    // between two move events. Keep the last valid row while the pointer is
    // still inside the tree instead of silently turning a valid drop into a
    // no-op. Leaving the tree (or hovering an explicitly invalid row above)
    // still clears the target.
    const treeRect = treeRef.current?.getBoundingClientRect();
    const insideTree = treeRect
      && clientX >= treeRect.left
      && clientX <= treeRect.right
      && clientY >= treeRect.top
      && clientY <= treeRect.bottom;
    return insideTree ? dropTargetRef.current : null;
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

  function siblingReorderTarget(documentId: string, direction: -1 | 1) {
    const source = documentsById.get(documentId);
    if (!source) return null;
    const siblings = documents
      .filter((candidate) => candidate.parentDocumentId === source.parentDocumentId)
      .sort((left, right) => left.treeOrder - right.treeOrder
        || left.title.localeCompare(right.title, localeTag(locale)));
    const sourceIndex = siblings.findIndex((candidate) => candidate.id === documentId);
    const target = siblings[sourceIndex + direction];
    if (!target) return null;
    return {
      documentId: target.id,
      position: direction < 0 ? "before" as const : "after" as const,
    };
  }

  function moveAmongSiblings(documentId: string, direction: -1 | 1) {
    const target = siblingReorderTarget(documentId, direction);
    if (!target || reorderPending) return;
    closeMenu(true);
    void commitReorder(documentId, target);
  }

  function indentReorderTarget(documentId: string) {
    const previousSibling = siblingReorderTarget(documentId, -1);
    return previousSibling
      ? { documentId: previousSibling.documentId, position: "inside" as const }
      : null;
  }

  function outdentReorderTarget(documentId: string) {
    const source = documentsById.get(documentId);
    if (!source?.parentDocumentId) return null;
    const parent = documentsById.get(source.parentDocumentId);
    return parent ? { documentId: parent.id, position: "after" as const } : null;
  }

  function moveToHierarchyTarget(
    documentId: string,
    target: { documentId: string; position: DocumentTreeDropPosition } | null,
  ) {
    if (!target || reorderPending) return;
    closeMenu(true);
    void commitReorder(documentId, target);
  }

  function startPointerReorder(
    event: ReactPointerEvent<HTMLElement>,
    documentId: string,
  ) {
    if (
      event.pointerType === "mouse"
      || dragInputRef.current
      || !onReorder
      || reorderPending
      || !event.isPrimary
      || event.button !== 0
    ) return;
    dragInputRef.current = "pointer";
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const captureTarget = event.currentTarget;
    let active = false;

    // Touch drag owns gestures only on the dedicated handle. Capturing at
    // pointerdown prevents iOS/WebKit from losing the gesture when the finger
    // leaves the small handle while the rest of the row remains scrollable.
    event.preventDefault();
    try {
      captureTarget.setPointerCapture(pointerId);
    } catch {
      // Some synthetic test events cannot establish capture. The window
      // listeners below still provide a safe fallback for those events.
    }

    const releaseCapture = () => {
      try {
        if (captureTarget.hasPointerCapture(pointerId)) {
          captureTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // The browser may already have released capture after pointercancel.
      }
    };

    let cleaned = false;
    const removeListeners = () => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      releaseCapture();
      if (activeDragCleanupRef.current === removeListeners) {
        activeDragCleanupRef.current = null;
      }
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
      const nextTarget = resolveDropTargetAtPoint(
        documentId,
        moveEvent.clientX,
        moveEvent.clientY,
      );
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
      dragInputRef.current = null;
      if (!active) return;
      finishEvent.preventDefault();
      const finalTarget = resolveDropTargetAtPoint(
        documentId,
        finishEvent.clientX,
        finishEvent.clientY,
      );
      window.setTimeout(() => {
        suppressNavigationRef.current = false;
      }, 0);
      void commitReorder(documentId, finalTarget);
    };
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      removeListeners();
      dragInputRef.current = null;
      suppressNavigationRef.current = false;
      clearDragState();
    };

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish, { passive: false });
    window.addEventListener("pointercancel", cancel);
    activeDragCleanupRef.current = removeListeners;
  }

  function startMouseReorder(
    event: ReactMouseEvent<HTMLDivElement>,
    documentId: string,
  ) {
    if (dragInputRef.current || !onReorder || reorderPending || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest("[data-document-tree-action]")) return;

    dragInputRef.current = "mouse";
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;

    let cleaned = false;
    const removeListeners = () => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      if (activeDragCleanupRef.current === removeListeners) {
        activeDragCleanupRef.current = null;
      }
    };
    const move = (moveEvent: MouseEvent) => {
      if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return;
      if (!active) {
        active = true;
        suppressNavigationRef.current = true;
        setDraggingDocumentId(documentId);
        setDropTarget(null);
        setReorderError("");
      }
      moveEvent.preventDefault();
      const nextTarget = resolveDropTargetAtPoint(
        documentId,
        moveEvent.clientX,
        moveEvent.clientY,
      );
      dropTargetRef.current = nextTarget;
      setDropTarget((current) => current && nextTarget
        && current.documentId === nextTarget.documentId
        && current.position === nextTarget.position
        ? current
        : nextTarget);
      autoScrollTree(moveEvent.clientY);
    };
    const finish = (finishEvent: MouseEvent) => {
      removeListeners();
      dragInputRef.current = null;
      if (!active) return;
      finishEvent.preventDefault();
      const finalTarget = resolveDropTargetAtPoint(
        documentId,
        finishEvent.clientX,
        finishEvent.clientY,
      );
      window.setTimeout(() => {
        suppressNavigationRef.current = false;
      }, 0);
      void commitReorder(documentId, finalTarget);
    };

    window.addEventListener("mousemove", move, { passive: false });
    window.addEventListener("mouseup", finish, { passive: false });
    activeDragCleanupRef.current = removeListeners;
  }

  function renderNode(node: DocumentTreeNode, depth: number) {
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.id);
    const isActive = node.id === activeDocumentId;
    return (
      <div className={styles.pageTreeBranch} key={node.id}>
        <div
          className={`${styles.pageTreeRow} ${onRename || onDelete || onReorder ? styles.pageTreeRowWithMenu : ""} ${isActive ? styles.pageTreeActive : ""}`}
          data-active-document={isActive ? "true" : undefined}
          data-document-id={node.id}
          data-reorderable={onReorder ? "true" : undefined}
          data-dragging={draggingDocumentId === node.id ? "true" : undefined}
          data-drop-position={dropTarget?.documentId === node.id ? dropTarget.position : undefined}
          aria-grabbed={onReorder ? draggingDocumentId === node.id : undefined}
          onMouseDown={(event) => startMouseReorder(event, node.id)}
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
          {onReorder && (
            <span
              className={styles.pageTreeDragHandle}
              data-document-tree-drag-handle
              onPointerDown={(event) => startPointerReorder(event, node.id)}
              aria-hidden="true"
            >
              <GripVertical size={15} />
            </span>
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
          {(onRename || onDelete || onReorder) && (
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
      {menu && (onRename || onDelete || onReorder) && (
        <div
          ref={menuRef}
          className={styles.pageTreeMenuDropdown}
          role="menu"
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
          style={{ top: menu.top, left: menu.left }}
        >
          {onReorder && (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={!siblingReorderTarget(menu.documentId, -1) || reorderPending}
                onClick={() => moveAmongSiblings(menu.documentId, -1)}
              ><ChevronUp size={15} /><span>{copy.moveUp}</span></button>
              <button
                type="button"
                role="menuitem"
                disabled={!siblingReorderTarget(menu.documentId, 1) || reorderPending}
                onClick={() => moveAmongSiblings(menu.documentId, 1)}
              ><ChevronDown size={15} /><span>{copy.moveDown}</span></button>
              <button
                type="button"
                role="menuitem"
                disabled={!indentReorderTarget(menu.documentId) || reorderPending}
                onClick={() => moveToHierarchyTarget(
                  menu.documentId,
                  indentReorderTarget(menu.documentId),
                )}
              ><IndentIncrease size={15} /><span>{copy.moveIntoPrevious}</span></button>
              <button
                type="button"
                role="menuitem"
                disabled={!outdentReorderTarget(menu.documentId) || reorderPending}
                onClick={() => moveToHierarchyTarget(
                  menu.documentId,
                  outdentReorderTarget(menu.documentId),
                )}
              ><IndentDecrease size={15} /><span>{copy.moveOut}</span></button>
            </>
          )}
          {onRename && (
            <button type="button" role="menuitem" onClick={() => {
              const documentId = menu.documentId;
              closeMenu();
              onRename(documentId);
            }}><PencilLine size={15} /><span>{copy.rename}</span></button>
          )}
          {onDelete && (
            <button type="button" role="menuitem" className={styles.pageTreeMenuDanger} onClick={() => {
              const documentId = menu.documentId;
              closeMenu();
              onDelete(documentId);
            }}><Trash2 size={15} /><span>{copy.delete}</span></button>
          )}
        </div>
      )}
    </>
  );
}
