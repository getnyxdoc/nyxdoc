import { z } from "zod";
import {
  DOCUMENT_TASK_ATTACHMENT_FIELDS,
  DOCUMENT_TASK_PRIORITIES,
  DOCUMENT_TASK_STATUSES,
} from "@/lib/tasks/types";

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const taskAttachments = z.array(z.object({
  mediaId: z.string().uuid(),
  field: z.enum(DOCUMENT_TASK_ATTACHMENT_FIELDS),
}).strict()).max(20);

export const documentTaskQuerySchema = z.object({
  status: z.enum(DOCUMENT_TASK_STATUSES).optional(),
  priority: z.enum(DOCUMENT_TASK_PRIORITIES).optional(),
  assignedAgentId: z.string().trim().min(1).max(160).nullable().optional(),
  targetDocumentId: z.string().uuid().nullable().optional(),
  openOnly: z.boolean().optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const createDocumentTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).default(""),
  acceptanceCriteria: z.string().trim().max(5_000).default(""),
  attachments: taskAttachments.default([]),
  priority: z.enum(DOCUMENT_TASK_PRIORITIES).default("normal"),
  targetDocumentId: z.string().uuid().nullable().default(null),
  assignedAgentId: z.string().trim().min(1).max(160).nullable().default(null),
  requiresReview: z.boolean().default(true),
  requestId: z.string().trim().min(8).max(128).optional(),
}).strict();

export const updateDocumentTaskSchema = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(10_000).optional(),
  acceptanceCriteria: z.string().trim().max(5_000).optional(),
  attachments: taskAttachments.optional(),
  priority: z.enum(DOCUMENT_TASK_PRIORITIES).optional(),
  targetDocumentId: z.string().uuid().nullable().optional(),
  assignedAgentId: z.string().trim().min(1).max(160).nullable().optional(),
  requiresReview: z.boolean().optional(),
  status: z.enum(DOCUMENT_TASK_STATUSES).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  blocker: nullableText(2_000),
  resultSummary: nullableText(5_000),
}).strict().refine(
  (value) => Object.entries(value).some(([key, child]) => key !== "expectedVersion" && child !== undefined),
  { message: "변경할 값을 하나 이상 입력해주세요." },
);

export const claimDocumentTaskSchema = z.object({
  expectedVersion: z.number().int().positive(),
  requestId: z.string().trim().min(8).max(128),
  message: z.string().trim().max(500).nullable().optional(),
}).strict();

export const reportDocumentTaskSchema = z.object({
  expectedVersion: z.number().int().positive(),
  requestId: z.string().trim().min(8).max(128),
  status: z.enum(["in_progress", "blocked", "ready"]),
  progress: z.number().int().min(0).max(100).optional(),
  message: z.string().trim().max(2_000).nullable().optional(),
}).strict();

export const completeDocumentTaskSchema = z.object({
  expectedVersion: z.number().int().positive(),
  requestId: z.string().trim().min(8).max(128),
  resultSummary: z.string().trim().min(1).max(5_000),
  resultDocumentId: z.string().uuid().nullable().optional(),
  resultRevisionNumber: z.number().int().positive().nullable().optional(),
}).strict().superRefine((value, context) => {
  const hasDocument = value.resultDocumentId !== undefined && value.resultDocumentId !== null;
  const hasRevision = value.resultRevisionNumber !== undefined && value.resultRevisionNumber !== null;
  if (hasDocument !== hasRevision) {
    context.addIssue({
      code: "custom",
      path: hasDocument ? ["resultRevisionNumber"] : ["resultDocumentId"],
      message: "결과 문서와 결과 리비전 번호는 함께 입력해주세요.",
    });
  }
});
