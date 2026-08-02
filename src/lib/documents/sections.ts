import { createHash } from "node:crypto";
import { DocumentServiceError } from "@/lib/documents/types";
import { nyxdocToMarkdown } from "@/lib/documents/markdown";
import {
  parseNyxdocDocumentV2,
  type NyxdocBlock,
  type NyxdocDocumentV2,
} from "@/lib/editor/schema";

const HEADING_LEVELS = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
} as const;

export type DocumentSection = {
  sectionId: string;
  headingBlockId: string;
  level: number;
  title: string;
  headingPath: string[];
  parentSectionId: string | null;
  startBlockIndex: number;
  endBlockIndex: number;
  blockCount: number;
  sectionHash: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nodeText(value: unknown): string {
  if (Array.isArray(value)) return value.map(nodeText).join("");
  const node = record(value);
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return nodeText(node.children);
}

function headingLevel(block: NyxdocBlock) {
  return HEADING_LEVELS[block.type as keyof typeof HEADING_LEVELS] ?? null;
}

function withoutNodeIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNodeIds);
  const node = record(value);
  if (!node) return value;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== "id")
      .map(([key, child]) => [key, withoutNodeIds(child)]),
  );
}

function semanticFingerprint(value: unknown) {
  return JSON.stringify(withoutNodeIds(value));
}

function nodeType(value: unknown) {
  const node = record(value);
  return typeof node?.type === "string" ? node.type : null;
}

function reconcileNodeIds(previous: unknown, next: unknown): unknown {
  if (Array.isArray(next)) {
    const previousItems = Array.isArray(previous) ? previous : [];
    const used = new Set<number>();
    const matches = new Map<number, number>();

    for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
      const fingerprint = semanticFingerprint(next[nextIndex]);
      const previousIndex = previousItems.findIndex((item, index) => (
        !used.has(index) && semanticFingerprint(item) === fingerprint
      ));
      if (previousIndex >= 0) {
        used.add(previousIndex);
        matches.set(nextIndex, previousIndex);
      }
    }

    for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
      if (matches.has(nextIndex)) continue;
      const previousAtIndex = previousItems[nextIndex];
      if (
        previousAtIndex !== undefined
        && !used.has(nextIndex)
        && nodeType(previousAtIndex) === nodeType(next[nextIndex])
      ) {
        used.add(nextIndex);
        matches.set(nextIndex, nextIndex);
      }
    }

    return next.map((item, nextIndex) => {
      const previousIndex = matches.get(nextIndex);
      return reconcileNodeIds(previousIndex === undefined ? undefined : previousItems[previousIndex], item);
    });
  }

  const nextNode = record(next);
  if (!nextNode) return next;
  const previousNode = record(previous);
  const reconciled = structuredClone(nextNode);
  if (
    previousNode
    && typeof previousNode.id === "string"
    && previousNode.id
    && nodeType(previousNode) === nodeType(nextNode)
  ) {
    reconciled.id = previousNode.id;
  }
  if (Array.isArray(nextNode.children)) {
    reconciled.children = reconcileNodeIds(previousNode?.children, nextNode.children);
  }
  return reconciled;
}

export function documentSectionHash(blocks: readonly NyxdocBlock[]) {
  return createHash("sha256")
    .update(JSON.stringify(blocks.map(withoutNodeIds)))
    .digest("hex");
}

export function getDocumentOutline(content: NyxdocDocumentV2): DocumentSection[] {
  const headings = content.blocks.flatMap((block, startBlockIndex) => {
    const level = headingLevel(block);
    return level === null ? [] : [{ block, level, startBlockIndex }];
  });
  const stack: Array<{ level: number; sectionId: string; title: string }> = [];

  return headings.map((heading) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
    const title = nodeText(heading.block.children).trim();
    const parentSectionId = stack.at(-1)?.sectionId ?? null;
    const headingPath = [...stack.map((item) => item.title), title];
    let endBlockIndex = content.blocks.length;
    for (let index = heading.startBlockIndex + 1; index < content.blocks.length; index += 1) {
      const nextLevel = headingLevel(content.blocks[index]);
      if (nextLevel !== null && nextLevel <= heading.level) {
        endBlockIndex = index;
        break;
      }
    }
    const blocks = content.blocks.slice(heading.startBlockIndex, endBlockIndex);
    const section: DocumentSection = {
      sectionId: heading.block.id,
      headingBlockId: heading.block.id,
      level: heading.level,
      title,
      headingPath,
      parentSectionId,
      startBlockIndex: heading.startBlockIndex,
      endBlockIndex,
      blockCount: blocks.length,
      sectionHash: documentSectionHash(blocks),
    };
    stack.push({ level: heading.level, sectionId: section.sectionId, title });
    return section;
  });
}

export function getDocumentSection(content: NyxdocDocumentV2, sectionId: string) {
  const section = getDocumentOutline(content).find((candidate) => candidate.sectionId === sectionId);
  if (!section) {
    throw new DocumentServiceError("NOT_FOUND", "The requested document section was not found.", { sectionId });
  }
  const blocks = content.blocks.slice(section.startBlockIndex, section.endBlockIndex);
  const sectionContent = parseNyxdocDocumentV2({ schemaVersion: 2, blocks });
  return {
    section,
    content: sectionContent,
    markdown: nyxdocToMarkdown(sectionContent),
  };
}

export function getDocumentSectionForBlock(content: NyxdocDocumentV2, blockId: string) {
  const blockIndex = content.blocks.findIndex((block) => block.id === blockId);
  if (blockIndex < 0) return null;
  return getDocumentOutline(content)
    .filter((section) => section.startBlockIndex <= blockIndex && blockIndex < section.endBlockIndex)
    .sort((left, right) => right.level - left.level)[0] ?? null;
}

export function replaceDocumentSection(
  content: NyxdocDocumentV2,
  sectionId: string,
  replacement: NyxdocDocumentV2,
) {
  const current = getDocumentSection(content, sectionId);
  const first = replacement.blocks[0];
  const replacementLevel = first ? headingLevel(first) : null;
  if (!first || replacementLevel !== current.section.level) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      `Section Markdown must start with an H${current.section.level} heading.`,
      { sectionId, expectedHeadingLevel: current.section.level },
    );
  }

  const reconciled = reconcileNodeIds(current.content.blocks, replacement.blocks) as NyxdocBlock[];
  reconciled[0] = { ...reconciled[0], id: current.section.headingBlockId } as NyxdocBlock;
  return parseNyxdocDocumentV2({
    schemaVersion: 2,
    blocks: [
      ...content.blocks.slice(0, current.section.startBlockIndex),
      ...reconciled,
      ...content.blocks.slice(current.section.endBlockIndex),
    ],
  });
}
