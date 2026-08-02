import { describe, expect, it } from "vitest";
import { buildHandoffMarkdown, deriveHandoffRequestId } from "@/lib/mcp/handoff";

describe("MCP handoff capture", () => {
  it("builds one structured project-memory document", () => {
    const markdown = buildHandoffMarkdown({
      title: "OAuth 연결 결정",
      summary: "Nyxdoc를 원격 MCP 기억 저장소로 연결한다.",
      background: "사람과 외부 에이전트가 같은 정본을 사용해야 한다.",
      decisions: ["Streamable HTTP를 공통 전송으로 사용한다."],
      requirements: ["기존 Bearer 연결 키를 유지한다."],
      acceptanceCriteria: ["Codex와 ChatGPT가 같은 도구 목록을 읽는다."],
      todos: [{
        title: "OAuth 연결 검증",
        description: "발견 문서와 PKCE 흐름을 확인한다.",
        acceptanceCriteria: "원격 클라이언트가 get_capabilities를 호출한다.",
      }],
      risks: ["OAuth 권한이 워크스페이스 경계를 넘지 않아야 한다."],
      openQuestions: ["CIMD를 언제 추가할 것인가?"],
      references: [{ label: "MCP 인증", url: "https://modelcontextprotocol.io/specification" }],
      rawTranscript: "사용자: ``` 코드 펜스도 보존해줘",
    });

    expect(markdown).not.toContain("# OAuth 연결 결정");
    expect(markdown.startsWith("## Summary\n")).toBe(true);
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("## Agent To-do");
    expect(markdown).toContain("  - Done when: 원격 클라이언트가 get_capabilities를 호출한다.");
    expect(markdown).toContain("## Raw Conversation");
    expect(markdown).toContain("````text");
  });

  it("derives stable bounded child request IDs without exposing the source ID", () => {
    const source = `conversation-${"x".repeat(120)}`;
    const first = deriveHandoffRequestId(source, "todo:0");
    const replay = deriveHandoffRequestId(source, "todo:0");
    const second = deriveHandoffRequestId(source, "todo:1");

    expect(first).toBe(replay);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(first).not.toContain(source);
  });
});
