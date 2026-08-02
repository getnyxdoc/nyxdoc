import { z } from "zod";
import { ASSIGNMENT_STATUSES, ASSIGNMENT_TYPES } from "@/lib/collaboration/types";
import { DOCUMENT_WORKFLOW_STATUSES } from "@/lib/documents/types";

// Migrated credentials intentionally keep a stable `legacy-agent-*` identity.
// Agent IDs are opaque workspace-local identifiers, not necessarily UUIDs.
export const workspaceAgentIdSchema = z.string().trim().min(1).max(160);

export const savedViewQuerySchema = z.object({
  parentDocumentId: z.string().uuid().nullable().optional(),
  withinDocumentId: z.string().uuid().optional(),
  titlePrefix: z.string().trim().min(1).max(200).optional(),
  documentType: z.string().trim().min(1).max(80).optional(),
  workflowStatus: z.enum(DOCUMENT_WORKFLOW_STATUSES).optional(),
  tag: z.string().trim().min(1).max(50).optional(),
  updatedAfter: z.iso.datetime().optional(),
  updatedBefore: z.iso.datetime().optional(),
  updatedWithinDays: z.number().int().min(1).max(3650).optional(),
  assignedAgentId: workspaceAgentIdSchema.optional(),
  assignmentType: z.enum(ASSIGNMENT_TYPES).optional(),
  unassigned: z.boolean().optional(),
  sort: z.enum(["tree", "updated_desc"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict().superRefine((query, context) => {
  if (query.unassigned && query.assignedAgentId) {
    context.addIssue({
      code: "custom",
      path: ["unassigned"],
      message: "미할당 보기와 특정 에이전트 보기는 동시에 사용할 수 없습니다.",
    });
  }
  if (query.updatedAfter && query.updatedWithinDays) {
    context.addIssue({
      code: "custom",
      path: ["updatedWithinDays"],
      message: "고정 시작 시각과 최근 일수는 하나만 선택해주세요.",
    });
  }
});

export const createSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  query: savedViewQuerySchema,
  visibility: z.enum(["private", "workspace"]).default("workspace"),
}).strict();

export const updateSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  query: savedViewQuerySchema.optional(),
  visibility: z.enum(["private", "workspace"]).optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "변경할 값을 하나 이상 입력해주세요.",
});

export const assignmentQuerySchema = z.object({
  documentId: z.string().uuid().optional(),
  agentId: workspaceAgentIdSchema.optional(),
  status: z.enum(ASSIGNMENT_STATUSES).optional(),
}).strict();

export const createAssignmentSchema = z.object({
  documentId: z.string().uuid(),
  agentId: workspaceAgentIdSchema,
  assignmentType: z.enum(ASSIGNMENT_TYPES),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();

export const updateAssignmentSchema = z.object({
  status: z.enum(ASSIGNMENT_STATUSES).optional(),
  note: z.string().trim().max(500).nullable().optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "변경할 값을 하나 이상 입력해주세요.",
});

export const agentPresenceSchema = z.object({
  sessionId: z.string().uuid().optional(),
  documentId: z.string().uuid(),
  blockId: z.string().trim().min(1).max(160).nullable().optional(),
  state: z.enum(["reading", "editing", "drafting", "reviewing"]),
  progress: z.number().min(0).max(100).nullable().optional(),
  message: z.string().trim().max(200).nullable().optional(),
}).strict();
