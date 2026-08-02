"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from "react";
import {
  AppBugTraceRecorder,
} from "@/lib/diagnostics/app-trace";
import type { AppBugTraceEvent } from "@/lib/diagnostics/schema";

type TraceInput = AppBugTraceEvent extends infer Event
  ? Event extends AppBugTraceEvent
    ? Omit<Event, "sequence" | "offsetMs">
    : never
  : never;

type BugReportContextValue = {
  enabled: boolean;
  getSessionId: () => string;
  beginScope: (scope: { userId: string; workspaceId: string }) => void;
  record: (event: TraceInput) => void;
  snapshot: () => AppBugTraceEvent[];
};

const AppBugReportContext = createContext<BugReportContextValue | null>(null);
const fallbackRecorder = new AppBugTraceRecorder();
let fallbackSessionId = "";
let fallbackScope = "";
const fallbackContext: BugReportContextValue = {
  enabled: true,
  getSessionId: () => {
    fallbackSessionId ||= globalThis.crypto.randomUUID();
    return fallbackSessionId;
  },
  beginScope: (scope) => {
    const nextScope = `${scope.userId}:${scope.workspaceId}`;
    if (fallbackScope === nextScope) return;
    fallbackScope = nextScope;
    fallbackRecorder.clear();
    fallbackSessionId = globalThis.crypto.randomUUID();
  },
  record: (event) => fallbackRecorder.record(event),
  snapshot: () => fallbackRecorder.snapshot(),
};

export function AppBugReportProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const recorderRef = useRef(new AppBugTraceRecorder());
  const sessionIdRef = useRef(globalThis.crypto.randomUUID());
  const scopeRef = useRef("");

  const beginScope = useCallback((scope: { userId: string; workspaceId: string }) => {
    if (!enabled) return;
    const nextScope = `${scope.userId}:${scope.workspaceId}`;
    if (scopeRef.current === nextScope) return;
    scopeRef.current = nextScope;
    recorderRef.current.clear();
    sessionIdRef.current = globalThis.crypto.randomUUID();
  }, [enabled]);
  const record = useCallback((event: TraceInput) => {
    if (!enabled) return;
    recorderRef.current.record(event);
  }, [enabled]);
  const getSessionId = useCallback(() => sessionIdRef.current, []);
  const snapshot = useCallback(
    () => enabled ? recorderRef.current.snapshot() : [],
    [enabled],
  );
  const value = useMemo(() => ({
    enabled,
    getSessionId,
    beginScope,
    record,
    snapshot,
  }), [beginScope, enabled, getSessionId, record, snapshot]);

  return (
    <AppBugReportContext.Provider value={value}>
      {children}
    </AppBugReportContext.Provider>
  );
}

export function useAppBugReports() {
  const context = useContext(AppBugReportContext);
  return context ?? fallbackContext;
}
