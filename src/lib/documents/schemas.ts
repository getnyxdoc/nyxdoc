import { z } from "zod";
import {
  nyxdocCodeBlockSchema,
  nyxdocCodeLineSchema,
  nyxdocDividerSchema,
  nyxdocDocumentV2Schema,
  nyxdocImageSchema,
  nyxdocTableCellSchema,
  nyxdocTableRowSchema,
  nyxdocTableSchema,
  nyxdocTextBlockSchema,
} from "@/lib/editor/schema";
import { DOCUMENT_WORKFLOW_STATUSES } from "@/lib/documents/types";

export const requestIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const documentTypeSchema = z.string().trim().min(1).max(80).nullable();
const documentTagsSchema = z.array(z.string().trim().min(1).max(50)).max(30);

export const createDocumentSchema = z.object({
  requestId: requestIdSchema.optional(),
  title: z.string().min(1).max(200),
  parentDocumentId: z.string().uuid().nullable().optional(),
  documentType: documentTypeSchema.optional(),
  workflowStatus: z.enum(DOCUMENT_WORKFLOW_STATUSES).optional(),
  tags: documentTagsSchema.optional(),
  content: nyxdocDocumentV2Schema,
  summary: z.string().min(1).max(300).optional(),
}).strict();

export const agentCreateDocumentSchema = createDocumentSchema.extend({
  requestId: requestIdSchema,
});

export const updateDocumentSchema = z
  .object({
    requestId: requestIdSchema.optional(),
    baseRevision: z.number().int().positive(),
    title: z.string().min(1).max(200).optional(),
    parentDocumentId: z.string().uuid().nullable().optional(),
    documentType: documentTypeSchema.optional(),
    workflowStatus: z.enum(DOCUMENT_WORKFLOW_STATUSES).optional(),
    tags: documentTagsSchema.optional(),
    content: nyxdocDocumentV2Schema.optional(),
    summary: z.string().min(1).max(300).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.title === undefined
      && value.parentDocumentId === undefined
      && value.documentType === undefined
      && value.workflowStatus === undefined
      && value.tags === undefined
      && value.content === undefined
    ) {
      context.addIssue({ code: "custom", message: "바꿀 제목, 위치, 메타데이터 또는 본문이 필요합니다." });
    }
  });

export const agentUpdateDocumentSchema = updateDocumentSchema.and(z.object({
  requestId: requestIdSchema,
}));

export const reorderDocumentSchema = z.object({
  targetDocumentId: z.string().uuid(),
  position: z.enum(["before", "after"]),
}).strict();

const workingDocumentReplacementFields = {
  title: z.string().min(1).max(200).optional(),
  parentDocumentId: z.string().uuid().nullable().optional(),
  documentType: documentTypeSchema.optional(),
  workflowStatus: z.enum(DOCUMENT_WORKFLOW_STATUSES).optional(),
  tags: documentTagsSchema.optional(),
  content: nyxdocDocumentV2Schema.optional(),
};

const documentDraftVersionCasFields = {
  expectedGeneration: z.number().int().positive(),
  expectedDraftVersion: z.number().int().nonnegative(),
};

const documentDraftCasFields = {
  ...documentDraftVersionCasFields,
  expectedBaseRevision: z.number().int().positive(),
};

export const updateWorkingDocumentSchema = z.object({
  requestId: requestIdSchema,
  expectedDraftVersion: z.number().int().nonnegative(),
  ...workingDocumentReplacementFields,
}).strict().superRefine((value, context) => {
  if (
    value.title === undefined
    && value.parentDocumentId === undefined
    && value.documentType === undefined
    && value.workflowStatus === undefined
    && value.tags === undefined
    && value.content === undefined
  ) {
    context.addIssue({ code: "custom", message: "공유 초안에서 바꿀 필드가 필요합니다." });
  }
});

export const commitWorkingDocumentSchema = z.object({
  requestId: requestIdSchema,
  expectedDraftVersion: z.number().int().nonnegative(),
  summary: z.string().min(1).max(300).optional(),
}).strict();

export const restoreWorkingRevisionSchema = z.object({
  requestId: requestIdSchema,
  ...documentDraftCasFields,
}).strict();

export const discardWorkingDocumentSchema = z.object({
  documentId: z.string().uuid(),
  ...documentDraftCasFields,
}).strict();

export const archiveDocumentSchema = z.object({
  baseRevision: z.number().int().positive(),
});

export const restoreDocumentRevisionSchema = z.object({
  baseRevision: z.number().int().positive(),
  ...documentDraftVersionCasFields,
}).strict();

const patchNodeIdSchema = z.string().min(1).max(160).optional();
const patchTextBlockSchema = z.object({
  ...nyxdocTextBlockSchema.shape,
  id: patchNodeIdSchema,
}).strict().superRefine((block, context) => {
  if (block.listStyleType && block.indent === undefined) {
    context.addIssue({ code: "custom", path: ["indent"], message: "목록 블록에는 들여쓰기 단계가 필요합니다." });
  }
  if (block.checked !== undefined && block.listStyleType !== "todo") {
    context.addIssue({ code: "custom", path: ["checked"], message: "완료 상태는 할 일 목록에서만 사용할 수 있습니다." });
  }
  if (
    !block.listStyleType
    && (block.listStart !== undefined || block.listRestart !== undefined || block.listRestartPolite !== undefined)
  ) {
    context.addIssue({ code: "custom", path: ["listStyleType"], message: "목록 번호 속성은 목록 블록에서만 사용할 수 있습니다." });
  }
});
const patchCodeLineSchema = z.object({
  ...nyxdocCodeLineSchema.shape,
  id: patchNodeIdSchema,
}).strict();
const patchCodeBlockSchema = z.object({
  ...nyxdocCodeBlockSchema.shape,
  id: patchNodeIdSchema,
  children: z.array(patchCodeLineSchema).min(1).max(10_000),
}).strict();
const patchTableCellSchema = z.object({
  ...nyxdocTableCellSchema.shape,
  id: patchNodeIdSchema,
  children: z.array(patchTextBlockSchema).min(1).max(100),
}).strict();
const patchTableRowSchema = z.object({
  ...nyxdocTableRowSchema.shape,
  id: patchNodeIdSchema,
  children: z.array(patchTableCellSchema).min(1).max(20),
}).strict();
const patchTableSchema = z.object({
  ...nyxdocTableSchema.shape,
  id: patchNodeIdSchema,
  children: z.array(patchTableRowSchema).min(1).max(50),
}).strict();
const patchDividerSchema = z.object({
  ...nyxdocDividerSchema.shape,
  id: patchNodeIdSchema,
}).strict().superRefine((divider, context) => {
  if (divider.children[0].text !== "") {
    context.addIssue({ code: "custom", path: ["children", 0, "text"], message: "구분선에는 내용이 없어야 합니다." });
  }
});
const patchImageSchema = z.object({
  ...nyxdocImageSchema.shape,
  id: patchNodeIdSchema,
}).strict().superRefine((image, context) => {
  if (image.url !== `/api/media/${image.mediaId}`) {
    context.addIssue({ code: "custom", path: ["url"], message: "이미지는 Nyxdoc 내부 미디어 링크를 사용해야 합니다." });
  }
  if (image.children[0].text !== "") {
    context.addIssue({ code: "custom", path: ["children", 0, "text"], message: "이미지의 void 텍스트는 비어 있어야 합니다." });
  }
});

export const documentAstBlockInputSchema = z.union([
  patchTextBlockSchema,
  patchDividerSchema,
  patchImageSchema,
  patchCodeBlockSchema,
  patchTableSchema,
]);

export const documentPatchOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace_block"),
    blockId: z.string().min(1).max(160),
    block: documentAstBlockInputSchema,
  }),
  z.object({
    op: z.enum(["insert_before", "insert_after"]),
    anchorBlockId: z.string().min(1).max(160),
    blocks: z.array(documentAstBlockInputSchema).min(1).max(50),
  }),
  z.object({
    op: z.literal("delete_block"),
    blockId: z.string().min(1).max(160),
  }),
  z.object({
    op: z.enum(["move_before", "move_after"]),
    blockId: z.string().min(1).max(160),
    anchorBlockId: z.string().min(1).max(160),
  }),
]);

export const patchDocumentSchema = z.object({
  baseRevision: z.number().int().positive(),
  requestId: requestIdSchema,
  operations: z.array(documentPatchOperationSchema).min(1).max(100),
  summary: z.string().min(1).max(300).optional(),
});

export const patchWorkingDocumentSchema = z.object({
  requestId: requestIdSchema,
  expectedDraftVersion: z.number().int().nonnegative(),
  operations: z.array(documentPatchOperationSchema).min(1).max(100),
}).strict();
