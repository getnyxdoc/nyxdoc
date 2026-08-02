import { createHash, randomUUID } from "node:crypto";
import {
  BaseBlockquotePlugin,
  BaseBoldPlugin,
  BaseCodePlugin,
  BaseH1Plugin,
  BaseH2Plugin,
  BaseH3Plugin,
  BaseH4Plugin,
  BaseH5Plugin,
  BaseH6Plugin,
  BaseHorizontalRulePlugin,
  BaseItalicPlugin,
  BaseStrikethroughPlugin,
} from "@platejs/basic-nodes";
import { BaseCodeBlockPlugin, BaseCodeLinePlugin } from "@platejs/code-block";
import { BaseLinkPlugin } from "@platejs/link";
import { BaseListPlugin } from "@platejs/list";
import { MarkdownPlugin, remarkMdx } from "@platejs/markdown";
import { BaseImagePlugin } from "@platejs/media";
import {
  BaseTableCellHeaderPlugin,
  BaseTableCellPlugin,
  BaseTablePlugin,
  BaseTableRowPlugin,
} from "@platejs/table";
import remarkGfm from "remark-gfm";
import { BaseParagraphPlugin, createSlateEditor, type Value } from "platejs";
import { DocumentServiceError } from "@/lib/documents/types";
import {
  parseNyxdocDocumentV2,
  type NyxdocDocumentV2,
} from "@/lib/editor/schema";

const markdownPlugins = [
  BaseParagraphPlugin,
  BaseH1Plugin,
  BaseH2Plugin,
  BaseH3Plugin,
  BaseH4Plugin,
  BaseH5Plugin,
  BaseH6Plugin,
  BaseBlockquotePlugin,
  BaseHorizontalRulePlugin,
  BaseBoldPlugin,
  BaseItalicPlugin,
  BaseStrikethroughPlugin,
  BaseCodePlugin,
  BaseCodeBlockPlugin,
  BaseCodeLinePlugin,
  BaseLinkPlugin,
  BaseListPlugin,
  BaseImagePlugin,
  BaseTablePlugin,
  BaseTableRowPlugin,
  BaseTableCellPlugin,
  BaseTableCellHeaderPlugin,
  MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm, remarkMdx] } }),
];

const mediaPathPattern = /^\/api\/media\/([0-9a-f-]{36})$/i;
const documentReferencePattern = /^nyxdoc:\/\/document\/([0-9a-f-]{36})$/i;
const supportedElementTypes = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "hr",
  "img",
  "code_block",
  "code_line",
  "table",
  "tr",
  "td",
  "th",
  "a",
]);

function internalMediaPath(value: unknown) {
  if (typeof value !== "string") return null;
  const direct = value.match(mediaPathPattern);
  if (direct) return { mediaId: direct[1], url: value };
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(mediaPathPattern);
    return match ? { mediaId: match[1], url: parsed.pathname } : null;
  } catch {
    return null;
  }
}

function deterministicNodeId(seed: string, path: number[], type: string) {
  const digest = createHash("sha256").update(`${seed}:${path.join(".")}:${type}`).digest("hex");
  return `md_${digest.slice(0, 40)}`;
}

function nodeText(value: unknown): string {
  if (Array.isArray(value)) return value.map(nodeText).join("");
  if (!value || typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  if (typeof node.text === "string") return node.text;
  return nodeText(node.children);
}

function blockquoteInlineChildren(value: unknown) {
  if (!Array.isArray(value)) return [{ text: "" }];
  const flattened: unknown[] = [];
  for (const child of value) {
    if (
      child
      && typeof child === "object"
      && (child as Record<string, unknown>).type === "p"
      && Array.isArray((child as Record<string, unknown>).children)
    ) {
      if (flattened.length > 0) flattened.push({ text: "\n" });
      flattened.push(...((child as Record<string, unknown>).children as unknown[]));
    } else {
      flattened.push(child);
    }
  }
  return flattened.length > 0 ? flattened : [{ text: "" }];
}

export type MarkdownConversionWarning = {
  code: string;
  message: string;
  path: number[];
};

function normalizeMarkdownNode(
  value: unknown,
  path: number[],
  idSeed: string | undefined,
  warnings: MarkdownConversionWarning[],
): unknown {
  if (!value || typeof value !== "object") return value;
  const node = structuredClone(value) as Record<string, unknown>;
  if (typeof node.text === "string") return node;
  if (typeof node.type !== "string") {
    throw new DocumentServiceError("INVALID_INPUT", "Markdown 변환 결과에 알 수 없는 노드가 있습니다.");
  }
  const nodeType = node.type;
  if (!supportedElementTypes.has(nodeType)) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      `아직 가져올 수 없는 Markdown 요소입니다: ${node.type}`,
    );
  }

  if (node.type === "a") {
    const reference = typeof node.url === "string" ? node.url.match(documentReferencePattern) : null;
    if (reference) {
      node.type = "doc_ref";
      node.documentId = reference[1];
      delete node.url;
    }
  }
  if (node.type === "img") {
    const media = internalMediaPath(node.url);
    if (!media) {
      throw new DocumentServiceError(
        "INVALID_INPUT",
        "Markdown 이미지는 먼저 Nyxdoc에 업로드한 뒤 /api/media/{id} 링크를 사용해야 합니다.",
      );
    }
    node.mediaId = media.mediaId;
    node.url = media.url;
    const alt = typeof node.alt === "string" ? node.alt : nodeText(node.caption);
    if (alt) node.alt = alt;
    delete node.caption;
  }

  node.id = typeof node.id === "string" && node.id
    ? node.id
    : idSeed
      ? deterministicNodeId(idSeed, path, nodeType)
      : randomUUID();
  const children = node.type === "blockquote"
    ? blockquoteInlineChildren(node.children)
    : node.children;
  node.children = Array.isArray(children)
    ? children.map((child, index) => normalizeMarkdownNode(child, [...path, index], idSeed, warnings))
    : [{ text: "" }];
  return node;
}

function markdownEditor(value?: Value) {
  return createSlateEditor({
    plugins: markdownPlugins,
    ...(value ? { value } : {}),
  });
}

export function markdownToNyxdocWithReport(
  markdown: string,
  options: { idSeed?: string } = {},
): { content: NyxdocDocumentV2; warnings: MarkdownConversionWarning[] } {
  if (!markdown.trim()) {
    throw new DocumentServiceError("INVALID_INPUT", "가져올 Markdown 내용이 필요합니다.");
  }
  try {
    const editor = markdownEditor();
    const value = editor.getApi(MarkdownPlugin).markdown.deserialize(markdown);
    const warnings: MarkdownConversionWarning[] = [];
    const blocks = value.map((block, index) =>
      normalizeMarkdownNode(block, [index], options.idSeed, warnings));
    return { content: parseNyxdocDocumentV2({ schemaVersion: 2, blocks }), warnings };
  } catch (error) {
    if (error instanceof DocumentServiceError) throw error;
    throw new DocumentServiceError("INVALID_INPUT", "Markdown을 Nyxdoc 문서로 변환할 수 없습니다.");
  }
}

export function markdownToNyxdoc(
  markdown: string,
  options: { idSeed?: string } = {},
): NyxdocDocumentV2 {
  return markdownToNyxdocWithReport(markdown, options).content;
}

function markdownSafeNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(markdownSafeNode);
  if (!value || typeof value !== "object") return value;
  const node = structuredClone(value) as Record<string, unknown>;
  if (node.type === "doc_ref" && typeof node.documentId === "string") {
    node.type = "a";
    node.url = `nyxdoc://document/${node.documentId}`;
    delete node.documentId;
  }
  if (node.type === "callout") node.type = "blockquote";
  if (node.type === "img" && typeof node.alt === "string" && node.alt) {
    node.caption = [{ text: node.alt }];
  }
  if (Array.isArray(node.children)) node.children = node.children.map(markdownSafeNode);
  return node;
}

export function nyxdocToMarkdown(content: NyxdocDocumentV2) {
  try {
    const value = content.blocks.map(markdownSafeNode) as Value;
    const editor = markdownEditor(value);
    return editor.getApi(MarkdownPlugin).markdown.serialize();
  } catch {
    throw new DocumentServiceError("INVALID_INPUT", "이 문서를 Markdown으로 내보낼 수 없습니다.");
  }
}
