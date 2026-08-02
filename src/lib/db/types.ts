export const BLOCK_TYPES = [
  "heading",
  "heading_2",
  "heading_3",
  "paragraph",
  "callout",
  "list_item",
  "numbered_list_item",
  "todo",
  "quote",
  "divider",
  "table",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export const MAX_BLOCK_INDENT = 6;

export type TableBlockData = {
  rows: string[][];
  headerRow: boolean;
  headerColumn: boolean;
};

export type DocumentBlockSnapshot = {
  id: string;
  type: BlockType;
  content: string;
  indent: number;
  checked?: boolean;
  table?: TableBlockData;
  order: number;
  version: number;
};
