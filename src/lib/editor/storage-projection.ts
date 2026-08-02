import type { BlockType, TableBlockData } from "@/lib/db/types";
import {
  nyxdocBlockText,
  parseNyxdocDocumentV2,
  type NyxdocInline,
  type NyxdocTextBlock,
} from "@/lib/editor/schema";

export type StoredDocumentBlockInput = {
  id: string;
  type: BlockType;
  content: string;
  indent: number;
  checked?: boolean;
  table?: TableBlockData;
  contentJson: string;
};

function inlinePlainText(children: NyxdocInline[]) {
  return children
    .map((child) => ("text" in child ? child.text : child.children.map((leaf) => leaf.text).join("")))
    .join("");
}

function textStorageType(block: NyxdocTextBlock): BlockType {
  if (block.listStyleType === "disc") return "list_item";
  if (block.listStyleType === "decimal") return "numbered_list_item";
  if (block.listStyleType === "todo") return "todo";
  if (block.type === "h1") return "heading";
  if (block.type === "h2") return "heading_2";
  if (["h3", "h4", "h5", "h6"].includes(block.type)) return "heading_3";
  if (block.type === "blockquote") return "quote";
  if (block.type === "callout") return "callout";
  return "paragraph";
}

export function v2ToStorageBlockInputs(value: unknown): StoredDocumentBlockInput[] {
  const document = parseNyxdocDocumentV2(value);
  return document.blocks.map((block) => {
    const base = {
      id: block.id,
      contentJson: JSON.stringify(block),
    };
    if (block.type === "hr") {
      return { ...base, type: "divider", content: "---", indent: 0 };
    }
    if (block.type === "img") {
      return { ...base, type: "paragraph", content: nyxdocBlockText(block) || "이미지", indent: 0 };
    }
    if (block.type === "code_block") {
      return { ...base, type: "paragraph", content: nyxdocBlockText(block), indent: 0 };
    }
    if (block.type === "table") {
      const firstRow = block.children[0];
      const table = {
        rows: block.children.map((row) =>
          row.children.map((cell) => cell.children.map((child) => inlinePlainText(child.children)).join("\n")),
        ),
        headerRow: firstRow.children.every((cell) => cell.type === "th"),
        headerColumn: block.children.every((row) => row.children[0]?.type === "th"),
      };
      return {
        ...base,
        type: "table",
        content: table.rows.map((row) => row.join("\t")).join("\n"),
        indent: 0,
        table,
      };
    }

    const list = block.listStyleType !== undefined;
    return {
      ...base,
      type: textStorageType(block),
      content: nyxdocBlockText(block),
      indent: list ? Math.max(0, (block.indent ?? 1) - 1) : (block.indent ?? 0),
      ...(block.listStyleType === "todo" ? { checked: block.checked === true } : {}),
    };
  });
}
