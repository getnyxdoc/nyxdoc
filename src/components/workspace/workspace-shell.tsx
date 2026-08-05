"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as Y from "yjs";
import {
  AlertTriangle,
  Bug,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudOff,
  Copy,
  Eye,
  FileDown,
  FilePlus2,
  FileText,
  FolderTree,
  History,
  ImagePlus,
  PencilLine,
  RotateCcw,
  Save,
  Settings2,
  Share2,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { NyxdocMark } from "@/components/brand/nyxdoc-mark";
import { useAppBugReports } from "@/components/diagnostics/app-bug-report-provider";
import { NyxdocRichEditor } from "@/components/editor/editor-lab";
import type {
  NyxdocCollaborationStatus,
  NyxdocEditorCollaboration,
  NyxdocRichEditorChange,
} from "@/components/editor/editor-lab";
import { UserAvatar } from "@/components/profile/user-avatar";
import { useHorizontalDragScroll } from "@/components/use-horizontal-drag-scroll";
import { DocumentAssignments } from "@/components/workspace/document-assignments";
import { DocumentTasks } from "@/components/workspace/document-tasks";
import { DocumentTree } from "@/components/workspace/document-tree";
import { RealtimePresence } from "@/components/workspace/realtime-presence";
import { SavedViewsPanel } from "@/components/workspace/saved-views-panel";
import { useFormSaveShortcut } from "@/components/workspace/use-form-save-shortcut";
import {
  CREATE_WORKSPACE_OPTION_VALUE,
  WorkspaceCreateDialog,
} from "@/components/workspace/workspace-create-dialog";
import type {
  DocumentRevisionSnapshot,
  DocumentSummary,
  DocumentTreeDropPosition,
} from "@/lib/documents/types";
import { reorderSiblingDocumentSummaries } from "@/lib/documents/tree-order";
import {
  NYXDOC_MAX_DOCUMENT_TEXT_LENGTH,
  NYXDOC_MAX_TOP_LEVEL_BLOCKS,
  type NyxdocDocumentV2,
} from "@/lib/editor/schema";
import type { EditorDiagnosticEvent } from "@/lib/editor/diagnostics";
import { getCaretTraceRecorder } from "@/lib/editor/caret-trace";
import {
  requestTraceEvent,
  suggestBugReportCategory,
} from "@/lib/diagnostics/app-trace";
import {
  BUG_REPORT_ATTACHMENT_MIME_TYPES,
  MAX_BUG_REPORT_ATTACHMENT_BYTES,
  MAX_BUG_REPORT_ATTACHMENTS,
  diagnosticCountBucket,
  sanitizeEditorTrace,
  type AppBugReportRequest,
  type AppBugTraceEvent,
  type BugReportCategory,
  type EditorBugTraceEvent,
} from "@/lib/diagnostics/schema";
import type { WorkspaceView } from "@/lib/workspace/view";
import { rememberWorkspaceSelection } from "@/lib/workspaces/selection";
import { useI18n } from "@/lib/i18n/client";
import { formatCopy } from "@/lib/i18n/copy";
import { localeTag, type AppLocale } from "@/lib/i18n/locales";
import { WORKSPACE_SHELL_COPY } from "./workspace-shell.copy";
import styles from "./workspace.module.css";

type ApiBody = {
  error?: string;
  code?: string;
  document?: { id: string };
  nextDocumentId?: string;
  revision?: DocumentRevisionSnapshot;
  unchanged?: boolean;
  workingDocument?: {
    draftVersion: number;
    committedDraftVersion: number;
    hasUncommittedChanges: boolean;
  };
};

type DocumentListApiBody = {
  documents?: DocumentSummary[];
};

type DocumentReorderApiBody = DocumentListApiBody & {
  error?: string;
};

type CachedNavigationPreference = {
  expandedDocumentIds: string[];
  lastActiveDocumentId: string | null;
  version: number;
  updatedAt: string;
};

type WorkspaceLifecycleApiBody = {
  error?: string;
  nextWorkspaceId?: string;
  workspace?: {
    id: string;
    name: string;
    lifecycleState: "active" | "trashed" | "purged";
  };
};

type PublicShareApiBody = {
  error?: string;
  share?: {
    enabled: boolean;
    urlPath: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
};

type DocumentAccessEntry = {
  userId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "editor" | "viewer";
  source: "workspace" | "document_grant";
  grantedAt: string | null;
};

type DocumentShareCandidate = {
  userId: string;
  name: string;
  email: string;
};

type DocumentAccessApiBody = {
  error?: string;
  access?: DocumentAccessEntry[];
  entry?: DocumentAccessEntry;
};

type DocumentCandidatesApiBody = {
  error?: string;
  candidates?: DocumentShareCandidate[];
};

type BugReportApiBody = {
  code?: string;
  error?: string;
  report?: {
    code: string;
    createdAt: string;
    expiresAt: string;
  };
};

const DEFAULT_SIDEBAR_WIDTH = 248;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 560;
const SIDEBAR_WIDTH_STORAGE_KEY = "nyxdoc:workspace-sidebar-width";
const NAVIGATION_STORAGE_PREFIX = "nyxdoc:workspace-navigation";
let rememberedSidebarWidth = DEFAULT_SIDEBAR_WIDTH;
let sidebarWidthInitialized = false;
const sidebarWidthListeners = new Set<() => void>();
function clampSidebarWidth(width: number) {
  const viewportMaximum = typeof window === "undefined"
    ? MAX_SIDEBAR_WIDTH
    : Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 480));
  return Math.round(Math.min(viewportMaximum, Math.max(MIN_SIDEBAR_WIDTH, width)));
}

function sidebarWidthSnapshot() {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;
  if (!sidebarWidthInitialized) {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    rememberedSidebarWidth = Number.isFinite(stored) && stored > 0
      ? stored
      : DEFAULT_SIDEBAR_WIDTH;
    sidebarWidthInitialized = true;
  }
  return clampSidebarWidth(rememberedSidebarWidth);
}

function subscribeSidebarWidth(listener: () => void) {
  sidebarWidthListeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== SIDEBAR_WIDTH_STORAGE_KEY) return;
    const stored = Number(event.newValue);
    rememberedSidebarWidth = Number.isFinite(stored) && stored > 0
      ? stored
      : DEFAULT_SIDEBAR_WIDTH;
    sidebarWidthInitialized = true;
    sidebarWidthListeners.forEach((notify) => notify());
  };
  const handleResize = () => sidebarWidthListeners.forEach((notify) => notify());
  window.addEventListener("storage", handleStorage);
  window.addEventListener("resize", handleResize);
  return () => {
    sidebarWidthListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener("resize", handleResize);
  };
}

function workspaceHref(workspaceId: string, documentId?: string) {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (documentId) query.set("document", documentId);
  return `/app?${query.toString()}`;
}

function shortDate(value: string, locale: AppLocale) {
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function documentAccessRoleLabel(role: DocumentAccessEntry["role"], locale: AppLocale) {
  return ({
    en: { owner: "Owner", admin: "Administrator", editor: "Editor", viewer: "Viewer" },
    ko: { owner: "소유자", admin: "관리자", editor: "편집자", viewer: "뷰어" },
    ja: { owner: "所有者", admin: "管理者", editor: "編集者", viewer: "閲覧者" },
  } as const)[locale][role];
}

async function responseBody(response: Response) {
  return (await response.json().catch(() => ({}))) as ApiBody;
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function documentPath(documents: WorkspaceView["documents"], documentId: string) {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const path: WorkspaceView["documents"] = [];
  const visited = new Set<string>();
  let cursor = byId.get(documentId);
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    path.unshift(cursor);
    cursor = cursor.parentDocumentId ? byId.get(cursor.parentDocumentId) : undefined;
  }
  return path;
}

function navigationStorageKey(userId: string, workspaceId: string) {
  return `${NAVIGATION_STORAGE_PREFIX}:${userId}:${workspaceId}`;
}

function normalizedExpandedDocumentIds(
  documents: readonly DocumentSummary[],
  expandedDocumentIds: readonly string[],
) {
  const allowed = new Set(documents.map((document) => document.id));
  const seen = new Set<string>();
  return expandedDocumentIds.filter((id) => {
    if (!allowed.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function expandedWithActiveAncestors(
  documents: readonly DocumentSummary[],
  expandedDocumentIds: readonly string[],
  activeDocumentId: string,
) {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const expanded = new Set(normalizedExpandedDocumentIds(documents, expandedDocumentIds));
  const visited = new Set<string>();
  let cursor = byId.get(activeDocumentId)?.parentDocumentId ?? null;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    expanded.add(cursor);
    cursor = byId.get(cursor)?.parentDocumentId ?? null;
  }
  return [...expanded];
}

function readCachedNavigationPreference(key: string) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<CachedNavigationPreference>;
    if (!Array.isArray(candidate.expandedDocumentIds) || typeof candidate.updatedAt !== "string") {
      return null;
    }
    return {
      expandedDocumentIds: candidate.expandedDocumentIds.filter(
        (id): id is string => typeof id === "string",
      ),
      lastActiveDocumentId: typeof candidate.lastActiveDocumentId === "string"
        ? candidate.lastActiveDocumentId
        : null,
      version: typeof candidate.version === "number"
        && Number.isInteger(candidate.version)
        && candidate.version >= 0
        ? candidate.version
        : 0,
      updatedAt: candidate.updatedAt,
    } satisfies CachedNavigationPreference;
  } catch {
    return null;
  }
}

function descendantIds(documents: WorkspaceView["documents"], documentId: string) {
  const descendants = new Set<string>();
  let frontier = [documentId];
  while (frontier.length) {
    const parents = new Set(frontier);
    frontier = documents
      .filter((document) => document.parentDocumentId && parents.has(document.parentDocumentId))
      .map((document) => document.id)
      .filter((id) => !descendants.has(id));
    frontier.forEach((id) => descendants.add(id));
  }
  return descendants;
}

function contentForEditing(source: NyxdocDocumentV2) {
  const content = structuredClone(source);
  const last = content.blocks.at(-1);
  if (last && ["table", "img", "hr"].includes(last.type)) {
    content.blocks.push({
      id: globalThis.crypto.randomUUID(),
      type: "p",
      children: [{ text: "" }],
    });
  }
  return content;
}

type BugReportDialogState = {
  clientReportId: string;
  sessionId: string;
  capturedAt: string;
  suggestedCategory: BugReportCategory;
  category: BugReportCategory;
  description: string;
  environment: AppBugReportRequest["environment"];
  snapshot: AppBugReportRequest["snapshot"];
  events: AppBugTraceEvent[];
  editorTrace: EditorBugTraceEvent[];
  attachments: Array<{
    id: string;
    file: File;
    previewUrl: string;
  }>;
  status: "editing" | "submitting" | "success" | "error";
  code?: string;
  error?: string;
  copied?: boolean;
};

function clientBuildSha() {
  return process.env.NEXT_PUBLIC_NYXDOC_BUILD_SHA?.trim() || "development";
}

function bugReportEnvironment(locale: AppLocale): AppBugReportRequest["environment"] {
  const userAgent = navigator.userAgent;
  const browser = /Edg\//u.test(userAgent)
    ? "edge"
    : /Firefox\//u.test(userAgent)
      ? "firefox"
      : /CriOS\/|Chrome\//u.test(userAgent)
        ? "chrome"
        : /Safari\//u.test(userAgent)
          ? "safari"
          : "other";
  const browserVersionPattern = browser === "edge"
    ? /Edg\/(\d+)/u
    : browser === "firefox"
      ? /Firefox\/(\d+)/u
      : browser === "chrome"
        ? /(?:CriOS|Chrome)\/(\d+)/u
        : browser === "safari"
          ? /Version\/(\d+)/u
          : null;
  const browserMajor = browserVersionPattern
    ? Number(userAgent.match(browserVersionPattern)?.[1] ?? Number.NaN)
    : Number.NaN;
  const platform = /iPhone|iPad|iPod/u.test(userAgent)
    ? "ios"
    : /Android/u.test(userAgent)
      ? "android"
      : /Windows/u.test(userAgent)
        ? "windows"
        : /Macintosh|Mac OS X/u.test(userAgent)
          ? "macos"
          : /Linux/u.test(userAgent)
            ? "linux"
            : "other";
  return {
    browser,
    browserMajor: Number.isInteger(browserMajor) ? browserMajor : null,
    platform,
    viewportClass: window.innerWidth < 720
      ? "compact"
      : window.innerWidth < 1_200
        ? "medium"
        : "wide",
    locale,
    online: navigator.onLine,
  };
}

export function WorkspaceShell({ view }: { view: WorkspaceView }) {
  const { locale } = useI18n();
  const copy = WORKSPACE_SHELL_COPY[locale];
  const bugReports = useAppBugReports();
  const offlineCommitMessage = copy.offlineCommit;
  const router = useRouter();
  const collaborationDoc = useMemo(
    () => new Y.Doc({ guid: view.collaboration.roomName }),
    [view.collaboration.roomName],
  );
  const [editorMode, setEditorMode] = useState<"edit" | "create" | null>(null);
  const [editorSessionId, setEditorSessionId] = useState(0);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftParentId, setDraftParentId] = useState<string | null>(null);
  const [draftInitialContent, setDraftInitialContent] = useState<NyxdocDocumentV2>(view.activeDocument.content);
  const [draftContent, setDraftContent] = useState<unknown>(view.activeDocument.content);
  const [draftContentValid, setDraftContentValid] = useState(true);
  const [summary, setSummary] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saveToastCycle, setSaveToastCycle] = useState(0);
  const [collaborationReady, setCollaborationReady] = useState(false);
  const [collaborationStatus, setCollaborationStatus] = useState<NyxdocCollaborationStatus>("connecting");
  const [collaborationMessage, setCollaborationMessage] = useState("");
  const [collaborativeTitle, setCollaborativeTitle] = useState(view.activeDocument.title);
  const collaborativeTitleRef = useRef<HTMLTextAreaElement>(null);
  const [collaborativeContentValid, setCollaborativeContentValid] = useState(true);
  const collaborativeDiagnosticsRef = useRef<NyxdocRichEditorChange["diagnostics"] | null>(null);
  const [collaborativeDirty, setCollaborativeDirty] = useState(view.collaboration.hasUncommittedChanges);
  const [collaborativeDraftVersion, setCollaborativeDraftVersion] = useState(
    view.collaboration.draftVersion,
  );
  const [collaborativeCommittedDraftVersion, setCollaborativeCommittedDraftVersion] = useState(
    view.collaboration.committedDraftVersion,
  );
  const [documents, setDocuments] = useState(view.documents);
  const [expandedDocumentIds, setExpandedDocumentIds] = useState(
    view.navigation.expandedDocumentIds,
  );
  const [commitPending, setCommitPending] = useState(false);
  const [discardPending, setDiscardPending] = useState(false);
  const [restoringRevisionId, setRestoringRevisionId] = useState<string | null>(null);
  const [loadingRevisionId, setLoadingRevisionId] = useState<string | null>(null);
  const [revisionPreview, setRevisionPreview] = useState<DocumentRevisionSnapshot | null>(null);
  const [revisionPreviewError, setRevisionPreviewError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [documentDialog, setDocumentDialog] = useState<{ mode: "rename" | "delete"; documentId: string } | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [documentActionPending, setDocumentActionPending] = useState(false);
  const [documentActionError, setDocumentActionError] = useState("");
  const sidebarWidth = useSyncExternalStore(
    subscribeSidebarWidth,
    sidebarWidthSnapshot,
    () => DEFAULT_SIDEBAR_WIDTH,
  );
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashPendingId, setTrashPendingId] = useState<string | null>(null);
  const [trashError, setTrashError] = useState("");
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [workspaceLifecycleAction, setWorkspaceLifecycleAction] = useState<{
    workspaceId: string;
    workspaceName: string;
  } | null>(null);
  const [workspaceLifecycleConfirmation, setWorkspaceLifecycleConfirmation] = useState("");
  const [workspaceLifecyclePending, setWorkspaceLifecyclePending] = useState<string | null>(null);
  const [workspaceLifecycleError, setWorkspaceLifecycleError] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [sharePending, setSharePending] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareCopied, setShareCopied] = useState(false);
  const [publicShare, setPublicShare] = useState<PublicShareApiBody["share"]>(undefined);
  const [documentAccess, setDocumentAccess] = useState<DocumentAccessEntry[]>([]);
  const [shareCandidates, setShareCandidates] = useState<DocumentShareCandidate[]>([]);
  const [shareCandidateQuery, setShareCandidateQuery] = useState("");
  const [shareCandidatesLoading, setShareCandidatesLoading] = useState(false);
  const [shareSearchFocused, setShareSearchFocused] = useState(false);
  const [selectedShareCandidate, setSelectedShareCandidate] = useState<DocumentShareCandidate | null>(null);
  const [newShareRole, setNewShareRole] = useState<"viewer" | "editor">("viewer");
  const [bugReportDialog, setBugReportDialog] = useState<BugReportDialogState | null>(null);
  const trashDocumentCount = view.trashWorkspaces.reduce(
    (count, workspace) => count + workspace.documents.length,
    0,
  );
  const totalTrashCount = trashDocumentCount + view.trashedWorkspaces.length;
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  const documentListRefreshTimerRef = useRef<number | null>(null);
  const documentListRequestRef = useRef<AbortController | null>(null);
  const expandedDocumentIdsRef = useRef(view.navigation.expandedDocumentIds);
  const navigationActiveDocumentRef = useRef(view.navigation.lastActiveDocumentId);
  const navigationVersionRef = useRef(view.navigation.version);
  const navigationMutationRef = useRef(0);
  const navigationInitializedKeyRef = useRef<string | null>(null);
  const navigationSaveTailRef = useRef<Promise<void>>(Promise.resolve());
  const recentEditorDiagnosticsRef = useRef(new Map<string, number>());
  const documentActionsDrag = useHorizontalDragScroll<HTMLDivElement>();
  const recordTreeDiagnostic = useCallback((event: {
    action: "expand" | "collapse" | "navigate" | "active_revealed" | "storage_fallback";
  }) => {
    bugReports.record({ kind: "tree", action: event.action });
  }, [bugReports]);
  const collaborativeInitialDocument = useMemo(
    () => contentForEditing(view.activeDocument.content),
    [view.activeDocument.content],
  );
  const editorDocumentLinks = useMemo(
    () => documents
      .filter((document) => document.id !== view.activeDocument.id)
      .map((document) => ({
        id: document.id,
        title: document.title,
        pathLabel: documentPath(documents, document.id)
          .map((item) => item.title)
          .join(" / "),
      })),
    [documents, view.activeDocument.id],
  );
  const settingsParams = new URLSearchParams();
  if (view.workspace.accessSource === "membership") {
    settingsParams.set("workspace", view.workspace.id);
  }
  settingsParams.set("document", view.activeDocument.id);
  const settingsHref = `/settings/account?${settingsParams.toString()}`;
  const printHref = `/print?${new URLSearchParams({
    workspace: view.workspace.id,
    document: view.activeDocument.id,
    autoprint: "1",
  }).toString()}`;

  useEffect(() => {
    bugReports.beginScope({
      userId: view.user.id,
      workspaceId: view.workspace.id,
    });
    bugReports.record({ kind: "lifecycle", action: "workspace_opened" });
    bugReports.record({ kind: "lifecycle", action: "document_opened" });
  }, [
    bugReports,
    view.activeDocument.id,
    view.user.id,
    view.workspace.id,
  ]);

  const workspaceScopedRequest = useCallback((
    workspaceId: string,
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const headers = new Headers(init.headers);
    headers.set("x-nyxdoc-workspace-id", workspaceId);
    return fetch(input, { ...init, headers });
  }, []);

  const workspaceRequest = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const operationId = globalThis.crypto.randomUUID();
      const startedAt = performance.now();
      try {
        const response = await workspaceScopedRequest(view.workspace.id, input, init);
        bugReports.record(requestTraceEvent({
          request: input,
          method: init.method,
          status: response.status,
          durationMs: performance.now() - startedAt,
          operationId,
        }));
        return response;
      } catch (error) {
        bugReports.record(requestTraceEvent({
          request: input,
          method: init.method,
          status: null,
          durationMs: performance.now() - startedAt,
          operationId,
          errorName: error instanceof Error ? error.name : undefined,
        }));
        throw error;
      }
    },
    [bugReports, view.workspace.id, workspaceScopedRequest],
  );

  const persistNavigationPreference = useCallback((
    nextExpandedDocumentIds: readonly string[],
    activeDocumentId = view.activeDocument.id,
  ) => {
    const mutationId = navigationMutationRef.current + 1;
    navigationMutationRef.current = mutationId;
    const normalized = normalizedExpandedDocumentIds(documents, nextExpandedDocumentIds);
    const updatedAt = new Date().toISOString();
    expandedDocumentIdsRef.current = normalized;
    navigationActiveDocumentRef.current = activeDocumentId;
    setExpandedDocumentIds(normalized);
    try {
      window.localStorage.setItem(
        navigationStorageKey(view.user.id, view.workspace.id),
        JSON.stringify({
          expandedDocumentIds: normalized,
          lastActiveDocumentId: activeDocumentId,
          version: navigationVersionRef.current,
          updatedAt,
        } satisfies CachedNavigationPreference),
      );
    } catch {
      recordTreeDiagnostic({ action: "storage_fallback" });
    }

    navigationSaveTailRef.current = navigationSaveTailRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const response = await workspaceRequest("/api/workspace-navigation", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              activeDocumentId,
              expandedDocumentIds: normalized,
              expectedVersion: navigationVersionRef.current,
            }),
          });
          const body = await response.json().catch(() => ({})) as {
            preference?: WorkspaceView["navigation"];
          };
          const preference = body.preference;
          if (response.status === 409 && preference) {
            navigationVersionRef.current = preference.version;
            if (mutationId === navigationMutationRef.current) {
              const serverExpanded = normalizedExpandedDocumentIds(
                documents,
                preference.expandedDocumentIds,
              );
              expandedDocumentIdsRef.current = serverExpanded;
              navigationActiveDocumentRef.current = preference.lastActiveDocumentId;
              setExpandedDocumentIds(serverExpanded);
              window.localStorage.setItem(
                navigationStorageKey(view.user.id, view.workspace.id),
                JSON.stringify({
                  expandedDocumentIds: serverExpanded,
                  lastActiveDocumentId: preference.lastActiveDocumentId,
                  version: preference.version,
                  updatedAt: preference.updatedAt ?? new Date().toISOString(),
                } satisfies CachedNavigationPreference),
              );
            }
            return;
          }
          if (!response.ok || !preference) {
            throw new Error(`Navigation preference save failed (${response.status}).`);
          }
          navigationVersionRef.current = preference.version;
          if (mutationId === navigationMutationRef.current) {
            window.localStorage.setItem(
              navigationStorageKey(view.user.id, view.workspace.id),
              JSON.stringify({
                expandedDocumentIds: expandedDocumentIdsRef.current,
                lastActiveDocumentId: navigationActiveDocumentRef.current,
                version: preference.version,
                updatedAt: preference.updatedAt ?? new Date().toISOString(),
              } satisfies CachedNavigationPreference),
            );
          }
        } catch {
          // The local preference remains available and a later change retries the server save.
        }
      });
  }, [
    documents,
    recordTreeDiagnostic,
    view.activeDocument.id,
    view.user.id,
    view.workspace.id,
    workspaceRequest,
  ]);

  useLayoutEffect(() => {
    const cacheKey = navigationStorageKey(view.user.id, view.workspace.id);
    if (navigationInitializedKeyRef.current === cacheKey) return;
    navigationInitializedKeyRef.current = cacheKey;
    const cached = readCachedNavigationPreference(cacheKey);
    const source = cached && cached.version >= view.navigation.version
      ? cached
      : view.navigation;
    const normalized = normalizedExpandedDocumentIds(documents, source.expandedDocumentIds);
    expandedDocumentIdsRef.current = normalized;
    navigationActiveDocumentRef.current = source.lastActiveDocumentId;
    navigationVersionRef.current = source.version;
    setExpandedDocumentIds(normalized);
  }, [
    documents,
    view.navigation,
    view.user.id,
    view.workspace.id,
  ]);

  useEffect(() => {
    if (navigationActiveDocumentRef.current === view.activeDocument.id) return;
    const next = expandedWithActiveAncestors(
      documents,
      expandedDocumentIdsRef.current,
      view.activeDocument.id,
    );
    if (next.length !== expandedDocumentIdsRef.current.length) {
      recordTreeDiagnostic({ action: "active_revealed" });
    }
    persistNavigationPreference(next, view.activeDocument.id);
  }, [
    documents,
    persistNavigationPreference,
    recordTreeDiagnostic,
    view.activeDocument.id,
  ]);

  const refreshDocumentList = useCallback(() => {
    if (documentListRefreshTimerRef.current !== null) {
      window.clearTimeout(documentListRefreshTimerRef.current);
    }
    documentListRefreshTimerRef.current = window.setTimeout(async () => {
      documentListRefreshTimerRef.current = null;
      documentListRequestRef.current?.abort();
      const controller = new AbortController();
      documentListRequestRef.current = controller;
      try {
        const response = await workspaceRequest("/api/documents", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = await response.json() as DocumentListApiBody;
        if (Array.isArray(body.documents)) {
          setDocuments(body.documents);
          bugReports.record({
            kind: "lifecycle",
            action: "document_list_refreshed",
          });
        }
      } catch {
        // A transient list refresh failure must not interrupt document editing.
      } finally {
        if (documentListRequestRef.current === controller) {
          documentListRequestRef.current = null;
        }
      }
    }, 180);
  }, [bugReports, workspaceRequest]);

  const reorderDocumentInTree = useCallback(async (
    documentId: string,
    targetDocumentId: string,
    position: DocumentTreeDropPosition,
  ) => {
    const previousDocuments = documents;
    const optimisticDocuments = reorderSiblingDocumentSummaries(
      previousDocuments,
      documentId,
      targetDocumentId,
      position,
    );
    if (optimisticDocuments === previousDocuments) return;
    setDocuments(optimisticDocuments);

    try {
      const response = await workspaceRequest(
        `/api/documents/${encodeURIComponent(documentId)}/reorder`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetDocumentId, position }),
        },
      );
      const body = await response.json().catch(() => ({})) as DocumentReorderApiBody;
      if (!response.ok) {
        throw new Error(body.error || copy.documentReorderFailed);
      }
      if (Array.isArray(body.documents)) setDocuments(body.documents);
      else refreshDocumentList();
    } catch (error) {
      setDocuments(previousDocuments);
      throw new Error(
        error instanceof Error && error.message
          ? error.message
          : copy.documentReorderFailed,
      );
    }
  }, [copy.documentReorderFailed, documents, refreshDocumentList, workspaceRequest]);

  useEffect(() => () => {
    if (documentListRefreshTimerRef.current !== null) {
      window.clearTimeout(documentListRefreshTimerRef.current);
    }
    documentListRequestRef.current?.abort();
  }, [view.workspace.id]);

  const reportEditorDiagnostic = useCallback((
    diagnostic: Pick<EditorDiagnosticEvent, "event" | "details">,
  ) => {
    if (!bugReports.enabled) return;
    bugReports.record({
      kind: "editor_diagnostic",
      event: diagnostic.event,
    });
    const safeDiagnostic = {
      event: diagnostic.event,
      details: {
        ...diagnostic.details,
        ...(diagnostic.details?.issues
          ? {
              issues: diagnostic.details.issues.map((issue) => ({
                code: issue.code,
                path: issue.path,
              })),
            }
          : {}),
      },
    };
    const fingerprint = JSON.stringify(safeDiagnostic);
    const now = Date.now();
    const lastSentAt = recentEditorDiagnosticsRef.current.get(fingerprint) ?? 0;
    if (now - lastSentAt < 5_000) return;
    recentEditorDiagnosticsRef.current.set(fingerprint, now);
    if (recentEditorDiagnosticsRef.current.size > 100) {
      for (const [key, sentAt] of recentEditorDiagnosticsRef.current) {
        if (now - sentAt > 60_000) recentEditorDiagnosticsRef.current.delete(key);
      }
    }
    void workspaceRequest("/api/editor-diagnostics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: view.workspace.id,
        documentId: view.activeDocument.id,
        ...safeDiagnostic,
      }),
      cache: "no-store",
      keepalive: true,
    }).catch(() => {
      // Diagnostics must never interrupt editing or saving.
    });
  }, [
    bugReports,
    view.activeDocument.id,
    view.workspace.id,
    workspaceRequest,
  ]);

  const getCollaborationToken = useCallback(async () => {
    const response = await fetch("/api/collaboration/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nyxdoc-workspace-id": view.workspace.id,
      },
      body: JSON.stringify({ documentId: view.activeDocument.id }),
      cache: "no-store",
    });
    const body = await responseBody(response) as ApiBody & { token?: string; roomName?: string };
    if (!response.ok || !body.token) {
      throw new Error(body.error || copy.tokenFailed);
    }
    if (body.roomName && body.roomName !== view.collaboration.roomName) {
      throw new Error(copy.draftReplaced);
    }
    return body.token;
  }, [
    copy.draftReplaced,
    copy.tokenFailed,
    view.activeDocument.id,
    view.collaboration.roomName,
    view.workspace.id,
  ]);

  const handleCollaborationStatus = useCallback((
    status: NyxdocCollaborationStatus,
    message = "",
  ) => {
    setCollaborationStatus(status);
    setCollaborationMessage(message);
    bugReports.record({ kind: "sync", state: status });
    if (status === "error") {
      reportEditorDiagnostic({
        event: "collaboration_error",
        details: {
          category: message ? "provider_error" : "unknown",
          status,
        },
      });
    }
    if (status === "synced") {
      setError((current) => current === offlineCommitMessage ? "" : current);
    }
  }, [bugReports, offlineCommitMessage, reportEditorDiagnostic]);

  const handleCanonicalCommit = useCallback((event: {
    documentId: string;
    revisionNumber: number;
    draftVersion: number;
  }) => {
    if (event.documentId !== view.activeDocument.id) return;
    setCollaborativeDirty(false);
    setCollaborativeDraftVersion(event.draftVersion);
    setCollaborativeCommittedDraftVersion(event.draftVersion);
    setSaveToastCycle((current) => current + 1);
    router.refresh();
  }, [router, view.activeDocument.id]);

  const handleDraftStatus = useCallback((event: {
    documentId: string;
    draftVersion: number;
    hasUncommittedChanges: boolean;
  }) => {
    if (event.documentId !== view.activeDocument.id) return;
    setCollaborativeDirty(event.hasUncommittedChanges);
    setCollaborativeDraftVersion(event.draftVersion);
  }, [view.activeDocument.id]);

  const handleCollaborativeEditorChange = useCallback(({
    diagnostics,
    valid,
  }: NyxdocRichEditorChange) => {
    collaborativeDiagnosticsRef.current = diagnostics;
    setCollaborativeContentValid((current) => current === valid ? current : valid);
  }, []);

  const editorCollaboration = useMemo<NyxdocEditorCollaboration>(() => ({
    ydoc: collaborationDoc,
    roomName: view.collaboration.roomName,
    publicUrl: view.collaboration.publicUrl,
    user: {
      id: view.user.id,
      name: view.user.name,
      avatarUrl: view.user.image,
      color: "#3b9977",
    },
    getToken: getCollaborationToken,
    onReady: () => setCollaborationReady(true),
    onStatusChange: handleCollaborationStatus,
    onCanonicalCommit: handleCanonicalCommit,
    onDraftStatus: handleDraftStatus,
  }), [
    collaborationDoc,
    getCollaborationToken,
    handleCanonicalCommit,
    handleDraftStatus,
    handleCollaborationStatus,
    view.collaboration.publicUrl,
    view.collaboration.roomName,
    view.user.id,
    view.user.image,
    view.user.name,
  ]);

  useEffect(() => {
    const metadata = collaborationDoc.getMap<unknown>("metadata");
    const synchronize = () => {
      const title = metadata.get("title");
      if (typeof title === "string") setCollaborativeTitle(title);
    };
    metadata.observe(synchronize);
    synchronize();
    return () => metadata.unobserve(synchronize);
  }, [collaborationDoc]);

  useEffect(() => () => collaborationDoc.destroy(), [collaborationDoc]);

  useLayoutEffect(() => {
    const title = collaborativeTitleRef.current;
    if (!title) return;
    let measuredWidth = title.clientWidth;
    const resize = () => {
      measuredWidth = title.clientWidth;
      title.style.height = "0px";
      title.style.height = `${title.scrollHeight}px`;
    };
    resize();
    const observer = new ResizeObserver(() => {
      if (title.clientWidth !== measuredWidth) resize();
    });
    observer.observe(title);
    return () => observer.disconnect();
  }, [collaborativeTitle]);

  const updateCollaborativeMetadata = useCallback((
    key: "title" | "parentDocumentId",
    value: string | null,
  ) => {
    if (!collaborationReady || !view.permissions.canEditDocuments) return;
    const metadata = collaborationDoc.getMap<unknown>("metadata");
    if (metadata.get(key) === value) return;
    collaborationDoc.transact(() => metadata.set(key, value), "nyxdoc-human-metadata");
    setCollaborativeDirty(true);
  }, [collaborationDoc, collaborationReady, view.permissions.canEditDocuments]);

  const commitSharedDraft = useCallback(async () => {
    if (!view.permissions.canCommitDocuments || commitPending) return;
    if (!collaborationReady || collaborationStatus !== "synced") {
      setError(offlineCommitMessage);
      return;
    }
    if (!collaborativeTitle.trim()) {
      setError(copy.titleRequired);
      return;
    }
    if (!collaborativeContentValid) {
      const diagnostics = collaborativeDiagnosticsRef.current;
      if (diagnostics && diagnostics.blockCount > NYXDOC_MAX_TOP_LEVEL_BLOCKS) {
        setError(formatCopy(copy.bodyTooManyBlocks, {
          count: diagnostics.blockCount.toLocaleString(localeTag(locale)),
          limit: NYXDOC_MAX_TOP_LEVEL_BLOCKS.toLocaleString(localeTag(locale)),
        }));
      } else if (
        diagnostics
        && diagnostics.textLength > NYXDOC_MAX_DOCUMENT_TEXT_LENGTH
      ) {
        setError(formatCopy(copy.bodyTooLong, {
          count: diagnostics.textLength.toLocaleString(localeTag(locale)),
          limit: NYXDOC_MAX_DOCUMENT_TEXT_LENGTH.toLocaleString(localeTag(locale)),
        }));
      } else {
        setError(copy.bodyInvalid);
      }
      return;
    }
    setCommitPending(true);
    setError("");
    bugReports.record({ kind: "lifecycle", action: "commit_started" });
    let response: Response;
    try {
      response = await workspaceRequest("/api/collaboration/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomName: view.collaboration.roomName,
          draftVersion: collaborativeDraftVersion,
          generation: view.collaboration.generation,
          stateVector: encodeBase64Url(Y.encodeStateVector(collaborationDoc)),
        }),
      });
    } catch {
      setCommitPending(false);
      setError(offlineCommitMessage);
      bugReports.record({ kind: "lifecycle", action: "commit_failed" });
      reportEditorDiagnostic({
        event: "commit_failed",
        details: {
          category: "network_error",
          code: "COLLABORATION_UNAVAILABLE",
        },
      });
      return;
    }
    const body = await responseBody(response);
    setCommitPending(false);
    if (!response.ok) {
      bugReports.record({ kind: "lifecycle", action: "commit_failed" });
      reportEditorDiagnostic({
        event: "commit_failed",
        details: {
          category: "server_rejected",
          code: body.code || "UNKNOWN",
          status: String(response.status),
        },
      });
      setError(
        body.code === "REVISION_CONFLICT"
          ? copy.commitConflict
          : body.error || copy.commitFailed,
      );
      return;
    }
    setCollaborativeDirty(body.workingDocument?.hasUncommittedChanges ?? false);
    if (body.workingDocument) {
      setCollaborativeDraftVersion(body.workingDocument.draftVersion);
      setCollaborativeCommittedDraftVersion(body.workingDocument.committedDraftVersion);
    }
    bugReports.record({ kind: "lifecycle", action: "commit_succeeded" });
    setSaveToastCycle((current) => current + 1);
    router.refresh();
  }, [
    bugReports,
    collaborationDoc,
    collaborationReady,
    collaborationStatus,
    collaborativeContentValid,
    collaborativeDraftVersion,
    collaborativeTitle,
    commitPending,
    copy.bodyInvalid,
    copy.bodyTooLong,
    copy.bodyTooManyBlocks,
    copy.commitConflict,
    copy.commitFailed,
    copy.titleRequired,
    offlineCommitMessage,
    locale,
    reportEditorDiagnostic,
    router,
    view.collaboration.generation,
    view.collaboration.roomName,
    view.permissions.canCommitDocuments,
    workspaceRequest,
  ]);

  const discardSharedDraft = useCallback(async () => {
    if (!view.permissions.canEditDocuments || discardPending || !collaborativeDirty) return;
    if (!window.confirm(copy.discardConfirm)) return;
    setDiscardPending(true);
    setError("");
    bugReports.record({ kind: "lifecycle", action: "discard_started" });
    let response: Response;
    try {
      response = await workspaceRequest("/api/collaboration/discard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentId: view.activeDocument.id,
          expectedGeneration: view.collaboration.generation,
          expectedDraftVersion: collaborativeDraftVersion,
          expectedBaseRevision: view.activeDocument.revisionNumber,
        }),
      });
    } catch {
      setDiscardPending(false);
      bugReports.record({ kind: "lifecycle", action: "discard_failed" });
      setError(copy.discardFailed);
      return;
    }
    const body = await responseBody(response);
    setDiscardPending(false);
    if (!response.ok) {
      bugReports.record({ kind: "lifecycle", action: "discard_failed" });
      setError(body.error || copy.discardFailed);
      return;
    }
    setCollaborativeDirty(false);
    if (body.workingDocument) {
      setCollaborativeDraftVersion(body.workingDocument.draftVersion);
      setCollaborativeCommittedDraftVersion(body.workingDocument.committedDraftVersion);
    }
    bugReports.record({ kind: "lifecycle", action: "discard_succeeded" });
    router.refresh();
  }, [
    bugReports,
    collaborativeDirty,
    collaborativeDraftVersion,
    copy.discardConfirm,
    copy.discardFailed,
    discardPending,
    router,
    view.activeDocument.id,
    view.activeDocument.revisionNumber,
    view.collaboration.generation,
    view.permissions.canEditDocuments,
    workspaceRequest,
  ]);

  const updateSidebarWidth = useCallback((width: number, persist = true) => {
    const next = clampSidebarWidth(width);
    rememberedSidebarWidth = next;
    sidebarWidthInitialized = true;
    if (persist) window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
    sidebarWidthListeners.forEach((listener) => listener());
  }, []);

  useEffect(() => {
    rememberWorkspaceSelection(view.workspace.id);
  }, [view.workspace.id]);

  useEffect(() => () => {
    sidebarResizeCleanupRef.current?.();
  }, []);

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 760 || event.button !== 0) return;
    event.currentTarget.focus();
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    sidebarResizeCleanupRef.current?.();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (moveEvent: PointerEvent) => updateSidebarWidth(startWidth + moveEvent.clientX - startX);
    const stop = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      sidebarResizeCleanupRef.current = null;
    };
    sidebarResizeCleanupRef.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  function resizeSidebarWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 16;
    const width = sidebarWidth;
    const next = event.key === "ArrowLeft"
      ? width - step
      : event.key === "ArrowRight"
        ? width + step
        : event.key === "Home"
          ? MIN_SIDEBAR_WIDTH
          : event.key === "End"
            ? MAX_SIDEBAR_WIDTH
            : null;
    if (next === null) return;
    event.preventDefault();
    updateSidebarWidth(next);
  }

  useEffect(() => {
    if (saveToastCycle === 0) return;
    const timer = window.setTimeout(() => setSaveToastCycle(0), 2_300);
    return () => window.clearTimeout(timer);
  }, [saveToastCycle]);

  function openCreate(parentDocumentId: string | null = null) {
    const content: NyxdocDocumentV2 = {
      schemaVersion: 2,
      blocks: [{ id: globalThis.crypto.randomUUID(), type: "p", children: [{ text: "" }] }],
    };
    setDraftTitle("");
    setDraftParentId(parentDocumentId);
    setDraftInitialContent(content);
    setDraftContent(content);
    setDraftContentValid(true);
    setEditorSessionId((current) => current + 1);
    setSummary("");
    setError("");
    setEditorMode("create");
  }

  function openDocumentDialog(mode: "rename" | "delete", documentId: string) {
    const document = documents.find((item) => item.id === documentId);
    if (!document) return;
    setRenameTitle(document.title);
    setDocumentActionError("");
    setDocumentDialog({ mode, documentId });
  }

  function closeDocumentDialog() {
    if (documentActionPending) return;
    setDocumentDialog(null);
    setDocumentActionError("");
  }

  function navigateFromEditor(documentId: string) {
    if (pending || (editorMode === "edit" && documentId === view.activeDocument.id)) return;
    if (!window.confirm(copy.navigateConfirm)) return;
    setEditorMode(null);
    router.push(workspaceHref(view.workspace.id, documentId));
  }

  function createFromEditor(parentDocumentId: string | null) {
    if (pending) return;
    if (!window.confirm(copy.createConfirm)) return;
    openCreate(parentDocumentId);
  }

  async function saveDocument(event: FormEvent) {
    event.preventDefault();
    if (!editorMode) return;
    setPending(true);
    setError("");
    const normalizedTitle = draftTitle.trim()
      || (editorMode === "create" ? copy.untitled : draftTitle);
    const payload = {
      title: normalizedTitle,
      parentDocumentId: draftParentId,
      content: draftContent,
      ...(summary.trim() ? { summary: summary.trim() } : {}),
    };
    const response = await workspaceRequest(
      editorMode === "edit" ? `/api/documents/${view.activeDocument.id}` : "/api/documents",
      {
        method: editorMode === "edit" ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          editorMode === "edit"
            ? { ...payload, baseRevision: view.activeDocument.revisionNumber }
            : payload,
        ),
      },
    );
    const body = await responseBody(response);
    setPending(false);
    if (!response.ok) {
      setError(
        body.code === "REVISION_CONFLICT"
          ? copy.documentConflict
          : body.error || copy.documentSaveFailed,
      );
      return;
    }
    setSaveToastCycle((current) => current + 1);
    setEditorMode(null);
    if (editorMode === "create" && body.document?.id) {
      router.push(workspaceHref(view.workspace.id, body.document.id));
    }
    router.refresh();
  }

  async function openRevisionPreview(revisionId: string) {
    if (loadingRevisionId || restoringRevisionId) return;
    setLoadingRevisionId(revisionId);
    setRevisionPreviewError("");
    const response = await workspaceRequest(
      `/api/documents/${view.activeDocument.id}/revisions/${revisionId}`,
    );
    const body = await responseBody(response);
    setLoadingRevisionId(null);
    if (!response.ok || !body.revision) {
      setRevisionPreviewError(body.error || copy.revisionLoadFailed);
      return;
    }
    setRevisionPreview(body.revision);
  }

  async function restoreRevision(revisionId: string, revisionNumber: number) {
    if (restoringRevisionId) return;
    if (!window.confirm(formatCopy(copy.revisionRestoreConfirm, { revision: revisionNumber }))) return;
    setRestoringRevisionId(revisionId);
    setError("");
    const response = await workspaceRequest(
      `/api/documents/${view.activeDocument.id}/revisions/${revisionId}/restore`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: view.activeDocument.revisionNumber,
          expectedGeneration: view.collaboration.generation,
          expectedDraftVersion: collaborativeDraftVersion,
        }),
      },
    );
    const body = await responseBody(response);
    setRestoringRevisionId(null);
    if (!response.ok) {
      setError(
        body.code === "REVISION_CONFLICT"
          ? copy.revisionConflict
          : body.error || copy.revisionRestoreFailed,
      );
      return;
    }
    setRevisionPreview(null);
    router.refresh();
  }

  async function renameDocument(event: FormEvent) {
    event.preventDefault();
    if (!dialogDocument) return;
    const title = renameTitle.trim();
    if (!title || title === dialogDocument.title || documentActionPending) return;
    setDocumentActionPending(true);
    setDocumentActionError("");
    const response = await workspaceRequest(`/api/documents/${dialogDocument.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: dialogDocument.revisionNumber,
        title,
        summary: formatCopy(copy.renameSummary, { title }),
      }),
    });
    const body = await responseBody(response);
    setDocumentActionPending(false);
    if (!response.ok) {
      setDocumentActionError(
        body.code === "REVISION_CONFLICT"
          ? copy.revisionConflict
          : body.error || copy.renameFailed,
      );
      return;
    }
    setDocumentDialog(null);
    router.refresh();
  }

  async function archiveSelectedDocument(event: FormEvent) {
    event.preventDefault();
    if (!dialogDocument || deletingLastDocument || documentActionPending) return;
    setDocumentActionPending(true);
    setDocumentActionError("");
    const response = await workspaceRequest(`/api/documents/${dialogDocument.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: dialogDocument.revisionNumber }),
    });
    const body = await responseBody(response);
    setDocumentActionPending(false);
    if (!response.ok) {
      setDocumentActionError(
        body.code === "REVISION_CONFLICT"
          ? copy.revisionConflict
          : body.error || copy.deleteFailed,
      );
      return;
    }
    setDocumentDialog(null);
    if (deletingActiveDocument) {
      router.replace(workspaceHref(view.workspace.id, body.nextDocumentId));
    }
    router.refresh();
  }

  async function restoreTrashDocument(workspaceId: string, rootDocumentId: string) {
    if (trashPendingId) return;
    setTrashPendingId(`${workspaceId}:${rootDocumentId}`);
    setTrashError("");
    const response = await workspaceScopedRequest(
      workspaceId,
      `/api/trash/${rootDocumentId}/restore`,
      { method: "POST" },
    );
    const body = await responseBody(response);
    setTrashPendingId(null);
    if (!response.ok) {
      setTrashError(body.error || copy.documentRestoreFailed);
      return;
    }
    router.refresh();
  }

  async function purgeTrashDocument(
    workspaceId: string,
    rootDocumentId: string,
    title: string,
  ) {
    if (trashPendingId || !window.confirm(
      formatCopy(copy.purgeDocumentConfirm, { title }),
    )) return;
    setTrashPendingId(`${workspaceId}:${rootDocumentId}`);
    setTrashError("");
    const response = await workspaceScopedRequest(
      workspaceId,
      `/api/trash/${rootDocumentId}`,
      { method: "DELETE" },
    );
    const body = await responseBody(response);
    setTrashPendingId(null);
    if (!response.ok) {
      setTrashError(body.error || copy.documentPurgeFailed);
      return;
    }
    router.refresh();
  }

  async function emptyWorkspaceTrash(
    workspaceId: string,
    workspaceName: string,
    documentCount: number,
  ) {
    if (trashPendingId || documentCount === 0 || !window.confirm(
      formatCopy(copy.emptyTrashConfirm, {
        workspace: workspaceName,
        count: documentCount,
      }),
    )) return;
    setTrashPendingId(`${workspaceId}:all`);
    setTrashError("");
    const response = await workspaceScopedRequest(workspaceId, "/api/trash", { method: "DELETE" });
    const body = await responseBody(response);
    setTrashPendingId(null);
    if (!response.ok) {
      setTrashError(body.error || copy.emptyTrashFailed);
      return;
    }
    router.refresh();
  }

  function openWorkspaceLifecycleAction(
    workspaceId: string,
    workspaceName: string,
  ) {
    setWorkspaceLifecycleAction({ workspaceId, workspaceName });
    setWorkspaceLifecycleConfirmation("");
    setWorkspaceLifecycleError("");
  }

  async function submitWorkspaceLifecycleAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceLifecycleAction || workspaceLifecyclePending) return;
    const { workspaceId, workspaceName } = workspaceLifecycleAction;
    if (workspaceLifecycleConfirmation.trim() !== workspaceName) return;
    setWorkspaceLifecyclePending(`purge:${workspaceId}`);
    setWorkspaceLifecycleError("");
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/purge`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmationName: workspaceLifecycleConfirmation.trim() }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as WorkspaceLifecycleApiBody;
    if (!response.ok || !body.workspace) {
      setWorkspaceLifecyclePending(null);
      setWorkspaceLifecycleError(
        body.error || copy.workspacePurgeFailed,
      );
      return;
    }
    setWorkspaceLifecyclePending(null);
    setWorkspaceLifecycleAction(null);
    setWorkspaceLifecycleConfirmation("");
    router.refresh();
  }

  async function restoreTrashedWorkspace(workspaceId: string) {
    if (workspaceLifecyclePending) return;
    setWorkspaceLifecyclePending(`restore:${workspaceId}`);
    setWorkspaceLifecycleError("");
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/restore`, {
      method: "POST",
    });
    const body = (await response.json().catch(() => ({}))) as WorkspaceLifecycleApiBody;
    if (!response.ok || !body.workspace) {
      setWorkspaceLifecyclePending(null);
      setWorkspaceLifecycleError(body.error || copy.workspaceRestoreFailed);
      return;
    }
    rememberWorkspaceSelection(workspaceId);
    window.location.assign(workspaceHref(workspaceId));
  }

  async function openPublicShare() {
    if (!view.permissions.canShareDocuments || shareLoading) return;
    bugReports.record({ kind: "lifecycle", action: "share_opened" });
    setShareOpen(true);
    setShareLoading(true);
    setShareError("");
    setShareCopied(false);
    setShareCandidateQuery("");
    setShareSearchFocused(false);
    setSelectedShareCandidate(null);
    setNewShareRole("viewer");
    try {
      const documentId = encodeURIComponent(view.activeDocument.id);
      const [publicResponse, accessResponse] = await Promise.all([
        workspaceRequest(`/api/documents/${documentId}/share`, { cache: "no-store" }),
        workspaceRequest(`/api/documents/${documentId}/access`, { cache: "no-store" }),
      ]);
      const publicBody = await publicResponse.json().catch(() => ({})) as PublicShareApiBody;
      const accessBody = await accessResponse.json().catch(() => ({})) as DocumentAccessApiBody;
      if (!publicResponse.ok || !publicBody.share) {
        setShareError(publicBody.error || copy.publicAccessLoadFailed);
        return;
      }
      if (!accessResponse.ok || !accessBody.access) {
        setShareError(accessBody.error || copy.accessLoadFailed);
        return;
      }
      setPublicShare(publicBody.share);
      setDocumentAccess(accessBody.access);
    } catch {
      setShareError(copy.networkError);
    } finally {
      setShareLoading(false);
    }
  }

  async function setPublicShareEnabled(enabled: boolean) {
    if (sharePending) return;
    setSharePending(true);
    setShareError("");
    setShareCopied(false);
    try {
      const response = await workspaceRequest(
        `/api/documents/${encodeURIComponent(view.activeDocument.id)}/share`,
        { method: enabled ? "POST" : "DELETE" },
      );
      const body = await response.json().catch(() => ({})) as PublicShareApiBody;
      if (!response.ok || !body.share) {
        setShareError(body.error || copy.shareSaveFailed);
        return;
      }
      setPublicShare(body.share);
    } catch {
      setShareError(copy.networkError);
    } finally {
      setSharePending(false);
    }
  }

  async function copyPublicShareUrl() {
    if (!publicShare?.enabled || !publicShare.urlPath) return;
    const url = new URL(publicShare.urlPath, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1_800);
    } catch {
      setShareError(copy.shareCopyFailed);
    }
  }

  async function saveDocumentAccess(
    userId: string,
    role: "viewer" | "editor",
  ) {
    if (sharePending) return false;
    setSharePending(true);
    setShareError("");
    try {
      const response = await workspaceRequest(
        `/api/documents/${encodeURIComponent(view.activeDocument.id)}/access`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId, role }),
        },
      );
      const body = await response.json().catch(() => ({})) as DocumentAccessApiBody;
      if (!response.ok || !body.entry) {
        setShareError(body.error || copy.accessSaveFailed);
        return false;
      }
      setDocumentAccess((current) => {
        const remaining = current.filter((entry) => entry.userId !== body.entry!.userId);
        return [...remaining, body.entry!].sort((left, right) =>
          left.source.localeCompare(right.source)
          || left.name.localeCompare(right.name, localeTag(locale))
          || left.email.localeCompare(right.email));
      });
      setShareCandidates((current) => current.filter((candidate) => candidate.userId !== userId));
      return true;
    } catch {
      setShareError(copy.networkError);
      return false;
    } finally {
      setSharePending(false);
    }
  }

  async function addDocumentAccess() {
    if (!selectedShareCandidate) {
      setShareError(copy.selectShareUser);
      return;
    }
    if (await saveDocumentAccess(selectedShareCandidate.userId, newShareRole)) {
      setSelectedShareCandidate(null);
      setShareCandidateQuery("");
      setNewShareRole("viewer");
    }
  }

  async function removeDocumentAccess(userId: string) {
    if (sharePending) return;
    setSharePending(true);
    setShareError("");
    try {
      const response = await workspaceRequest(
        `/api/documents/${encodeURIComponent(view.activeDocument.id)}/access/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as DocumentAccessApiBody;
        setShareError(body.error || copy.accessDeleteFailed);
        return;
      }
      setDocumentAccess((current) => current.filter((entry) => entry.userId !== userId));
    } catch {
      setShareError(copy.networkError);
    } finally {
      setSharePending(false);
    }
  }

  useEffect(() => {
    if (!shareOpen || shareLoading || selectedShareCandidate) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setShareCandidatesLoading(true);
      const query = new URLSearchParams({ q: shareCandidateQuery.trim() });
      void workspaceRequest(
        `/api/documents/${encodeURIComponent(view.activeDocument.id)}/access/candidates?${query.toString()}`,
        { cache: "no-store", signal: controller.signal },
      )
        .then(async (response) => {
          const body = await response.json().catch(() => ({})) as DocumentCandidatesApiBody;
          if (!response.ok || !body.candidates) {
            throw new Error(body.error || copy.candidatesLoadFailed);
          }
          setShareCandidates(body.candidates);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setShareError(error instanceof Error ? error.message : copy.candidatesLoadFailed);
        })
        .finally(() => {
          if (!controller.signal.aborted) setShareCandidatesLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    copy.candidatesLoadFailed,
    selectedShareCandidate,
    shareCandidateQuery,
    shareLoading,
    shareOpen,
    view.activeDocument.id,
    workspaceRequest,
  ]);

  const editorValid =
    draftContentValid &&
    (editorMode === "create" || draftTitle.trim().length > 0);
  const handleInvalidSaveShortcut = useCallback(() => {
    setError(
      editorMode === "create"
        ? copy.fixBody
        : copy.fixTitleAndBody,
    );
  }, [copy.fixBody, copy.fixTitleAndBody, editorMode]);
  useFormSaveShortcut({
    enabled: editorMode !== null,
    formId: "nyxdoc-document-editor",
    onInvalid: handleInvalidSaveShortcut,
    pending,
    valid: editorValid,
  });
  useEffect(() => {
    if (!view.permissions.canCommitDocuments || editorMode !== null) return;
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      void commitSharedDraft();
    };
    window.addEventListener("keydown", handleSaveShortcut, true);
    return () => window.removeEventListener("keydown", handleSaveShortcut, true);
  }, [commitSharedDraft, editorMode, view.permissions.canCommitDocuments]);
  const activeChildren = documents
    .filter((document) => document.parentDocumentId === view.activeDocument.id)
    .sort((left, right) => left.treeOrder - right.treeOrder || left.title.localeCompare(right.title, localeTag(locale)));
  const unavailableParents = editorMode === "edit"
    ? new Set([view.activeDocument.id, ...descendantIds(documents, view.activeDocument.id)])
    : new Set<string>();
  const parentOptions = documents
    .filter((document) => !unavailableParents.has(document.id))
    .map((document) => ({
      ...document,
      pathLabel: documentPath(documents, document.id).map((item) => item.title).join(" / "),
    }))
    .sort((left, right) => left.pathLabel.localeCompare(right.pathLabel, localeTag(locale)));
  // CRDT updates are normally acknowledged in a few milliseconds. Showing
  // that transport pulse for every keystroke makes the entire action bar
  // flash even though the draft itself remains safely stored. Keep the
  // visible state stable while online and reserve state changes for events
  // that actually require the user's attention.
  const collaborationStatusLabel = collaborationStatus === "synced" || collaborationStatus === "saving"
    ? collaborativeDirty ? copy.draftSaved : copy.matchesRevision
    : collaborationStatus === "connecting"
        ? copy.connecting
        : collaborationStatus === "offline"
          ? copy.offline
          : copy.connectionError;
  const collaborationOnline = collaborationStatus === "synced" || collaborationStatus === "saving";
  const canCommitSharedDraft =
    view.permissions.canCommitDocuments
    && collaborationReady
    && collaborationStatus === "synced"
    && collaborativeTitle.trim().length > 0
    && collaborativeContentValid
    && !commitPending;
  const commitTemporarilySyncing =
    collaborationStatus === "saving"
    && view.permissions.canCommitDocuments
    && collaborationReady
    && collaborativeTitle.trim().length > 0
    && collaborativeContentValid
    && !commitPending;
  const dialogDocument = documentDialog
    ? documents.find((document) => document.id === documentDialog.documentId)
    : undefined;
  const archiveDescendants = dialogDocument
    ? descendantIds(documents, dialogDocument.id)
    : new Set<string>();
  const archiveDescendantCount = archiveDescendants.size;
  const archiveCount = archiveDescendantCount + 1;
  const deletingLastDocument = archiveCount >= documents.length;
  const deletingActiveDocument = Boolean(
    dialogDocument &&
    (dialogDocument.id === view.activeDocument.id || archiveDescendants.has(view.activeDocument.id)),
  );

  function changeWorkspace(workspaceId: string) {
    if (workspaceId === CREATE_WORKSPACE_OPTION_VALUE) {
      setWorkspaceCreateOpen(true);
      return;
    }
    rememberWorkspaceSelection(workspaceId);
    router.push(workspaceHref(workspaceId));
  }

  function currentBugSnapshot(): AppBugReportRequest["snapshot"] {
    const diagnostics = collaborativeDiagnosticsRef.current;
    return {
      surface: shareOpen
        ? "share_dialog"
        : historyOpen
          ? "history_panel"
          : view.permissions.canEditDocuments || editorMode !== null
            ? "editor"
            : "workspace",
      editorMode: editorMode ?? (view.permissions.canEditDocuments ? "edit" : "read"),
      canonicalRevision: view.activeDocument.revisionNumber,
      generation: view.collaboration.generation,
      draftVersion: collaborativeDraftVersion,
      committedDraftVersion: collaborativeCommittedDraftVersion,
      dirty: collaborativeDirty,
      syncState: collaborationStatus,
      validationState: collaborativeContentValid ? "valid" : "invalid",
      visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
      accessKind: view.workspace.accessSource,
      workspaceRole: view.workspace.role,
      canRead: true,
      canEdit: view.permissions.canEditDocuments,
      canCommit: view.permissions.canCommitDocuments,
      canShare: view.permissions.canShareDocuments,
      blockCount: diagnosticCountBucket(
        diagnostics?.blockCount ?? view.activeDocument.content.blocks.length,
      ),
      textLength: diagnosticCountBucket(diagnostics?.textLength ?? 0),
      nodeTypeCount: diagnosticCountBucket(diagnostics?.nodeTypes?.length ?? 0),
      documentCount: diagnosticCountBucket(documents.length),
      sidebarWidth: sidebarWidth < 240
        ? "compact"
        : sidebarWidth > 360
          ? "wide"
          : "standard",
    };
  }

  function openBugReport() {
    if (!bugReports.enabled) return;
    // Freeze the diagnostic context before opening the dialog. Opening a
    // modal changes focus and selection, so collecting it afterwards would
    // describe the report UI rather than the problem the user just saw.
    const events = bugReports.snapshot();
    const suggestedCategory = suggestBugReportCategory(events);
    const editorTrace = sanitizeEditorTrace(
      getCaretTraceRecorder(view.activeDocument.id).snapshot(),
    );
    setBugReportDialog({
      clientReportId: globalThis.crypto.randomUUID(),
      sessionId: bugReports.getSessionId(),
      capturedAt: new Date().toISOString(),
      suggestedCategory,
      category: suggestedCategory,
      description: "",
      environment: bugReportEnvironment(locale),
      snapshot: currentBugSnapshot(),
      events,
      editorTrace,
      attachments: [],
      status: "editing",
      copied: false,
    });
  }

  function closeBugReport() {
    setBugReportDialog((current) => {
      current?.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      return null;
    });
  }

  function addBugReportAttachments(files: FileList | null) {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;
    setBugReportDialog((current) => {
      if (!current || current.status === "submitting" || current.status === "success") {
        return current;
      }
      const available = MAX_BUG_REPORT_ATTACHMENTS - current.attachments.length;
      if (selected.length > available) {
        return { ...current, error: copy.bugAttachmentTooMany };
      }
      if (selected.some((file) => file.size > MAX_BUG_REPORT_ATTACHMENT_BYTES)) {
        return { ...current, error: copy.bugAttachmentTooLarge };
      }
      if (selected.some((file) => !BUG_REPORT_ATTACHMENT_MIME_TYPES.includes(
        file.type as (typeof BUG_REPORT_ATTACHMENT_MIME_TYPES)[number],
      ))) {
        return { ...current, error: copy.bugAttachmentUnsupported };
      }
      return {
        ...current,
        error: undefined,
        attachments: [
          ...current.attachments,
          ...selected.map((file) => ({
            id: globalThis.crypto.randomUUID(),
            file,
            previewUrl: URL.createObjectURL(file),
          })),
        ],
      };
    });
  }

  function removeBugReportAttachment(id: string) {
    setBugReportDialog((current) => {
      if (!current || current.status === "submitting") return current;
      const removed = current.attachments.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return {
        ...current,
        error: undefined,
        attachments: current.attachments.filter((attachment) => attachment.id !== id),
      };
    });
  }

  async function submitBugReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const frozen = bugReportDialog;
    if (!frozen || frozen.status === "submitting" || frozen.status === "success") return;
    setBugReportDialog({ ...frozen, status: "submitting", error: undefined });
    const report = {
      schemaVersion: 1,
      clientReportId: frozen.clientReportId,
      sessionId: frozen.sessionId,
      trigger: "manual",
      category: frozen.category,
      categorySource: frozen.category === frozen.suggestedCategory
        ? "suggested"
        : "user_override",
      suggestedCategory: frozen.suggestedCategory,
      reasonCode: "manual_report",
      capturedAt: frozen.capturedAt,
      clientBuildSha: clientBuildSha(),
      documentId: view.activeDocument.id,
      ...(frozen.description.trim()
        ? { description: frozen.description.trim() }
        : {}),
      environment: frozen.environment,
      snapshot: frozen.snapshot,
      events: frozen.events,
      ...(frozen.category === "editor_caret"
        ? { editorTrace: frozen.editorTrace }
        : {}),
    } satisfies AppBugReportRequest;
    try {
      const requestInit: RequestInit = frozen.attachments.length > 0
        ? (() => {
            const form = new FormData();
            form.set("report", JSON.stringify(report));
            frozen.attachments.forEach((attachment) => {
              form.append("attachment", attachment.file, attachment.file.name);
            });
            return { method: "POST", body: form, cache: "no-store" };
          })()
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(report),
            cache: "no-store",
          };
      const response = await workspaceRequest("/api/bug-reports", {
        ...requestInit,
      });
      const body = await response.json().catch(() => ({})) as BugReportApiBody;
      if (!response.ok || !body.report?.code) {
        setBugReportDialog({
          ...frozen,
          status: "error",
          error: response.status === 429 ? copy.bugRateLimited : copy.bugFailed,
        });
        return;
      }
      setBugReportDialog({
        ...frozen,
        status: "success",
        code: body.report.code,
        error: undefined,
      });
    } catch {
      setBugReportDialog({
        ...frozen,
        status: "error",
        error: copy.bugFailed,
      });
    }
  }

  function reportAutomaticCaretAnomaly(incident: {
    reason: Exclude<
      AppBugReportRequest["detector"],
      undefined
    > | "manual";
    mountCount: number;
    trace: Parameters<typeof sanitizeEditorTrace>[0];
  }) {
    if (!bugReports.enabled || incident.reason === "manual") return;
    const report = {
      schemaVersion: 1,
      clientReportId: globalThis.crypto.randomUUID(),
      sessionId: bugReports.getSessionId(),
      trigger: "automatic",
      category: "editor_caret",
      categorySource: "detector",
      detector: incident.reason,
      reasonCode: incident.reason,
      capturedAt: new Date().toISOString(),
      clientBuildSha: clientBuildSha(),
      documentId: view.activeDocument.id,
      environment: bugReportEnvironment(locale),
      snapshot: currentBugSnapshot(),
      events: bugReports.snapshot(),
      editorTrace: sanitizeEditorTrace(incident.trace),
    } satisfies AppBugReportRequest;
    void workspaceRequest("/api/bug-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      cache: "no-store",
      keepalive: true,
    }).catch(() => {
      // Automatic diagnostics must never interrupt editing or saving.
    });
  }

  return (
    <main
      className={styles.page}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <header className={styles.topbar}>
        <Link href={workspaceHref(view.workspace.id)} className={styles.brand}><span><NyxdocMark size={34} /></span>nyxdoc</Link>
        <div className={styles.documentIdentity}>
          <label className={styles.workspaceSwitcher}>
            <span className={styles.visuallyHidden}>{copy.workspaceSelect}</span>
            <select
              aria-label={copy.workspaceSelect}
              value={view.workspace.id}
              onChange={(event) => changeWorkspace(event.target.value)}
            >
              {view.workspaces.map((workspace) => (
                <option value={workspace.id} key={workspace.id}>{workspace.name}</option>
              ))}
              <option disabled>──────────</option>
              <option value={CREATE_WORKSPACE_OPTION_VALUE}>{copy.newWorkspace}</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <span className={styles.identityDivider} aria-hidden="true">/</span>
          <span className={styles.documentTitleText}>
            {collaborativeTitle.trim() || copy.untitled}
          </span>
        </div>
        <div
          className={styles.documentActions}
          role="group"
          aria-label={copy.documentMenu}
          title={copy.horizontalHint}
          {...documentActionsDrag}
        >
          <RealtimePresence
            key={view.activeDocument.id}
            workspaceId={view.workspace.id}
            activeDocumentId={view.activeDocument.id}
            userId={view.user.id}
            editing={view.permissions.canEditDocuments}
            watchWorkspaceDocuments={view.permissions.canAccessWorkspaceFeatures}
            onDocumentListInvalidated={refreshDocumentList}
          />
          {view.permissions.canAccessWorkspaceFeatures && (
            <DocumentAssignments
              workspaceId={view.workspace.id}
              documentId={view.activeDocument.id}
              agents={view.agents}
              assignments={view.assignments}
              canManage={view.permissions.canManageAssignments}
            />
          )}
          <button
            type="button"
            className={`${styles.historyButton} ${historyOpen ? styles.historyButtonActive : ""}`}
            aria-controls="document-history-panel"
            aria-expanded={historyOpen}
            onClick={() => {
              setRevisionPreviewError("");
              bugReports.record({ kind: "lifecycle", action: "history_opened" });
              setHistoryOpen(true);
            }}
          >
            <History size={15} />
            <span>{copy.history}</span>
            <small>{formatCopy(copy.revision, { revision: view.activeDocument.revisionNumber })}</small>
            <ChevronRight size={14} />
          </button>
              {view.permissions.canExportDocuments && (
                <a
                  className={styles.documentUtilityButton}
                  href={printHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={copy.pdfTitle}
                >
                  <FileDown size={15} />
                  <span>PDF</span>
                </a>
              )}
              {view.permissions.canShareDocuments && (
                <button
                  type="button"
                  className={styles.documentUtilityButton}
                  onClick={() => void openPublicShare()}
                  title={copy.shareTitle}
                >
                  <Share2 size={15} />
                  <span>{copy.share}</span>
                </button>
              )}
              {view.permissions.canCreateDocuments && (
                <button className={styles.childCreateButton} onClick={() => openCreate(view.activeDocument.id)} aria-label={copy.createChild} title={copy.createChild}><FilePlus2 size={15} /><span>{copy.childDocument}</span></button>
              )}
              {view.permissions.canEditDocuments && (
                <span
                  className={`${styles.collaborationState} ${!collaborationOnline ? styles.collaborationStateOffline : ""}`}
                  title={collaborationMessage || collaborationStatusLabel}
                >
                  {collaborationOnline ? <Cloud size={14} /> : <CloudOff size={14} />}
                  <span>{collaborationStatusLabel}</span>
                </span>
              )}
              {view.permissions.canEditDocuments && collaborativeDirty && (
                <button
                  type="button"
                  className={styles.discardDraftButton}
                  disabled={discardPending || commitPending}
                  onClick={() => void discardSharedDraft()}
                >
                  <RotateCcw size={14} />
                  <span>{discardPending ? copy.discarding : copy.discardDraft}</span>
                </button>
              )}
              {view.permissions.canCommitDocuments && (
                <button
                  type="button"
                  className={`${styles.editButton} ${commitTemporarilySyncing ? styles.editButtonSyncing : ""}`}
                  disabled={!canCommitSharedDraft}
                  onClick={() => void commitSharedDraft()}
                  title={collaborationStatus === "offline" ? copy.offlineSaveTitle : copy.saveShortcut}
                >
                  <Save size={15} />
                  <span>{commitPending ? copy.saving : copy.save}</span>
                </button>
              )}
              {bugReports.enabled && (
                <button
                  type="button"
                  className={styles.documentUtilityButton}
                  onClick={openBugReport}
                  title={copy.reportBugDescription}
                >
                  <Bug size={15} />
                  <span>{copy.reportBug}</span>
                </button>
              )}
        </div>
        <Link href={settingsHref} className={styles.account} aria-label={copy.accountSettings}>
          <UserAvatar
            className={styles.avatar}
            imageUrl={view.user.image}
            name={view.user.name}
          />
          <div className={styles.accountCopy}><strong>{view.user.name}</strong><small>{view.user.email}</small></div>
          <span className={styles.accountSettingsIcon}><Settings2 size={16} /></span>
        </Link>
      </header>

      <div className={`${styles.layout} ${historyOpen ? styles.layoutWithHistory : ""}`}>
        <aside className={styles.sidebar}>
          <div className={styles.mobileWorkspaceNavigation}>
            <Building2 size={18} aria-hidden="true" />
            <label className={styles.workspaceSwitcher}>
              <span className={styles.visuallyHidden}>{copy.workspaceSelect}</span>
              <select
                aria-label={copy.workspaceSelect}
                value={view.workspace.id}
                onChange={(event) => changeWorkspace(event.target.value)}
              >
                {view.workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>{workspace.name}</option>
                ))}
                <option disabled>──────────</option>
                <option value={CREATE_WORKSPACE_OPTION_VALUE}>{copy.newWorkspace}</option>
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </label>
          </div>
          {view.permissions.canAccessWorkspaceFeatures && (
            <DocumentTasks
              key={`${view.workspace.id}:${view.activeDocument.id}`}
              workspaceId={view.workspace.id}
              activeDocumentId={view.activeDocument.id}
              initialTasks={view.tasks}
              agents={view.agents}
              documents={documents}
              canCreate={view.permissions.canCreateTasks}
              canUpdate={view.permissions.canUpdateTasks}
              canManage={view.permissions.canManageTasks}
            />
          )}
          <div className={styles.sideHeading}>
            <span>{copy.documents}</span>
            {view.permissions.canCreateDocuments && (
              <button onClick={() => openCreate(null)} aria-label={copy.createTopLevel} title={copy.createTopLevel}><FilePlus2 size={15} /></button>
            )}
          </div>
          {view.permissions.canAccessWorkspaceFeatures && (
            <SavedViewsPanel
              workspaceId={view.workspace.id}
              userId={view.user.id}
              views={view.savedViews}
              agents={view.agents}
              documents={documents}
              canManage={view.permissions.canManageSavedViews}
              canManageAll={view.permissions.canManageAllSavedViews}
            />
          )}
          <DocumentTree
            userId={view.user.id}
            workspaceId={view.workspace.id}
            documents={documents}
            activeDocumentId={view.activeDocument.id}
            expandedDocumentIds={expandedDocumentIds}
            onExpandedDocumentIdsChange={persistNavigationPreference}
            navigationStateKey="workspace"
            onCreateChild={view.permissions.canCreateDocuments ? openCreate : undefined}
            onRename={view.permissions.canEditDocuments
              ? (documentId) => openDocumentDialog("rename", documentId)
              : undefined}
            onDelete={view.permissions.canTrashDocuments
              ? (documentId) => openDocumentDialog("delete", documentId)
              : undefined}
            onReorder={view.permissions.canManageDocumentStructure
              ? reorderDocumentInTree
              : undefined}
            onDiagnostic={bugReports.enabled ? recordTreeDiagnostic : undefined}
          />
          {view.permissions.canAccessWorkspaceFeatures && (
            <button className={styles.trashButton} type="button" onClick={() => {
              setTrashError("");
              setTrashOpen(true);
            }}>
              <Trash2 size={15} />
              <span>{copy.trash}</span>
              {totalTrashCount > 0 && <em>{totalTrashCount}</em>}
            </button>
          )}
        </aside>

        <div
          className={styles.sidebarResizeHandle}
          role="separator"
          aria-label={copy.resizeSidebar}
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          title={copy.resizeSidebarTitle}
          onDoubleClick={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onKeyDown={resizeSidebarWithKeyboard}
          onPointerDown={startSidebarResize}
        />

        <section className={styles.documentPane}>

          <article
            className={`${styles.paper} ${view.permissions.canEditDocuments ? styles.paperEditing : ""}`}
            aria-label={formatCopy(copy.body, { title: view.activeDocument.title })}
          >
            {view.permissions.canEditDocuments ? (
              <NyxdocRichEditor
                key={view.collaboration.roomName}
                ariaLabel={formatCopy(copy.sharedDraft, { title: view.activeDocument.title })}
                documentHeader={(
                  <header className={`${styles.documentPageHeader} ${styles.documentPageHeaderEditing}`}>
                    <textarea
                      ref={collaborativeTitleRef}
                      className={styles.documentPageTitleInput}
                      aria-label={copy.documentName}
                      value={collaborativeTitle}
                      maxLength={200}
                      rows={1}
                      placeholder={copy.untitled}
                      disabled={!collaborationReady}
                      onChange={(event) => {
                        setCollaborativeTitle(event.target.value);
                        updateCollaborativeMetadata("title", event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        const editor = event.currentTarget
                          .closest("article")
                          ?.querySelector<HTMLElement>('[data-slate-editor="true"]');
                        editor?.focus();
                      }}
                    />
                  </header>
                )}
                documentId={view.activeDocument.id}
                documentLinks={editorDocumentLinks}
                initialDocument={collaborativeInitialDocument}
                workspaceId={view.workspace.id}
                collaboration={editorCollaboration}
                toolbarTop={56}
                onChange={handleCollaborativeEditorChange}
                onDiagnostic={bugReports.enabled ? reportEditorDiagnostic : undefined}
                onCaretAnomaly={bugReports.enabled ? reportAutomaticCaretAnomaly : undefined}
              />
            ) : (
              <NyxdocRichEditor
                key={`${view.activeDocument.id}:${view.activeDocument.revisionId}:view`}
                ariaLabel={formatCopy(copy.body, { title: view.activeDocument.title })}
                documentHeader={(
                  <header className={styles.documentPageHeader}>
                    <h1 className={styles.documentPageTitle}>
                      {collaborativeTitle.trim() || copy.untitled}
                    </h1>
                  </header>
                )}
                documentId={view.activeDocument.id}
                initialDocument={view.activeDocument.content}
                readOnly
                workspaceId={view.workspace.id}
              />
            )}
            {activeChildren.length > 0 && (
              <section className={styles.childDocuments}>
                <header>
                  <div><FolderTree size={17} /><strong>{copy.childDocuments}</strong></div>
                  {view.permissions.canCreateDocuments && (
                    <button type="button" onClick={() => openCreate(view.activeDocument.id)}><FilePlus2 size={14} /> {copy.newDocument}</button>
                  )}
                </header>
                <div className={styles.childDocumentList}>
                  {activeChildren.map((document) => (
                    <Link href={workspaceHref(view.workspace.id, document.id)} key={document.id}>
                      <span><FileText size={16} /></span>
                      <div><strong>{document.title}</strong><small>{formatCopy(copy.revision, { revision: document.revisionNumber })}</small></div>
                      <ChevronRight size={15} />
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </article>
        </section>

        {historyOpen && (
          <aside
            id="document-history-panel"
            className={styles.historyPanel}
            aria-label={copy.history}
          >
            <header className={styles.historyPanelHeader}>
              <div>
                <span><History size={15} /> {copy.history}</span>
                <strong id="document-history-title">{view.activeDocument.title}</strong>
                <small>{copy.revisionSavedNewest}</small>
              </div>
              <button
                type="button"
                aria-label={copy.closeHistory}
                onClick={() => setHistoryOpen(false)}
              >
                <X size={17} />
              </button>
            </header>
            <div className={styles.historyPanelList}>
              {view.revisions.map((revision) => {
                const isCurrent = revision.id === view.activeDocument.revisionId;
                return (
                  <article className={isCurrent ? styles.currentRevision : ""} key={revision.id}>
                    <span className={revision.actorType === "agent" ? styles.agentRevision : revision.actorType === "human" ? styles.humanRevision : ""}>{revision.number}</span>
                    <div>
                      <strong>{revision.summary}</strong>
                      <small className={styles.revisionActorLine}>
                        <UserAvatar
                          className={styles.revisionActorAvatar}
                          imageUrl={revision.actorAvatarMediaId ? `/api/media/${revision.actorAvatarMediaId}` : null}
                          name={revision.actorLabel}
                        />
                        <span>{revision.actorLabel} · {shortDate(revision.createdAt, locale)}</span>
                      </small>
                    </div>
                    {isCurrent
                      ? <em>{copy.current}</em>
                      : (
                        <button
                          type="button"
                          aria-label={formatCopy(copy.viewRevision, { revision: revision.number })}
                          disabled={loadingRevisionId !== null || restoringRevisionId !== null}
                          onClick={() => openRevisionPreview(revision.id)}
                        >
                          <Eye size={13} /> {loadingRevisionId === revision.id ? copy.loading : copy.view}
                        </button>
                      )}
                  </article>
                );
              })}
            </div>
            {revisionPreviewError && <div className={styles.historyPanelError} role="status">{revisionPreviewError}</div>}
          </aside>
        )}
      </div>

      {error && !editorMode && <div className={styles.pageToast} role="status">{error}</div>}
      {saveToastCycle > 0 && (
        <div className={styles.saveToast} role="status" aria-live="polite">
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>{copy.revisionSavedToast}</span>
        </div>
      )}

      {bugReportDialog && (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget
              && bugReportDialog.status !== "submitting"
            ) {
              closeBugReport();
            }
          }}
        >
          <form
            className={styles.bugReportDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bug-report-title"
            onSubmit={submitBugReport}
          >
            <header>
              <span><Bug size={19} /></span>
              <div>
                <h2 id="bug-report-title">{copy.bugDialogTitle}</h2>
                <p>{copy.bugDialogDescription}</p>
              </div>
              <button
                type="button"
                aria-label={copy.close}
                disabled={bugReportDialog.status === "submitting"}
                onClick={closeBugReport}
              >
                <X size={18} />
              </button>
            </header>

            {bugReportDialog.status === "success" && bugReportDialog.code ? (
              <section className={styles.bugReportSuccess} aria-live="polite">
                <CheckCircle2 size={28} aria-hidden="true" />
                <h3>{copy.bugRecorded}</h3>
                <p>{copy.bugRecordedDescription}</p>
                <div>
                  <code>{bugReportDialog.code}</code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(bugReportDialog.code ?? "").then(() => {
                        setBugReportDialog((current) => current
                          ? { ...current, copied: true }
                          : current);
                      });
                    }}
                  >
                    <Copy size={14} />
                    {bugReportDialog.copied ? copy.copied : copy.copyBugCode}
                  </button>
                </div>
              </section>
            ) : (
              <>
                <label className={styles.bugReportField}>
                  <span>{copy.bugType}</span>
                  <select
                    value={bugReportDialog.category}
                    disabled={bugReportDialog.status === "submitting"}
                    onChange={(event) => {
                      const category = event.target.value as BugReportCategory;
                      setBugReportDialog((current) => current
                        ? { ...current, category, error: undefined }
                        : current);
                    }}
                  >
                    <option value="editor_caret">{copy.bugCategoryEditor}</option>
                    <option value="save_sync">{copy.bugCategorySave}</option>
                    <option value="navigation_tree">{copy.bugCategoryNavigation}</option>
                    <option value="permissions_sharing">{copy.bugCategoryPermissions}</option>
                    <option value="performance">{copy.bugCategoryPerformance}</option>
                    <option value="other">{copy.bugCategoryOther}</option>
                  </select>
                  <small>{copy.bugSuggestedType}</small>
                </label>
                <label className={styles.bugReportField}>
                  <span>{copy.bugDescriptionLabel} <em>{copy.optional}</em></span>
                  <textarea
                    value={bugReportDialog.description}
                    maxLength={1_000}
                    rows={4}
                    disabled={bugReportDialog.status === "submitting"}
                    placeholder={copy.bugDescriptionPlaceholder}
                    onChange={(event) => {
                      const description = event.target.value;
                      setBugReportDialog((current) => current
                        ? { ...current, description, error: undefined }
                        : current);
                    }}
                  />
                  <small className={styles.bugReportSensitiveWarning}>
                    <AlertTriangle size={13} />
                    {copy.bugSensitiveWarning}
                  </small>
                </label>
                <div className={styles.bugReportAttachments}>
                  <div>
                    <span>{copy.bugAttachmentsLabel} <em>{copy.optional}</em></span>
                    <label className={styles.bugReportAttachmentButton}>
                      <ImagePlus size={15} aria-hidden="true" />
                      {copy.bugAttachmentsAdd}
                      <input
                        type="file"
                        accept={BUG_REPORT_ATTACHMENT_MIME_TYPES.join(",")}
                        multiple
                        disabled={
                          bugReportDialog.status === "submitting"
                          || bugReportDialog.attachments.length >= MAX_BUG_REPORT_ATTACHMENTS
                        }
                        onChange={(event) => {
                          addBugReportAttachments(event.target.files);
                          event.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  <small>{copy.bugAttachmentsDescription}</small>
                  {bugReportDialog.attachments.length > 0 && (
                    <div className={styles.bugReportAttachmentGrid}>
                      {bugReportDialog.attachments.map((attachment) => (
                        <article key={attachment.id}>
                          <Image
                            src={attachment.previewUrl}
                            alt={attachment.file.name}
                            width={120}
                            height={80}
                            unoptimized
                          />
                          <span title={attachment.file.name}>{attachment.file.name}</span>
                          <button
                            type="button"
                            aria-label={`${copy.bugAttachmentRemove}: ${attachment.file.name}`}
                            disabled={bugReportDialog.status === "submitting"}
                            onClick={() => removeBugReportAttachment(attachment.id)}
                          >
                            <X size={14} />
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
                <div className={styles.bugReportPrivacy}>
                  <strong>{copy.bugPrivacyTitle}</strong>
                  <p>{copy.bugPrivacyDescription}</p>
                </div>
                {bugReportDialog.error && (
                  <div className={styles.modalError} role="status">
                    {bugReportDialog.error}
                  </div>
                )}
              </>
            )}

            <footer>
              <button
                type="button"
                className={styles.dialogCancelButton}
                disabled={bugReportDialog.status === "submitting"}
                onClick={closeBugReport}
              >
                {bugReportDialog.status === "success" ? copy.close : copy.cancel}
              </button>
              {bugReportDialog.status !== "success" && (
                <button
                  type="submit"
                  className={styles.bugReportSubmit}
                  disabled={bugReportDialog.status === "submitting"}
                >
                  <Bug size={14} />
                  {bugReportDialog.status === "submitting"
                    ? copy.bugSubmitting
                    : copy.bugSubmit}
                </button>
              )}
            </footer>
          </form>
        </div>
      )}

      {shareOpen && (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !sharePending) setShareOpen(false);
          }}
        >
          <section
            className={styles.shareDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-share-title"
          >
            <header>
              <span><Share2 size={19} /></span>
              <div>
                <h2 id="document-share-title">{formatCopy(copy.shareDialogTitle, { title: view.activeDocument.title })}</h2>
                <p>{copy.shareDialogDescription}</p>
              </div>
              <button
                type="button"
                aria-label={copy.closeShare}
                disabled={sharePending}
                onClick={() => setShareOpen(false)}
              ><X size={18} /></button>
            </header>
            {shareLoading ? (
              <div className={styles.shareLoading}>{copy.loadingShare}</div>
            ) : (
              <>
                <section className={styles.sharePeopleSection} aria-labelledby="share-people-title">
                  <div className={styles.shareSectionHeading}>
                    <span><UserPlus size={16} /></span>
                    <div>
                      <h3 id="share-people-title">{copy.sharePeople}</h3>
                      <p>{copy.sharePeopleDescription}</p>
                    </div>
                  </div>
                  <div className={styles.shareRecipientComposer}>
                    <div className={styles.shareCandidateField}>
                      <input
                        aria-label={copy.findUser}
                        autoComplete="off"
                        placeholder={copy.userPlaceholder}
                        value={shareCandidateQuery}
                        onChange={(event) => {
                          setSelectedShareCandidate(null);
                          setShareCandidateQuery(event.target.value);
                          setShareSearchFocused(true);
                        }}
                        onFocus={() => setShareSearchFocused(true)}
                        onBlur={() => window.setTimeout(() => setShareSearchFocused(false), 120)}
                      />
                      {selectedShareCandidate && (
                        <button
                          type="button"
                          aria-label={copy.clearUser}
                          onClick={() => {
                            setSelectedShareCandidate(null);
                            setShareCandidateQuery("");
                          }}
                        ><X size={14} /></button>
                      )}
                      {shareSearchFocused && !selectedShareCandidate && (
                        <div className={styles.shareCandidateDropdown}>
                          {shareCandidatesLoading ? (
                            <p>{copy.findingUsers}</p>
                          ) : shareCandidates.length > 0 ? (
                            shareCandidates.map((candidate) => (
                              <button
                                type="button"
                                key={candidate.userId}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  setSelectedShareCandidate(candidate);
                                  setShareCandidateQuery(`${candidate.name} · ${candidate.email}`);
                                  setShareSearchFocused(false);
                                }}
                              >
                                <UserAvatar className={styles.shareAvatar} imageUrl={null} name={candidate.name} />
                                <span><strong>{candidate.name}</strong><small>{candidate.email}</small></span>
                              </button>
                            ))
                          ) : (
                            <p>{copy.noShareCandidates}</p>
                          )}
                        </div>
                      )}
                    </div>
                    <select
                      aria-label={copy.newUserRole}
                      value={newShareRole}
                      onChange={(event) => setNewShareRole(event.target.value as "viewer" | "editor")}
                    >
                      <option value="viewer">{copy.viewer}</option>
                      <option value="editor">{copy.editor}</option>
                    </select>
                    <button
                      type="button"
                      disabled={!selectedShareCandidate || sharePending}
                      onClick={() => void addDocumentAccess()}
                    >
                      {copy.shareAction}
                    </button>
                  </div>
                </section>

                <section className={styles.shareAccessSection} aria-labelledby="share-access-title">
                  <div className={styles.shareSectionHeading}>
                    <span><Users size={16} /></span>
                    <div>
                      <h3 id="share-access-title">{copy.accessUsers}</h3>
                      <p>{copy.accessUsersDescription}</p>
                    </div>
                  </div>
                  <div className={styles.shareAccessList}>
                    {documentAccess.map((entry) => (
                      <article key={`${entry.source}:${entry.userId}`}>
                        <UserAvatar className={styles.shareAvatar} imageUrl={null} name={entry.name} />
                        <div>
                          <strong>{entry.name}{entry.userId === view.user.id ? ` (${copy.me})` : ""}</strong>
                          <small>{entry.email}</small>
                          {entry.source === "workspace" && <em>{copy.inherited}</em>}
                        </div>
                        {entry.source === "document_grant" ? (
                          <div className={styles.shareAccessActions}>
                            <select
                              aria-label={formatCopy(copy.entryRole, { name: entry.name })}
                              disabled={sharePending}
                              value={entry.role}
                              onChange={(event) => void saveDocumentAccess(
                                entry.userId,
                                event.target.value as "viewer" | "editor",
                              )}
                            >
                              <option value="viewer">{copy.viewer}</option>
                              <option value="editor">{copy.editor}</option>
                            </select>
                            <button
                              type="button"
                              disabled={sharePending}
                              onClick={() => void removeDocumentAccess(entry.userId)}
                            >
                              {copy.remove}
                            </button>
                          </div>
                        ) : (
                          <span className={styles.shareInheritedRole}>
                            {documentAccessRoleLabel(entry.role, locale)}
                          </span>
                        )}
                      </article>
                    ))}
                  </div>
                </section>

                <section className={styles.shareGeneralSection} aria-labelledby="share-general-title">
                  <div className={styles.shareSectionHeading}>
                    <span><Share2 size={16} /></span>
                    <div>
                      <h3 id="share-general-title">{copy.generalAccess}</h3>
                      <p>{copy.generalAccessDescription}</p>
                    </div>
                  </div>
                <div className={styles.shareStatus} data-enabled={publicShare?.enabled === true}>
                  <div>
                    <strong>{publicShare?.enabled ? copy.anyoneWithLink : copy.restricted}</strong>
                    <small>
                      {publicShare?.enabled
                        ? copy.publicEnabledDescription
                        : copy.restrictedDescription}
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={sharePending}
                    onClick={() => void setPublicShareEnabled(!publicShare?.enabled)}
                  >
                    {sharePending
                      ? copy.processing
                      : publicShare?.enabled
                        ? copy.makeRestricted
                        : copy.publishLink}
                  </button>
                </div>
                {publicShare?.enabled && publicShare.urlPath && (
                  <div className={styles.shareLinkBox}>
                    <code>{new URL(publicShare.urlPath, window.location.origin).toString()}</code>
                    <button type="button" onClick={() => void copyPublicShareUrl()}>
                      <Copy size={14} /> {shareCopied ? copy.copied : copy.copyLink}
                    </button>
                  </div>
                )}
                <p className={styles.shareNotice}>
                  {copy.restrictLinkNote}
                </p>
                </section>
              </>
            )}
            {shareError && <div className={styles.modalError} role="alert">{shareError}</div>}
          </section>
        </div>
      )}

      {editorMode && (
        <div className={`${styles.modalBackdrop} ${styles.editorBackdrop}`} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !pending) setEditorMode(null);
        }}>
          <section className={styles.editorModal} role="dialog" aria-modal="true" aria-labelledby="editor-title">
            <header className={styles.editorTopbar}>
              <div className={styles.editorTopbarStart}>
                <button type="button" className={styles.editorCloseButton} onClick={() => setEditorMode(null)} disabled={pending} aria-label={copy.returnToDocument}><X size={18} /></button>
                <span className={styles.editorDocumentIcon}><FileText size={16} /></span>
                <div className={styles.editorPath}>
                  <label className={styles.editorFilenameField}>
                    <span id="editor-title" className={styles.visuallyHidden}>{editorMode === "edit" ? copy.editDocument : copy.createDocument}</span>
                    <input
                      form="nyxdoc-document-editor"
                      aria-label={copy.documentName}
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      maxLength={200}
                      size={Math.min(Math.max(draftTitle.length + 1, 12), 40)}
                      placeholder={copy.untitled}
                      autoFocus={editorMode === "create"}
                      required={editorMode === "edit"}
                    />
                  </label>
                </div>
              </div>
              <div className={styles.editorTopbarActions}>
                <label className={styles.editorLocation}>
                  <FolderTree size={14} />
                  <span>{copy.position}</span>
                  <select
                    aria-label={copy.documentLocation}
                    value={draftParentId ?? ""}
                    onChange={(event) => setDraftParentId(event.target.value || null)}
                  >
                    <option value="">{copy.topLevel}</option>
                    {parentOptions.map((document) => <option value={document.id} key={document.id}>{document.pathLabel}</option>)}
                  </select>
                </label>
                <span className={styles.editorRevisionState}><History size={14} /> {editorMode === "edit"
                  ? formatCopy(copy.saveAsRevision, { revision: view.activeDocument.revisionNumber + 1 })
                  : copy.saveFirstRevision}</span>
                <button
                  type="submit"
                  form="nyxdoc-document-editor"
                  className={styles.saveButton}
                  disabled={pending || !editorValid}
                >
                  <Save size={15} /> {pending ? copy.saving : copy.save}
                  {!pending && <kbd className={styles.saveShortcut}>Ctrl/⌘ S</kbd>}
                </button>
              </div>
            </header>
            <div className={styles.editorBody}>
              <aside className={styles.editorSidebar} aria-label={copy.editingNavigation}>
                <div className={styles.editorSidebarHeading}>
                  <span>{copy.documents}</span>
                  {view.permissions.canCreateDocuments && (
                    <button type="button" onClick={() => createFromEditor(null)} aria-label={copy.createTopLevel} title={copy.createTopLevel}><FilePlus2 size={15} /></button>
                  )}
                </div>
                <DocumentTree
                  userId={view.user.id}
                  workspaceId={view.workspace.id}
                  documents={documents}
                  activeDocumentId={view.activeDocument.id}
                  expandedDocumentIds={expandedDocumentIds}
                  onExpandedDocumentIdsChange={persistNavigationPreference}
                  navigationStateKey="editor"
                  onCreateChild={view.permissions.canCreateDocuments ? createFromEditor : undefined}
                  onNavigate={navigateFromEditor}
                  onReorder={view.permissions.canManageDocumentStructure
                    ? reorderDocumentInTree
                    : undefined}
                  onDiagnostic={bugReports.enabled ? recordTreeDiagnostic : undefined}
                />
              </aside>
              <div
                className={`${styles.sidebarResizeHandle} ${styles.editorSidebarResizeHandle}`}
                role="separator"
                aria-label={copy.resizeSidebar}
                aria-orientation="vertical"
                aria-valuemin={MIN_SIDEBAR_WIDTH}
                aria-valuemax={MAX_SIDEBAR_WIDTH}
                aria-valuenow={sidebarWidth}
                tabIndex={0}
                title={copy.resizeSidebarTitle}
                onDoubleClick={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
                onKeyDown={resizeSidebarWithKeyboard}
                onPointerDown={startSidebarResize}
              />
              <form id="nyxdoc-document-editor" onSubmit={saveDocument}>
                <div className={styles.editorCanvas}>
                  <NyxdocRichEditor
                    key={editorSessionId}
                    ariaLabel={copy.editorBody}
                    documentId={editorMode === "edit" ? view.activeDocument.id : undefined}
                    documentLinks={editorDocumentLinks}
                    initialDocument={draftInitialContent}
                    workspaceId={view.workspace.id}
                    onChange={({ content, valid }) => {
                      setDraftContent(content);
                      setDraftContentValid(valid);
                    }}
                    onCaretAnomaly={bugReports.enabled ? reportAutomaticCaretAnomaly : undefined}
                  />
                  <section className={styles.editorChangeNote}>
                    <div>
                      <History size={17} />
                      <label htmlFor="editor-change-summary">{copy.changeNote} <span>{copy.optional}</span></label>
                    </div>
                    <p>{copy.changeNoteHint}</p>
                    <input
                      id="editor-change-summary"
                      value={summary}
                      onChange={(event) => setSummary(event.target.value)}
                      maxLength={300}
                      placeholder={copy.changeNotePlaceholder}
                    />
                  </section>
                  {error && <div className={styles.modalError}>{error}</div>}
                  <p className={styles.editorClosingNote}>{copy.revisionSafety}</p>
                </div>
              </form>
            </div>
          </section>
        </div>
      )}

      {revisionPreview && (
        <div
          className={`${styles.modalBackdrop} ${styles.revisionPreviewBackdrop}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !restoringRevisionId) {
              setRevisionPreview(null);
            }
          }}
        >
          <section
            className={styles.revisionPreviewDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="revision-preview-title"
          >
            <header className={styles.revisionPreviewHeader}>
              <div>
                <span><Eye size={14} /> {copy.readOnly}</span>
                <h2 id="revision-preview-title">{formatCopy(copy.revisionPreview, { revision: revisionPreview.number })}</h2>
                <p>{revisionPreview.summary}</p>
                <small className={styles.revisionPreviewActor}>
                  <UserAvatar
                    className={styles.revisionActorAvatar}
                    imageUrl={revisionPreview.actorAvatarMediaId ? `/api/media/${revisionPreview.actorAvatarMediaId}` : null}
                    name={revisionPreview.actorLabel}
                  />
                  <span>{revisionPreview.actorLabel} · {shortDate(revisionPreview.createdAt, locale)}</span>
                </small>
              </div>
              <button
                type="button"
                aria-label={copy.closePreview}
                disabled={restoringRevisionId !== null}
                onClick={() => setRevisionPreview(null)}
              >
                <X size={18} />
              </button>
            </header>
            <div className={styles.revisionPreviewNotice}>
              {formatCopy(copy.currentDocumentRevision, { revision: view.activeDocument.revisionNumber })}
            </div>
            <article className={styles.revisionPreviewPaper} aria-label={formatCopy(copy.revisionBody, { revision: revisionPreview.number })}>
              <NyxdocRichEditor
                key={`${view.activeDocument.id}:${revisionPreview.id}:preview`}
                ariaLabel={formatCopy(copy.revisionBody, { revision: revisionPreview.number })}
                documentId={view.activeDocument.id}
                initialDocument={revisionPreview.content}
                readOnly
                workspaceId={view.workspace.id}
              />
            </article>
            <footer className={styles.revisionPreviewFooter}>
              <button
                type="button"
                className={styles.dialogCancelButton}
                disabled={restoringRevisionId !== null}
                onClick={() => setRevisionPreview(null)}
              >
                {copy.close}
              </button>
              {view.permissions.canRestoreRevisions && (
                <button
                  type="button"
                  className={styles.revisionRestoreButton}
                  disabled={restoringRevisionId !== null}
                  onClick={() => restoreRevision(revisionPreview.id, revisionPreview.number)}
                >
                  <RotateCcw size={14} />
                  {restoringRevisionId === revisionPreview.id ? copy.restoring : copy.restoreToDraft}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}

      {documentDialog && dialogDocument && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDocumentDialog();
        }}>
          <form
            className={styles.documentDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-dialog-title"
            onSubmit={documentDialog.mode === "rename" ? renameDocument : archiveSelectedDocument}
          >
            <header>
              <span className={documentDialog.mode === "delete" ? styles.documentDialogDangerIcon : ""}>
                {documentDialog.mode === "rename" ? <PencilLine size={19} /> : <Trash2 size={19} />}
              </span>
              <div>
                <h2 id="document-dialog-title">{documentDialog.mode === "rename" ? copy.renameDocument : copy.deleteDocument}</h2>
                <p>{documentDialog.mode === "rename" ? copy.renameDescription : copy.deleteDescription}</p>
              </div>
              <button type="button" onClick={closeDocumentDialog} disabled={documentActionPending} aria-label={copy.dialogClose}><X size={18} /></button>
            </header>

            {documentDialog.mode === "rename" ? (
              <label className={styles.renameDocumentField}>
                <span>{copy.documentName}</span>
                <input
                  value={renameTitle}
                  onChange={(event) => setRenameTitle(event.target.value)}
                  maxLength={200}
                  autoFocus
                  required
                />
              </label>
            ) : (
              <div className={styles.archiveDocumentSummary}>
                <FileText size={18} />
                <div>
                  <strong>{dialogDocument.title}</strong>
                  <span>
                    {archiveDescendantCount > 0
                      ? formatCopy(copy.descendantsDeleted, { count: archiveDescendantCount })
                      : copy.onlyDocumentDeleted}
                  </span>
                </div>
              </div>
            )}

            {documentDialog.mode === "delete" && (
              <p className={deletingLastDocument ? styles.archiveDocumentBlocked : styles.archiveDocumentNote}>
                {deletingLastDocument
                  ? copy.cannotDeleteLast
                  : copy.trashRetention}
              </p>
            )}
            {documentActionError && <div className={styles.modalError}>{documentActionError}</div>}

            <footer>
              <button type="button" className={styles.dialogCancelButton} onClick={closeDocumentDialog} disabled={documentActionPending}>{copy.cancel}</button>
              <button
                type="submit"
                className={documentDialog.mode === "delete" ? styles.dialogDangerButton : styles.dialogPrimaryButton}
                disabled={
                  documentActionPending ||
                  (documentDialog.mode === "rename" && (!renameTitle.trim() || renameTitle.trim() === dialogDocument.title)) ||
                  (documentDialog.mode === "delete" && deletingLastDocument)
                }
              >
                {documentActionPending ? copy.processing : documentDialog.mode === "rename" ? copy.rename : formatCopy(copy.moveToTrash, { count: archiveCount })}
              </button>
            </footer>
          </form>
        </div>
      )}

      {workspaceCreateOpen && (
        <WorkspaceCreateDialog onClose={() => setWorkspaceCreateOpen(false)} />
      )}

      {trashOpen && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => {
          if (
            event.target === event.currentTarget
            && !trashPendingId
            && !workspaceLifecyclePending
          ) setTrashOpen(false);
        }}>
          <section className={styles.trashDialog} role="dialog" aria-modal="true" aria-labelledby="trash-title">
            <header>
              <div>
                <span><Trash2 size={18} /></span>
                <div>
                  <h2 id="trash-title">{copy.unifiedTrash}</h2>
                  <p>{copy.unifiedTrashDescription}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTrashOpen(false)}
                disabled={Boolean(trashPendingId) || Boolean(workspaceLifecyclePending)}
                aria-label={copy.closeTrash}
              ><X size={18} /></button>
            </header>

            <div
              className={styles.trashDialogBody}
              role="region"
              aria-label={copy.trashList}
              tabIndex={0}
            >
              <section
                className={styles.trashSection}
                aria-labelledby="trash-documents-title"
              >
                <header className={styles.trashSectionHeading}>
                  <div>
                    <strong id="trash-documents-title">{copy.deletedDocuments}</strong>
                    <small>{copy.deletedDocumentsDescription}</small>
                  </div>
                  <em>{trashDocumentCount}</em>
                </header>
                {trashDocumentCount === 0 ? (
                  <p className={styles.emptyTrash}>{copy.noDeletedDocuments}</p>
                ) : view.trashWorkspaces
                  .filter((group) => group.documents.length > 0)
                  .map((group) => (
                    <div className={styles.trashWorkspaceGroup} key={group.workspace.id}>
                      <header>
                        <div>
                          <span><Building2 size={15} /></span>
                          <strong>{group.workspace.name}</strong>
                          <small>{formatCopy(copy.documentGroups, { count: group.documents.length })}</small>
                        </div>
                        {group.canPurgeDocuments && (
                          <button
                            type="button"
                            disabled={Boolean(trashPendingId)}
                            onClick={() => void emptyWorkspaceTrash(
                              group.workspace.id,
                              group.workspace.name,
                              group.documents.length,
                            )}
                          >
                            <Trash2 size={13} />
                            {trashPendingId === `${group.workspace.id}:all`
                              ? copy.backingUpDeleting
                              : copy.emptyThisTrash}
                          </button>
                        )}
                      </header>
                      <div className={styles.trashList}>
                        {group.documents.map((item) => {
                          const pendingId = `${group.workspace.id}:${item.rootDocumentId}`;
                          return (
                            <article key={`${group.workspace.id}:${item.id}`}>
                              <span><FileText size={16} /></span>
                              <div>
                                <strong>{item.rootTitle}</strong>
                                <small>{item.documentCount > 1 ? formatCopy(copy.includesChildren, { count: item.documentCount }) : copy.oneDocument} · {item.actorLabel}</small>
                                <small>{formatCopy(copy.deletedTimeline, {
                                  deleted: shortDate(item.trashedAt, locale),
                                  purge: shortDate(item.purgeAfter, locale),
                                })}</small>
                              </div>
                              {group.canRestoreDocuments && (
                                <button
                                  type="button"
                                  onClick={() => void restoreTrashDocument(
                                    group.workspace.id,
                                    item.rootDocumentId,
                                  )}
                                  disabled={Boolean(trashPendingId)}
                                >
                                  <RotateCcw size={14} />
                                  {trashPendingId === pendingId ? copy.processing : copy.restore}
                                </button>
                              )}
                              {group.canPurgeDocuments && (
                                <button
                                  className={styles.purgeButton}
                                  type="button"
                                  onClick={() => void purgeTrashDocument(
                                    group.workspace.id,
                                    item.rootDocumentId,
                                    item.rootTitle,
                                  )}
                                  disabled={Boolean(trashPendingId)}
                                ><Trash2 size={14} /> {copy.permanentlyDelete}</button>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  ))}
              </section>

              <section
                className={styles.trashSection}
                aria-labelledby="trash-workspaces-title"
              >
                <header className={styles.trashSectionHeading}>
                  <div>
                    <strong id="trash-workspaces-title">{copy.deletedWorkspaces}</strong>
                    <small>{copy.deletedWorkspacesDescription}</small>
                  </div>
                  <em>{view.trashedWorkspaces.length}</em>
                </header>
                {view.trashedWorkspaces.length === 0 ? (
                  <p className={styles.emptyTrash}>{copy.noDeletedWorkspaces}</p>
                ) : (
                  <div className={styles.workspaceTrashList}>
                    {view.trashedWorkspaces.map((workspace) => (
                      <article key={`trashed:${workspace.id}`}>
                        <span data-state="trashed"><Trash2 size={16} /></span>
                        <div>
                          <strong>{workspace.name}</strong>
                          <small>{formatCopy(copy.deletedTimeline, {
                            deleted: shortDate(workspace.trashedAt, locale),
                            purge: shortDate(workspace.purgeAfter, locale),
                          })}</small>
                        </div>
                        <button
                          type="button"
                          disabled={Boolean(workspaceLifecyclePending)}
                          onClick={() => void restoreTrashedWorkspace(workspace.id)}
                        >
                          <RotateCcw size={14} />
                          {workspaceLifecyclePending === `restore:${workspace.id}` ? copy.restoringWorkspace : copy.restore}
                        </button>
                        <button
                          type="button"
                          className={styles.workspaceTrashButton}
                          disabled={Boolean(workspaceLifecyclePending)}
                          onClick={() => openWorkspaceLifecycleAction(
                            workspace.id,
                            workspace.name,
                          )}
                        ><Trash2 size={14} /> {copy.permanentlyDelete}</button>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {trashError && <div className={styles.trashError} role="alert">{trashError}</div>}
            {!workspaceLifecycleAction && workspaceLifecycleError && (
              <div className={styles.trashError} role="alert">{workspaceLifecycleError}</div>
            )}
            <footer>
              <button
                type="button"
                onClick={() => setTrashOpen(false)}
                disabled={Boolean(trashPendingId) || Boolean(workspaceLifecyclePending)}
              >{copy.close}</button>
            </footer>
          </section>
        </div>
      )}

      {workspaceLifecycleAction && (
        <div className={`${styles.modalBackdrop} ${styles.lifecycleBackdrop}`} role="presentation">
          <form
            className={styles.workspaceLifecycleDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-lifecycle-title"
            onSubmit={submitWorkspaceLifecycleAction}
          >
            <span><AlertTriangle size={20} /></span>
            <p>PERMANENT DELETION</p>
            <h2 id="workspace-lifecycle-title">{copy.workspacePurgeTitle}</h2>
            <small>{copy.workspacePurgeDescription}</small>
            <label>
              <span>{copy.typeWorkspaceName}</span>
              <strong>{workspaceLifecycleAction.workspaceName}</strong>
              <input
                autoFocus
                autoComplete="off"
                value={workspaceLifecycleConfirmation}
                onChange={(event) => setWorkspaceLifecycleConfirmation(event.target.value)}
              />
            </label>
            {workspaceLifecycleError && (
              <div className={styles.trashError} role="alert">{workspaceLifecycleError}</div>
            )}
            <footer>
              <button
                type="button"
                disabled={Boolean(workspaceLifecyclePending)}
                onClick={() => {
                  setWorkspaceLifecycleAction(null);
                  setWorkspaceLifecycleConfirmation("");
                  setWorkspaceLifecycleError("");
                }}
              >{copy.cancel}</button>
              <button
                type="submit"
                disabled={
                  Boolean(workspaceLifecyclePending)
                  || workspaceLifecycleConfirmation.trim() !== workspaceLifecycleAction.workspaceName
                }
              >
                <Trash2 size={14} />
                {workspaceLifecyclePending
                  ? copy.backingUpDeleting
                  : copy.backupAndDelete}
              </button>
            </footer>
          </form>
        </div>
      )}

    </main>
  );
}
