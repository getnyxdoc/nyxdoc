import { describe, expect, it } from "vitest";
import { v2ToStorageBlockInputs } from "@/lib/editor/storage-projection";

describe("AST v2 storage projection", () => {
  it("derives searchable rows without changing canonical node JSON", () => {
    const content = {
      schemaVersion: 2 as const,
      blocks: [
        { id: "projection-heading", type: "h2" as const, children: [{ text: "제목" }] },
        {
          id: "projection-list",
          type: "p" as const,
          indent: 2,
          listStyleType: "disc" as const,
          children: [{ text: "목록" }],
        },
      ],
    };

    const rows = v2ToStorageBlockInputs(content);
    expect(rows).toMatchObject([
      { id: "projection-heading", type: "heading_2", content: "제목", indent: 0 },
      { id: "projection-list", type: "list_item", content: "목록", indent: 1 },
    ]);
    expect(JSON.parse(rows[0].contentJson)).toEqual(content.blocks[0]);
    expect(JSON.parse(rows[1].contentJson)).toEqual(content.blocks[1]);
  });
});
