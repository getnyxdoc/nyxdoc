import { z } from "zod";

export const NYXDOC_CONTENT_SCHEMA_VERSION = 2 as const;

export const NYXDOC_FONT_SIZES = [
  "12px",
  "14px",
  "16px",
  "18px",
  "20px",
  "24px",
  "32px",
  "40px",
] as const;

export const NYXDOC_TEXT_ALIGNMENTS = ["start", "left", "center", "right", "end", "justify"] as const;
export const NYXDOC_LIST_STYLES = ["disc", "decimal", "todo"] as const;

const MAX_NODE_ID_LENGTH = 160;
const MAX_TEXT_LEAF_LENGTH = 20_000;
// Keep the document boundary generous enough for imported office documents.
// The limits remain finite so one document cannot grow without bound, but a
// normal long-form document should not have to be split merely because every
// source paragraph became a top-level editor block.
export const NYXDOC_MAX_TOP_LEVEL_BLOCKS = 5_000;
export const NYXDOC_MAX_DOCUMENT_TEXT_LENGTH = 1_000_000;
const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EDITOR_RUNTIME_FIELDS = new Set(["_id"]);

export function stripNyxdocEditorRuntimeFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNyxdocEditorRuntimeFields);
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !EDITOR_RUNTIME_FIELDS.has(key) && child !== undefined)
      .map(([key, child]) => [key, stripNyxdocEditorRuntimeFields(child)]),
  );
}

export function projectNyxdocEditorContent(blocks: unknown) {
  return {
    schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
    blocks: stripNyxdocEditorRuntimeFields(blocks),
  };
}

const nodeIdSchema = z.string().min(1).max(MAX_NODE_ID_LENGTH);
const webUrlSchema = z
  .string()
  .max(2_048)
  .superRefine((value, context) => {
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      context.addIssue({ code: "custom", message: "링크 주소에 제어 문자를 사용할 수 없습니다." });
      return;
    }
    if (value !== value.trim()) {
      context.addIssue({ code: "custom", message: "링크 주소 앞뒤에 공백을 사용할 수 없습니다." });
      return;
    }

    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "일반 링크는 HTTP 또는 HTTPS 주소만 사용할 수 있습니다.",
        });
      }
    } catch {
      context.addIssue({ code: "custom", message: "올바른 웹 링크 주소가 아닙니다." });
    }
  });
const colorSchema = z
  .string()
  .max(40)
  .regex(/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i, "지원하지 않는 색상 값입니다.");

export const nyxdocTextSchema = z
  .object({
    text: z.string().max(MAX_TEXT_LEAF_LENGTH),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    code: z.boolean().optional(),
    fontSize: z.enum(NYXDOC_FONT_SIZES).optional(),
    color: colorSchema.optional(),
    backgroundColor: colorSchema.optional(),
  })
  .strict();

export type NyxdocText = z.infer<typeof nyxdocTextSchema>;

export const nyxdocLinkSchema = z
  .object({
    id: nodeIdSchema.optional(),
    type: z.literal("a"),
    url: webUrlSchema,
    autoTitle: z.boolean().optional(),
    children: z.array(nyxdocTextSchema).min(1).max(200),
  })
  .strict();

export type NyxdocLink = z.infer<typeof nyxdocLinkSchema>;

export const nyxdocDocumentReferenceSchema = z
  .object({
    id: nodeIdSchema.optional(),
    type: z.literal("doc_ref"),
    documentId: z.string().uuid(),
    autoTitle: z.boolean().optional(),
    sourceUrl: webUrlSchema.optional(),
    children: z.array(nyxdocTextSchema).min(1).max(200),
  })
  .strict();

export type NyxdocDocumentReference = z.infer<typeof nyxdocDocumentReferenceSchema>;
export type NyxdocInline = NyxdocText | NyxdocLink | NyxdocDocumentReference;

const inlineChildrenSchema = z
  .array(z.union([nyxdocTextSchema, nyxdocLinkSchema, nyxdocDocumentReferenceSchema]))
  .min(1)
  .max(1_000);

export const nyxdocTextBlockSchema = z
  .object({
    id: nodeIdSchema,
    type: z.enum(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "callout"]),
    align: z.enum(NYXDOC_TEXT_ALIGNMENTS).optional(),
    indent: z.number().int().min(1).max(6).optional(),
    listStyleType: z.enum(NYXDOC_LIST_STYLES).optional(),
    listStart: z.number().int().min(1).max(100_000).optional(),
    listRestart: z.number().int().min(1).max(100_000).optional(),
    listRestartPolite: z.number().int().min(1).max(100_000).optional(),
    checked: z.boolean().optional(),
    children: inlineChildrenSchema,
  })
  .strict()
  .superRefine((block, context) => {
    if (block.listStyleType && block.indent === undefined) {
      context.addIssue({
        code: "custom",
        path: ["indent"],
        message: "목록 블록에는 1 이상의 들여쓰기 단계가 필요합니다.",
      });
    }
    if (block.checked !== undefined && block.listStyleType !== "todo") {
      context.addIssue({
        code: "custom",
        path: ["checked"],
        message: "완료 상태는 할 일 목록에서만 사용할 수 있습니다.",
      });
    }
    if (
      !block.listStyleType &&
      (block.listStart !== undefined || block.listRestart !== undefined || block.listRestartPolite !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["listStyleType"],
        message: "목록 번호 속성은 목록 블록에서만 사용할 수 있습니다.",
      });
    }
  });

export type NyxdocTextBlock = z.infer<typeof nyxdocTextBlockSchema>;

export const nyxdocDividerSchema = z
  .object({
    id: nodeIdSchema,
    type: z.literal("hr"),
    children: z.tuple([nyxdocTextSchema]),
  })
  .strict()
  .superRefine((divider, context) => {
    if (divider.children[0].text !== "") {
      context.addIssue({ code: "custom", path: ["children", 0, "text"], message: "구분선에는 내용이 없어야 합니다." });
    }
  });

export type NyxdocDivider = z.infer<typeof nyxdocDividerSchema>;

export const nyxdocImageSchema = z
  .object({
    id: nodeIdSchema,
    type: z.literal("img"),
    mediaId: z.string().regex(MEDIA_ID_PATTERN),
    url: z.string().max(240),
    alt: z.string().max(1_000).optional(),
    name: z.string().max(255).optional(),
    width: z.number().int().min(80).max(4_000).optional(),
    height: z.number().int().min(40).max(4_000).optional(),
    children: z.tuple([nyxdocTextSchema]),
  })
  .strict()
  .superRefine((image, context) => {
    if (image.url !== `/api/media/${image.mediaId}`) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "이미지는 Nyxdoc 내부 미디어 링크를 사용해야 합니다.",
      });
    }
    if (image.children[0].text !== "") {
      context.addIssue({
        code: "custom",
        path: ["children", 0, "text"],
        message: "이미지의 void 텍스트는 비어 있어야 합니다.",
      });
    }
  });

export type NyxdocImage = z.infer<typeof nyxdocImageSchema>;

const nyxdocCodeTextSchema = z.object({ text: z.string().max(MAX_TEXT_LEAF_LENGTH) }).strict();

export const nyxdocCodeLineSchema = z
  .object({
    id: nodeIdSchema,
    type: z.literal("code_line"),
    children: z.array(nyxdocCodeTextSchema).min(1).max(200),
  })
  .strict();

export type NyxdocCodeLine = z.infer<typeof nyxdocCodeLineSchema>;

export const nyxdocCodeBlockSchema = z
  .object({
    id: nodeIdSchema,
    type: z.literal("code_block"),
    lang: z.string().max(50).optional(),
    children: z.array(nyxdocCodeLineSchema).min(1).max(10_000),
  })
  .strict();

export type NyxdocCodeBlock = z.infer<typeof nyxdocCodeBlockSchema>;

export const nyxdocTableCellSchema = z
  .object({
    id: nodeIdSchema,
    type: z.enum(["td", "th"]),
    colSpan: z.number().int().min(1).max(20).optional(),
    rowSpan: z.number().int().min(1).max(50).optional(),
    background: colorSchema.optional(),
    children: z.array(nyxdocTextBlockSchema).min(1).max(100),
  })
  .strict();

export type NyxdocTableCell = z.infer<typeof nyxdocTableCellSchema>;

export const nyxdocTableRowSchema = z
  .object({
    id: nodeIdSchema,
    type: z.literal("tr"),
    size: z.number().int().min(20).max(1_000).optional(),
    children: z.array(nyxdocTableCellSchema).min(1).max(20),
  })
  .strict();

export type NyxdocTableRow = z.infer<typeof nyxdocTableRowSchema>;

export const nyxdocTableSchema = z
  .object({
    id: nodeIdSchema,
    type: z.literal("table"),
    colSizes: z.array(z.number().int().min(40).max(2_000)).max(20).optional(),
    marginLeft: z.number().int().min(0).max(2_000).optional(),
    children: z.array(nyxdocTableRowSchema).min(1).max(50),
  })
  .strict();

export type NyxdocTable = z.infer<typeof nyxdocTableSchema>;
export type NyxdocBlock = NyxdocTextBlock | NyxdocDivider | NyxdocImage | NyxdocCodeBlock | NyxdocTable;

export const nyxdocBlockSchema = z.union([
  nyxdocTextBlockSchema,
  nyxdocDividerSchema,
  nyxdocImageSchema,
  nyxdocCodeBlockSchema,
  nyxdocTableSchema,
]);

function inlineText(children: NyxdocInline[]) {
  return children
    .map((child) => ("text" in child ? child.text : child.children.map((leaf) => leaf.text).join("")))
    .join("");
}

export function nyxdocBlockText(block: NyxdocBlock): string {
  if (block.type === "hr") return "";
  if (block.type === "img") return block.alt || block.name || "";
  if (block.type === "code_block") {
    return block.children.map((line) => line.children.map((leaf) => leaf.text).join("")).join("\n");
  }
  if (block.type === "table") {
    return block.children
      .map((row) =>
        row.children
          .map((cell) => cell.children.map((child) => inlineText(child.children)).join("\n"))
          .join("\t"),
      )
      .join("\n");
  }
  return inlineText(block.children);
}

function collectElementIds(block: NyxdocBlock) {
  const ids: string[] = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") ids.push(record.id);
    if (Array.isArray(record.children)) record.children.forEach(visit);
  }
  visit(block);
  return ids;
}

export const nyxdocDocumentV2Schema = z
  .object({
    schemaVersion: z.literal(NYXDOC_CONTENT_SCHEMA_VERSION),
    blocks: z.array(nyxdocBlockSchema).min(1).max(NYXDOC_MAX_TOP_LEVEL_BLOCKS),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    for (const [blockIndex, block] of document.blocks.entries()) {
      for (const id of collectElementIds(block)) {
        if (ids.has(id)) {
          context.addIssue({
            code: "custom",
            path: ["blocks", blockIndex, "id"],
            message: `문서 안에서 노드 ID가 중복되었습니다: ${id}`,
          });
        }
        ids.add(id);
      }
    }

    const textLength = document.blocks.reduce((length, block) => length + nyxdocBlockText(block).length, 0);
    if (textLength > NYXDOC_MAX_DOCUMENT_TEXT_LENGTH) {
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: `문서 전체 텍스트는 ${NYXDOC_MAX_DOCUMENT_TEXT_LENGTH.toLocaleString()}자 이하여야 합니다.`,
      });
    }
  });

export type NyxdocDocumentV2 = z.infer<typeof nyxdocDocumentV2Schema>;

export function nyxdocDocumentText(document: NyxdocDocumentV2) {
  return document.blocks.map(nyxdocBlockText).filter(Boolean).join("\n");
}

export function parseNyxdocDocumentV2(value: unknown) {
  return nyxdocDocumentV2Schema.parse(value);
}
