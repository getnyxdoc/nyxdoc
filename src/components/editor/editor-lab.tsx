"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useHorizontalDragScroll } from "@/components/use-horizontal-drag-scroll";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  CheckCircle2,
  Code2,
  Combine,
  ExternalLink,
  FlaskConical,
  FileCode2,
  FileText,
  IndentDecrease,
  IndentIncrease,
  ImageIcon,
  Italic,
  Keyboard,
  Link2,
  List as ListIcon,
  ListChecks,
  ListOrdered,
  LoaderCircle,
  PanelLeftClose,
  PanelTopClose,
  Redo2,
  Split,
  Strikethrough,
  Table2,
  Trash2,
  Underline,
  Undo2,
  Unlink2,
  X,
} from "lucide-react";
import type {
  TElement,
  TLinkElement,
  TTableCellElement,
  TTableElement,
  TTableRowElement,
  Value,
} from "platejs";
import { KEYS, NodeApi, PathApi, RangeApi } from "platejs";
import { slateNodesToInsertDelta } from "@slate-yjs/core";
import {
  BoldRules,
  CodeRules,
  HeadingRules,
  HorizontalRuleRules,
  ItalicRules,
  StrikethroughRules,
} from "@platejs/basic-nodes";
import {
  BoldPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  HorizontalRulePlugin,
  ItalicPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import { CodeBlockRules, insertEmptyCodeBlock } from "@platejs/code-block";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import {
  FontBackgroundColorPlugin,
  FontColorPlugin,
  FontSizePlugin,
  TextAlignPlugin,
} from "@platejs/basic-styles/react";
import { setAlign } from "@platejs/basic-styles";
import { indent, outdent } from "@platejs/indent";
import { IndentPlugin } from "@platejs/indent/react";
import {
  BulletedListRules,
  OrderedListRules,
  TaskListRules,
  toggleList,
} from "@platejs/list";
import {
  ListPlugin,
  useTodoListElement,
  useTodoListElementState,
} from "@platejs/list/react";
import { ResizeHandle } from "@platejs/resizable";
import { ImagePlugin } from "@platejs/media/react";
import { LinkRules, unwrapLink } from "@platejs/link";
import { LinkPlugin, useLink } from "@platejs/link/react";
import { SlashInputPlugin, SlashPlugin } from "@platejs/slash-command/react";
import { TrailingBlockPlugin } from "@platejs/utils";
import type { UnifiedProvider, YjsProviderConfig } from "@platejs/yjs";
import { YjsPlugin } from "@platejs/yjs/react";
import * as Y from "yjs";
import {
  deleteColumn,
  deleteRow,
  deleteTable,
  insertTable,
  insertTableColumn,
  insertTableRow,
  mergeTableCells,
  splitTableCell,
} from "@platejs/table";
import {
  TableCellHeaderPlugin,
  TableCellPlugin,
  TablePlugin,
  TableProvider,
  TableRowPlugin,
  useTableCellElement,
  useTableCellElementResizable,
  useTableColSizes,
  useTableElement,
  useTableMergeState,
  useTableSelectionDom,
} from "@platejs/table/react";
import {
  ParagraphPlugin,
  Plate,
  PlateContent,
  PlateElement,
  Key,
  createPlatePlugin,
  useEditorSelection,
  useFocused,
  useEditorState,
  createPlateEditor,
  usePlateEditor,
  useSelected,
  type PlateEditor,
  type PlateElementProps,
} from "platejs/react";
import {
  NYXDOC_FONT_SIZES,
  nyxdocDocumentV2Schema,
  projectNyxdocEditorContent,
  type NyxdocDocumentV2,
} from "@/lib/editor/schema";
import {
  documentNodeIdRepairs,
  repairDocumentNodeIds,
  type DocumentNodeIdRepair,
} from "@/lib/editor/node-ids";
import {
  deserializeLargeHtmlDocument,
  deserializeLargePlainTextDocument,
} from "@/lib/editor/large-html-paste";
import {
  CollaborativeNodeIdPlugin,
  shouldAssignCollaborativeNodeId,
} from "@/lib/editor/collaborative-node-ids";
import {
  diagnosticKey,
  getCaretTraceRecorder,
} from "@/lib/editor/caret-trace";
import type {
  CaretIncidentReason,
  CaretSelectionSnapshot,
  CaretTraceEvent,
} from "@/lib/editor/diagnostics";
import { useI18n } from "@/lib/i18n/client";
import { formatCopy } from "@/lib/i18n/copy";
import { uploadMediaFile } from "@/lib/media/client";
import styles from "./editor-lab.module.css";
import {
  EDITOR_COPY,
  EDITOR_LAB_CHECKS,
  EDITOR_SHORTCUT_GROUPS,
} from "./editor-lab.copy";
import { NyxdocSlashInputElement } from "./slash-command";

type ListParagraphElement = TElement & {
  align?: string;
  checked?: boolean;
  indent?: number;
  listStart?: number;
  listStyleType?: string;
};

export type NyxdocEditorDocumentLink = {
  id: string;
  title: string;
  pathLabel: string;
};

type NyxdocLinkRenderContextValue = {
  documentId?: string;
  externalLinkTitles: ReadonlyMap<string, ResolvedExternalLinkPreview>;
  mode: "workspace" | "public";
  workspaceId?: string;
};

const EMPTY_EXTERNAL_LINK_TITLES = new Map<string, ResolvedExternalLinkPreview>();
const NyxdocLinkRenderContext = createContext<NyxdocLinkRenderContextValue>({
  externalLinkTitles: EMPTY_EXTERNAL_LINK_TITLES,
  mode: "workspace",
});

type NyxdocDocumentReferenceElement = TElement & {
  autoTitle?: boolean;
  documentId: string;
  sourceUrl?: string;
};

type NyxdocExternalLinkElement = TLinkElement & {
  autoTitle?: boolean;
};

type ResolvedExternalLinkPreview = {
  title: string;
  url: string;
};

const externalLinkPreviewRequests = new Map<
  string,
  Promise<ResolvedExternalLinkPreview | null>
>();
const MAX_EXTERNAL_LINK_PREVIEW_REQUESTS = 300;

function externalLinkTitleCandidate(element: NyxdocExternalLinkElement) {
  if (typeof element.url !== "string") return null;
  const visibleText = NodeApi.string(element).trim();
  try {
    const visibleUrl = normalizeEditorLinkUrl(visibleText);
    const targetUrl = normalizeEditorLinkUrl(element.url);
    return visibleUrl === targetUrl ? targetUrl : null;
  } catch {
    return null;
  }
}

function collectExternalLinkTitleCandidates(value: unknown) {
  const candidates = new Set<string>();
  const visit = (node: unknown) => {
    if (candidates.size >= MAX_EXTERNAL_LINK_PREVIEW_REQUESTS) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const element = node as Partial<NyxdocExternalLinkElement>;
    if (element.type === KEYS.link && Array.isArray(element.children)) {
      const candidate = externalLinkTitleCandidate(element as NyxdocExternalLinkElement);
      if (candidate) candidates.add(candidate);
    }
    if (Array.isArray(element.children)) {
      for (const child of element.children) visit(child);
    }
  };
  visit(value);
  return [...candidates];
}

function resolveExternalLinkPreview({
  documentId,
  url,
  workspaceId,
}: {
  documentId: string;
  url: string;
  workspaceId: string;
}) {
  const key = `${workspaceId}\u0000${documentId}\u0000${url}`;
  const existing = externalLinkPreviewRequests.get(key);
  if (existing) return existing;

  const request = fetch("/api/link-preview", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nyxdoc-workspace-id": workspaceId,
    },
    body: JSON.stringify({ documentId, url }),
  })
    .then(async (response) => {
      const body = await response.json().catch(() => ({})) as {
        title?: string;
        url?: string;
      };
      const title = body.title?.trim().slice(0, 200) ?? "";
      if (!response.ok || !title) return null;
      return { title, url: body.url ?? url };
    })
    .catch(() => null);

  externalLinkPreviewRequests.set(key, request);
  if (externalLinkPreviewRequests.size > MAX_EXTERNAL_LINK_PREVIEW_REQUESTS) {
    const first = externalLinkPreviewRequests.keys().next().value as string | undefined;
    if (first) externalLinkPreviewRequests.delete(first);
  }
  return request;
}

function TodoParagraphElement(props: PlateElementProps<TElement>) {
  const { locale } = useI18n();
  const copy = EDITOR_COPY[locale];
  const element = props.element as ListParagraphElement;
  const state = useTodoListElementState({ element });
  const { checkboxProps } = useTodoListElement(state);

  return (
    <PlateElement {...props} as="div" className={styles.listParagraph}>
      <span className={styles.todoMarker} contentEditable={false}>
        <input
          aria-label={copy.todoComplete}
          checked={checkboxProps.checked}
          type="checkbox"
          onChange={(event) => checkboxProps.onCheckedChange(event.target.checked)}
          onMouseDown={checkboxProps.onMouseDown}
        />
      </span>
      <div className={styles.listContent}>{props.children}</div>
    </PlateElement>
  );
}

function ParagraphElement(props: PlateElementProps<TElement>) {
  const element = props.element as ListParagraphElement;
  const empty = NodeApi.string(element).length === 0;

  if (element.listStyleType === KEYS.listTodo) return <TodoParagraphElement {...props} />;

  if (element.listStyleType) {
    return <PlateElement {...props} as="div" className={styles.listParagraph} />;
  }

  return (
    <PlateElement
      {...props}
      as="p"
      attributes={{
        ...props.attributes,
        "data-nyxdoc-block-id": element.id,
      }}
      className={`${styles.paragraph} ${empty ? styles.emptyParagraph : ""}`}
    />
  );
}

function CalloutElement(props: PlateElementProps<TElement>) {
  return <PlateElement {...props} as="aside" className={styles.callout} />;
}

function FlatBlockquoteElement(props: PlateElementProps<TElement>) {
  return <PlateElement {...props} as="blockquote" />;
}

function openLinkInNewTab(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string | undefined,
) {
  if (!href) return;
  event.preventDefault();
  event.stopPropagation();
  window.open(href, "_blank", "noopener,noreferrer");
}

function NyxdocLinkElement(props: PlateElementProps<TLinkElement>) {
  const { props: linkProps } = useLink({ element: props.element });
  const element = props.element as NyxdocExternalLinkElement;
  const linkContext = useContext(NyxdocLinkRenderContext);
  const candidateUrl = externalLinkTitleCandidate(element);
  const resolvedLink = candidateUrl
    ? linkContext.externalLinkTitles.get(candidateUrl)
    : undefined;
  const resolvedTitle = resolvedLink?.title ?? null;

  return (
    <PlateElement
      {...props}
      as="a"
      attributes={{
        ...props.attributes,
        ...linkProps,
        rel: "noopener noreferrer",
        target: "_blank",
        onClick: (event) => openLinkInNewTab(event, linkProps.href),
        ...(resolvedTitle
          ? {
              "aria-label": resolvedTitle,
              "data-nyxdoc-resolved-link-title": "true",
              title: element.url,
            }
          : {}),
      }}
      className={styles.documentLink}
    >
      {resolvedTitle ? (
        <>
          <span contentEditable={false}>{resolvedTitle}</span>
          <span aria-hidden="true" className={styles.visuallyHidden}>
            {props.children}
          </span>
        </>
      ) : props.children}
    </PlateElement>
  );
}

function DocumentReferenceElement(props: PlateElementProps<TElement>) {
  const element = props.element as NyxdocDocumentReferenceElement;
  const linkContext = useContext(NyxdocLinkRenderContext);
  if (linkContext.mode === "public") {
    return (
      <PlateElement
        {...props}
        as="span"
        attributes={{
          ...props.attributes,
          "data-nyxdoc-document-id": element.documentId,
        }}
        className={styles.documentReference}
      />
    );
  }
  const query = new URLSearchParams({ document: element.documentId });
  if (linkContext.workspaceId) query.set("workspace", linkContext.workspaceId);
  const href = `/app?${query.toString()}`;
  return (
    <PlateElement
      {...props}
      as="a"
      attributes={{
        ...props.attributes,
        href,
        rel: "noopener noreferrer",
        target: "_blank",
        onClick: (event) => openLinkInNewTab(event, href),
        "data-nyxdoc-document-id": element.documentId,
      }}
      className={styles.documentReference}
    />
  );
}

type NyxdocCodeBlockElement = TElement & {
  lang?: string;
};

function CodeBlockElement(props: PlateElementProps<TElement>) {
  const element = props.element as NyxdocCodeBlockElement;
  return (
    <PlateElement
      {...props}
      as="pre"
      attributes={{
        ...props.attributes,
        ...(element.lang ? { "data-language": element.lang } : {}),
      }}
      className={styles.codeBlock}
    >
      <code>{props.children}</code>
    </PlateElement>
  );
}

function CodeLineElement(props: PlateElementProps<TElement>) {
  return <PlateElement {...props} as="div" className={styles.codeLine} />;
}

type NyxdocEditorImageElement = TElement & {
  alt?: string;
  mediaId?: string;
  name?: string;
  uploadState?: "uploading";
  url?: string;
  width?: number;
};

function NyxdocImageElement(props: PlateElementProps<TElement>) {
  const { locale } = useI18n();
  const copy = EDITOR_COPY[locale];
  const element = props.element as NyxdocEditorImageElement;
  const linkContext = useContext(NyxdocLinkRenderContext);
  const selected = useSelected();
  const focused = useFocused();
  const uploading = element.uploadState === "uploading";
  const renderedUrl = element.url
    && linkContext.mode === "workspace"
    && linkContext.documentId
    && element.url.startsWith("/api/media/")
      ? `${element.url}?${new URLSearchParams({ document: linkContext.documentId }).toString()}`
      : element.url;

  return (
    <PlateElement {...props} className={styles.imageElement}>
      <figure
        className={`${styles.imageFigure} ${selected && focused ? styles.imageFigureSelected : ""}`}
        contentEditable={false}
        style={element.width ? { width: element.width } : undefined}
      >
        {renderedUrl ? (
          // The Next image optimizer cannot forward the viewer's session cookie
          // to this authenticated media route, so the editor renders it directly.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={element.alt || ""}
            className={styles.documentImage}
            draggable={false}
            src={renderedUrl}
          />
        ) : (
          <div className={styles.imageFallback}><ImageIcon aria-hidden="true" size={24} /></div>
        )}
        {uploading && (
          <span className={styles.imageUploadOverlay} role="status">
            <LoaderCircle aria-hidden="true" className={styles.spinner} size={20} />
            {copy.imageUploading}
          </span>
        )}
      </figure>
      {props.children}
    </PlateElement>
  );
}

function findElementPathById(editor: PlateEditor, id: string) {
  for (const [, path] of editor.api.nodes<TElement>({
    at: [],
    match: (node) => (node as { id?: unknown }).id === id,
  })) {
    return path;
  }
  return undefined;
}

type StableCaretPointBookmark = {
  elementId: string;
  offset: number;
  relativePath: number[];
};

type StableCaretBookmark = {
  anchor: StableCaretPointBookmark;
  focus: StableCaretPointBookmark;
};

function stableCaretPointBookmark(
  editor: PlateEditor,
  point: { path: number[]; offset: number },
): StableCaretPointBookmark | null {
  for (let depth = point.path.length - 1; depth >= 1; depth -= 1) {
    try {
      const node = NodeApi.get(editor, point.path.slice(0, depth)) as { id?: unknown };
      if (typeof node.id === "string" && node.id) {
        return {
          elementId: node.id,
          relativePath: point.path.slice(depth),
          offset: point.offset,
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function stableCaretBookmark(
  editor: PlateEditor,
  selection: PlateEditor["selection"],
): StableCaretBookmark | null {
  if (!selection) return null;
  const anchor = stableCaretPointBookmark(editor, selection.anchor);
  const focus = stableCaretPointBookmark(editor, selection.focus);
  return anchor && focus ? { anchor, focus } : null;
}

function pointFromStableCaretBookmark(
  editor: PlateEditor,
  bookmark: StableCaretPointBookmark,
) {
  const elementPath = findElementPathById(editor, bookmark.elementId);
  if (!elementPath) return null;
  const preferredPath = [...elementPath, ...bookmark.relativePath];
  try {
    const node = NodeApi.get(editor, preferredPath) as { text?: unknown };
    if (typeof node.text === "string") {
      return {
        path: preferredPath,
        offset: Math.min(bookmark.offset, node.text.length),
      };
    }
  } catch {
    // The element survived but its inline shape changed. Fall back to its end.
  }
  try {
    return editor.api.end(elementPath);
  } catch {
    return null;
  }
}

function restoreStableCaretBookmark(
  editor: PlateEditor,
  bookmark: StableCaretBookmark,
  resetSelection = false,
) {
  const anchor = pointFromStableCaretBookmark(editor, bookmark.anchor);
  const focus = pointFromStableCaretBookmark(editor, bookmark.focus);
  if (!anchor || !focus) return false;
  if (resetSelection) editor.tf.deselect();
  editor.tf.select({ anchor, focus });
  editor.tf.focus();
  return true;
}

function TableElementInner(props: PlateElementProps<TTableElement>) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { marginLeft, props: tableProps } = useTableElement();
  const storedColSizes = useTableColSizes();
  useTableSelectionDom(tableRef);

  const firstRow = props.element.children[0] as TTableRowElement | undefined;
  const columnCount = firstRow?.children.length ?? 1;
  const colSizes = storedColSizes.length
    ? storedColSizes
    : Array.from({ length: columnCount }, () => 180);
  const width = colSizes.reduce((total, size) => total + (size || 180), 0);

  return (
    <PlateElement {...props} className={styles.tableElement} style={{ paddingLeft: marginLeft }}>
      <div className={styles.tableScroll}>
        <table
          ref={tableRef}
          {...tableProps}
          className={styles.table}
          style={{ width }}
        >
          <colgroup>
            {colSizes.map((size, index) => (
              <col key={index} style={{ width: size || 180 }} />
            ))}
          </colgroup>
          <tbody>{props.children}</tbody>
        </table>
      </div>
    </PlateElement>
  );
}

function TableElement(props: PlateElementProps<TTableElement>) {
  return (
    <TableProvider>
      <TableElementInner {...props} />
    </TableProvider>
  );
}

function TableRowElement(props: PlateElementProps<TTableRowElement>) {
  return <PlateElement {...props} as="tr" className={styles.tableRow} />;
}

function TableCellElement({
  isHeader = false,
  ...props
}: PlateElementProps<TTableCellElement> & { isHeader?: boolean }) {
  const state = useTableCellElement();
  const resize = useTableCellElementResizable({
    colIndex: state.colIndex,
    colSpan: state.colSpan,
    rowIndex: state.rowIndex,
  });
  const CellTag = isHeader ? "th" : "td";

  return (
    <PlateElement
      {...props}
      as={CellTag}
      className={`${styles.tableCell} ${isHeader ? styles.tableHeaderCell : ""}`}
      attributes={{
        ...props.attributes,
        colSpan: state.colSpan,
        "data-table-cell-id": props.element.id,
        rowSpan: props.element.rowSpan,
      }}
      style={{
        background: props.element.background,
        maxWidth: state.width,
        minWidth: state.width,
        width: state.width,
      }}
    >
      <div className={styles.tableCellContent} style={{ minHeight: state.minHeight }}>
        {props.children}
      </div>
      <ResizeHandle
        {...resize.rightProps}
        className={`${styles.resizeHandle} ${styles.resizeHandleRight}`}
        contentEditable={false}
      />
      <ResizeHandle
        {...resize.bottomProps}
        className={`${styles.resizeHandle} ${styles.resizeHandleBottom}`}
        contentEditable={false}
      />
      {!resize.hiddenLeft && (
        <ResizeHandle
          {...resize.leftProps}
          className={`${styles.resizeHandle} ${styles.resizeHandleLeft}`}
          contentEditable={false}
        />
      )}
    </PlateElement>
  );
}

function TableHeaderCellElement(props: PlateElementProps<TTableCellElement>) {
  return <TableCellElement {...props} isHeader />;
}

const textBlockTypes = [KEYS.p, ...KEYS.heading, KEYS.blockquote, KEYS.callout];

const CalloutPlugin = createPlatePlugin({
  key: KEYS.callout,
  node: { isElement: true },
}).withComponent(CalloutElement);

const FlatBlockquotePlugin = createPlatePlugin({
  key: KEYS.blockquote,
  node: { isElement: true },
}).withComponent(FlatBlockquoteElement);

const DocumentReferencePlugin = createPlatePlugin({
  key: "doc_ref",
  node: { isElement: true, isInline: true },
}).withComponent(DocumentReferenceElement);

const listBlockProperties = [
  "checked",
  "indent",
  "listRestart",
  "listRestartPolite",
  "listStart",
  "listStyleType",
] as const;

function domEditorSelection(editor: PlateEditor) {
  if (typeof window === "undefined") return editor.selection;
  const domSelection = window.getSelection();
  if (!domSelection || domSelection.rangeCount === 0) return editor.selection;
  return editor.api.toSlateRange(domSelection, {
    exactMatch: false,
    suppressThrow: true,
  }) ?? editor.selection;
}

function syncEditorSelectionFromDOM(editor: PlateEditor) {
  const selection = domEditorSelection(editor);
  if (selection) editor.tf.select(selection);
  return selection;
}

function diagnosticIdentifier(value: string | undefined, fallback = "other") {
  if (!value || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) return fallback;
  return value;
}

function tableLocationForPoint(editor: PlateEditor, path: number[]) {
  let blockIndex: number | undefined;
  let rowIndex: number | undefined;
  let columnIndex: number | undefined;
  try {
    for (let depth = 1; depth < path.length; depth += 1) {
      const node = NodeApi.get(editor, path.slice(0, depth)) as TElement;
      if (node.type === KEYS.table) blockIndex = path[0];
      if (node.type === KEYS.tr) rowIndex = path[depth - 1];
      if (node.type === KEYS.td || node.type === KEYS.th) {
        columnIndex = path[depth - 1];
      }
    }
  } catch {
    return undefined;
  }
  if (blockIndex === undefined || rowIndex === undefined || columnIndex === undefined) {
    return undefined;
  }
  return { blockIndex, rowIndex, columnIndex };
}

function caretSelectionSnapshot(
  editor: PlateEditor,
  selection: PlateEditor["selection"],
  root: HTMLElement | null,
): CaretSelectionSnapshot {
  const selectedCellCount = root?.querySelectorAll('[data-table-cell-selected="true"]').length ?? 0;
  if (!selection) return {
    kind: selectedCellCount > 0 ? "cells" : "none",
    selectedCellCount,
  };
  return {
    kind: selectedCellCount > 0 ? "cells" : "text",
    collapsed: RangeApi.isCollapsed(selection),
    anchor: {
      path: [...selection.anchor.path],
      offset: selection.anchor.offset,
    },
    focus: {
      path: [...selection.focus.path],
      offset: selection.focus.offset,
    },
    table: tableLocationForPoint(editor, selection.anchor.path),
    selectedCellCount,
  };
}

function editorHasFocus(root: HTMLElement | null) {
  if (!root || typeof document === "undefined") return false;
  if (root.contains(document.activeElement)) return true;
  const anchorNode = document.getSelection()?.anchorNode;
  return Boolean(anchorNode && root.contains(anchorNode));
}

function setSelectedTextBlockType(editor: PlateEditor, type: string) {
  if (!editor.selection) return false;

  const entries = editor.api.blocks<ListParagraphElement>({
    at: editor.selection,
    match: (node) => {
      const nodeType = (node as TElement).type;
      return typeof nodeType === "string" && (textBlockTypes as string[]).includes(nodeType);
    },
  });
  if (entries.length === 0) return false;

  editor.tf.withoutNormalizing(() => {
    for (const [, path] of entries) {
      editor.tf.unsetNodes([...listBlockProperties], { at: path });
      editor.tf.setNodes({ type }, { at: path });
    }
  });
  return true;
}

function toggleNyxdocList(editor: PlateEditor, listStyleType: string) {
  const current = editor.api.block<ListParagraphElement>()?.[0];
  if (current?.listStyleType !== listStyleType) {
    setSelectedTextBlockType(editor, KEYS.p);
  }
  toggleList(editor, { listStyleType });
}

function notionBlockShortcutDigit(code: string, key: string) {
  const digitMatch = /^(?:Digit|Numpad)([0-6])$/.exec(code);
  if (digitMatch) return Number(digitMatch[1]);
  if (/^[0-6]$/.test(key)) return Number(key);
  return ({
    ")": 0,
    "!": 1,
    "@": 2,
    "#": 3,
    "$": 4,
    "%": 5,
    "^": 6,
  } as Record<string, number>)[key];
}

const NotionShortcutPlugin = createPlatePlugin({
  key: "nyxdoc-notion-shortcuts",
  handlers: {
    onKeyDown: ({ editor, event }) => {
      if (event.nativeEvent.isComposing) return;

      const mod = event.ctrlKey || event.metaKey;

      if (
        event.key !== " "
        || mod
        || event.altKey
        || event.shiftKey
        || !editor.selection
        || !RangeApi.isCollapsed(editor.selection)
      ) return;

      const block = editor.api.block<TElement>();
      if (!block || block[1].length !== 1) return;
      const blockStart = editor.api.start(block[1]);
      if (!blockStart) return;
      const marker = editor.api.string({
        anchor: blockStart,
        focus: editor.selection.anchor,
      });
      if (marker !== "\"" && marker !== ">" && marker !== "+") return;

      event.preventDefault();
      editor.tf.deleteBackward("character");
      if (marker === "+") {
        toggleNyxdocList(editor, KEYS.ul);
      } else {
        setSelectedTextBlockType(editor, KEYS.blockquote);
      }
      return true;
    },
  },
  shortcuts: {
    bold: {
      keys: [[Key.Mod, "b"]],
      preventDefault: true,
      handler: ({ editor }) => editor.tf.toggleMark(KEYS.bold),
    },
    italic: {
      keys: [[Key.Mod, "i"]],
      preventDefault: true,
      handler: ({ editor }) => editor.tf.toggleMark(KEYS.italic),
    },
    underline: {
      keys: [[Key.Mod, "u"]],
      preventDefault: true,
      handler: ({ editor }) => editor.tf.toggleMark(KEYS.underline),
    },
    inlineCode: {
      keys: [[Key.Mod, "e"]],
      preventDefault: true,
      handler: ({ editor }) => editor.tf.toggleMark(KEYS.code),
    },
    strikethrough: {
      keys: [[Key.Mod, Key.Shift, "s"]],
      preventDefault: true,
      handler: ({ editor }) => editor.tf.toggleMark(KEYS.strikethrough),
    },
    toggleTodo: {
      keys: [[Key.Mod, Key.Enter]],
      preventDefault: true,
      handler: ({ editor }) => {
        const entry = editor.api.block<ListParagraphElement>();
        if (!entry || entry[0].listStyleType !== KEYS.listTodo) return false;
        editor.tf.setNodes({ checked: entry[0].checked !== true }, { at: entry[1] });
        return true;
      },
    },
  },
});

const editorPlugins = [
  ParagraphPlugin.withComponent(ParagraphElement),
  TrailingBlockPlugin,
  H1Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  H2Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  H3Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  H4Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  H5Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  H6Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  FlatBlockquotePlugin,
  HorizontalRulePlugin.configure({ inputRules: [HorizontalRuleRules.markdown()] }),
  CalloutPlugin,
  CodeBlockPlugin.configure({
    inputRules: [CodeBlockRules.markdown({ on: "match" })],
    node: { component: CodeBlockElement },
    options: { defaultLanguage: null },
    shortcuts: { toggle: { keys: "mod+alt+8" } },
  }),
  CodeLinePlugin.withComponent(CodeLineElement),
  BoldPlugin.configure({ inputRules: [BoldRules.markdown()] }),
  ItalicPlugin.configure({ inputRules: [ItalicRules.markdown()] }),
  UnderlinePlugin,
  StrikethroughPlugin.configure({ inputRules: [StrikethroughRules.markdown()] }),
  CodePlugin.configure({ inputRules: [CodeRules.markdown()] }),
  NotionShortcutPlugin,
  LinkPlugin.configure({
    inputRules: [
      LinkRules.markdown(),
      LinkRules.autolink({ variant: "space" }),
      LinkRules.autolink({ variant: "break" }),
      LinkRules.autolink({ variant: "paste" }),
    ],
    options: {
      allowedSchemes: ["http", "https"],
      defaultLinkAttributes: {
        rel: "noopener noreferrer",
        target: "_blank",
      },
      keepSelectedTextOnPaste: true,
    },
  }).withComponent(NyxdocLinkElement),
  DocumentReferencePlugin,
  ImagePlugin.configure({
    options: {
      disableEmbedInsert: true,
      disableUploadInsert: true,
    },
  }).withComponent(NyxdocImageElement),
  FontSizePlugin.configure({ inject: { targetPlugins: textBlockTypes } }),
  FontColorPlugin.configure({ inject: { targetPlugins: textBlockTypes } }),
  FontBackgroundColorPlugin.configure({ inject: { targetPlugins: textBlockTypes } }),
  TextAlignPlugin.configure({
    inject: {
      nodeProps: {
        defaultNodeValue: "start",
        nodeKey: "align",
        styleKey: "textAlign",
        validNodeValues: ["start", "left", "center", "right", "end", "justify"],
      },
      targetPlugins: textBlockTypes,
    },
  }),
  IndentPlugin.configure({
    inject: { targetPlugins: textBlockTypes },
    options: { indentMax: 6, offset: 28, unit: "px" },
  }),
  ListPlugin.configure({
    inputRules: [
      BulletedListRules.markdown({ variant: "-" }),
      BulletedListRules.markdown({ variant: "*" }),
      OrderedListRules.markdown({ variant: "." }),
      TaskListRules.markdown({ checked: false }),
    ],
    inject: { targetPlugins: textBlockTypes },
  }),
  SlashPlugin.configure({
    options: {
      // The stock previous-character check crosses block boundaries. At the
      // start of an empty paragraph after a table it sees the last table-cell
      // character, so `/` never opens. Keep the low-level check permissive and
      // enforce the intended same-block rule here instead.
      triggerPreviousCharPattern: /^[\s\S]*$/,
      // The first AST contract does not allow nested tables or divider nodes
      // inside cells, so slash commands stay on top-level text blocks.
      triggerQuery: (editor) => {
        if (!editor.selection || !RangeApi.isCollapsed(editor.selection)) return false;
        if (editor.api.above({ match: { type: KEYS.table } })) return false;

        const block = editor.api.block<TElement>();
        if (!block || block[1].length !== 1) return false;
        const blockStart = editor.api.start(block[1]);
        if (!blockStart) return false;

        const textBeforeCaret = editor.api.string({
          anchor: blockStart,
          focus: editor.selection.anchor,
        });
        return textBeforeCaret.length === 0 || /\s$/.test(textBeforeCaret);
      },
    },
  }),
  SlashInputPlugin.withComponent(NyxdocSlashInputElement),
  TablePlugin.configure({
    node: { component: TableElement },
    options: { disableMerge: false, initialTableWidth: 720, minColumnWidth: 72 },
  }),
  TableRowPlugin.withComponent(TableRowElement),
  TableCellPlugin.withComponent(TableCellElement),
  TableCellHeaderPlugin.withComponent(TableHeaderCellElement),
];

function createEditorLabInitialValue(
  copy: Record<keyof typeof EDITOR_COPY.en, string>,
): Value {
  return [
  {
    id: "lab-title",
    type: "h1",
    children: [{ text: copy.sampleTitle }],
  },
  {
    id: "lab-intro",
    type: "p",
    children: [
      { text: copy.sampleIntroPrefix },
      { text: copy.sampleHuman, bold: true, color: "#25785d" },
      { text: copy.sampleIntroJoin },
      { text: copy.sampleAgent, bold: true, backgroundColor: "#fff1ad" },
      { text: copy.sampleIntroSuffix },
    ],
  },
  {
    id: "lab-multiline",
    type: "p",
    children: [
      { text: copy.sampleMultiline },
    ],
  },
  {
    id: "lab-font-size",
    type: "p",
    children: [
      { text: copy.sampleFontPrefix },
      { text: copy.sampleFontLarge, fontSize: "24px" },
    ],
  },
  {
    id: "lab-center",
    type: "p",
    align: "center",
    children: [{ text: copy.sampleCentered }],
  },
  {
    id: "lab-list-1",
    type: "p",
    indent: 1,
    listStyleType: "disc",
    children: [{ text: copy.sampleListFirst }],
  },
  {
    id: "lab-list-2",
    type: "p",
    indent: 2,
    listStyleType: "disc",
    children: [{ text: copy.sampleListSecond }],
  },
  {
    id: "lab-table",
    type: "table",
    colSizes: [210, 250, 250],
    children: [
      {
        id: "lab-table-row-1",
        type: "tr",
        children: [
          {
            id: "lab-table-cell-1-1",
            type: "th",
            children: [{ id: "lab-table-p-1-1", type: "p", children: [{ text: copy.sampleTableCheck }] }],
          },
          {
            id: "lab-table-cell-1-2",
            type: "th",
            children: [{ id: "lab-table-p-1-2", type: "p", children: [{ text: copy.sampleTableAction }] }],
          },
          {
            id: "lab-table-cell-1-3",
            type: "th",
            children: [{ id: "lab-table-p-1-3", type: "p", children: [{ text: copy.sampleTableExpected }] }],
          },
        ],
      },
      {
        id: "lab-table-row-2",
        type: "tr",
        children: [
          {
            id: "lab-table-cell-2-1",
            type: "td",
            children: [{ id: "lab-table-p-2-1", type: "p", children: [{ text: copy.sampleTableMultiCell }] }],
          },
          {
            id: "lab-table-cell-2-2",
            type: "td",
            children: [{ id: "lab-table-p-2-2", type: "p", children: [{ text: copy.sampleTableDrag }] }],
          },
          {
            id: "lab-table-cell-2-3",
            type: "td",
            children: [{ id: "lab-table-p-2-3", type: "p", children: [{ text: copy.sampleTableHighlight }] }],
          },
        ],
      },
      {
        id: "lab-table-row-3",
        type: "tr",
        children: [
          {
            id: "lab-table-cell-3-1",
            type: "td",
            children: [{ id: "lab-table-p-3-1", type: "p", children: [{ text: copy.sampleTableCopyPaste }] }],
          },
          {
            id: "lab-table-cell-3-2",
            type: "td",
            children: [{ id: "lab-table-p-3-2", type: "p", children: [{ text: "Ctrl+C / Ctrl+V" }] }],
          },
          {
            id: "lab-table-cell-3-3",
            type: "td",
            children: [{ id: "lab-table-p-3-3", type: "p", children: [{ text: copy.sampleTableMatrix }] }],
          },
        ],
      },
    ],
  },
  {
    id: "lab-after-table",
    type: "p",
    children: [{ text: "" }],
  },
  ];
}

function createEditorLabDocumentLinks(
  copy: Record<keyof typeof EDITOR_COPY.en, string>,
): NyxdocEditorDocumentLink[] {
  return [
    {
      id: "internal-guide-e2e",
      title: copy.sampleGuideTitle,
      pathLabel: copy.sampleGuidePath,
    },
    {
      id: "internal-policy-e2e",
      title: copy.samplePolicyTitle,
      pathLabel: copy.samplePolicyPath,
    },
  ];
}
const editorLabDocumentId = "99999999-9999-4999-8999-999999999999";
const editorLabLinkContext: NyxdocLinkRenderContextValue = {
  documentId: editorLabDocumentId,
  externalLinkTitles: EMPTY_EXTERNAL_LINK_TITLES,
  mode: "workspace",
  workspaceId: "workspace-e2e",
};

type ToolbarButtonProps = {
  active?: boolean;
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  label: string;
  onAction: () => void;
};

function ToolbarButton({
  active = false,
  children,
  destructive = false,
  disabled = false,
  label,
  onAction,
}: ToolbarButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={`${styles.toolbarButton} ${active ? styles.toolbarButtonActive : ""} ${destructive ? styles.toolbarButtonDanger : ""}`}
      disabled={disabled}
      title={label}
      type="button"
      onClick={onAction}
      onMouseDown={(event) => event.preventDefault()}
    >
      {children}
    </button>
  );
}

class EditorLinkValidationError extends Error {
  constructor(
    readonly code: "document_required" | "invalid_protocol" | "url_required",
  ) {
    super(code);
    this.name = "EditorLinkValidationError";
  }
}

function normalizeEditorLinkUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new EditorLinkValidationError("url_required");

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new EditorLinkValidationError("invalid_protocol");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EditorLinkValidationError("invalid_protocol");
  }
  return parsed.toString();
}

function internalDocumentForUrl(
  rawUrl: string,
  documentLinks: NyxdocEditorDocumentLink[],
) {
  try {
    const url = new URL(rawUrl);
    const currentOrigin = typeof window === "undefined" ? "" : window.location.origin;
    if (url.origin !== currentOrigin) return null;
    const documentId = url.searchParams.get("document");
    return documentId
      ? documentLinks.find((document) => document.id === documentId) ?? null
      : null;
  } catch {
    return null;
  }
}

function unwrapAutoTitledLinkAtCaret(editor: PlateEditor) {
  const selection = editor.selection;
  if (!selection || !RangeApi.isCollapsed(selection)) return null;

  let entry = editor.api.above<NyxdocExternalLinkElement | NyxdocDocumentReferenceElement>({
    match: { type: [KEYS.link, "doc_ref"] },
  });
  if (entry && !editor.api.isEnd(selection.anchor, entry[1])) entry = undefined;

  if (!entry && selection.anchor.offset === 0 && selection.anchor.path.length === 2) {
    const siblingIndex = selection.anchor.path[1];
    if (siblingIndex > 0) {
      const previousPath = PathApi.previous(selection.anchor.path);
      const previous = previousPath ? NodeApi.get(editor, previousPath) : undefined;
      if (
        previous
        && typeof previous === "object"
        && ((previous as TElement).type === KEYS.link || (previous as TElement).type === "doc_ref")
      ) {
        entry = [
          previous as NyxdocExternalLinkElement | NyxdocDocumentReferenceElement,
          previousPath!,
        ];
      }
    }
  }

  if (!entry || entry[0].autoTitle !== true) return null;
  const [node, path] = entry;
  const rawUrl = node.type === "doc_ref"
    ? (node as NyxdocDocumentReferenceElement).sourceUrl
    : (node as NyxdocExternalLinkElement).url;
  if (!rawUrl) return null;

  editor.tf.replaceNodes({ text: rawUrl }, {
    at: path,
    select: true,
  });
  editor.tf.collapse({ edge: "end" });
  return node.type === "doc_ref" ? "internal" as const : "external" as const;
}

function scheduleEditorAutomaticLinkTitles({
  attempts,
  documentId,
  documentLinks,
  editor,
  onDiagnostic,
  workspaceId,
}: {
  attempts: Set<string>;
  documentId?: string;
  documentLinks: NyxdocEditorDocumentLink[];
  editor: PlateEditor;
  onDiagnostic?: (event: NyxdocEditorDiagnostic) => void;
  workspaceId: string;
}) {
  const links = editor.api.nodes<NyxdocExternalLinkElement>({
    at: [],
    match: { type: KEYS.link },
  });
  for (const [link] of links) {
    if (
      link.autoTitle === true
      || typeof link.id !== "string"
      || typeof link.url !== "string"
    ) continue;
    const visibleText = NodeApi.string(link).trim();
    let visibleUrl: string;
    let targetUrl: string;
    try {
      visibleUrl = normalizeEditorLinkUrl(visibleText);
      targetUrl = normalizeEditorLinkUrl(link.url);
    } catch {
      continue;
    }
    if (visibleUrl !== targetUrl) continue;

    const attemptKey = `${link.id}\u0000${targetUrl}`;
    if (attempts.has(attemptKey)) continue;
    attempts.add(attemptKey);
    if (attempts.size > 300) {
      const first = attempts.values().next().value as string | undefined;
      if (first) attempts.delete(first);
    }

    const linkId = link.id;
    const applyTitle = (
      title: string,
      finalUrl: string,
      internalDocument?: NyxdocEditorDocumentLink,
    ) => {
      const path = findElementPathById(editor, linkId);
      if (!path) return;
      const current = editor.api.node(path)?.[0] as NyxdocExternalLinkElement | undefined;
      if (
        !current
        || current.type !== KEYS.link
        || current.url !== link.url
        || current.autoTitle === true
      ) return;
      const currentText = NodeApi.string(current).trim();
      try {
        if (normalizeEditorLinkUrl(currentText) !== targetUrl) return;
      } catch {
        return;
      }
      const cleanTitle = title.trim().slice(0, 200);
      if (!cleanTitle) return;
      const replacement = {
        ...current,
        children: [{ text: cleanTitle }],
        autoTitle: true,
      } as NyxdocExternalLinkElement | NyxdocDocumentReferenceElement;
      if (internalDocument) {
        delete (replacement as Partial<NyxdocExternalLinkElement>).url;
        Object.assign(replacement, {
          type: "doc_ref",
          documentId: internalDocument.id,
          sourceUrl: finalUrl,
        });
      } else {
        Object.assign(replacement, { url: finalUrl });
      }
      editor.tf.replaceNodes(replacement, { at: path });
      onDiagnostic?.({
        event: "link_auto_titled",
        details: {
          kind: internalDocument ? "internal" : "external",
          fetchedTitle: !internalDocument,
        },
      });
    };

    const internalDocument = internalDocumentForUrl(targetUrl, documentLinks);
    if (internalDocument) {
      queueMicrotask(() => applyTitle(internalDocument.title, targetUrl, internalDocument));
      continue;
    }

    void fetch("/api/link-preview", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nyxdoc-workspace-id": workspaceId,
      },
      body: JSON.stringify({
        ...(documentId ? { documentId } : {}),
        url: targetUrl,
      }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as {
          title?: string;
          url?: string;
        };
        if (!response.ok || !body.title) return;
        applyTitle(body.title, body.url ?? targetUrl);
      })
      .catch(() => {
        // A raw clickable URL remains valid when metadata lookup fails.
      });
  }
}

type LinkShortcutRequest = {
  id: number;
  selection: PlateEditor["selection"];
};

type CaretTraceInput = Omit<
  CaretTraceEvent,
  "composing" | "elapsedMs" | "focused" | "sequence"
> & Partial<Pick<CaretTraceEvent, "composing" | "focused">>;

function EditorToolbar({
  documentId,
  documentLinks = [],
  embedded = false,
  stickyTop,
  linkShortcutRequest = null,
  onDiagnostic,
  pendingUploads,
  uploadError,
  onClearUploadError,
  workspaceId,
}: {
  documentId?: string;
  documentLinks?: NyxdocEditorDocumentLink[];
  embedded?: boolean;
  stickyTop?: number;
  linkShortcutRequest?: LinkShortcutRequest | null;
  onDiagnostic?: (event: NyxdocEditorDiagnostic) => void;
  pendingUploads: number;
  uploadError: string | null;
  onClearUploadError: () => void;
  workspaceId?: string;
}) {
  const { locale } = useI18n();
  const copy = EDITOR_COPY[locale];
  const shortcutGroups = EDITOR_SHORTCUT_GROUPS[locale];
  const editor = useEditorState();
  const currentSelection = useEditorSelection() as PlateEditor["selection"];
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkKind, setLinkKind] = useState<"external" | "internal">("external");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkPending, setLinkPending] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [documentSearch, setDocumentSearch] = useState("");
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const lastEditorSelection = useRef<PlateEditor["selection"]>(null);
  const lastHandledLinkShortcut = useRef(0);
  const savedLinkSelection = useRef<PlateEditor["selection"]>(null);
  const editingLinkNode = useRef<{ kind: "external" | "internal"; path: number[]; id?: string } | null>(null);
  const toolbarDrag = useHorizontalDragScroll<HTMLDivElement>();
  const marks = (editor.api.marks() ?? {}) as Record<string, unknown>;
  const currentBlock = editor.api.block<TElement>()?.[0] as ListParagraphElement | undefined;
  const currentBlockType = typeof currentBlock?.type === "string"
    && ([KEYS.p, ...KEYS.heading, KEYS.blockquote, KEYS.callout] as string[]).includes(currentBlock.type)
    ? currentBlock.type
    : KEYS.p;
  const currentAlignment = currentBlock?.align ?? "start";
  const currentListStyle = currentBlock?.listStyleType;
  const linkEntry = editor.api.above<TLinkElement>({ match: { type: KEYS.link } });
  const documentReferenceEntry = editor.api.above<NyxdocDocumentReferenceElement>({
    match: { type: "doc_ref" },
  });
  const inTable = Boolean(editor.api.above<TTableElement>({ match: { type: KEYS.table } }));
  const { canMerge, canSplit: canSplitFromPlate } = useTableMergeState();
  const selectedCell = editor.api.above({
    match: { type: [KEYS.td, KEYS.th] },
  })?.[0] as TTableCellElement | undefined;
  // Plate 53.0.9 can report `canSplit: false` for a collapsed selection in a
  // merged cell. The cell span is the actual source of truth for this action.
  const canSplit = canSplitFromPlate || Boolean(
    selectedCell
      && ((selectedCell.colSpan ?? 1) > 1 || (selectedCell.rowSpan ?? 1) > 1),
  );
  const filteredDocumentLinks = useMemo(() => {
    const query = documentSearch.trim().normalize("NFC").toLocaleLowerCase();
    return documentLinks
      .filter((document) => !query
        || document.pathLabel.normalize("NFC").toLocaleLowerCase().includes(query))
      .slice(0, 30);
  }, [documentLinks, documentSearch]);

  const prepareLinkEditor = useCallback((selection: PlateEditor["selection"]) => {
    const activeLink = editor.api.above<TLinkElement>({
      at: selection ?? undefined,
      match: { type: KEYS.link },
    });
    const activeReference = editor.api.above<NyxdocDocumentReferenceElement>({
      at: selection ?? undefined,
      match: { type: "doc_ref" },
    });
    if (activeReference) {
      setLinkKind("internal");
      setDocumentSearch(NodeApi.string(activeReference[0]));
      setSelectedDocumentId(activeReference[0].documentId);
      setLinkText(NodeApi.string(activeReference[0]));
      setLinkUrl("");
      editingLinkNode.current = {
        kind: "internal",
        path: [...activeReference[1]],
        id: typeof activeReference[0].id === "string" ? activeReference[0].id : undefined,
      };
      return;
    }
    setLinkKind("external");
    setLinkUrl(activeLink?.[0].url ?? "");
    let selectedText = "";
    if (selection) {
      try {
        selectedText = editor.api.string(selection).trim();
      } catch {
        selectedText = "";
      }
    }
    setLinkText(activeLink ? NodeApi.string(activeLink[0]) : selectedText);
    setDocumentSearch("");
    setSelectedDocumentId(null);
    editingLinkNode.current = activeLink
      ? {
          kind: "external",
          path: [...activeLink[1]],
          id: typeof activeLink[0].id === "string" ? activeLink[0].id : undefined,
        }
      : null;
  }, [editor]);

  useEffect(() => {
    if (currentSelection) {
      lastEditorSelection.current = structuredClone(currentSelection);
    }
  }, [currentSelection]);

  useEffect(() => {
    if (!linkShortcutRequest || linkShortcutRequest.id <= lastHandledLinkShortcut.current) return;
    lastHandledLinkShortcut.current = linkShortcutRequest.id;
    savedLinkSelection.current = linkShortcutRequest.selection
      ? structuredClone(linkShortcutRequest.selection)
      : null;
    prepareLinkEditor(linkShortcutRequest.selection);
    setLinkError(null);
    setLinkOpen(true);
  }, [linkShortcutRequest, prepareLinkEditor]);

  useEffect(() => {
    if (!shortcutHelpOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setShortcutHelpOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [shortcutHelpOpen]);

  function run(action: () => void) {
    syncEditorSelectionFromDOM(editor);
    action();
    editor.tf.focus();
  }

  function runWithLastSelection(action: () => void) {
    const selection = domEditorSelection(editor) ?? currentSelection ?? lastEditorSelection.current;
    if (selection) editor.tf.select(selection);
    run(action);
  }

  function rememberSelection() {
    const selection = domEditorSelection(editor);
    savedLinkSelection.current = selection
      ? structuredClone(selection)
      : null;
  }

  function openLinkEditor() {
    rememberSelection();
    prepareLinkEditor(savedLinkSelection.current);
    setLinkError(null);
    setLinkOpen(true);
  }

  function closeLinkEditor() {
    setLinkOpen(false);
    setLinkPending(false);
    setLinkError(null);
    editingLinkNode.current = null;
    editor.tf.focus();
  }

  function insertOrReplaceInlineNode(node: TElement) {
    const editing = editingLinkNode.current;
    if (editing) {
      const currentPath = editing.id ? findElementPathById(editor, editing.id) : editing.path;
      if (currentPath) {
        editor.tf.withoutNormalizing(() => {
          editor.tf.removeNodes({ at: currentPath });
          editor.tf.insertNodes(node, { at: currentPath });
        });
        return typeof node.id === "string" ? node.id : null;
      }
    }
    if (savedLinkSelection.current) {
      editor.tf.select(savedLinkSelection.current);
      if (!RangeApi.isCollapsed(savedLinkSelection.current)) editor.tf.delete();
    }
    editor.tf.insertNodes(node);
    return typeof node.id === "string" ? node.id : null;
  }

  function focusInlineNode(nodeId: string | null, textLength: number) {
    if (nodeId) {
      const path = findElementPathById(editor, nodeId);
      if (path) {
        const point = { path: [...path, 0], offset: textLength };
        editor.tf.select({ anchor: point, focus: point });
      }
    }
    editor.tf.focus();
  }

  async function applyLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (linkPending) return;
    const editingExistingLink = Boolean(editingLinkNode.current);
    const selectionCollapsed = savedLinkSelection.current
      ? RangeApi.isCollapsed(savedLinkSelection.current)
      : null;
    try {
      setLinkPending(true);
      if (linkKind === "internal") {
        const selectedDocument = documentLinks.find((document) => (
          document.id === selectedDocumentId
          || document.id === documentSearch
          || document.pathLabel === documentSearch
          || document.title === documentSearch
        ));
        if (!selectedDocument) throw new EditorLinkValidationError("document_required");
        const nodeId = insertOrReplaceInlineNode({
          id: editingLinkNode.current?.id ?? globalThis.crypto.randomUUID(),
          type: "doc_ref",
          documentId: selectedDocument.id,
          children: [{ text: selectedDocument.title }],
        } as TElement);
        setLinkOpen(false);
        setLinkError(null);
        editingLinkNode.current = null;
        focusInlineNode(nodeId, selectedDocument.title.length);
        onDiagnostic?.({
          event: "link_applied",
          details: {
            kind: "internal",
            editingExistingLink,
            selectionCollapsed,
          },
        });
        return;
      }
      const normalizedUrl = normalizeEditorLinkUrl(linkUrl);
      let displayText = linkText.trim();
      const automaticTitle = displayText.length === 0;
      let finalUrl = normalizedUrl;
      let fetchedTitle = false;
      if (!displayText && workspaceId) {
        try {
          const response = await fetch("/api/link-preview", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-nyxdoc-workspace-id": workspaceId,
            },
            body: JSON.stringify({
              ...(documentId ? { documentId } : {}),
              url: normalizedUrl,
            }),
          });
          const body = await response.json().catch(() => ({})) as {
            title?: string;
            url?: string;
          };
          if (response.ok) {
            displayText = body.title?.trim() ?? "";
            finalUrl = body.url ?? normalizedUrl;
            fetchedTitle = Boolean(displayText);
          }
        } catch {
          // The link itself remains useful when title lookup is unavailable.
        }
      }
      displayText ||= new URL(finalUrl).hostname.replace(/^www\./i, "");
      const nodeId = insertOrReplaceInlineNode({
        id: editingLinkNode.current?.id ?? globalThis.crypto.randomUUID(),
        type: KEYS.link,
        url: finalUrl,
        ...(automaticTitle ? { autoTitle: true } : {}),
        children: [{ text: displayText }],
      } as TElement);
      setLinkOpen(false);
      setLinkError(null);
      editingLinkNode.current = null;
      focusInlineNode(nodeId, displayText.length);
      onDiagnostic?.({
        event: "link_applied",
        details: {
          kind: "external",
          editingExistingLink,
          selectionCollapsed,
          fetchedTitle,
        },
      });
    } catch (error) {
      const validationCode = error instanceof EditorLinkValidationError
        ? error.code
        : null;
      setLinkError(
        validationCode === "document_required"
          ? copy.internalDocumentRequired
          : validationCode === "url_required"
            ? copy.urlRequired
            : validationCode === "invalid_protocol"
              ? copy.httpOnly
              : copy.linkApplyFailed,
      );
      onDiagnostic?.({
        event: "link_failed",
        details: {
          kind: linkKind,
          category: validationCode === "document_required"
            ? "document_not_selected"
            : validationCode === "url_required" || validationCode === "invalid_protocol"
              ? "invalid_url"
              : "apply_failed",
          editingExistingLink,
          selectionCollapsed,
        },
      });
    } finally {
      setLinkPending(false);
    }
  }

  function removeLink() {
    const reference = documentReferenceEntry;
    if (reference) {
      const text = NodeApi.string(reference[0]);
      editor.tf.withoutNormalizing(() => {
        editor.tf.removeNodes({ at: reference[1] });
        editor.tf.insertNodes({ text }, { at: reference[1] });
      });
    } else {
      unwrapLink(editor);
    }
    setLinkOpen(false);
    setLinkError(null);
    editingLinkNode.current = null;
    editor.tf.focus();
  }

  return (
    <div
      className={`${styles.toolbar} ${embedded ? styles.embeddedToolbar : ""}`}
      style={embedded && stickyTop !== undefined ? { top: stickyTop } : undefined}
      role="toolbar"
      aria-label={copy.formattingToolbar}
      title={copy.horizontalToolbarHint}
      {...toolbarDrag}
    >
      <div className={styles.toolbarGroup}>
        <ToolbarButton label={copy.undo} onAction={() => run(() => editor.tf.undo())}><Undo2 size={17} /></ToolbarButton>
        <ToolbarButton label={copy.redo} onAction={() => run(() => editor.tf.redo())}><Redo2 size={17} /></ToolbarButton>
      </div>

      <div className={styles.toolbarGroup}>
        <select
          aria-label={copy.blockType}
          className={styles.blockTypeSelect}
          value={currentBlockType}
          onChange={(event) => {
            const blockType = event.target.value;
            runWithLastSelection(() => setSelectedTextBlockType(editor, blockType));
          }}
        >
          <option value="p">{copy.body}</option>
          <option value="h1">{copy.heading1}</option>
          <option value="h2">{copy.heading2}</option>
          <option value="h3">{copy.heading3}</option>
          <option value="h4">{copy.heading4}</option>
          <option value="h5">{copy.heading5}</option>
          <option value="h6">{copy.heading6}</option>
          <option value="blockquote">{copy.quote}</option>
          <option value="callout">{copy.callout}</option>
        </select>
        <select
          aria-label={copy.fontSize}
          className={styles.fontSizeSelect}
          value={typeof marks.fontSize === "string" ? marks.fontSize : "16px"}
          onChange={(event) => {
            const fontSize = event.target.value;
            runWithLastSelection(() => editor.tf.addMarks({ fontSize }));
          }}
        >
          {NYXDOC_FONT_SIZES.map((size) => <option value={size} key={size}>{size.replace("px", "")}</option>)}
        </select>
      </div>

      <div className={styles.toolbarGroup}>
        <ToolbarButton active={marks.bold === true} label={copy.bold} onAction={() => run(() => editor.tf.toggleMark(KEYS.bold))}><Bold size={17} /></ToolbarButton>
        <ToolbarButton active={marks.italic === true} label={copy.italic} onAction={() => run(() => editor.tf.toggleMark(KEYS.italic))}><Italic size={17} /></ToolbarButton>
        <ToolbarButton active={marks.underline === true} label={copy.underline} onAction={() => run(() => editor.tf.toggleMark(KEYS.underline))}><Underline size={17} /></ToolbarButton>
        <ToolbarButton active={marks.strikethrough === true} label={copy.strikethrough} onAction={() => run(() => editor.tf.toggleMark(KEYS.strikethrough))}><Strikethrough size={17} /></ToolbarButton>
        <ToolbarButton active={marks.code === true} label={copy.inlineCode} onAction={() => run(() => editor.tf.toggleMark(KEYS.code))}><Code2 size={17} /></ToolbarButton>
        <div className={styles.linkControl}>
          <ToolbarButton active={Boolean(linkEntry || documentReferenceEntry)} label={copy.linkAddOrEdit} onAction={openLinkEditor}><Link2 size={17} /></ToolbarButton>
          {linkOpen && (
            <form className={styles.linkForm} aria-label={copy.linkEditor} onSubmit={applyLink}>
              <div className={styles.linkKindTabs} role="tablist" aria-label={copy.linkKind}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={linkKind === "external"}
                  onClick={() => {
                    setLinkKind("external");
                    setLinkError(null);
                  }}
                ><ExternalLink size={13} /> {copy.externalLink}</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={linkKind === "internal"}
                  onClick={() => {
                    setLinkKind("internal");
                    setLinkError(null);
                  }}
                ><FileText size={13} /> {copy.internalDocument}</button>
              </div>
              {linkKind === "external" ? (
                <div className={styles.externalLinkFields}>
                  <input
                    autoFocus
                    aria-label={copy.linkUrl}
                    autoCapitalize="none"
                    inputMode="url"
                    placeholder="https://example.com"
                    spellCheck={false}
                    type="text"
                    value={linkUrl}
                    onChange={(event) => {
                      setLinkUrl(event.target.value);
                      setLinkError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeLinkEditor();
                    }}
                  />
                  <input
                    aria-label={copy.displayTitle}
                    placeholder={copy.automaticTitle}
                    value={linkText}
                    onChange={(event) => setLinkText(event.target.value)}
                  />
                </div>
              ) : (
                <div className={styles.internalLinkPicker}>
                  <input
                    autoFocus
                    aria-label={copy.internalDocumentSearch}
                    placeholder={copy.documentSearchPlaceholder}
                    value={documentSearch}
                    onChange={(event) => {
                      setDocumentSearch(event.target.value);
                      setSelectedDocumentId(null);
                      setLinkError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeLinkEditor();
                    }}
                  />
                  <div className={styles.internalLinkResults}>
                    {filteredDocumentLinks.length === 0 ? (
                      <span>{copy.noMatchingDocuments}</span>
                    ) : filteredDocumentLinks.map((document) => (
                      <button
                        type="button"
                        key={document.id}
                        data-selected={selectedDocumentId === document.id}
                        onClick={() => {
                          setSelectedDocumentId(document.id);
                          setDocumentSearch(document.pathLabel);
                          setLinkText(document.title);
                        }}
                      >
                        <FileText size={13} />
                        <span><strong>{document.title}</strong><small>{document.pathLabel}</small></span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className={styles.linkFormActions}>
                <button type="submit" disabled={linkPending}>{linkPending ? copy.checking : copy.apply}</button>
                <button type="button" onClick={closeLinkEditor}>{copy.close}</button>
              </div>
              {linkError && <span role="alert">{linkError}</span>}
            </form>
          )}
        </div>
        <ToolbarButton disabled={!linkEntry && !documentReferenceEntry} label={copy.unlink} onAction={removeLink}><Unlink2 size={17} /></ToolbarButton>
        <label className={styles.colorControl} title={copy.textColor}>
          <span>A</span>
          <input
            aria-label={copy.textColor}
            type="color"
            value={typeof marks.color === "string" ? marks.color : "#20312b"}
            onChange={(event) => {
              const color = event.target.value;
              runWithLastSelection(() => editor.tf.addMarks({ color }));
            }}
          />
        </label>
        <label className={styles.highlightControl} title={copy.backgroundColor}>
          <span>H</span>
          <input
            aria-label={copy.backgroundColor}
            type="color"
            value={typeof marks.backgroundColor === "string" ? marks.backgroundColor : "#fff1ad"}
            onChange={(event) => {
              const backgroundColor = event.target.value;
              runWithLastSelection(() => editor.tf.addMarks({ backgroundColor }));
            }}
          />
        </label>
      </div>

      <div className={styles.toolbarGroup}>
        <ToolbarButton active={["start", "left"].includes(currentAlignment)} label={copy.alignLeft} onAction={() => run(() => setAlign(editor, "left"))}><AlignLeft size={17} /></ToolbarButton>
        <ToolbarButton active={currentAlignment === "center"} label={copy.alignCenter} onAction={() => run(() => setAlign(editor, "center"))}><AlignCenter size={17} /></ToolbarButton>
        <ToolbarButton active={["end", "right"].includes(currentAlignment)} label={copy.alignRight} onAction={() => run(() => setAlign(editor, "right"))}><AlignRight size={17} /></ToolbarButton>
        <ToolbarButton active={currentAlignment === "justify"} label={copy.alignJustify} onAction={() => run(() => setAlign(editor, "justify"))}><AlignJustify size={17} /></ToolbarButton>
      </div>

      <div className={styles.toolbarGroup}>
        <ToolbarButton active={currentListStyle === KEYS.ul} label={copy.bulletList} onAction={() => run(() => toggleNyxdocList(editor, KEYS.ul))}><ListIcon size={17} /></ToolbarButton>
        <ToolbarButton active={currentListStyle === KEYS.ol} label={copy.numberedList} onAction={() => run(() => toggleNyxdocList(editor, KEYS.ol))}><ListOrdered size={17} /></ToolbarButton>
        <ToolbarButton active={currentListStyle === KEYS.listTodo} label={copy.todoList} onAction={() => run(() => toggleNyxdocList(editor, KEYS.listTodo))}><ListChecks size={17} /></ToolbarButton>
        <ToolbarButton label={copy.outdent} onAction={() => run(() => outdent(editor))}><IndentDecrease size={17} /></ToolbarButton>
        <ToolbarButton label={copy.indent} onAction={() => run(() => indent(editor))}><IndentIncrease size={17} /></ToolbarButton>
      </div>

      <div className={styles.toolbarGroup}>
        <ToolbarButton label={copy.insertCodeBlock} onAction={() => run(() => insertEmptyCodeBlock(editor))}><FileCode2 size={17} /></ToolbarButton>
        <ToolbarButton label={copy.insertTable} onAction={() => run(() => insertTable(editor, { colCount: 3, header: true, rowCount: 3 }))}><Table2 size={17} /></ToolbarButton>
        <ToolbarButton disabled={!inTable} label={copy.addRowBelow} onAction={() => run(() => insertTableRow(editor))}><BetweenHorizontalEnd size={17} /></ToolbarButton>
        <ToolbarButton destructive disabled={!inTable} label={copy.deleteSelectedRow} onAction={() => run(() => deleteRow(editor))}><PanelTopClose size={17} /></ToolbarButton>
        <ToolbarButton disabled={!inTable} label={copy.addColumnRight} onAction={() => run(() => insertTableColumn(editor))}><BetweenVerticalEnd size={17} /></ToolbarButton>
        <ToolbarButton destructive disabled={!inTable} label={copy.deleteSelectedColumn} onAction={() => run(() => deleteColumn(editor))}><PanelLeftClose size={17} /></ToolbarButton>
        <ToolbarButton disabled={!canMerge} label={copy.mergeSelectedCells} onAction={() => run(() => mergeTableCells(editor))}><Combine size={17} /></ToolbarButton>
        <ToolbarButton disabled={!canSplit} label={copy.splitCell} onAction={() => run(() => splitTableCell(editor))}><Split size={17} /></ToolbarButton>
        <ToolbarButton destructive disabled={!inTable} label={copy.deleteTable} onAction={() => run(() => deleteTable(editor))}><Trash2 size={17} /></ToolbarButton>
      </div>

      <div className={styles.toolbarGroup}>
        <ToolbarButton
          active={shortcutHelpOpen}
          label={copy.keyboardShortcuts}
          onAction={() => setShortcutHelpOpen((open) => !open)}
        >
          <Keyboard size={18} />
        </ToolbarButton>
      </div>

      {shortcutHelpOpen && createPortal(
        <div
          className={styles.shortcutHelpBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShortcutHelpOpen(false);
          }}
        >
          <section
            className={styles.shortcutHelpDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="nyxdoc-shortcut-help-title"
          >
            <header>
              <div>
                <span><Keyboard size={15} /> NOTION-FRIENDLY</span>
                <h2 id="nyxdoc-shortcut-help-title">{copy.keyboardShortcuts}</h2>
                <p>{copy.shortcutDescription}</p>
              </div>
              <button type="button" aria-label={copy.shortcutClose} onClick={() => setShortcutHelpOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <div className={styles.shortcutHelpGrid}>
              {shortcutGroups.map((group) => (
                <section key={group.title}>
                  <h3>{group.title}</h3>
                  <dl>
                    {group.items.map(([keys, description]) => (
                      <div key={keys}>
                        <dt><kbd>{keys}</kbd></dt>
                        <dd>{description}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
            <footer>{copy.shortcutUnsupported}</footer>
          </section>
        </div>,
        document.body,
      )}

      <div className={styles.uploadStatus} aria-live="polite">
        {pendingUploads > 0 && (
          <span className={styles.uploadPending}>
            <LoaderCircle aria-hidden="true" className={styles.spinner} size={15} />
            {formatCopy(copy.uploadsPending, { count: pendingUploads })}
          </span>
        )}
        {uploadError && (
          <button className={styles.uploadError} type="button" onClick={onClearUploadError}>
            {uploadError} · {copy.dismiss}
          </button>
        )}
      </div>
    </div>
  );
}

function containsTransientSlashInput(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;

  return nodes.some((node) => {
    if (!node || typeof node !== "object") return false;
    const candidate = node as { children?: unknown; type?: unknown };
    return candidate.type === KEYS.slashInput
      || containsTransientSlashInput(candidate.children);
  });
}

function containsUploadingImage(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;

  return nodes.some((node) => {
    if (!node || typeof node !== "object") return false;
    const candidate = node as { children?: unknown; uploadState?: unknown };
    return candidate.uploadState === "uploading"
      || containsUploadingImage(candidate.children);
  });
}

function editorNodeTypes(nodes: unknown) {
  const types = new Set<string>();
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string") types.add(record.type.slice(0, 80));
    if (Array.isArray(record.children)) visit(record.children);
  }
  visit(nodes);
  return [...types].sort().slice(0, 40);
}

function editorTextLength(nodes: unknown) {
  let length = 0;
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") length += record.text.length;
    if (Array.isArray(record.children)) visit(record.children);
  }
  visit(nodes);
  return length;
}

function nodeIdRepairDiagnostic(
  repairs: DocumentNodeIdRepair[],
): NyxdocEditorDiagnostic {
  return {
    event: "node_ids_repaired",
    details: {
      missingIdCount: repairs.filter((repair) => repair.reason === "missing").length,
      duplicateIdCount: repairs.filter((repair) => repair.reason === "duplicate").length,
      paths: repairs.slice(0, 20).map((repair) => repair.path.join(".")),
    },
  };
}

function repairEditorNodeIds(editor: PlateEditor, value: Value) {
  const repairs = documentNodeIdRepairs(
    value,
    () => globalThis.crypto.randomUUID(),
  );
  if (repairs.length === 0) return [];

  editor.tf.withoutSaving(() => {
    editor.tf.withoutNormalizing(() => {
      for (const repair of repairs) {
        editor.tf.setNodes(
          { id: repair.nextId } as Partial<TElement>,
          { at: repair.path },
        );
      }
    });
  });
  return repairs;
}

function clipboardImageFiles(event: ReactClipboardEvent<HTMLDivElement>) {
  const itemFiles = Array.from(event.clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (itemFiles.length > 0) return itemFiles;
  return Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
}

function handleEditorShortcut(
  event: ReactKeyboardEvent<HTMLDivElement>,
  editor: PlateEditor,
  requestLinkEditor: (selection: PlateEditor["selection"]) => void,
  onDiagnostic?: (event: NyxdocEditorDiagnostic) => void,
) {
  if (event.nativeEvent.isComposing) return;

  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const shortcutDigit = notionBlockShortcutDigit(event.code, event.key);

  if (
    !mod
    && !event.altKey
    && !event.shiftKey
    && event.key === "Backspace"
  ) {
    syncEditorSelectionFromDOM(editor);
    const kind = unwrapAutoTitledLinkAtCaret(editor);
    if (kind) {
      event.preventDefault();
      event.stopPropagation();
      onDiagnostic?.({
        event: "link_unwrapped",
        details: { kind },
      });
      return;
    }
  }

  if (!mod && !event.altKey && !event.shiftKey && event.key === "ArrowUp") {
    syncEditorSelectionFromDOM(editor);
    if (
      editor.selection
      && RangeApi.isCollapsed(editor.selection)
      && editor.selection.anchor.path[0] === 0
      && editor.selection.anchor.path[1] === 0
      && editor.selection.anchor.offset === 0
      && (editor.children[0] as TElement | undefined)?.type === KEYS.codeBlock
    ) {
      event.preventDefault();
      event.stopPropagation();
      const id = globalThis.crypto.randomUUID();
      editor.tf.insertNodes(
        { id, type: KEYS.p, children: [{ text: "" }] } as TElement,
        { at: [0], select: true },
      );
      return;
    }
  }

  if (mod && shortcutDigit !== undefined && (event.shiftKey || event.altKey)) {
    event.preventDefault();
    event.stopPropagation();
    syncEditorSelectionFromDOM(editor);
    if (shortcutDigit <= 3) {
      const blockTypes = [KEYS.p, KEYS.h1, KEYS.h2, KEYS.h3];
      setSelectedTextBlockType(editor, blockTypes[shortcutDigit]);
    } else {
      const listTypes = [KEYS.listTodo, KEYS.ul, KEYS.ol];
      toggleNyxdocList(editor, listTypes[shortcutDigit - 4]);
    }
    return;
  }

  if (mod && !event.altKey && !event.shiftKey && key === "d") {
    event.preventDefault();
    event.stopPropagation();
    syncEditorSelectionFromDOM(editor);
    editor.tf.withNewBatch(() => {
      editor.tf.duplicateNodes({ block: true, select: true });
    });
    return;
  }

  if (
    mod
    && event.shiftKey
    && !event.altKey
    && (key === "arrowup" || key === "arrowdown")
    && editor.selection
  ) {
    syncEditorSelectionFromDOM(editor);
    const currentIndex = editor.selection.focus.path[0];
    const movingUp = key === "arrowup";
    if (movingUp ? currentIndex > 0 : currentIndex < editor.children.length - 1) {
      event.preventDefault();
      event.stopPropagation();
      editor.tf.withNewBatch(() => {
        editor.tf.moveNodes({
          at: [currentIndex],
          to: movingUp ? [currentIndex - 1] : [currentIndex + 2],
        });
      });
    }
    return;
  }

  if (
    event.altKey ||
    event.shiftKey ||
    !mod ||
    key !== "k"
  ) return;

  event.preventDefault();
  event.stopPropagation();
  const selection = syncEditorSelectionFromDOM(editor);
  requestLinkEditor(selection ? structuredClone(selection) : null);
}

export type NyxdocRichEditorChange = {
  content: unknown;
  diagnostics: {
    blockCount: number;
    issues: Array<{ code: string; message: string; path: string }>;
    nodeTypes: string[];
    textLength: number;
  };
  valid: boolean;
};

export type NyxdocEditorDiagnostic = {
  event:
    | "validation_failed"
    | "validation_recovered"
    | "node_ids_repaired"
    | "link_applied"
    | "link_auto_titled"
    | "link_unwrapped"
    | "link_failed";
  details: {
    blockCount?: number;
    category?: string;
    duplicateIdCount?: number;
    editingExistingLink?: boolean;
    fetchedTitle?: boolean;
    issueCount?: number;
    issues?: Array<{ code: string; message: string; path: string }>;
    kind?: "external" | "internal";
    missingIdCount?: number;
    nodeTypes?: string[];
    paths?: string[];
    selectionCollapsed?: boolean | null;
    textLength?: number;
  };
};

export type NyxdocCollaborationStatus =
  | "connecting"
  | "synced"
  | "saving"
  | "offline"
  | "error";

export type NyxdocEditorCollaboration = {
  ydoc: Y.Doc;
  roomName: string;
  publicUrl: string;
  providers?: Array<UnifiedProvider | YjsProviderConfig>;
  autoConnect?: boolean;
  initialValue?: Value | null;
  user: {
    id: string;
    name: string;
    avatarUrl: string | null;
    color: string;
  };
  getToken: () => Promise<string>;
  onReady?: () => void;
  onStatusChange?: (status: NyxdocCollaborationStatus, message?: string) => void;
  onCanonicalCommit?: (event: {
    documentId: string;
    revisionNumber: number;
    draftVersion: number;
  }) => void;
  onDraftStatus?: (event: {
    documentId: string;
    draftVersion: number;
    hasUncommittedChanges: boolean;
  }) => void;
};

const EMPTY_COLLABORATIVE_VALUE: Value = [];
const EDITOR_CHUNK_SIZE = 96;
const COLLABORATIVE_ANALYSIS_DELAY_MS = 180;
const AUTOMATIC_LINK_TITLE_DELAY_MS = 320;
const COLLABORATIVE_BULK_BLOCK_THRESHOLD = 120;
const COLLABORATIVE_BULK_TEXT_THRESHOLD = 32_000;

type CollaborativeBulkEditor = PlateEditor & {
  localOrigin?: unknown;
  sharedRoot?: Y.XmlText;
  undoManager?: Y.UndoManager;
};

type CollaborativeBulkEditResult = {
  repairs: DocumentNodeIdRepair[];
  selection: PlateEditor["selection"];
  value: Value;
};

function decodedSlateFragment(data: DataTransfer): Value | null {
  const html = data.getData("text/html");
  const encoded = data.getData("application/x-slate-fragment")
    || html.match(/data-slate-fragment="(.+?)"/m)?.[1]
    || "";
  if (!encoded) return null;

  try {
    const parsed = JSON.parse(decodeURIComponent(globalThis.atob(encoded))) as unknown;
    return Array.isArray(parsed) ? parsed as Value : null;
  } catch {
    return null;
  }
}

function isLargeClipboardDocument(data: DataTransfer) {
  const fragment = decodedSlateFragment(data);
  if (
    fragment
    && (
      fragment.length >= COLLABORATIVE_BULK_BLOCK_THRESHOLD
      || editorTextLength(fragment) >= COLLABORATIVE_BULK_TEXT_THRESHOLD
    )
  ) {
    return true;
  }

  const html = data.getData("text/html");
  if (html.length >= COLLABORATIVE_BULK_TEXT_THRESHOLD) return true;

  const text = data.getData("text/plain");
  if (text.length >= COLLABORATIVE_BULK_TEXT_THRESHOLD) return true;
  let lineCount = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lineCount += 1;
    if (lineCount >= COLLABORATIVE_BULK_BLOCK_THRESHOLD) return true;
  }
  return false;
}

function selectedTopLevelBlockCount(selection: PlateEditor["selection"]) {
  if (!selection || !RangeApi.isExpanded(selection)) return 0;
  const [start, end] = RangeApi.edges(selection);
  return Math.max(0, end.path[0] - start.path[0] + 1);
}

function selectionCoversEntireDocument(editor: PlateEditor) {
  if (!editor.selection || !RangeApi.isExpanded(editor.selection)) return false;
  const [selectionStart, selectionEnd] = RangeApi.edges(editor.selection);
  const documentStart = editor.api.start([]);
  const documentEnd = editor.api.end([]);
  return Boolean(
    documentStart
    && documentEnd
    && PathApi.equals(selectionStart.path, documentStart.path)
    && selectionStart.offset === documentStart.offset
    && PathApi.equals(selectionEnd.path, documentEnd.path)
    && selectionEnd.offset === documentEnd.offset
  );
}

function editorDocumentIsEmpty(editor: PlateEditor) {
  if (editor.children.length !== 1) return false;
  const onlyBlock = editor.children[0] as TElement | undefined;
  return onlyBlock?.type === KEYS.p && NodeApi.string(onlyBlock) === "";
}

function valueEndPoint(value: Value) {
  let node: unknown = value.at(-1);
  if (!node) return { path: [0, 0], offset: 0 };
  const path = [value.length - 1];
  while (
    node
    && typeof node === "object"
    && Array.isArray((node as { children?: unknown }).children)
  ) {
    const children = (node as { children: unknown[] }).children;
    if (children.length === 0) break;
    path.push(children.length - 1);
    node = children.at(-1);
  }
  return {
    path,
    offset: node && typeof node === "object" && typeof (node as { text?: unknown }).text === "string"
      ? (node as { text: string }).text.length
      : 0,
  };
}

function clipboardDocumentValue(data: DataTransfer): Value | null {
  const slateFragment = decodedSlateFragment(data);
  if (slateFragment?.length) return slateFragment;

  const html = data.getData("text/html");
  if (html) {
    try {
      const value = deserializeLargeHtmlDocument(html);
      if (value.length > 0) return value;
    } catch {
      // Fall through to plain text so malformed third-party HTML can still paste.
    }
  }

  const text = data.getData("text/plain");
  if (!text) return null;
  return deserializeLargePlainTextDocument(text);
}

function setFullDocumentClipboardData(
  data: DataTransfer,
  value: Value,
  editorRoot: HTMLDivElement | null,
) {
  const encoded = globalThis.btoa(encodeURIComponent(JSON.stringify(value)));
  data.setData("application/x-slate-fragment", encoded);
  data.setData("text/plain", value.map((node) => NodeApi.string(node)).join("\n"));

  const slateEditor = editorRoot?.querySelector<HTMLElement>('[data-slate-editor="true"]');
  if (!slateEditor) return;
  const container = document.createElement("div");
  container.innerHTML = slateEditor.innerHTML;
  const firstContentNode = container.querySelector<HTMLElement>('[data-slate-node="element"]');
  firstContentNode?.setAttribute("data-slate-fragment", encoded);
  data.setData("text/html", container.innerHTML);
}

function prepareCollaborativeReplacement(value: Value): CollaborativeBulkEditResult | null {
  const nonEmptyValue = value.length > 0
    ? value
    : [{
        id: globalThis.crypto.randomUUID(),
        type: KEYS.p,
        children: [{ text: "" }],
      }] as Value;
  const repaired = repairDocumentNodeIds(
    nonEmptyValue,
    () => globalThis.crypto.randomUUID(),
  );
  const nextValue = repaired.value as Value;
  const projected = projectNyxdocEditorContent(nextValue);
  if (!nyxdocDocumentV2Schema.safeParse(projected).success) return null;
  const end = valueEndPoint(nextValue);
  return {
    repairs: repaired.repairs,
    selection: { anchor: end, focus: end },
    value: nextValue,
  };
}

function prepareCollaborativeBulkEdit(
  editor: PlateEditor,
  mutate: (workingEditor: PlateEditor) => void,
): CollaborativeBulkEditResult | null {
  if (!editor.selection) return null;

  const workingEditor = createPlateEditor({
    plugins: editorPlugins,
    value: structuredClone(editor.children) as Value,
    nodeId: {
      idCreator: () => globalThis.crypto.randomUUID(),
      reuseId: true,
    },
  });
  workingEditor.tf.select(structuredClone(editor.selection));
  mutate(workingEditor);

  const rawValue = workingEditor.children.length > 0
    ? workingEditor.children as Value
    : [{
        id: globalThis.crypto.randomUUID(),
        type: KEYS.p,
        children: [{ text: "" }],
      }] as Value;
  const repaired = repairDocumentNodeIds(
    rawValue,
    () => globalThis.crypto.randomUUID(),
  );
  const value = repaired.value as Value;
  const projected = projectNyxdocEditorContent(value);
  if (!nyxdocDocumentV2Schema.safeParse(projected).success) return null;

  return {
    repairs: repaired.repairs,
    selection: workingEditor.selection
      ? structuredClone(workingEditor.selection)
      : null,
    value,
  };
}

function applyCollaborativeBulkEdit(
  collaboration: NyxdocEditorCollaboration,
  editor: PlateEditor,
  result: CollaborativeBulkEditResult,
) {
  const collaborativeEditor = editor as CollaborativeBulkEditor;
  const sharedRoot = collaborativeEditor.sharedRoot
    ?? collaboration.ydoc.get("content", Y.XmlText);
  const undoManager = collaborativeEditor.undoManager;
  if (!undoManager || !collaborativeEditor.localOrigin) return false;

  // Slate-Yjs translates every Slate operation separately. Replacing a large
  // selection that way blocks the main thread for seconds, so encode the
  // validated next document as one undoable local Yjs transaction instead.
  // Local-origin events are intentionally ignored by the Yjs observer, hence
  // the matching editor state assignment immediately after the transaction.
  undoManager.stopCapturing();
  collaborativeEditor.selection = null;
  collaboration.ydoc.transact(() => {
    sharedRoot.delete(0, sharedRoot.length);
    sharedRoot.applyDelta(slateNodesToInsertDelta(result.value as never));
  }, collaborativeEditor.localOrigin);
  undoManager.stopCapturing();
  collaborativeEditor.children = result.value;
  collaborativeEditor.selection = result.selection;
  (collaborativeEditor as PlateEditor & { onChange: () => void }).onChange();
  return true;
}

export function NyxdocRichEditor({
  ariaLabel,
  documentHeader,
  documentId,
  documentLinks = [],
  initialDocument,
  linkMode = "workspace",
  onCaretAnomaly,
  onChange,
  onDiagnostic,
  readOnly = false,
  workspaceId,
  collaboration,
  toolbarTop,
}: {
  ariaLabel?: string;
  documentHeader?: ReactNode;
  documentId?: string;
  documentLinks?: NyxdocEditorDocumentLink[];
  initialDocument: NyxdocDocumentV2;
  linkMode?: "workspace" | "public";
  onCaretAnomaly?: (incident: {
    reason: CaretIncidentReason;
    mountCount: number;
    trace: CaretTraceEvent[];
  }) => void;
  onChange?: (change: NyxdocRichEditorChange) => void;
  onDiagnostic?: (event: NyxdocEditorDiagnostic) => void;
  readOnly?: boolean;
  workspaceId?: string;
  collaboration?: NyxdocEditorCollaboration;
  toolbarTop?: number;
}) {
  const { locale } = useI18n();
  const copy = EDITOR_COPY[locale];
  const resolvedAriaLabel = ariaLabel ?? copy.documentBody;
  const editorRootRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const editorFocusedRef = useRef(false);
  const localEditEventRef = useRef(false);
  const stableCaretRef = useRef<StableCaretBookmark | null>(null);
  const caretRecoveryFrameRef = useRef<number | null>(null);
  const caretRecoveryForceRef = useRef(false);
  const caretRecoveryAttemptsRef = useRef(0);
  const automaticIncidentRef = useRef<(reason: CaretIncidentReason) => void>(() => {});
  const lastAutomaticIncidentRef = useRef(new Map<CaretIncidentReason, number>());
  const caretRecorder = useMemo(
    () => documentId ? getCaretTraceRecorder(documentId) : null,
    [documentId],
  );
  const nonCollaborativeInitialValue = useMemo(
    () => structuredClone(initialDocument.blocks) as Value,
    [initialDocument],
  );
  const initialValue = collaboration ? EMPTY_COLLABORATIVE_VALUE : nonCollaborativeInitialValue;
  const initialExternalLinkTitleCandidates = useMemo(
    () => linkMode === "workspace"
      ? collectExternalLinkTitleCandidates(initialDocument.blocks)
      : [],
    [initialDocument, linkMode],
  );
  const [externalLinkTitleCandidates, setExternalLinkTitleCandidates] = useState(
    initialExternalLinkTitleCandidates,
  );
  const [resolvedExternalLinkTitles, setResolvedExternalLinkTitles] = useState<
    ReadonlyMap<string, ResolvedExternalLinkPreview>
  >(EMPTY_EXTERNAL_LINK_TITLES);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [linkShortcutRequest, setLinkShortcutRequest] = useState<LinkShortcutRequest | null>(null);
  const lastValidationFingerprint = useRef("");
  const automaticTitleAttempts = useRef(new Set<string>());
  const pendingChangeValueRef = useRef<Value | null>(null);
  const changeAnalysisTimerRef = useRef<number | null>(null);
  const automaticLinkTitleTimerRef = useRef<number | null>(null);
  const collaborativeBulkActiveRef = useRef(false);
  const collaborativeBulkSelectionFrameRef = useRef<number | null>(null);
  const collaborationPlugin = useMemo(() => {
    if (!collaboration) return null;
    return YjsPlugin.configure({
      options: {
        ydoc: collaboration.ydoc,
        userId: collaboration.user.id,
        cursors: {
          data: {
            id: collaboration.user.id,
            name: collaboration.user.name,
            avatarUrl: collaboration.user.avatarUrl,
            color: collaboration.user.color,
          },
        },
        providers: collaboration.providers ?? [
          {
            type: "indexeddb",
            options: { docName: `nyxdoc-draft:${collaboration.roomName}` },
          },
          {
            type: "hocuspocus",
            options: {
              name: collaboration.roomName,
              url: collaboration.publicUrl,
              token: collaboration.getToken,
              onStatus: ({ status }: { status: string }) => {
                collaboration.onStatusChange?.(
                  status === "connected" ? "connecting" : "offline",
                );
              },
              onSynced: ({ state }: { state: boolean }) => {
                if (state) collaboration.onStatusChange?.("synced");
              },
              onUnsyncedChanges: ({ number }: { number: number }) => {
                collaboration.onStatusChange?.(number > 0 ? "saving" : "synced");
              },
              onAuthenticationFailed: ({ reason }: { reason: string }) => {
                collaboration.onStatusChange?.(
                  "error",
                  reason || copy.collaborationAuthFailed,
                );
              },
              onStateless: ({ payload }: { payload: string }) => {
                try {
                  const event = JSON.parse(payload) as {
                    type?: unknown;
                    documentId?: unknown;
                    revisionNumber?: unknown;
                    draftVersion?: unknown;
                    hasUncommittedChanges?: unknown;
                  };
                  if (
                    event.type === "canonical-committed"
                    && typeof event.documentId === "string"
                    && typeof event.revisionNumber === "number"
                    && typeof event.draftVersion === "number"
                  ) {
                    collaboration.onCanonicalCommit?.({
                      documentId: event.documentId,
                      revisionNumber: event.revisionNumber,
                      draftVersion: event.draftVersion,
                    });
                  } else if (
                    event.type === "draft-status"
                    && typeof event.documentId === "string"
                    && typeof event.draftVersion === "number"
                    && typeof event.hasUncommittedChanges === "boolean"
                  ) {
                    collaboration.onDraftStatus?.({
                      documentId: event.documentId,
                      draftVersion: event.draftVersion,
                      hasUncommittedChanges: event.hasUncommittedChanges,
                    });
                  }
                } catch {
                  // Stateless messages are optional collaboration hints. Ignore
                  // unknown payloads so they can never interrupt editing.
                }
              },
            },
          },
        ],
        onConnect: ({ type }: { type: string }) => {
          if (type === "hocuspocus") collaboration.onStatusChange?.("connecting");
        },
        onDisconnect: ({ type }: { type: string }) => {
          if (type === "hocuspocus") collaboration.onStatusChange?.("offline");
        },
        onError: ({ error, type }: { error: Error; type: string }) => {
          if (type === "hocuspocus") {
            collaboration.onStatusChange?.("error", error.message);
          }
        },
        onSyncChange: ({ isSynced, type }: { isSynced: boolean; type: string }) => {
          if (type === "hocuspocus") {
            collaboration.onStatusChange?.(isSynced ? "synced" : "offline");
          }
        },
      },
    });
  }, [collaboration, copy.collaborationAuthFailed]);
  const plugins = useMemo(
    () => collaborationPlugin
      ? [...editorPlugins, collaborationPlugin, CollaborativeNodeIdPlugin]
      : editorPlugins,
    [collaborationPlugin],
  );
  const editor = usePlateEditor({
    plugins,
    value: initialValue,
    skipInitialization: Boolean(collaborationPlugin),
    chunking: {
      chunkSize: EDITOR_CHUNK_SIZE,
      contentVisibilityAuto: true,
    },
    nodeId: {
      filter: () => !collaborationPlugin || shouldAssignCollaborativeNodeId(),
      idCreator: () => globalThis.crypto.randomUUID(),
      reuseId: Boolean(collaborationPlugin),
    },
  });

  useEffect(() => {
    let active = true;
    if (
      linkMode !== "workspace"
      || !documentId
      || !workspaceId
      || externalLinkTitleCandidates.length === 0
    ) {
      return () => {
        active = false;
      };
    }

    let nextIndex = 0;
    const worker = async () => {
      while (active) {
        const url = externalLinkTitleCandidates[nextIndex];
        nextIndex += 1;
        if (!url) return;
        const preview = await resolveExternalLinkPreview({
          documentId,
          url,
          workspaceId,
        });
        if (!active || !preview) continue;
        setResolvedExternalLinkTitles((current) => {
          const existing = current.get(url);
          if (existing?.title === preview.title && existing.url === preview.url) return current;
          const next = new Map(current);
          next.set(url, preview);
          if (next.size > MAX_EXTERNAL_LINK_PREVIEW_REQUESTS) {
            const first = next.keys().next().value as string | undefined;
            if (first) next.delete(first);
          }
          return next;
        });
      }
    };
    const workerCount = Math.min(4, externalLinkTitleCandidates.length);
    void Promise.all(Array.from({ length: workerCount }, () => worker()));
    return () => {
      active = false;
    };
  }, [
    documentId,
    externalLinkTitleCandidates,
    linkMode,
    workspaceId,
  ]);

  const recordCaretTrace = useCallback((input: CaretTraceInput) => {
    if (!caretRecorder) return;
    const reason = caretRecorder.record({
      ...input,
      composing: input.composing ?? composingRef.current,
      focused: input.focused ?? editorHasFocus(editorRootRef.current),
    });
    if (reason) queueMicrotask(() => automaticIncidentRef.current(reason));
  }, [caretRecorder]);

  const scheduleStableCaretRecovery = useCallback((force = false) => {
    caretRecoveryForceRef.current = caretRecoveryForceRef.current || force;
    caretRecoveryAttemptsRef.current = Math.max(
      caretRecoveryAttemptsRef.current,
      force ? 2 : 1,
    );
    if (caretRecoveryFrameRef.current !== null) return;
    recordCaretTrace({
      kind: "selection_change",
      action: force ? "stable_caret_recovery_scheduled_force" : "stable_caret_recovery_scheduled",
      selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
      blockCount: editor.children.length,
    });
    const recover = () => {
      caretRecoveryFrameRef.current = null;
      const shouldForce = caretRecoveryForceRef.current;
      const bookmark = stableCaretRef.current;
      if (composingRef.current) {
        recordCaretTrace({
          kind: "selection_change",
          action: "stable_caret_recovery_skipped_composing",
          selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
          blockCount: editor.children.length,
          composing: true,
        });
        caretRecoveryForceRef.current = false;
        caretRecoveryAttemptsRef.current = 0;
        return;
      }
      if (bookmark && (shouldForce || (editorFocusedRef.current && !editor.selection))) {
        const restored = restoreStableCaretBookmark(editor, bookmark, shouldForce);
        recordCaretTrace({
          kind: "selection_change",
          action: restored ? "stable_caret_recovery_restored" : "stable_caret_recovery_failed",
          selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
          blockCount: editor.children.length,
          focused: editorFocusedRef.current,
        });
        if (restored) {
          editorFocusedRef.current = true;
        }
      }
      caretRecoveryAttemptsRef.current = Math.max(0, caretRecoveryAttemptsRef.current - 1);
      if (shouldForce && caretRecoveryAttemptsRef.current > 0) {
        caretRecoveryFrameRef.current = requestAnimationFrame(recover);
        return;
      }
      caretRecoveryForceRef.current = false;
      caretRecoveryAttemptsRef.current = 0;
    };
    caretRecoveryFrameRef.current = requestAnimationFrame(recover);
  }, [editor, recordCaretTrace]);

  const reportAutomaticCaretIncident = useCallback((reason: CaretIncidentReason) => {
    if (!caretRecorder || !onCaretAnomaly) return;
    const now = Date.now();
    const lastReportedAt = lastAutomaticIncidentRef.current.get(reason) ?? 0;
    if (now - lastReportedAt < 60_000) return;
    lastAutomaticIncidentRef.current.set(reason, now);
    caretRecorder.record({
      kind: "automatic_report",
      action: reason,
      composing: composingRef.current,
      focused: editorHasFocus(editorRootRef.current),
      selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
      blockCount: editor.children.length,
    });
    onCaretAnomaly({
      reason,
      mountCount: Math.max(1, caretRecorder.mountCount),
      trace: caretRecorder.snapshot(),
    });
  }, [caretRecorder, editor, onCaretAnomaly]);

  useEffect(() => {
    automaticIncidentRef.current = (reason) => {
      reportAutomaticCaretIncident(reason);
    };
    return () => {
      automaticIncidentRef.current = () => {};
    };
  }, [reportAutomaticCaretIncident]);

  useEffect(() => {
    const root = editorRootRef.current;
    recordCaretTrace({
      kind: "editor_mount",
      blockCount: editor.children.length,
      selection: caretSelectionSnapshot(editor, editor.selection, root),
      focused: false,
    });
    return () => {
      if (caretRecoveryFrameRef.current !== null) {
        cancelAnimationFrame(caretRecoveryFrameRef.current);
        caretRecoveryFrameRef.current = null;
      }
      caretRecoveryForceRef.current = false;
      caretRecoveryAttemptsRef.current = 0;
      recordCaretTrace({
        kind: "editor_unmount",
        blockCount: editor.children.length,
        selection: caretSelectionSnapshot(editor, editor.selection, root),
      });
    };
  }, [editor, recordCaretTrace]);

  useEffect(() => {
    if (!collaborationPlugin || !collaboration) return;
    let active = true;
    let initialized = false;
    // React development Strict Mode intentionally replays effects as
    // setup -> cleanup -> setup. Starting Plate/Yjs synchronously in the
    // first setup leaves the replayed setup with a provider that has already
    // been destroyed. Defer startup by one task so the probe setup can be
    // cancelled without ever creating a WebSocket or IndexedDB provider.
    const startTimer = setTimeout(() => {
      if (!active) return;
      initialized = true;
      collaboration.onStatusChange?.("connecting");
      void editor.getApi(YjsPlugin).yjs.init({
        id: collaboration.roomName,
        autoConnect: collaboration.autoConnect,
        // The collaboration service is the only authority that seeds a room.
        // Passing canonical content here can create the same Slate nodes under
        // different Yjs client IDs when IndexedDB syncs before Hocuspocus, which
        // then merges into a duplicated document. `null` explicitly disables
        // the Plate client-side seed path.
        value: collaboration.initialValue ?? null,
        onReady: () => {
          if (!active) return;
          collaboration.onReady?.();
        },
      }).catch((error: unknown) => {
        if (!active) return;
        collaboration.onStatusChange?.(
          "error",
          error instanceof Error ? error.message : copy.collaborativeDraftFailed,
        );
      });
    }, 0);

    return () => {
      active = false;
      clearTimeout(startTimer);
      if (initialized) editor.getApi(YjsPlugin).yjs.destroy();
    };
  }, [collaboration, collaborationPlugin, copy.collaborativeDraftFailed, editor]);

  const reportChange = useCallback((nextValue: Value) => {
    if (!onChange) return;
    const content = projectNyxdocEditorContent(nextValue);
    const transient = containsTransientSlashInput(nextValue) || containsUploadingImage(nextValue);
    const validation = nyxdocDocumentV2Schema.safeParse(content);
    const issues = validation.success
      ? []
      : validation.error.issues.slice(0, 20).map((issue) => ({
          code: issue.code,
          message: issue.message,
          path: issue.path.map(String).join("."),
        }));
    const nodeTypes = editorNodeTypes(nextValue);
    const blockCount = nextValue.length;
    const textLength = editorTextLength(nextValue);
    const valid = !transient && validation.success;
    const fingerprint = valid
      ? ""
      : JSON.stringify({
          transient,
          issues: issues.map((issue) => [issue.code, issue.path]),
          nodeTypes,
        });
    if (fingerprint !== lastValidationFingerprint.current) {
      if (fingerprint) {
        onDiagnostic?.({
          event: "validation_failed",
          details: {
            blockCount,
            issueCount: issues.length,
            issues,
            nodeTypes,
            textLength,
          },
        });
      } else if (lastValidationFingerprint.current) {
        onDiagnostic?.({
          event: "validation_recovered",
          details: { blockCount, nodeTypes },
        });
      }
      lastValidationFingerprint.current = fingerprint;
    }
    onChange({
      content,
      diagnostics: { blockCount, issues, nodeTypes, textLength },
      valid,
    });
  }, [onChange, onDiagnostic]);

  const runAutomaticLinkTitles = useCallback(() => {
    if (readOnly || !workspaceId) return;
    scheduleEditorAutomaticLinkTitles({
      attempts: automaticTitleAttempts.current,
      documentId,
      documentLinks,
      editor,
      onDiagnostic,
      workspaceId,
    });
  }, [
    documentId,
    documentLinks,
    editor,
    onDiagnostic,
    readOnly,
    workspaceId,
  ]);

  const scheduleAutomaticLinkTitles = useCallback(() => {
    if (automaticLinkTitleTimerRef.current !== null) {
      window.clearTimeout(automaticLinkTitleTimerRef.current);
    }
    automaticLinkTitleTimerRef.current = window.setTimeout(() => {
      automaticLinkTitleTimerRef.current = null;
      runAutomaticLinkTitles();
    }, AUTOMATIC_LINK_TITLE_DELAY_MS);
  }, [runAutomaticLinkTitles]);

  const markLocalEditEvent = useCallback(() => {
    localEditEventRef.current = true;
    queueMicrotask(() => {
      localEditEventRef.current = false;
    });
  }, []);

  const scheduleChangeReport = useCallback((nextValue: Value) => {
    if (!collaboration) {
      reportChange(nextValue);
      return;
    }
    pendingChangeValueRef.current = nextValue;
    if (changeAnalysisTimerRef.current !== null) {
      window.clearTimeout(changeAnalysisTimerRef.current);
    }
    changeAnalysisTimerRef.current = window.setTimeout(() => {
      changeAnalysisTimerRef.current = null;
      const pendingValue = pendingChangeValueRef.current;
      pendingChangeValueRef.current = null;
      if (pendingValue) reportChange(pendingValue);
    }, COLLABORATIVE_ANALYSIS_DELAY_MS);
  }, [collaboration, reportChange]);

  useEffect(() => () => {
    if (changeAnalysisTimerRef.current !== null) {
      window.clearTimeout(changeAnalysisTimerRef.current);
      changeAnalysisTimerRef.current = null;
    }
    if (automaticLinkTitleTimerRef.current !== null) {
      window.clearTimeout(automaticLinkTitleTimerRef.current);
      automaticLinkTitleTimerRef.current = null;
    }
    if (collaborativeBulkSelectionFrameRef.current !== null) {
      cancelAnimationFrame(collaborativeBulkSelectionFrameRef.current);
      collaborativeBulkSelectionFrameRef.current = null;
    }
    collaborativeBulkActiveRef.current = false;
    pendingChangeValueRef.current = null;
  }, []);

  const handleValueChange = useCallback((
    nextValue: Value,
    operationTypes: string[],
  ) => {
    if (operationTypes.includes("insert_node")) {
      const repairs = repairEditorNodeIds(editor, nextValue);
      if (repairs.length > 0) {
        onDiagnostic?.(nodeIdRepairDiagnostic(repairs));
        return;
      }
    }
    const hasStructuralLinkChange = operationTypes.some((type) => (
      type === "insert_node"
      || type === "remove_node"
      || type === "set_node"
    ));
    if (linkMode === "workspace" && hasStructuralLinkChange) {
      const candidates = collectExternalLinkTitleCandidates(nextValue);
      setExternalLinkTitleCandidates((current) => (
        current.length === candidates.length
        && current.every((url, index) => url === candidates[index])
          ? current
          : candidates
      ));
    }
    const isLocalChange = !collaboration || localEditEventRef.current;
    if (isLocalChange && editorFocusedRef.current && operationTypes.some((type) => (
      type === "insert_node"
      || type === "insert_text"
      || type === "merge_node"
      || type === "remove_text"
      || type === "set_node"
      || type === "split_node"
    ))) {
      scheduleAutomaticLinkTitles();
    }
    scheduleChangeReport(nextValue);
  }, [
    editor,
    collaboration,
    linkMode,
    onDiagnostic,
    scheduleAutomaticLinkTitles,
    scheduleChangeReport,
  ]);

  const commitCollaborativeBulkEdit = useCallback((
    result: CollaborativeBulkEditResult,
  ) => {
    if (!collaboration) return false;

    collaborativeBulkActiveRef.current = true;
    const applied = applyCollaborativeBulkEdit(
      collaboration,
      editor,
      result,
    );
    if (!applied) {
      collaborativeBulkActiveRef.current = false;
      return false;
    }
    if (result.repairs.length > 0) {
      onDiagnostic?.(nodeIdRepairDiagnostic(result.repairs));
    }

    if (collaborativeBulkSelectionFrameRef.current !== null) {
      cancelAnimationFrame(collaborativeBulkSelectionFrameRef.current);
    }
    collaborativeBulkSelectionFrameRef.current = requestAnimationFrame(() => {
      collaborativeBulkSelectionFrameRef.current = null;
      const selection = result.selection;
      if (
        selection
        && editor.api.hasPath(selection.anchor.path)
        && editor.api.hasPath(selection.focus.path)
      ) {
        editor.tf.select(selection);
      } else {
        const end = editor.api.end([]);
        if (end) editor.tf.select(end);
      }
      editor.tf.focus();
      const bookmark = stableCaretBookmark(editor, editor.selection);
      if (bookmark) stableCaretRef.current = bookmark;
      collaborativeBulkActiveRef.current = false;
    });
    return true;
  }, [collaboration, editor, onDiagnostic]);

  const handleCut = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!collaboration) return;
    syncEditorSelectionFromDOM(editor);
    if (selectedTopLevelBlockCount(editor.selection) < COLLABORATIVE_BULK_BLOCK_THRESHOLD) {
      return;
    }

    let result: CollaborativeBulkEditResult | null = null;
    try {
      if (selectionCoversEntireDocument(editor)) {
        setFullDocumentClipboardData(
          event.clipboardData,
          editor.children as Value,
          editorRootRef.current,
        );
        result = prepareCollaborativeReplacement([{
          id: globalThis.crypto.randomUUID(),
          type: KEYS.p,
          children: [{ text: "" }],
        }] as Value);
      } else {
        editor.tf.setFragmentData(event.clipboardData);
        result = prepareCollaborativeBulkEdit(
          editor,
          (workingEditor) => workingEditor.tf.delete(),
        );
      }
    } catch {
      return;
    }
    if (!result) return;
    if (!commitCollaborativeBulkEdit(result)) return;

    event.preventDefault();
    event.stopPropagation();
  }, [collaboration, commitCollaborativeBulkEdit, editor]);

  const handlePaste = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const allImageFiles = clipboardImageFiles(event);
    if (allImageFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      const imageFiles = allImageFiles.slice(0, 5);
      setUploadError(
        allImageFiles.length > imageFiles.length
          ? copy.imageLimit
          : null,
      );

      for (const file of imageFiles) {
        const nodeId = globalThis.crypto.randomUUID();
        const previewUrl = URL.createObjectURL(file);
        editor.tf.insertNodes(
          {
            id: nodeId,
            type: KEYS.img,
            mediaId: "",
            name: file.name || copy.clipboardImage,
            uploadState: "uploading",
            url: previewUrl,
            children: [{ text: "" }],
          } as TElement,
          { nextBlock: true },
        );
        setPendingUploads((current) => current + 1);

        void uploadMediaFile(file, workspaceId, documentId)
          .then((media) => {
            const path = findElementPathById(editor, nodeId);
            if (!path) return;
            editor.tf.withoutNormalizing(() => {
              editor.tf.unsetNodes(["uploadState"], { at: path });
              editor.tf.setNodes(
                {
                  mediaId: media.id,
                  name: media.originalFilename || file.name || copy.clipboardImage,
                  url: media.url,
                },
                { at: path },
              );
            });
          })
          .catch((error: unknown) => {
            const path = findElementPathById(editor, nodeId);
            if (path) editor.tf.removeNodes({ at: path });
            setUploadError(
              error instanceof Error ? error.message : copy.imageUploadFailed,
            );
          })
          .finally(() => {
            URL.revokeObjectURL(previewUrl);
            setPendingUploads((current) => Math.max(0, current - 1));
          });
      }
      return;
    }

    if (!collaboration || !isLargeClipboardDocument(event.clipboardData)) return;
    syncEditorSelectionFromDOM(editor);
    let result: CollaborativeBulkEditResult | null = null;
    try {
      if (selectionCoversEntireDocument(editor) || editorDocumentIsEmpty(editor)) {
        const replacement = clipboardDocumentValue(event.clipboardData);
        result = replacement ? prepareCollaborativeReplacement(replacement) : null;
      } else {
        result = prepareCollaborativeBulkEdit(
          editor,
          (workingEditor) => workingEditor.tf.insertData(event.clipboardData),
        );
      }
    } catch {
      return;
    }
    if (!result || !commitCollaborativeBulkEdit(result)) return;

    event.preventDefault();
    event.stopPropagation();
  }, [
    collaboration,
    commitCollaborativeBulkEdit,
    copy.clipboardImage,
    copy.imageLimit,
    copy.imageUploadFailed,
    documentId,
    editor,
    setPendingUploads,
    setUploadError,
    workspaceId,
  ]);
  const linkRenderContext = useMemo<NyxdocLinkRenderContextValue>(
    () => ({
      documentId,
      externalLinkTitles: resolvedExternalLinkTitles,
      mode: linkMode,
      workspaceId,
    }),
    [
      documentId,
      linkMode,
      resolvedExternalLinkTitles,
      workspaceId,
    ],
  );

  return (
    <NyxdocLinkRenderContext.Provider value={linkRenderContext}>
      <div className={readOnly ? styles.documentView : styles.embeddedEditor}>
        <Plate
          editor={editor}
          onSelectionChange={({ selection }) => {
            const bookmark = stableCaretBookmark(editor, selection);
            if (bookmark) stableCaretRef.current = bookmark;
            recordCaretTrace({
              kind: "selection_change",
              selection: caretSelectionSnapshot(editor, selection, editorRootRef.current),
              blockCount: editor.children.length,
            });
          }}
          onValueChange={({ editor: changedEditor, value: nextValue }) => {
            const operationTypes = [...new Set(changedEditor.operations.map((operation) => (
              diagnosticIdentifier(operation.type)
            )))].slice(0, 20);
            const structuralReplacement = operationTypes.includes("insert_node")
              && operationTypes.includes("remove_node");
            recordCaretTrace({
              kind: "value_change",
              operationTypes,
              selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
              blockCount: nextValue.length,
            });
            handleValueChange(nextValue, operationTypes);
            if (
              !collaborativeBulkActiveRef.current
              &&
              editorFocusedRef.current
              && stableCaretRef.current
              && (!editor.selection || structuralReplacement)
            ) {
              scheduleStableCaretRecovery(structuralReplacement);
            }
          }}
        >
          {!readOnly && (
            <EditorToolbar
              documentId={documentId}
              documentLinks={documentLinks}
              embedded
              stickyTop={toolbarTop}
              linkShortcutRequest={linkShortcutRequest}
              onDiagnostic={onDiagnostic}
              pendingUploads={pendingUploads}
              uploadError={uploadError}
              workspaceId={workspaceId}
              onClearUploadError={() => setUploadError(null)}
            />
          )}
          {documentHeader && (
            <div className={styles.documentHeaderSlot}>
              {documentHeader}
            </div>
          )}
          <div
            ref={editorRootRef}
            className={readOnly ? styles.documentViewCanvas : styles.embeddedEditorCanvas}
            onBeforeInputCapture={readOnly ? undefined : (event) => {
              markLocalEditEvent();
              recordCaretTrace({
                kind: "beforeinput",
                inputType: diagnosticIdentifier((event.nativeEvent as InputEvent).inputType),
                selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
                blockCount: editor.children.length,
              });
            }}
            onBlurCapture={readOnly ? undefined : () => {
              editorFocusedRef.current = false;
              recordCaretTrace({
                kind: "blur",
                selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
                blockCount: editor.children.length,
                focused: false,
              });
            }}
            onCompositionEnd={readOnly ? undefined : () => {
              composingRef.current = false;
              recordCaretTrace({
                kind: "composition_end",
                selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
                blockCount: editor.children.length,
                composing: false,
              });
            }}
            onCompositionStart={readOnly ? undefined : () => {
              composingRef.current = true;
              recordCaretTrace({
                kind: "composition_start",
                selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
                blockCount: editor.children.length,
                composing: true,
              });
            }}
            onFocusCapture={readOnly ? undefined : () => {
              editorFocusedRef.current = true;
              const bookmark = stableCaretBookmark(editor, editor.selection);
              if (bookmark) stableCaretRef.current = bookmark;
              recordCaretTrace({
                kind: "focus",
                selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
                blockCount: editor.children.length,
                focused: true,
              });
            }}
            onKeyDownCapture={readOnly ? undefined : (event) => {
              if (!event.nativeEvent.isComposing) {
                const selection = syncEditorSelectionFromDOM(editor);
                const bookmark = stableCaretBookmark(editor, selection);
                if (bookmark) stableCaretRef.current = bookmark;
              }
              markLocalEditEvent();
              recordCaretTrace({
                kind: "keydown",
                key: diagnosticKey(event.nativeEvent),
                selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
                blockCount: editor.children.length,
                composing: event.nativeEvent.isComposing,
              });
              handleEditorShortcut(
                event,
                editor,
                (selection) => setLinkShortcutRequest((request) => ({
                  id: (request?.id ?? 0) + 1,
                  selection,
                })),
                onDiagnostic,
              );
            }}
            onKeyUp={readOnly ? undefined : (event) => {
              if (event.shiftKey || ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)) {
                syncEditorSelectionFromDOM(editor);
                recordCaretTrace({
                  kind: "selection_change",
                  action: "dom_selection_sync_after_navigation",
                  selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
                  blockCount: editor.children.length,
                });
              }
            }}
            onPointerDownCapture={readOnly ? undefined : () => recordCaretTrace({
              kind: "pointer_down",
              selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
              blockCount: editor.children.length,
            })}
            onPointerUpCapture={readOnly ? undefined : () => recordCaretTrace({
              kind: "pointer_up",
              selection: caretSelectionSnapshot(editor, editor.selection, editorRootRef.current),
              blockCount: editor.children.length,
            })}
            onMouseUp={readOnly ? undefined : () => syncEditorSelectionFromDOM(editor)}
          >
            <PlateContent
              className={`${styles.editorContent} ${readOnly ? styles.documentViewContent : styles.embeddedEditorContent}`}
              aria-label={resolvedAriaLabel}
              placeholder={readOnly ? undefined : copy.bodyPlaceholder}
              readOnly={readOnly}
              spellCheck={!readOnly}
              onCut={readOnly ? undefined : (event) => {
                markLocalEditEvent();
                handleCut(event);
              }}
              onPaste={readOnly ? undefined : (event) => {
                markLocalEditEvent();
                handlePaste(event);
              }}
            />
          </div>
        </Plate>
      </div>
    </NyxdocLinkRenderContext.Provider>
  );
}

export function EditorLab({ userName }: { userName: string }) {
  const { locale } = useI18n();
  const copy = EDITOR_COPY[locale];
  const editorLabInitialValue = useMemo(
    () => createEditorLabInitialValue(copy),
    [copy],
  );
  const editorLabDocumentLinks = useMemo(
    () => createEditorLabDocumentLinks(copy),
    [copy],
  );
  const checks = EDITOR_LAB_CHECKS[locale];
  const [value, setValue] = useState<Value>(() => editorLabInitialValue);
  const [showInspector, setShowInspector] = useState(true);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [linkShortcutRequest, setLinkShortcutRequest] = useState<LinkShortcutRequest | null>(null);
  const editorReadyRef = useRef<HTMLOutputElement>(null);
  const automaticTitleAttempts = useRef(new Set<string>());
  const editor = usePlateEditor({
    plugins: editorPlugins,
    value: editorLabInitialValue,
    chunking: {
      chunkSize: EDITOR_CHUNK_SIZE,
      contentVisibilityAuto: true,
    },
    nodeId: {
      idCreator: () => globalThis.crypto.randomUUID(),
    },
  });
  const validation = useMemo(
    () => nyxdocDocumentV2Schema.safeParse(projectNyxdocEditorContent(value)),
    [value],
  );
  const slashInputActive = useMemo(() => containsTransientSlashInput(value), [value]);
  const imageUploadActive = useMemo(() => containsUploadingImage(value), [value]);
  const updateLabValue = useCallback((nextValue: Value) => {
    if (repairEditorNodeIds(editor, nextValue).length > 0) return;
    scheduleEditorAutomaticLinkTitles({
      attempts: automaticTitleAttempts.current,
      documentId: editorLabDocumentId,
      documentLinks: editorLabDocumentLinks,
      editor,
      workspaceId: "workspace-e2e",
    });
    setValue(structuredClone(nextValue));
  }, [editor, editorLabDocumentLinks]);

  useEffect(() => {
    const marker = editorReadyRef.current;
    if (marker) marker.textContent = "ready";
  }, []);

  const handlePaste = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const allImageFiles = clipboardImageFiles(event);
    if (allImageFiles.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    const imageFiles = allImageFiles.slice(0, 5);
    setUploadError(
      allImageFiles.length > imageFiles.length
        ? copy.imageLimit
        : null,
    );

    for (const file of imageFiles) {
      const nodeId = globalThis.crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      editor.tf.insertNodes(
        {
          id: nodeId,
          type: KEYS.img,
          mediaId: "",
          name: file.name || copy.clipboardImage,
          uploadState: "uploading",
          url: previewUrl,
          children: [{ text: "" }],
        } as TElement,
        { nextBlock: true },
      );
      setPendingUploads((current) => current + 1);

      void uploadMediaFile(file)
        .then((media) => {
          const path = findElementPathById(editor, nodeId);
          if (!path) return;
          editor.tf.withoutNormalizing(() => {
            editor.tf.unsetNodes(["uploadState"], { at: path });
            editor.tf.setNodes(
              {
                mediaId: media.id,
                name: media.originalFilename || file.name || copy.clipboardImage,
                url: media.url,
              },
              { at: path },
            );
          });
        })
        .catch((error: unknown) => {
          const path = findElementPathById(editor, nodeId);
          if (path) editor.tf.removeNodes({ at: path });
          setUploadError(
            error instanceof Error ? error.message : copy.imageUploadFailed,
          );
        })
        .finally(() => {
          URL.revokeObjectURL(previewUrl);
          setPendingUploads((current) => Math.max(0, current - 1));
        });
    }
  }, [
    copy.clipboardImage,
    copy.imageLimit,
    copy.imageUploadFailed,
    editor,
  ]);

  return (
    <NyxdocLinkRenderContext.Provider value={editorLabLinkContext}>
    <div className={styles.labShell}>
      <header className={styles.labHeader}>
        <div className={styles.headerStart}>
          <Link href="/app" className={styles.backLink}><ArrowLeft size={17} /> {copy.workspace}</Link>
          <span className={styles.headerDivider} />
          <span className={styles.labTitle}><FlaskConical size={18} /> Editor Lab</span>
          <span className={styles.phaseBadge}>{copy.beforeSaveConnection}</span>
        </div>
        <div className={styles.headerEnd}>
          <span>{userName}</span>
          <output ref={editorReadyRef} data-testid="editor-ready" hidden />
          <button type="button" className={styles.inspectorToggle} onClick={() => setShowInspector((current) => !current)}>
            {showInspector ? copy.closeValidationPanel : copy.openValidationPanel}
          </button>
        </div>
      </header>

      <Plate
        editor={editor}
        onValueChange={({ value: nextValue }) => updateLabValue(nextValue)}
      >
        <EditorToolbar
          documentId={editorLabDocumentId}
          documentLinks={editorLabDocumentLinks}
          linkShortcutRequest={linkShortcutRequest}
          pendingUploads={pendingUploads}
          uploadError={uploadError}
          workspaceId="workspace-e2e"
          onClearUploadError={() => setUploadError(null)}
        />
        <main className={`${styles.labMain} ${showInspector ? "" : styles.labMainWide}`}>
          <section className={styles.editorStage} aria-label={copy.nextEditor}>
            <div
              className={styles.editorCanvas}
              onKeyDownCapture={(event) => handleEditorShortcut(
                event,
                editor,
                (selection) => setLinkShortcutRequest((request) => ({
                  id: (request?.id ?? 0) + 1,
                  selection,
                })),
              )}
              onKeyUp={(event) => {
                if (event.shiftKey || ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)) {
                  syncEditorSelectionFromDOM(editor);
                }
              }}
              onMouseUp={() => syncEditorSelectionFromDOM(editor)}
            >
              <PlateContent
                className={styles.editorContent}
                aria-label={copy.documentBody}
                placeholder={copy.bodyPlaceholder}
                spellCheck
                onPaste={handlePaste}
              />
            </div>
          </section>

          {showInspector && (
            <aside className={styles.inspector}>
              <div className={`${styles.schemaStatus} ${slashInputActive || imageUploadActive ? styles.schemaTransient : validation.success ? styles.schemaValid : styles.schemaInvalid}`}>
                {!slashInputActive && !imageUploadActive && validation.success ? <CheckCircle2 size={18} /> : <Code2 size={18} />}
                <div>
                  <strong>{imageUploadActive ? copy.imageUploading : slashInputActive ? copy.selectingCommand : validation.success ? copy.astValid : copy.astNeedsValidation}</strong>
                  <span>{imageUploadActive ? copy.uploadStatusDescription : slashInputActive ? copy.slashStatusDescription : validation.success ? copy.validStatusDescription : formatCopy(copy.validationRuleCount, { count: validation.error.issues.length })}</span>
                </div>
              </div>

              <div className={styles.inspectorSection}>
                <span className={styles.inspectorKicker}>{copy.labKicker}</span>
                <h2>{copy.labHeading}</h2>
                <p>{copy.labDescription}</p>
                <ol className={styles.checkList}>
                  {checks.map(([title, description]) => (
                    <li key={title}><span>{title}</span><small>{description}</small></li>
                  ))}
                </ol>
              </div>

              <details className={styles.jsonDetails}>
                <summary>{copy.showCurrentJson}</summary>
                <pre>{JSON.stringify({ schemaVersion: 2, blocks: value }, null, 2)}</pre>
              </details>

              {!slashInputActive && !imageUploadActive && !validation.success && (
                <details className={styles.errorDetails} open>
                  <summary>{copy.validationErrors}</summary>
                  <ul>{validation.error.issues.map((issue, index) => <li key={index}>{issue.path.join(".")}: {issue.message}</li>)}</ul>
                </details>
              )}
            </aside>
          )}
        </main>
      </Plate>
    </div>
    </NyxdocLinkRenderContext.Provider>
  );
}
