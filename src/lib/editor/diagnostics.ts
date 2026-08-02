import { z } from "zod";

const diagnosticIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

const diagnosticIssueSchema = z
  .object({
    code: diagnosticIdentifierSchema,
    path: z.string().max(240).regex(/^[A-Za-z0-9._:-]*$/),
  })
  .strict();

const editorDiagnosticDetailsSchema = z
  .object({
    // Diagnostics must still be accepted when the event being diagnosed is an
    // oversized paste. This bound is intentionally wider than the save limit.
    blockCount: z.number().int().min(0).max(100_000).optional(),
    category: diagnosticIdentifierSchema.optional(),
    code: diagnosticIdentifierSchema.optional(),
    duplicateIdCount: z.number().int().min(0).max(1_000).optional(),
    editingExistingLink: z.boolean().optional(),
    fetchedTitle: z.boolean().optional(),
    issueCount: z.number().int().min(0).max(1_000).optional(),
    issues: z.array(diagnosticIssueSchema).max(20).optional(),
    kind: z.enum(["external", "internal"]).optional(),
    missingIdCount: z.number().int().min(0).max(1_000).optional(),
    nodeTypes: z.array(diagnosticIdentifierSchema).max(40).optional(),
    paths: z.array(z.string().max(240).regex(/^[0-9.]*$/)).max(20).optional(),
    selectionCollapsed: z.boolean().nullable().optional(),
    status: diagnosticIdentifierSchema.optional(),
    textLength: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();

export const editorDiagnosticEventSchema = z
  .object({
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
    workspaceId: z.string().uuid(),
    documentId: z.string().uuid(),
    details: editorDiagnosticDetailsSchema,
  })
  .strict();

export type EditorDiagnosticEvent = z.infer<typeof editorDiagnosticEventSchema>;

export function parseEditorDiagnosticEvent(value: unknown) {
  return editorDiagnosticEventSchema.parse(value);
}

const caretPointSchema = z
  .object({
    path: z.array(z.number().int().min(0).max(100_000)).min(1).max(12),
    offset: z.number().int().min(0).max(10_000_000),
  })
  .strict();

const caretTableLocationSchema = z
  .object({
    blockIndex: z.number().int().min(0).max(100_000),
    rowIndex: z.number().int().min(0).max(10_000),
    columnIndex: z.number().int().min(0).max(10_000),
  })
  .strict();

export const caretSelectionSnapshotSchema = z
  .object({
    kind: z.enum(["none", "text", "cells"]),
    collapsed: z.boolean().optional(),
    anchor: caretPointSchema.optional(),
    focus: caretPointSchema.optional(),
    table: caretTableLocationSchema.optional(),
    selectedCellCount: z.number().int().min(0).max(10_000),
  })
  .strict();

export const caretTraceEventSchema = z
  .object({
    sequence: z.number().int().min(0).max(100_000),
    elapsedMs: z.number().int().min(0).max(86_400_000),
    kind: z.enum([
      "editor_mount",
      "editor_unmount",
      "focus",
      "blur",
      "pointer_down",
      "pointer_up",
      "keydown",
      "beforeinput",
      "composition_start",
      "composition_end",
      "selection_change",
      "value_change",
      "collaboration_status",
      "manual_report",
      "automatic_report",
    ]),
    action: diagnosticIdentifierSchema.optional(),
    key: z.enum([
      "arrow_down",
      "arrow_left",
      "arrow_right",
      "arrow_up",
      "backspace",
      "delete",
      "end",
      "enter",
      "home",
      "page_down",
      "page_up",
      "shortcut",
      "tab",
      "text",
      "other",
    ]).optional(),
    inputType: diagnosticIdentifierSchema.optional(),
    operationTypes: z.array(diagnosticIdentifierSchema).max(20).optional(),
    selection: caretSelectionSnapshotSchema.optional(),
    blockCount: z.number().int().min(0).max(100_000).optional(),
    composing: z.boolean(),
    focused: z.boolean(),
  })
  .strict();

export const caretIncidentReasonSchema = z.enum([
  "manual",
  "editor_remounted",
  "jumped_to_document_start",
  "table_cell_changed",
  "table_selection_escaped",
  "unexpected_block_jump",
]);

export const editorCaretIncidentRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    documentId: z.string().uuid(),
    clientIncidentId: z.string().uuid(),
    trigger: z.enum(["manual", "automatic"]),
    reason: caretIncidentReasonSchema,
    mountCount: z.number().int().min(1).max(1_000),
    environment: z
      .object({
        browser: z.enum(["chrome", "edge", "firefox", "safari", "other"]),
        browserMajor: z.number().int().min(0).max(10_000).nullable(),
        platform: z.enum(["windows", "macos", "linux", "ios", "android", "other"]),
        viewportWidth: z.number().int().min(1).max(100_000),
        viewportHeight: z.number().int().min(1).max(100_000),
        devicePixelRatio: z.number().min(0.1).max(100),
        locale: z.enum(["en", "ko", "ja"]),
      })
      .strict(),
    trace: z.array(caretTraceEventSchema).min(1).max(180),
  })
  .strict();

export type CaretSelectionSnapshot = z.infer<typeof caretSelectionSnapshotSchema>;
export type CaretTraceEvent = z.infer<typeof caretTraceEventSchema>;
export type CaretIncidentReason = z.infer<typeof caretIncidentReasonSchema>;
export type EditorCaretIncidentRequest = z.infer<typeof editorCaretIncidentRequestSchema>;

export function parseEditorCaretIncidentRequest(value: unknown) {
  return editorCaretIncidentRequestSchema.parse(value);
}
