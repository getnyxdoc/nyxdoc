import type { AppLocale } from "@/lib/i18n/locales";

export type AgentConnectionHandoffInput = {
  agentName: string;
  credentialName: string;
  documentScope?: string | null;
  keyAccess?: string | null;
  mcpUrl: string;
  role?: string | null;
  token: string | null;
  workspaceName?: string | null;
  locale?: AppLocale;
};

function singleLine(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function buildAgentConnectionHandoff(input: AgentConnectionHandoffInput) {
  const locale = input.locale ?? "ko";
  const copy = {
    en: {
      noDefaultWorkspace: "No default · specify an assigned workspace when starting work",
      storedKey: `Use the previously stored "${singleLine(input.credentialName)}" key · raw value cannot be shown again`,
      agent: "Agent",
      workspace: "Default workspace",
      role: "Workspace role",
      scope: "Document scope",
      ceiling: "Connection key permission ceiling",
      transport: "Transport",
      mcpUrl: "MCP URL",
      bearer: "Bearer connection key",
      title: "Set up the Nyxdoc connection.",
      intro: "Register the Nyxdoc MCP server with the connection information below and verify the connection.",
      steps: "Setup and verification:",
      step1: "Register the MCP URL above as a Streamable HTTP server.",
      step2: "Authenticate with the Authorization header in the form `Bearer <connection key>`.",
      step3: "After connecting, call `get_capabilities` first to inspect supported features and the latest document schema.",
      step4: "Use the connected MCP tools to read and edit Nyxdoc documents. Document-ID tools infer their workspace; pass workspaceId to list, search, create, and other ambiguous operations. When sharing a document with a person, use the absolute webUrl returned by Nyxdoc instead of guessing or inspecting the browser UI. For images, use create_image_upload and upload raw bytes to its one-time URL; never embed base64 in a document. Do not scrape the web UI or automate it with a browser.",
      step5: "Call `list_agent_workspaces` to verify every allowed workspace and its role and document scope. The workspace above is only the connection default, and the workspace open in a person's browser has no effect.",
      step6: "The connection key is secret. Do not expose it again in documents, logs, or responses.",
      step7: "If you cannot change MCP settings directly, provide the exact settings location and values for me to paste.",
      step8: "If the existing connection key is not in your secret store, do not guess it; tell me that a new key is required.",
    },
    ko: {
      noDefaultWorkspace: "기본값 없음 · 작업할 때 배정된 워크스페이스를 명시",
      storedKey: `기존에 저장된 "${singleLine(input.credentialName)}" 키 사용 · 원문 재표시 불가`,
      agent: "에이전트",
      workspace: "기본 워크스페이스",
      role: "워크스페이스 역할",
      scope: "접근 문서 범위",
      ceiling: "연결 키 권한 상한",
      transport: "전송 방식",
      mcpUrl: "MCP 주소",
      bearer: "Bearer 연결 키",
      title: "Nyxdoc 연결을 설정해줘.",
      intro: "아래 연결 정보를 사용해 Nyxdoc MCP 서버를 등록하고 연결 상태를 확인해줘.",
      steps: "설정 및 확인 절차:",
      step1: "위 MCP 주소를 Streamable HTTP 서버로 등록해.",
      step2: "인증은 Authorization 헤더에 `Bearer <연결 키>` 형식으로 적용해.",
      step3: "연결 후 `get_capabilities`를 먼저 호출해 지원 기능과 최신 문서 스키마를 확인해.",
      step4: "Nyxdoc 문서는 웹 UI를 스크래핑하거나 브라우저로 자동 조작하지 말고 연결된 MCP 도구로 조회·수정해. 문서 ID가 있는 도구는 워크스페이스를 자동 판별하고 목록·검색·생성처럼 대상이 모호한 작업에는 workspaceId를 명시해. 이미지는 create_image_upload로 일회용 주소를 받은 뒤 원본 바이트를 올리고 문서에 base64를 넣지 마.",
      step5: "`list_agent_workspaces`를 호출해 허용된 모든 워크스페이스와 각각의 역할·문서 범위를 확인해. 위 워크스페이스는 연결 기본값일 뿐이고 사람이 브라우저에서 열어둔 워크스페이스는 에이전트 작업에 영향을 주지 않아.",
      step6: "연결 키는 비밀값이므로 문서, 로그, 답변에 다시 노출하지 마.",
      step7: "네가 MCP 설정을 직접 변경할 수 없다면, 내가 붙여넣을 정확한 설정 위치와 설정값을 만들어서 안내해줘.",
      step8: "기존 연결 키가 네 비밀 저장소에 없다면 값을 추측하지 말고 새 키가 필요하다고 알려줘.",
    },
    ja: {
      noDefaultWorkspace: "既定値なし · 作業時に割り当て済みワークスペースを指定",
      storedKey: `保存済みの「${singleLine(input.credentialName)}」キーを使用 · 原文は再表示不可`,
      agent: "エージェント",
      workspace: "既定のワークスペース",
      role: "ワークスペースの役割",
      scope: "文書アクセス範囲",
      ceiling: "接続キー権限の上限",
      transport: "転送方式",
      mcpUrl: "MCP URL",
      bearer: "Bearer接続キー",
      title: "Nyxdoc接続を設定してください。",
      intro: "以下の接続情報を使ってNyxdoc MCPサーバーを登録し、接続状態を確認してください。",
      steps: "設定と確認手順：",
      step1: "上記MCP URLをStreamable HTTPサーバーとして登録してください。",
      step2: "Authorizationヘッダーへ`Bearer <接続キー>`形式で認証を設定してください。",
      step3: "接続後、最初に`get_capabilities`を呼び出し、対応機能と最新の文書スキーマを確認してください。",
      step4: "Nyxdoc文書の閲覧・編集には接続済みMCPツールを使用してください。文書IDを持つツールはワークスペースを自動判別し、一覧・検索・作成など対象が曖昧な操作ではworkspaceIdを指定します。画像はcreate_image_uploadで一度限りのURLを取得し、元のバイトをアップロードします。文書へbase64を埋め込まないでください。Web UIのスクレイピングやブラウザー自動操作は行わないでください。",
      step5: "`list_agent_workspaces`を呼び出し、許可されたすべてのワークスペースと各役割・文書範囲を確認してください。上記は接続の既定値にすぎず、人がブラウザーで開いているワークスペースはエージェント作業へ影響しません。",
      step6: "接続キーは秘密情報です。文書、ログ、回答へ再表示しないでください。",
      step7: "MCP設定を直接変更できない場合は、貼り付けるための正確な設定場所と設定値を案内してください。",
      step8: "既存の接続キーがシークレットストアにない場合は推測せず、新しいキーが必要だと知らせてください。",
    },
  }[locale];
  const agentName = singleLine(input.agentName);
  const compact = new URL(input.mcpUrl).searchParams.get("profile") === "compact";
  const compactSteps = {
    en: [
      "This URL uses compact MCP (four tools). Call nyxdoc_discover with operation=list_agent_workspaces, then call its returned tool with {operation,args} to verify access.",
      "Find each needed operation with nyxdoc_discover, then inspect its inputSchema and workflow. Full schemas are loaded only on demand; use the returned route for get_capabilities and other operations too.",
    ],
    ko: [
      "이 주소는 도구 4개만 노출하는 경량 MCP야. nyxdoc_discover에 operation=list_agent_workspaces를 보내고, 반환된 도구를 {operation,args}로 호출해 접근 범위를 확인해.",
      "필요한 기능만 nyxdoc_discover로 찾은 뒤 inputSchema와 workflow를 확인해. get_capabilities 등 기존 기능도 반환된 실행 도구로 호출하고, 전체 스키마를 미리 읽지 마.",
    ],
    ja: [
      "このURLは4ツールのみの軽量MCPです。nyxdoc_discoverでoperation=list_agent_workspacesを照会し、返されたツールを{operation,args}で呼び出してアクセスを確認してください。",
      "必要な操作だけをnyxdoc_discoverで探し、inputSchemaとworkflowを確認してください。get_capabilitiesも返された実行ツール経由で呼び出します。",
    ],
  }[locale];
  const workspaceName = input.workspaceName
    ? singleLine(input.workspaceName)
    : copy.noDefaultWorkspace;
  const credential = input.token
    ? input.token
    : copy.storedKey;

  const connectionDetails = [
    `- ${copy.agent}: ${agentName}`,
    `- ${copy.workspace}: ${workspaceName}`,
    ...(input.role ? [`- ${copy.role}: ${singleLine(input.role)}`] : []),
    ...(input.documentScope ? [`- ${copy.scope}: ${singleLine(input.documentScope)}`] : []),
    ...(input.keyAccess ? [`- ${copy.ceiling}: ${singleLine(input.keyAccess)}`] : []),
    `- ${copy.transport}: Streamable HTTP`,
    `- ${copy.mcpUrl}: ${input.mcpUrl.trim()}`,
    `- ${copy.bearer}: ${credential}`,
  ];

  return [
    copy.title,
    "",
    copy.intro,
    "",
    ...connectionDetails,
    "",
    copy.steps,
    `1. ${copy.step1}`,
    `2. ${copy.step2}`,
    `3. ${compact ? compactSteps[0] : copy.step3}`,
    `4. ${copy.step4}`,
    `5. ${compact ? compactSteps[1] : copy.step5}`,
    `6. ${copy.step6}`,
    `7. ${copy.step7}`,
    ...(!input.token
      ? [`8. ${copy.step8}`]
      : []),
  ].join("\n");
}
