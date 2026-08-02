import { describe, expect, it } from "vitest";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import {
  getDocumentOutline,
  getDocumentSection,
  getDocumentSectionForBlock,
  replaceDocumentSection,
} from "@/lib/documents/sections";

function document() {
  return parseNyxdocDocumentV2({
    schemaVersion: 2,
    blocks: [
      { id: "intro", type: "p", children: [{ text: "intro" }] },
      { id: "alpha", type: "h1", children: [{ text: "Alpha" }] },
      { id: "alpha-body", type: "p", children: [{ text: "Keep me" }] },
      { id: "alpha-child", type: "h2", children: [{ text: "Child" }] },
      { id: "alpha-child-body", type: "p", children: [{ text: "Child body" }] },
      { id: "beta", type: "h1", children: [{ text: "Beta" }] },
      { id: "beta-body", type: "p", children: [{ text: "Beta body" }] },
    ],
  });
}

describe("document sections", () => {
  it("derives stable heading ranges, ancestry, and hashes", () => {
    const outline = getDocumentOutline(document());
    expect(outline).toMatchObject([
      {
        sectionId: "alpha",
        level: 1,
        headingPath: ["Alpha"],
        parentSectionId: null,
        startBlockIndex: 1,
        endBlockIndex: 5,
        blockCount: 4,
      },
      {
        sectionId: "alpha-child",
        level: 2,
        headingPath: ["Alpha", "Child"],
        parentSectionId: "alpha",
        startBlockIndex: 3,
        endBlockIndex: 5,
        blockCount: 2,
      },
      {
        sectionId: "beta",
        level: 1,
        headingPath: ["Beta"],
        parentSectionId: null,
        startBlockIndex: 5,
        endBlockIndex: 7,
        blockCount: 2,
      },
    ]);
    expect(outline[0].sectionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(getDocumentSectionForBlock(document(), "alpha-child-body")?.sectionId).toBe("alpha-child");
  });

  it("returns only the selected section as Markdown", () => {
    const selected = getDocumentSection(document(), "alpha-child");
    expect(selected.markdown).toContain("## Child");
    expect(selected.markdown).toContain("Child body");
    expect(selected.markdown).not.toContain("Beta");
  });

  it("replaces one section while preserving anchors and unrelated block IDs", () => {
    const replacement = parseNyxdocDocumentV2({
      schemaVersion: 2,
      blocks: [
        { id: "generated-heading", type: "h1", children: [{ text: "Alpha revised" }] },
        { id: "generated-keep", type: "p", children: [{ text: "Keep me" }] },
        { id: "generated-new", type: "p", children: [{ text: "New paragraph" }] },
      ],
    });

    const next = replaceDocumentSection(document(), "alpha", replacement);
    expect(next.blocks.map((block) => block.id)).toEqual([
      "intro",
      "alpha",
      "alpha-body",
      "generated-new",
      "beta",
      "beta-body",
    ]);
    expect(next.blocks[1].children[0]).toMatchObject({ text: "Alpha revised" });
    expect(getDocumentOutline(next)[0]).toMatchObject({ sectionId: "alpha", title: "Alpha revised" });
  });

  it("rejects a replacement that changes the selected heading level", () => {
    const replacement = parseNyxdocDocumentV2({
      schemaVersion: 2,
      blocks: [{ id: "wrong", type: "h2", children: [{ text: "Wrong level" }] }],
    });
    expect(() => replaceDocumentSection(document(), "alpha", replacement))
      .toThrow("must start with an H1 heading");
  });
});
