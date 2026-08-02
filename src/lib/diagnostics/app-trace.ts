import type {
  AppBugTraceEvent,
  BugReportCategory,
} from "@/lib/diagnostics/schema";
import { diagnosticDurationBucket } from "@/lib/diagnostics/schema";

const MAX_EVENTS = 120;
const MAX_AGE_MS = 90_000;

type TraceInput = AppBugTraceEvent extends infer Event
  ? Event extends AppBugTraceEvent
    ? Omit<Event, "sequence" | "offsetMs">
    : never
  : never;

export class AppBugTraceRecorder {
  private readonly startedAt: number;
  private sequence = 0;
  private events: Array<AppBugTraceEvent & { elapsedMs: number }> = [];

  constructor(private readonly now: () => number = () => Date.now()) {
    this.startedAt = now();
  }

  record(input: TraceInput) {
    const elapsedMs = Math.max(0, Math.round(this.now() - this.startedAt));
    const event = {
      ...input,
      sequence: this.sequence,
      offsetMs: 0,
      elapsedMs,
    } as AppBugTraceEvent & { elapsedMs: number };
    this.sequence += 1;
    this.events.push(event);
    this.trim(elapsedMs);
  }

  snapshot() {
    const elapsedMs = Math.max(0, Math.round(this.now() - this.startedAt));
    this.trim(elapsedMs);
    return this.events.map(({ elapsedMs: eventElapsed, ...event }) => ({
      ...structuredClone(event),
      offsetMs: Math.min(0, Math.max(-120_000, eventElapsed - elapsedMs)),
    }));
  }

  clear() {
    this.events = [];
    this.sequence = 0;
  }

  private trim(elapsedMs: number) {
    this.events = this.events
      .filter((event) => elapsedMs - event.elapsedMs <= MAX_AGE_MS)
      .slice(-MAX_EVENTS);
  }
}

export type DiagnosticRequestOperation =
  Extract<AppBugTraceEvent, { kind: "request" }>["operation"];

export function classifyDiagnosticRequest(input: RequestInfo | URL): DiagnosticRequestOperation {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  let pathname = "";
  try {
    pathname = new URL(raw, "https://nyxdoc.invalid").pathname;
  } catch {
    return "other";
  }
  if (pathname === "/api/documents" || /^\/api\/documents\/[^/]+$/.test(pathname)) {
    return "documents";
  }
  if (pathname === "/api/collaboration/commit") return "collaboration_commit";
  if (pathname === "/api/collaboration/discard") return "collaboration_discard";
  if (pathname.includes("/revisions")) return "revisions";
  if (pathname.includes("/share") || pathname.includes("/access")) return "sharing";
  if (pathname.startsWith("/api/assignments")) return "assignments";
  if (pathname.startsWith("/api/tasks")) return "tasks";
  if (pathname.startsWith("/api/saved-views")) return "saved_views";
  if (pathname.startsWith("/api/editor-diagnostics") || pathname === "/api/bug-reports") {
    return "diagnostics";
  }
  return "other";
}

export function diagnosticMethod(method?: string) {
  const normalized = (method || "GET").toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalized)) {
    return normalized as Extract<AppBugTraceEvent, { kind: "request" }>["method"];
  }
  return "OTHER" as const;
}

export function diagnosticRequestOutcome(status: number | null, errorName?: string) {
  if (errorName === "AbortError") return "aborted" as const;
  if (status === null) return "network_error" as const;
  if (status >= 500) return "server_error" as const;
  if (status >= 400) return "client_error" as const;
  return "success" as const;
}

export function requestTraceEvent(input: {
  request: RequestInfo | URL;
  method?: string;
  status: number | null;
  durationMs: number;
  operationId: string;
  errorName?: string;
}): TraceInput {
  return {
    kind: "request",
    operation: classifyDiagnosticRequest(input.request),
    method: diagnosticMethod(input.method),
    outcome: diagnosticRequestOutcome(input.status, input.errorName),
    status: input.status,
    duration: diagnosticDurationBucket(input.durationMs),
    operationId: input.operationId,
  };
}

export function suggestBugReportCategory(
  events: AppBugTraceEvent[],
): BugReportCategory {
  for (const event of [...events].reverse()) {
    if (event.kind === "sync" && event.state === "error") return "save_sync";
    if (
      event.kind === "request"
      && (
        event.operation === "collaboration_commit"
        || event.operation === "collaboration_discard"
      )
      && event.outcome !== "success"
    ) return "save_sync";
    if (
      event.kind === "request"
      && (
        event.operation === "sharing"
        || event.status === 401
        || event.status === 403
      )
      && event.outcome !== "success"
    ) return "permissions_sharing";
    if (event.kind === "tree") return "navigation_tree";
    if (
      event.kind === "request"
      && (event.duration === "2_to_9s" || event.duration === "10s_or_more")
    ) return "performance";
    if (event.kind === "editor_diagnostic") return "editor_caret";
  }
  return "other";
}
