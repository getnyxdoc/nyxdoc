import { z } from "zod";
import type { CaretTraceEvent } from "@/lib/editor/diagnostics";

export const bugReportCategorySchema = z.enum([
  "editor_caret",
  "save_sync",
  "navigation_tree",
  "permissions_sharing",
  "performance",
  "other",
]);

export const bugReportCategorySourceSchema = z.enum([
  "suggested",
  "user_override",
  "detector",
]);

export const bugReportDetectorSchema = z.enum([
  "editor_remounted",
  "jumped_to_document_start",
  "table_cell_changed",
  "table_selection_escaped",
  "unexpected_block_jump",
]);

export const diagnosticCountBucketSchema = z.enum([
  "zero",
  "one_to_ten",
  "eleven_to_hundred",
  "hundred_one_to_thousand",
  "thousand_one_to_ten_thousand",
  "over_ten_thousand",
]);

export const diagnosticDurationBucketSchema = z.enum([
  "under_100ms",
  "100_to_499ms",
  "500_to_1999ms",
  "2_to_9s",
  "10s_or_more",
]);

const bugEnvironmentSchema = z
  .object({
    browser: z.enum(["chrome", "edge", "firefox", "safari", "other"]),
    browserMajor: z.number().int().min(0).max(10_000).nullable(),
    platform: z.enum(["windows", "macos", "linux", "ios", "android", "other"]),
    viewportClass: z.enum(["compact", "medium", "wide"]),
    locale: z.enum(["en", "ko", "ja"]),
    online: z.boolean(),
  })
  .strict();

const bugSnapshotSchema = z
  .object({
    surface: z.enum([
      "workspace",
      "editor",
      "tree",
      "share_dialog",
      "history_panel",
    ]),
    editorMode: z.enum(["read", "edit", "create"]),
    canonicalRevision: z.number().int().min(0).max(10_000_000),
    generation: z.number().int().min(0).max(10_000_000),
    draftVersion: z.number().int().min(0).max(10_000_000),
    committedDraftVersion: z.number().int().min(0).max(10_000_000),
    dirty: z.boolean(),
    syncState: z.enum(["connecting", "saving", "synced", "offline", "error"]),
    validationState: z.enum(["valid", "invalid"]),
    visibility: z.enum(["visible", "hidden"]),
    accessKind: z.enum(["membership", "team", "document_grant"]),
    workspaceRole: z.enum(["owner", "admin", "editor", "viewer"]),
    canRead: z.boolean(),
    canEdit: z.boolean(),
    canCommit: z.boolean(),
    canShare: z.boolean(),
    blockCount: diagnosticCountBucketSchema,
    textLength: diagnosticCountBucketSchema,
    nodeTypeCount: diagnosticCountBucketSchema,
    documentCount: diagnosticCountBucketSchema,
    sidebarWidth: z.enum(["compact", "standard", "wide"]),
  })
  .strict();

const traceBase = {
  sequence: z.number().int().min(0).max(10_000_000),
  offsetMs: z.number().int().min(-120_000).max(0),
};

export const appBugTraceEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...traceBase,
    kind: z.literal("request"),
    operation: z.enum([
      "documents",
      "collaboration_commit",
      "collaboration_discard",
      "revisions",
      "sharing",
      "assignments",
      "tasks",
      "saved_views",
      "diagnostics",
      "other",
    ]),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OTHER"]),
    outcome: z.enum(["success", "client_error", "server_error", "network_error", "aborted"]),
    status: z.number().int().min(0).max(599).nullable(),
    duration: diagnosticDurationBucketSchema,
    operationId: z.string().uuid(),
  }).strict(),
  z.object({
    ...traceBase,
    kind: z.literal("lifecycle"),
    action: z.enum([
      "workspace_opened",
      "document_opened",
      "document_list_refreshed",
      "history_opened",
      "share_opened",
      "commit_started",
      "commit_succeeded",
      "commit_failed",
      "discard_started",
      "discard_succeeded",
      "discard_failed",
    ]),
  }).strict(),
  z.object({
    ...traceBase,
    kind: z.literal("sync"),
    state: z.enum(["connecting", "saving", "synced", "offline", "error"]),
  }).strict(),
  z.object({
    ...traceBase,
    kind: z.literal("tree"),
    action: z.enum([
      "expand",
      "collapse",
      "navigate",
      "active_revealed",
      "storage_fallback",
    ]),
  }).strict(),
  z.object({
    ...traceBase,
    kind: z.literal("editor_diagnostic"),
    event: z.enum([
      "validation_failed",
      "validation_recovered",
      "node_ids_repaired",
      "link_applied",
      "link_auto_titled",
      "link_unwrapped",
      "link_failed",
      "collaboration_error",
      "commit_failed",
    ]),
  }).strict(),
]);

const editorSelectionShapeSchema = z
  .object({
    kind: z.enum(["none", "text", "cells"]),
    collapsed: z.boolean().optional(),
    topLevelBlock: diagnosticCountBucketSchema.optional(),
    pathDepth: z.number().int().min(0).max(12).optional(),
    tableRow: diagnosticCountBucketSchema.optional(),
    tableColumn: diagnosticCountBucketSchema.optional(),
    selectedCells: diagnosticCountBucketSchema,
  })
  .strict();

export const editorBugTraceEventSchema = z
  .object({
    sequence: z.number().int().min(0).max(10_000_000),
    offsetMs: z.number().int().min(-120_000).max(0),
    kind: z.enum([
      "editor_mount",
      "editor_unmount",
      "focus",
      "blur",
      "pointer",
      "text_edit",
      "selection_navigation",
      "command",
      "composition",
      "selection_change",
      "value_change",
      "collaboration_status",
      "report",
    ]),
    selection: editorSelectionShapeSchema.optional(),
    operationClass: z.enum([
      "text",
      "selection",
      "structure",
      "history",
      "other",
    ]).optional(),
    blockCount: diagnosticCountBucketSchema.optional(),
    composing: z.boolean(),
    focused: z.boolean(),
  })
  .strict();

const reportDescriptionSchema = z
  .string()
  .trim()
  .max(1_000)
  .regex(
    /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u,
    "Description contains unsupported control characters.",
  );

export const appBugReportRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    clientReportId: z.string().uuid(),
    sessionId: z.string().uuid(),
    trigger: z.enum(["manual", "automatic"]),
    category: bugReportCategorySchema,
    categorySource: bugReportCategorySourceSchema,
    suggestedCategory: bugReportCategorySchema.optional(),
    detector: bugReportDetectorSchema.optional(),
    reasonCode: z.enum([
      "manual_report",
      "editor_remounted",
      "jumped_to_document_start",
      "table_cell_changed",
      "table_selection_escaped",
      "unexpected_block_jump",
    ]),
    capturedAt: z.string().datetime(),
    clientBuildSha: z
      .string()
      .max(64)
      .regex(/^(?:[0-9a-f]{7,64}|unknown|development)$/),
    documentId: z.string().uuid().optional(),
    description: reportDescriptionSchema.optional(),
    environment: bugEnvironmentSchema,
    snapshot: bugSnapshotSchema,
    events: z.array(appBugTraceEventSchema).max(120),
    editorTrace: z.array(editorBugTraceEventSchema).max(180).optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.trigger === "automatic") {
      if (report.category !== "editor_caret" || report.categorySource !== "detector") {
        context.addIssue({
          code: "custom",
          message: "Automatic reports must be detector-classified editor reports.",
          path: ["category"],
        });
      }
      if (!report.detector || report.reasonCode === "manual_report") {
        context.addIssue({
          code: "custom",
          message: "Automatic reports require a supported detector.",
          path: ["detector"],
        });
      }
    } else if (report.reasonCode !== "manual_report" || report.detector) {
      context.addIssue({
        code: "custom",
        message: "Manual reports cannot claim an automatic detector.",
        path: ["reasonCode"],
      });
    }
    for (let index = 1; index < report.events.length; index += 1) {
      if (report.events[index].sequence <= report.events[index - 1].sequence) {
        context.addIssue({
          code: "custom",
          message: "Trace sequence must be strictly increasing.",
          path: ["events", index, "sequence"],
        });
        break;
      }
    }
  });

export type BugReportCategory = z.infer<typeof bugReportCategorySchema>;
export type BugReportCategorySource = z.infer<typeof bugReportCategorySourceSchema>;
export type AppBugTraceEvent = z.infer<typeof appBugTraceEventSchema>;
export type EditorBugTraceEvent = z.infer<typeof editorBugTraceEventSchema>;
export type AppBugReportRequest = z.infer<typeof appBugReportRequestSchema>;

export function parseAppBugReportRequest(value: unknown) {
  return appBugReportRequestSchema.parse(value);
}

export function diagnosticCountBucket(value: number) {
  if (value <= 0) return "zero" as const;
  if (value <= 10) return "one_to_ten" as const;
  if (value <= 100) return "eleven_to_hundred" as const;
  if (value <= 1_000) return "hundred_one_to_thousand" as const;
  if (value <= 10_000) return "thousand_one_to_ten_thousand" as const;
  return "over_ten_thousand" as const;
}

export function diagnosticDurationBucket(value: number) {
  if (value < 100) return "under_100ms" as const;
  if (value < 500) return "100_to_499ms" as const;
  if (value < 2_000) return "500_to_1999ms" as const;
  if (value < 10_000) return "2_to_9s" as const;
  return "10s_or_more" as const;
}

function operationClass(event: CaretTraceEvent) {
  const operations = event.operationTypes ?? [];
  if (operations.some((operation) => operation.includes("text"))) return "text" as const;
  if (operations.some((operation) => operation.includes("selection"))) return "selection" as const;
  if (operations.some((operation) => operation.includes("history"))) return "history" as const;
  if (operations.some((operation) => (
    operation.includes("node")
    || operation.includes("split")
    || operation.includes("merge")
  ))) return "structure" as const;
  return operations.length > 0 ? "other" as const : undefined;
}

function editorEventKind(event: CaretTraceEvent): EditorBugTraceEvent["kind"] {
  if (event.kind === "pointer_down" || event.kind === "pointer_up") return "pointer";
  if (event.kind === "beforeinput") return "text_edit";
  if (event.kind === "composition_start" || event.kind === "composition_end") {
    return "composition";
  }
  if (event.kind === "manual_report" || event.kind === "automatic_report") return "report";
  if (event.kind === "keydown") {
    if (event.key === "shortcut") return "command";
    if (event.key === "text" || event.key === "backspace" || event.key === "delete") {
      return "text_edit";
    }
    return "selection_navigation";
  }
  return event.kind;
}

export function sanitizeEditorTrace(
  trace: CaretTraceEvent[],
  capturedElapsedMs = trace.at(-1)?.elapsedMs ?? 0,
): EditorBugTraceEvent[] {
  return trace
    .filter((event) => capturedElapsedMs - event.elapsedMs <= 120_000)
    .slice(-180)
    .map((event) => ({
      sequence: event.sequence,
      offsetMs: Math.min(0, Math.max(-120_000, event.elapsedMs - capturedElapsedMs)),
      kind: editorEventKind(event),
      ...(event.selection
        ? {
            selection: {
              kind: event.selection.kind,
              ...(typeof event.selection.collapsed === "boolean"
                ? { collapsed: event.selection.collapsed }
                : {}),
              ...(event.selection.anchor
                ? {
                    topLevelBlock: diagnosticCountBucket(event.selection.anchor.path[0] ?? 0),
                    pathDepth: event.selection.anchor.path.length,
                  }
                : {}),
              ...(event.selection.table
                ? {
                    tableRow: diagnosticCountBucket(event.selection.table.rowIndex),
                    tableColumn: diagnosticCountBucket(event.selection.table.columnIndex),
                  }
                : {}),
              selectedCells: diagnosticCountBucket(event.selection.selectedCellCount),
            },
          }
        : {}),
      ...(operationClass(event) ? { operationClass: operationClass(event) } : {}),
      ...(typeof event.blockCount === "number"
        ? { blockCount: diagnosticCountBucket(event.blockCount) }
        : {}),
      composing: event.composing,
      focused: event.focused,
    }));
}
