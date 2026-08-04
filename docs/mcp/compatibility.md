# MCP 클라이언트 호환성

확인일: **2026-07-28**

Nyxdoc의 정식 원격 도구 표면은 `/mcp`의 stateless Streamable HTTP다. 클라이언트가
연결되면 가장 먼저 `get_capabilities`를 호출하고, 실제 반환된 프로토콜 버전과 도구 목록을
정본으로 사용한다.

호스트 제품의 요금제와 지원 표면은 Nyxdoc와 독립적으로 바뀔 수 있다. 아래의 “호스트
지원”은 확인일 기준 공식 문서 판정이고, “검증”은 Nyxdoc에서 실제 수행한 범위다.

## 호환성 표

| 클라이언트 | 전송 | 읽기 | 쓰기 | 인증 | 호스트 지원·제약 | Nyxdoc 검증 |
| --- | --- | --- | --- | --- | --- | --- |
| Codex Desktop | Streamable HTTP | 지원 | 지원 | Bearer 또는 OAuth | Codex 설정이 HTTP URL, Bearer 환경 변수, OAuth 로그인을 지원 | Bearer 운영 검증, OAuth 전체 HTTP 흐름 자동 검증 |
| Codex CLI | Streamable HTTP | 지원 | 지원 | Bearer 또는 OAuth | `codex mcp add --url`, `login`, `logout` 지원 | 같은 Codex MCP 설정 계약; 별도 CLI 수동 시나리오는 미검증 |
| Codex Desktop/CLI | STDIO | 해당 없음 | 해당 없음 | 로컬 환경 변수 | Codex 호스트는 STDIO를 지원하지만 Nyxdoc는 중복 STDIO 서버를 제공하지 않음 | 미지원 |
| ChatGPT 웹 Pro | 원격 MCP | 공식 범위 내 읽기·검색 | 현재 제한 | OAuth | custom app은 developer mode에서 읽기/fetch 중심 | Nyxdoc OAuth 프로토콜 검증, 실제 Pro 계정 연결 미검증 |
| ChatGPT 웹 Business | 원격 MCP | 지원 | 베타 | OAuth | 관리자/소유자가 full MCP app을 만들고 배포 | Nyxdoc OAuth 프로토콜 검증, 실제 Business 계정 연결 미검증 |
| ChatGPT 웹 Enterprise/Edu | 원격 MCP | 지원 | 베타 | OAuth | developer RBAC와 app action 제어 제공 | Nyxdoc OAuth 프로토콜 검증, 실제 관리형 계정 연결 미검증 |
| ChatGPT 모바일 | 원격 MCP | 현재 미지원 | 현재 미지원 | 해당 없음 | 공식 문서상 custom MCP app은 web only | 미검증 |
| OpenAI Responses API | 원격 MCP | 지원 | 도구와 승인 정책에 따름 | OAuth access token 또는 요청 헤더 | API 호출자가 인증과 도구 승인 정책을 구성 | 직접 통합 미검증 |
| OpenClaw | Streamable HTTP | 지원 | 지원 | Bearer | 사용하는 OpenClaw MCP 클라이언트 기능에 따름 | 운영 Bearer 경로 검증 |
| MCP TypeScript SDK | Streamable HTTP | 지원 | 지원 | Bearer 또는 OAuth | 표준 MCP 클라이언트 | DCR, PKCE, refresh, grant 폐기, 인증 MCP 호출 자동 검증 |

## 연결 방식

OAuth 클라이언트는 보호 리소스 메타데이터와 인증 서버 메타데이터를 발견하고 PKCE S256을
사용해야 한다. Nyxdoc 0.25.8은 동적 클라이언트 등록(DCR)을 제공한다. Client ID Metadata
Document(CIMD)는 아직 제공하지 않으며, CIMD만 허용하는 클라이언트는 별도 등록이 필요하다.

기존 자동화나 로컬 에이전트는 계속 `Authorization: Bearer <NYXDOC_TOKEN>`을 사용할 수
있다. OAuth와 연결 키는 같은 전역 에이전트·워크스페이스 grant capability·명시적
credential binding·문서 루트·IP 제한·감사 계약 아래에서 인증된다.

## 발견 주소

- MCP 리소스: `https://your-nyxdoc.example/mcp`
- 보호 리소스 메타데이터:
  `https://your-nyxdoc.example/.well-known/oauth-protected-resource`
- MCP 경로별 보호 리소스 메타데이터:
  `https://your-nyxdoc.example/.well-known/oauth-protected-resource/mcp`
- 인증 서버 메타데이터:
  `https://your-nyxdoc.example/.well-known/oauth-authorization-server`

인증되지 않은 `/mcp` 요청은 `401`과 `WWW-Authenticate`의 `resource_metadata`를 함께
반환한다.

## 클라이언트별 메모

Codex에서 연결 키를 사용할 때는 원문을 설정 파일에 직접 쓰지 않고
`bearer_token_env_var`로 환경 변수를 참조한다. OAuth를 선택하면 Codex의 MCP 로그인
명령으로 브라우저 승인을 진행한다.

ChatGPT는 사용자가 임의의 API 키를 입력하는 방식 대신 원격 MCP OAuth 흐름을 사용한다.
연결 화면에서 Nyxdoc 계정으로 로그인하고 에이전트 신원·워크스페이스·접근 프로필을 승인한다. app 게시 뒤
도구 정의를 바꾸면 ChatGPT 관리자가 새 action snapshot을 검토해야 할 수 있다.

OpenClaw는 현재 Nyxdoc 연결 안내가 발급하는 MCP 주소와 Bearer 연결 키를 사용하는 경로를
기준으로 한다. OAuth 지원 여부는 사용하는 OpenClaw 버전과 MCP 클라이언트 설정에서 별도로
확인한다.

공식 참고:

- [OpenAI Apps SDK authentication](https://developers.openai.com/apps-sdk/build/auth)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)
- [MCP and Connectors in the OpenAI API](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
