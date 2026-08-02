import { describe, expect, it } from "vitest";
import { buildAgentConnectionHandoff } from "@/lib/agents/handoff";

describe("agent connection handoff", () => {
  it("builds a self-contained handoff for a newly created key", () => {
    const handoff = buildAgentConnectionHandoff({
      agentName: "gameroom",
      credentialName: "gameroom 기본 키",
      documentScope: "운영 및 하위 문서",
      mcpUrl: "https://app.nyxdoc.com/mcp?workspace=workspace-1",
      role: "에디터 · 문서 작업",
      token: "nyx_live_secret",
      workspaceName: "gameroom",
    });

    expect(handoff).toContain("Nyxdoc 연결을 설정해줘.");
    expect(handoff).toContain("- 기본 워크스페이스: gameroom");
    expect(handoff).toContain("- 워크스페이스 역할: 에디터 · 문서 작업");
    expect(handoff).toContain("- 접근 문서 범위: 운영 및 하위 문서");
    expect(handoff).toContain("- MCP 주소: https://app.nyxdoc.com/mcp?workspace=workspace-1");
    expect(handoff).toContain("- Bearer 연결 키: nyx_live_secret");
    expect(handoff).toContain("`get_capabilities`");
    expect(handoff).toContain("`list_agent_workspaces`");
    expect(handoff).toContain("문서 ID가 있는 도구는 워크스페이스를 자동 판별");
    expect(handoff).toContain("사람이 브라우저에서 열어둔 워크스페이스는 에이전트 작업에 영향을 주지 않아");
    expect(handoff).toContain("웹 UI를 스크래핑하거나 브라우저로 자동 조작하지 말고");
    expect(handoff).toContain("create_image_upload");
    expect(handoff).toContain("문서에 base64를 넣지 마");
    expect(handoff).toContain("문서, 로그, 답변에 다시 노출하지 마");
  });

  it("does not pretend that an existing key can be revealed again", () => {
    const handoff = buildAgentConnectionHandoff({
      agentName: "nyx",
      credentialName: "공용 키",
      mcpUrl: "https://app.nyxdoc.com/mcp",
      token: null,
    });

    expect(handoff).toContain("기존에 저장된 \"공용 키\" 키 사용 · 원문 재표시 불가");
    expect(handoff).toContain("기존 연결 키가 네 비밀 저장소에 없다면");
    expect(handoff).not.toContain("Bearer 연결 키: null");
  });
});
