# MCP OAuth 2.1

Nyxdoc의 OAuth는 외부 MCP 클라이언트가 사람의 Nyxdoc 계정을 대신해 무제한 접근하는
구조가 아니다. 승인 시 새 전역 에이전트를 만들거나 사용자가 관리할 수 있는 기존 에이전트를
선택하고, OAuth 클라이언트 전용 내부 연결 자격을 별도로 만든다. 사람이 선택한
워크스페이스 grant의 접근 프로필·capability·문서 범위만 부여한다.

## 승인 흐름

1. 클라이언트가 보호 리소스·인증 서버 메타데이터를 발견한다.
2. 필요하면 DCR로 클라이언트를 등록한다.
3. Authorization Code + PKCE S256으로 로그인을 시작한다.
4. Nyxdoc 사용자가 새 에이전트를 만들지 기존 에이전트를 사용할지 선택한다.
5. 연결 앱, 요청 scope, 접근 워크스페이스와 접근 프로필을 확인한다.
6. 승인 후 OAuth access token이 발급된다.
7. `/mcp`는 OAuth 사용자·클라이언트 grant를 선택한 에이전트 자격으로 해석한 뒤 기존
   워크스페이스 capability, 문서 루트, IP 제한, 감사 경계를 다시 적용한다.

OAuth 승인 화면에서 선택할 수 있는 워크스페이스는 로그인한 사람이 에이전트 연결을 관리할
수 있는 공간뿐이다. 기존 에이전트 목록도 로그인한 사람이 관리할 수 있고 활성 상태인
개인·조직 에이전트로 제한한다. 처음 연결할 때는 새 에이전트 생성이 기본값이며, 같은 OAuth
client를 다시 승인하면 현재 연결된 에이전트가 먼저 선택된다. 사용자는 재승인 과정에서
다른 기존 에이전트나 새 에이전트로 바꿀 수 있다.

기존 에이전트를 선택해도 OAuth용 연결 자격은 해당 client 전용으로 새로 생성된다. 에이전트가
이미 쓰는 수동 Bearer 연결 키를 OAuth client와 공유하지 않는다. 선택한 에이전트가 이미
워크스페이스에 할당되어 있으면 기존 접근 프로필·capability·문서 범위를 보존하고, 아직 할당되지 않은
워크스페이스에만 승인 화면의 접근 프로필을 적용한다. 기존 grant는 재승인으로 조용히
변경하지 않고 OAuth 전용 credential binding만 갱신한다.

## 보안 속성

- PKCE는 S256만 허용한다.
- access token 유효기간은 1시간, refresh token은 30일이다.
- 동적 등록 client secret은 해시로 저장한다.
- access token은 문서·로그·감사 메타데이터에 기록하지 않는다.
- OAuth scope와 내부 연결 자격 scope의 교집합만 실제 scope가 된다.
- 토큰만으로 워크스페이스 grant binding이나 문서 범위를 우회할 수 없다.
- 재승인하면 해당 사용자·client의 기존 access token과 refresh token을 모두 폐기한다.
- 재승인하면서 에이전트를 바꾸면 이전 OAuth 전용 연결 자격도 폐기한다. 따라서 이미 발급된
  토큰의 에이전트 신원이 조용히 다른 신원으로 바뀌지 않는다.
- 기존 연결 키 폐기 또는 에이전트 비활성화도 OAuth 요청을 즉시 차단한다.
- 문서 본문의 비밀정보를 검사하거나 수집하지 않는다. Nyxdoc이 책임지는 경계는 인증과
  권한 없는 접근 차단이다.

지원 문서 scope:

- `documents:read`
- `documents:write`
- `documents:commit`
- `changes:read`
- `revisions:restore`

`documents:write`는 `documents:read`를, `documents:commit`은 `documents:write`를,
`revisions:restore`는 정본 저장 scope를 요구한다.

## 운영과 철회

Bearer 연결 키와 OAuth는 동등하게 지원되는 두 인증 방식이다. OAuth 연결도 에이전트 관리 화면의 전역
에이전트와 내부 연결 자격으로 보이며, 비활성화·폐기하면 더 이상 MCP 인증에 사용할 수 없다.
워크스페이스별 접근 프로필·capability와 문서 범위는 워크스페이스 설정에서 관리한다.

셀프호스팅 운영자는 공개 기준 URL을 정확히 설정하고 TLS 프록시가
`/.well-known/*`, `/api/auth/mcp/*`, `/oauth/authorize`, `/mcp`를 동일한 Nyxdoc
인스턴스로 전달하도록 해야 한다.

## 현재 제한

- DCR과 PKCE는 지원하지만 CIMD는 아직 지원하지 않는다.
- OAuth 승인 UI는 워크스페이스 접근 프로필을 선택한다. 문서 하위 트리와 사용자 지정
  capability는 연결 후 워크스페이스 설정에서 조정한다.
- OAuth token 자체를 사람이 복사하거나 다시 표시하는 UI는 제공하지 않는다.
