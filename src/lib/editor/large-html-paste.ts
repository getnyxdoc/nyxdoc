import type { Value } from "platejs";
import { NYXDOC_FONT_SIZES } from "@/lib/editor/schema";

// The generic Plate HTML deserializer becomes prohibitively expensive for
// office-sized clipboard payloads. This bounded, linear parser preserves the
// common document structures and marks used by Nyxdoc's AST v2.
type TextLeaf = {
  text: string;
  backgroundColor?: string;
  bold?: boolean;
  code?: boolean;
  color?: string;
  fontSize?: (typeof NYXDOC_FONT_SIZES)[number];
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
};

type InlineNode = TextLeaf | {
  id: string;
  type: "a";
  url: string;
  children: TextLeaf[];
};

type TextMarks = Omit<TextLeaf, "text">;

const BLOCK_TAGS = new Set([
  "ARTICLE",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "UL",
]);
const MAX_TEXT_LEAF_LENGTH = 20_000;

function id() {
  return globalThis.crypto.randomUUID();
}

function markKey(leaf: TextLeaf) {
  return JSON.stringify({
    backgroundColor: leaf.backgroundColor,
    bold: leaf.bold,
    code: leaf.code,
    color: leaf.color,
    fontSize: leaf.fontSize,
    italic: leaf.italic,
    strikethrough: leaf.strikethrough,
    underline: leaf.underline,
  });
}

function appendText(target: InlineNode[], text: string, marks: TextMarks) {
  if (!text) return;
  for (let offset = 0; offset < text.length; offset += MAX_TEXT_LEAF_LENGTH) {
    const leaf: TextLeaf = {
      ...marks,
      text: text.slice(offset, offset + MAX_TEXT_LEAF_LENGTH),
    };
    const previous = target.at(-1);
    if (
      previous
      && "text" in previous
      && previous.text.length + leaf.text.length <= MAX_TEXT_LEAF_LENGTH
      && markKey(previous) === markKey(leaf)
    ) {
      previous.text += leaf.text;
    } else {
      target.push(leaf);
    }
  }
}

function textLeaves(text: string, marks: TextMarks = {}) {
  const leaves: InlineNode[] = [];
  appendText(leaves, text, marks);
  return leaves.length > 0 ? leaves as TextLeaf[] : [{ text: "" }];
}

function supportedColor(value: string) {
  const color = value.trim();
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(color)
    ? color
    : undefined;
}

function nearestFontSize(value: string) {
  const size = Number.parseFloat(value);
  if (!Number.isFinite(size)) return undefined;
  return [...NYXDOC_FONT_SIZES].sort(
    (left, right) => Math.abs(Number.parseFloat(left) - size)
      - Math.abs(Number.parseFloat(right) - size),
  )[0];
}

function elementMarks(element: HTMLElement, inherited: TextMarks): TextMarks {
  const marks = { ...inherited };
  const tag = element.tagName;
  const style = element.style;
  const weight = Number.parseInt(style.fontWeight, 10);
  if (tag === "B" || tag === "STRONG" || weight >= 600 || style.fontWeight === "bold") {
    marks.bold = true;
  }
  if (tag === "I" || tag === "EM" || style.fontStyle === "italic") marks.italic = true;
  if (tag === "U" || style.textDecorationLine.includes("underline")) marks.underline = true;
  if (
    tag === "S"
    || tag === "STRIKE"
    || tag === "DEL"
    || style.textDecorationLine.includes("line-through")
  ) {
    marks.strikethrough = true;
  }
  if (tag === "CODE") marks.code = true;
  const color = supportedColor(style.color);
  const backgroundColor = supportedColor(style.backgroundColor);
  const fontSize = nearestFontSize(style.fontSize);
  if (color) marks.color = color;
  if (backgroundColor && backgroundColor !== "transparent") {
    marks.backgroundColor = backgroundColor;
  }
  if (fontSize) marks.fontSize = fontSize;
  return marks;
}

function parseInlineNode(node: Node, marks: TextMarks, target: InlineNode[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    appendText(target, node.textContent ?? "", marks);
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (node.matches("script, style, noscript")) return;
  if (node.tagName === "BR") {
    appendText(target, "\n", marks);
    return;
  }
  if (node.tagName === "IMG") {
    appendText(target, node.getAttribute("alt") || node.getAttribute("title") || "", marks);
    return;
  }

  const nextMarks = elementMarks(node, marks);
  if (node.tagName === "A") {
    const href = node.getAttribute("href")?.trim() ?? "";
    const children: InlineNode[] = [];
    node.childNodes.forEach((child) => parseInlineNode(child, nextMarks, children));
    const textChildren = children.flatMap((child) => (
      "text" in child ? [child] : child.children
    ));
    try {
      const url = new URL(href, document.baseURI);
      if (
        (url.protocol === "http:" || url.protocol === "https:")
        && textChildren.length > 0
      ) {
        target.push({
          id: id(),
          type: "a",
          url: url.toString(),
          children: textChildren,
        });
        return;
      }
    } catch {
      // Invalid or unsupported links become ordinary text.
    }
    for (const child of textChildren) appendText(target, child.text, child);
    return;
  }

  node.childNodes.forEach((child) => parseInlineNode(child, nextMarks, target));
}

function inlineChildren(node: Node, excluded?: Set<Node>) {
  const children: InlineNode[] = [];
  node.childNodes.forEach((child) => {
    if (!excluded?.has(child)) parseInlineNode(child, {}, children);
  });
  return children.length > 0 ? children : [{ text: "" }];
}

function textAlignment(element: HTMLElement) {
  const value = (element.style.textAlign || element.getAttribute("align") || "").toLowerCase();
  return ["start", "left", "center", "right", "end", "justify"].includes(value)
    ? value
    : undefined;
}

function textBlock(
  element: HTMLElement,
  type: "blockquote" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p",
  children = inlineChildren(element),
) {
  const align = textAlignment(element);
  return {
    id: id(),
    type,
    ...(align ? { align } : {}),
    children,
  };
}

function parseList(element: HTMLElement, depth: number): Value {
  const blocks: Value = [];
  const ordered = element.tagName === "OL";
  const start = Math.max(1, Number.parseInt(element.getAttribute("start") || "1", 10) || 1);
  const items = Array.from(element.children).filter((child) => child.tagName === "LI");

  items.forEach((item, itemIndex) => {
    const nestedLists = new Set(
      Array.from(item.children).filter((child) => child.matches("ul, ol")),
    );
    const checkbox = item.querySelector(':scope > input[type="checkbox"]') as HTMLInputElement | null;
    const children = inlineChildren(item, nestedLists);
    blocks.push({
      id: id(),
      type: "p",
      indent: Math.min(6, Math.max(1, depth)),
      listStyleType: checkbox ? "todo" : ordered ? "decimal" : "disc",
      ...(checkbox ? { checked: checkbox.checked } : {}),
      ...(ordered && itemIndex === 0 && start !== 1 ? { listStart: start } : {}),
      children,
    } as never);
    for (const nested of nestedLists) {
      blocks.push(...parseList(nested as HTMLElement, depth + 1));
    }
  });
  return blocks;
}

function parseCodeBlock(element: HTMLElement): Value {
  const className = element.querySelector("code")?.className || element.className;
  const language = className.match(/(?:language-|lang-)([\w+-]+)/i)?.[1];
  const lines = (element.textContent ?? "").replace(/\n$/, "").split(/\r\n|\r|\n/);
  const blocks: Value = [];
  for (let offset = 0; offset < lines.length; offset += 10_000) {
    blocks.push({
      id: id(),
      type: "code_block",
      ...(language ? { lang: language.slice(0, 50) } : {}),
      children: lines.slice(offset, offset + 10_000).map((line) => ({
        id: id(),
        type: "code_line",
        children: textLeaves(line),
      })),
    } as never);
  }
  return blocks;
}

function parseTable(element: HTMLElement): Value {
  const sourceRows = Array.from(element.querySelectorAll("tr"));
  const tables: Value = [];
  for (let rowOffset = 0; rowOffset < sourceRows.length; rowOffset += 50) {
    const rows = sourceRows.slice(rowOffset, rowOffset + 50).map((row) => ({
      id: id(),
      type: "tr",
      children: Array.from(row.children)
        .filter((cell) => cell.matches("td, th"))
        .slice(0, 20)
        .map((cell) => {
          const htmlCell = cell as HTMLTableCellElement;
          return {
            id: id(),
            type: cell.tagName === "TH" ? "th" : "td",
            ...(htmlCell.colSpan > 1 ? { colSpan: Math.min(20, htmlCell.colSpan) } : {}),
            ...(htmlCell.rowSpan > 1 ? { rowSpan: Math.min(50, htmlCell.rowSpan) } : {}),
            children: [{
              id: id(),
              type: "p",
              children: inlineChildren(cell),
            }],
          };
        }),
    })).filter((row) => row.children.length > 0);
    if (rows.length > 0) {
      tables.push({
        id: id(),
        type: "table",
        children: rows,
      } as never);
    }
  }
  return tables;
}

function parseContainer(element: HTMLElement): Value {
  const blocks: Value = [];
  const inlineBuffer: Node[] = [];
  const flushInline = () => {
    if (inlineBuffer.length === 0) return;
    const wrapper = document.createElement("p");
    inlineBuffer.forEach((child) => wrapper.appendChild(child.cloneNode(true)));
    if ((wrapper.textContent ?? "").trim() || wrapper.querySelector("br, img")) {
      blocks.push(textBlock(wrapper, "p") as never);
    }
    inlineBuffer.length = 0;
  };

  element.childNodes.forEach((child) => {
    if (child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName)) {
      flushInline();
      blocks.push(...parseBlock(child));
    } else {
      inlineBuffer.push(child);
    }
  });
  flushInline();
  return blocks;
}

function parseBlock(element: HTMLElement): Value {
  const tag = element.tagName;
  if (/^H[1-6]$/.test(tag)) {
    return [textBlock(element, tag.toLowerCase() as "h1") as never];
  }
  if (tag === "P") return [textBlock(element, "p") as never];
  if (tag === "BLOCKQUOTE") return [textBlock(element, "blockquote") as never];
  if (tag === "UL" || tag === "OL") return parseList(element, 1);
  if (tag === "PRE") return parseCodeBlock(element);
  if (tag === "TABLE") return parseTable(element);
  if (tag === "HR") {
    return [{
      id: id(),
      type: "hr",
      children: [{ text: "" }],
    } as never];
  }

  const nestedBlocks = Array.from(element.children).some((child) => BLOCK_TAGS.has(child.tagName));
  return nestedBlocks
    ? parseContainer(element)
    : [textBlock(element, "p") as never];
}

export function deserializeLargeHtmlDocument(html: string): Value {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const blocks = parseContainer(parsed.body);
  return blocks.length > 0
    ? blocks
    : [{
        id: id(),
        type: "p",
        children: textLeaves(parsed.body.textContent ?? ""),
      }] as Value;
}

export function deserializeLargePlainTextDocument(text: string): Value {
  return text.split(/\r\n|\r|\n/).map((line) => ({
    id: id(),
    type: "p",
    children: textLeaves(line),
  })) as Value;
}
