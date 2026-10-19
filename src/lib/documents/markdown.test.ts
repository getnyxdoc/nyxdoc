import { describe, expect, it } from "vitest";
import {
  markdownToNyxdoc,
  markdownToNyxdocWithReport,
  nyxdocToMarkdown,
} from "@/lib/documents/markdown";

describe("Nyxdoc Markdown portability", () => {
  it("imports and exports headings, rich text, lists, code, tables, media, and document references", () => {
    const targetId = "a9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2";
    const mediaId = "b9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2";
    const markdown = [
      "# 게임 조사",
      "",
      `**중요**한 [관련 문서](nyxdoc://document/${targetId})입니다.`,
      "",
      "- [x] 조사 완료",
      "",
      "```typescript",
      "const answer = 42;",
      "```",
      "",
      "| 항목 | 상태 |",
      "| --- | --- |",
      "| 문서 | 완료 |",
      "",
      `![화면](/api/media/${mediaId})`,
    ].join("\n");

    const content = markdownToNyxdoc(markdown);
    expect(content.blocks.map((block) => block.type)).toEqual([
      "h1",
      "p",
      "p",
      "code_block",
      "table",
      "img",
    ]);
    expect(content.blocks.every((block) => Boolean(block.id))).toBe(true);
    const paragraph = content.blocks[1];
    expect(paragraph.type).toBe("p");
    if (paragraph.type !== "p") throw new Error("문단 변환 결과가 아닙니다.");
    expect(paragraph.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "doc_ref", documentId: targetId }),
    ]));
    const code = content.blocks[3];
    expect(code).toMatchObject({ type: "code_block", lang: "typescript" });

    const exported = nyxdocToMarkdown(content);
    expect(exported).toContain("# 게임 조사");
    expect(exported).toContain("```typescript");
    expect(exported).toContain(`nyxdoc://document/${targetId}`);
    expect(exported).toContain(`/api/media/${mediaId}`);
    expect(markdownToNyxdoc(exported).blocks.map((block) => block.type)).toEqual(
      content.blocks.map((block) => block.type),
    );
  });

  it("rejects external Markdown images instead of silently embedding them", () => {
    expect(() => markdownToNyxdoc("![외부](https://example.com/image.png)"))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("round-trips links and surrounding rich text inside table headers and cells", () => {
    const targetId = "a9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2";
    const markdown = [
      "| [제목](https://example.com/header) | 상태 | 빈칸 |",
      "| --- | --- | --- |",
      `| 앞 **굵게** [웹 링크](https://example.com/page) 뒤 [문서](nyxdoc://document/${targetId})` + " | [**강조**](https://example.com/bold)와 `코드` | |",
      "| https://example.com/auto | *기울임*과 ~~삭제~~ | 끝 |",
    ].join("\n");
    const converted = markdownToNyxdocWithReport(markdown, { idSeed: "table-links" });
    expect(converted.warnings).toEqual([]);
    expect(markdownToNyxdoc(markdown, { idSeed: "table-links" })).toEqual(converted.content);
    const table = converted.content.blocks[0];
    if (table.type !== "table") throw new Error("표 변환 결과가 아닙니다.");
    expect(table.children[0].children[0].children).toMatchObject([
      { type: "p", children: [{ type: "a", url: "https://example.com/header" }] },
    ]);
    const body = table.children[1].children[0].children;
    expect(body).toHaveLength(1);
    expect(body[0].children).toMatchObject([
      { text: "앞 " }, { text: "굵게", bold: true }, { text: " " },
      { type: "a", url: "https://example.com/page", children: [{ text: "웹 링크" }] },
      { text: " 뒤 " }, { type: "doc_ref", documentId: targetId, children: [{ text: "문서" }] },
    ]);
    expect(table.children[1].children[1].children[0].children).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "a", children: [{ text: "강조", bold: true }] }),
      expect.objectContaining({ text: "코드", code: true }),
    ]));
    const exported = nyxdocToMarkdown(converted.content);
    expect(exported).toContain(`[문서](nyxdoc://document/${targetId})`);
    expect(exported).toContain("[웹 링크](https://example.com/page)");
    expect(nyxdocToMarkdown(markdownToNyxdoc(exported))).toBe(exported);
  });

  it("round-trips CommonMark blockquotes emitted by the exporter", () => {
    const content = markdownToNyxdoc(["# 인용", "", "> 사람이 남긴 인용문"].join("\n"));
    expect(content.blocks).toMatchObject([
      { type: "h1" },
      { type: "blockquote", children: [{ text: "사람이 남긴 인용문" }] },
    ]);

    const exported = nyxdocToMarkdown(content);
    expect(exported).toContain("> 사람이 남긴 인용문");
    expect(markdownToNyxdoc(exported).blocks.map((block) => block.type)).toEqual(["h1", "blockquote"]);
  });

  it("reports the invalid block location without echoing private input", () => {
    const error = (() => {
      try { markdownToNyxdoc("[private-label](relative-secret-path)"); } catch (failure) { return failure; }
    })();
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("blocks.0"),
      details: { issues: [{ path: ["blocks", "0", "children", "0", "url"], message: "올바른 웹 링크 주소가 아닙니다." }] },
    });
    expect(JSON.stringify(error)).not.toMatch(/private-label|relative-secret-path/);
  });

  it("preserves image alt text in both Markdown directions", () => {
    const mediaId = "b9a0cf6e-1f5b-4f95-8f45-0bd46e98b5a2";
    const content = markdownToNyxdoc(`![테스트 대체 텍스트](/api/media/${mediaId})`);
    expect(content.blocks[0]).toMatchObject({ type: "img", alt: "테스트 대체 텍스트" });
    expect(nyxdocToMarkdown(content)).toContain(`![테스트 대체 텍스트](/api/media/${mediaId})`);
  });

  it("round-trips heading levels four through six without losing structure", () => {
    const markdown = ["#### 세부 제목", "", "##### 더 세부 제목", "", "###### 가장 세부 제목"].join("\n");
    const converted = markdownToNyxdocWithReport(markdown);
    expect(converted.content.blocks.map((block) => block.type)).toEqual(["h4", "h5", "h6"]);
    expect(converted.warnings).toEqual([]);
    expect(nyxdocToMarkdown(converted.content)).toContain("###### 가장 세부 제목");
  });
});
