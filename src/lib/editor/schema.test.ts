import { describe, expect, it } from "vitest";
import {
  NYXDOC_CONTENT_SCHEMA_VERSION,
  NYXDOC_MAX_TOP_LEVEL_BLOCKS,
  nyxdocDocumentText,
  nyxdocDocumentV2Schema,
  parseNyxdocDocumentV2,
  projectNyxdocEditorContent,
  type NyxdocDocumentV2,
} from "@/lib/editor/schema";

const richDocument: NyxdocDocumentV2 = {
  schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
  blocks: [
    {
      id: "intro",
      type: "p",
      align: "center",
      children: [
        { text: "사람과 ", fontSize: "16px" },
        { text: "에이전트", bold: true, color: "#3b9977", fontSize: "24px" },
        { text: "가 함께 읽습니다." },
      ],
    },
    {
      id: "table",
      type: "table",
      colSizes: [180, 240],
      children: [
        {
          id: "row-1",
          type: "tr",
          children: [
            {
              id: "cell-1",
              type: "th",
              children: [{ id: "cell-p-1", type: "p", children: [{ text: "항목" }] }],
            },
            {
              id: "cell-2",
              type: "th",
              children: [{ id: "cell-p-2", type: "p", children: [{ text: "담당" }] }],
            },
          ],
        },
        {
          id: "row-2",
          type: "tr",
          children: [
            {
              id: "cell-3",
              type: "td",
              children: [{ id: "cell-p-3", type: "p", children: [{ text: "문서" }] }],
            },
            {
              id: "cell-4",
              type: "td",
              children: [{ id: "cell-p-4", type: "p", children: [{ text: "Codex" }] }],
            },
          ],
        },
      ],
    },
    {
      id: "launch-image",
      type: "img",
      mediaId: "a9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2",
      url: "/api/media/a9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2",
      alt: "출시 화면",
      name: "launch.png",
      children: [{ text: "" }],
    },
  ],
};

describe("Nyxdoc Document AST v2", () => {
  it("accepts a long office-document paste with hundreds of paragraphs", () => {
    const importedDocument = {
      schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
      blocks: Array.from({ length: 945 }, (_, index) => ({
        id: `imported-paragraph-${index}`,
        type: "p" as const,
        children: [{ text: `가져온 문단 ${index + 1}` }],
      })),
    };

    expect(nyxdocDocumentV2Schema.safeParse(importedDocument).success).toBe(true);
  });

  it("keeps an explicit finite boundary for pathological block counts", () => {
    const oversizedDocument = {
      schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
      blocks: Array.from({ length: NYXDOC_MAX_TOP_LEVEL_BLOCKS + 1 }, (_, index) => ({
        id: `oversized-paragraph-${index}`,
        type: "p" as const,
        children: [{ text: "" }],
      })),
    };

    expect(nyxdocDocumentV2Schema.safeParse(oversizedDocument).success).toBe(false);
  });

  it("accepts rich text, alignment, font size, and structured tables", () => {
    expect(parseNyxdocDocumentV2(richDocument)).toEqual(richDocument);
  });

  it("projects rich content to deterministic searchable text", () => {
    expect(nyxdocDocumentText(richDocument)).toBe(
      "사람과 에이전트가 함께 읽습니다.\n항목\t담당\n문서\tCodex\n출시 화면",
    );
  });

  it("accepts only authenticated internal media links, never data URLs", () => {
    const invalid = structuredClone(richDocument);
    const image = invalid.blocks[2];
    if (image.type !== "img") throw new Error("이미지 테스트 픽스처가 아닙니다.");
    image.url = "data:image/png;base64,AAAA";

    expect(nyxdocDocumentV2Schema.safeParse(invalid).success).toBe(false);
  });

  it("allows HTTPS links but rejects unsafe and non-web schemes at the canonical AST boundary", () => {
    const linked = structuredClone(richDocument);
    const paragraph = linked.blocks[0];
    if (paragraph.type !== "p") throw new Error("문단 테스트 픽스처가 아닙니다.");
    paragraph.children = [{
      id: "safe-link",
      type: "a",
      url: "https://example.com/docs?q=nyxdoc",
      children: [{ text: "안전한 문서" }],
    }];
    expect(nyxdocDocumentV2Schema.safeParse(linked).success).toBe(true);

    const unsafeUrls = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/id",
      "ftp://example.com/file",
      "nyxdoc://document/a9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2",
    ];
    for (const url of unsafeUrls) {
      const unsafe = structuredClone(linked);
      const unsafeParagraph = unsafe.blocks[0];
      if (unsafeParagraph.type !== "p") throw new Error("문단 테스트 픽스처가 아닙니다.");
      const link = unsafeParagraph.children[0];
      if (!("type" in link) || link.type !== "a") throw new Error("링크 테스트 픽스처가 아닙니다.");
      link.url = url;
      expect(nyxdocDocumentV2Schema.safeParse(unsafe).success, url).toBe(false);
    }
  });

  it("rejects duplicate stable IDs anywhere in the tree", () => {
    const duplicate = structuredClone(richDocument);
    duplicate.blocks[1].id = "intro";

    const result = nyxdocDocumentV2Schema.safeParse(duplicate);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("ID가 중복"))).toBe(true);
  });

  it("rejects unknown fields instead of silently losing them", () => {
    const result = nyxdocDocumentV2Schema.safeParse({
      schemaVersion: 2,
      blocks: [{ id: "p-1", type: "p", mysteryFormatting: true, children: [{ text: "내용" }] }],
    });
    expect(result.success).toBe(false);
  });

  it("removes only known editor runtime fields before canonical validation", () => {
    const projected = projectNyxdocEditorContent([
      {
        _id: "plate-runtime-block",
        id: "p-1",
        runtimeNormalization: undefined,
        type: "p",
        children: [{
          _id: "plate-runtime-leaf",
          runtimeNormalization: undefined,
          text: "보존되는 내용",
        }],
      },
    ]);

    expect(projected).toEqual({
      schemaVersion: 2,
      blocks: [{ id: "p-1", type: "p", children: [{ text: "보존되는 내용" }] }],
    });
    expect(nyxdocDocumentV2Schema.safeParse(projected).success).toBe(true);

    const unknownFormatting = projectNyxdocEditorContent([
      {
        _id: "plate-runtime-block",
        id: "p-1",
        type: "p",
        mysteryFormatting: true,
        children: [{ text: "내용" }],
      },
    ]);
    expect(nyxdocDocumentV2Schema.safeParse(unknownFormatting).success).toBe(false);
  });

  it("allows checked only on todo list blocks", () => {
    const result = nyxdocDocumentV2Schema.safeParse({
      schemaVersion: 2,
      blocks: [{ id: "p-1", type: "p", checked: true, children: [{ text: "내용" }] }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts code blocks and internal document references as first-class content", () => {
    const documentId = "a9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2";
    const document = parseNyxdocDocumentV2({
      schemaVersion: 2,
      blocks: [
        {
          id: "code",
          type: "code_block",
          lang: "typescript",
          children: [
            { id: "line-1", type: "code_line", children: [{ text: "const answer = 42;" }] },
          ],
        },
        {
          id: "reference",
          type: "p",
          children: [{
            id: "doc-ref",
            type: "doc_ref",
            documentId,
            children: [{ text: "관련 설계" }],
          }],
        },
      ],
    });

    expect(nyxdocDocumentText(document)).toBe("const answer = 42;\n관련 설계");
  });

  it("preserves reversible automatic titles for external and internal links", () => {
    const parsed = parseNyxdocDocumentV2({
      schemaVersion: 2,
      blocks: [{
        id: "links",
        type: "p",
        children: [{
          id: "external",
          type: "a",
          url: "https://naver.com/",
          autoTitle: true,
          children: [{ text: "NAVER" }],
        }, {
          id: "internal",
          type: "doc_ref",
          documentId: "a9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2",
          sourceUrl: "https://app.nyxdoc.com/app?document=a9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2",
          autoTitle: true,
          children: [{ text: "관련 설계" }],
        }],
      }],
    });

    expect(parsed.blocks[0]).toMatchObject({
      children: [
        { type: "a", autoTitle: true },
        { type: "doc_ref", autoTitle: true },
      ],
    });
  });
});
