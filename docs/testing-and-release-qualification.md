# Nyxdoc 테스트 및 릴리스 적격성 전략

상태: 단계적으로 적용 중인 운영 기준

이 문서는 현재 코드와 CI를 기준으로 Nyxdoc의 테스트 계층과 릴리스 판정 경계를
정의한다. 기준으로 확인한 현재 구현은 `src/test/fixture.ts`의 SQLite in-memory
fixture, `src/**/*.test.ts`의 Vitest 테스트, `e2e/`의 Playwright 테스트,
`compose.yaml`의 `app`·`collaboration`·`gateway` 구성, 그리고
`.github/workflows/ci.yml`와 `.github/workflows/release.yml`이다.

핵심 결론은 다음과 같다.

- Compose 전체가 Nyxdoc 앱 경계의 정본이다. `app`만 띄운 테스트는 배포 경로의
  정본이 아니다.
- 장기 staging VM은 탐색·재현·관찰용이다.
  상태가 누적되고 운영자가 개입할 수 있으므로 릴리스 합격의 정본으로 삼지
  않는다.
- 릴리스 lifecycle의 정본은 후보 버전마다 새로 만드는 ephemeral VM이다. 깨끗한
  호스트에서 설치, 기동, 인증, 데이터 보존, 업그레이드, 재기동, 백업 경로를
  검증하고 폐기한다.
- mocked browser 테스트는 UI 상호작용 계약을 검증할 수 있지만 릴리스 근거가
  아니다.
- 릴리스 근거는 historical fixture를 사용한 실제 HTTP/DB/auth vertical이어야
  한다. 관련 기능이면 실제 WebSocket collaboration도 포함한다.
- production에서는 데이터를 바꾸지 않는 smoke만 실행한다. 운영 smoke의 성공은
  릴리스 qualification을 대신하지 않는다.

## 현재 구조와 해석

현재 GitHub CI는 다음 작업을 실행한다.

| 작업 | 현재 검증 | 이 전략에서의 역할 |
|---|---|---|
| `test` | `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` | 빠른 정적·단위 게이트 |
| `editor-e2e` | Chromium 설치 후 `npm run test:editor-e2e` | 실제 브라우저 편집기 계약 게이트 |
| `integration` | first-party browser vertical mock guard, legacy agent 연결 회귀, MCP OAuth | 실제 HTTP/DB/auth vertical의 빠른 게이트 |
| `compose-lifecycle` | `install.sh --build` → 보존 uninstall → 재설치 → 확인된 purge | Compose 데이터 생명주기 게이트 |

Forgejo와 GitHub CI의 `integration`은 임시 SQLite DB를 만들고 실제 Next 개발
서버를 띄운다. `scripts/test-agent-connect-http.ts`는 과거 형식의 agent ID와
기존 credential을 새 workspace에 연결하는 실제 HTTP/session/DB/MCP 회귀를,
`scripts/test-mcp-oauth-http.ts`는 실제 OAuth 흐름을 검증한다. 따라서 L3의 일부
근거는 이미 PR CI에 있지만, 이 작업은 후보 Compose 이미지나 세 서비스 경계를
검증하지 않는다. `check-browser-vertical-no-first-party-mocks`
검사도 전용 browser vertical 디렉터리에만 적용되며, 현재 `e2e/`의 UI 계약
mock을 release evidence로 승격시키는 장치가 아니다.

GitHub release workflow의 `quality`도 두 실제 HTTP 회귀와 mock guard를
실행한 뒤 멀티아키텍처 이미지를 publish한다. 다만 현재 자동화에는 후보 이미지
대상 Compose vertical, historical fixture 전체 집합, ephemeral VM, 운영 smoke가
release job의 blocking 단계로 연결되어 있지 않다.
해당 VM 게이트가 실제 workflow에 연결되기 전까지는 tag가 생성되거나 이미지가
publish된 사실만으로 “완전한 릴리스 qualification”이라고 부르지 않는다.

`compose.yaml`은 단일 이미지에서 다음 세 프로세스를 묶는다.

- `app`: Next.js, Better Auth, REST/MCP, SQLite migration;
- `collaboration`: Yjs/Hocuspocus와 working draft WebSocket;
- `gateway`: 외부에 노출되는 HTTP 및 `/collaboration` 진입점.

따라서 외부 클라이언트는 gateway로 접속하고, app의
`/api/health`와 collaboration의 `/health`가 각각 정상이어야 한다. 이 세
서비스, 같은 이미지, 실제 파일 SQLite volume, 실제 환경변수를 함께 검증하는
것이 배포 계약이다.

## 테스트 계층

### L0 — 정적·빌드 검증

모든 PR과 릴리스 후보는 다음을 통과해야 한다.

```text
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

이는 타입, lint, 순수 로직, migration/build 파손을 빠르게 잡는 게이트다.
컨테이너가 실제로 기동한다는 증거는 아니므로 L2 이상을 대체하지 않는다.

### L1 — 단위·서비스 계약

`npm test`는 Node 환경의 Vitest(`vitest.config.ts`)로 실행되며, 현재 fixture는
`createTestDatabase()`로 migration을 적용한 in-memory SQLite와 검증된 테스트
사용자를 만든다. 문서/편집기 schema, block ID, 권한, agent, MCP projection,
backup/integrity, collaboration 명령과 같은 결정적 규칙을 이 계층에서 빠르게
검증한다.

L1의 원칙은 “경계를 대체한 테스트는 그 경계의 통합 증거가 아니다”이다. DB,
인증, 권한, migration의 내부 규칙을 테스트할 때 mock을 쓸 수 있지만, 해당
테스트의 이름과 보고서에 mock 범위를 드러낸다. 실제 HTTP와 세 서비스의 조합을
검증해야 하는 항목은 L3로 올린다.

### L2 — 브라우저 계약

`npm run test:editor-e2e`는 `playwright.config.ts`에 따라 기본적으로 로컬
`npm run dev`를 띄우고 `e2e/`를 Chromium으로 실행한다. 키보드 입력, selection,
편집기 AST 투영, 접근성, 레이아웃, 클라이언트 상태처럼 브라우저 자체의
상호작용을 검증하는 계층이다.

현재 `e2e/editor.spec.ts`, `e2e/workspace.spec.ts`, `e2e/settings.spec.ts`에는
`page.route(...).fulfill(...)`, `addInitScript`, local/session storage 설정,
가짜 `EventSource`가 사용된다. 이 테스트들은 의도된 UI 상태를 재현하는 데
유효하지만, 실제 Better Auth, SQLite, REST, MCP, gateway, collaboration의
결합을 통과했다는 뜻은 아니다. 따라서 L2 결과만으로 release pass를 선언하지
않는다.

### L3 — Compose vertical

릴리스 후보의 기능 근거는 Compose 경계를 통해 수집한다.

1. 후보와 동일한 이미지로 `app`, `collaboration`, `gateway`를 기동한다.
2. gateway의 `/api/health`와 collaboration의 `/health`를 확인한다.
3. 실제 HTTP 요청으로 sign-up/sign-in/session cookie 또는 bearer token을
   만들고, 실제 SQLite 파일 DB의 사용자·workspace·권한·revision을 확인한다.
4. 실제 API와 MCP 경로에서 문서 읽기/쓰기, revision, idempotency, 권한 거부,
   media, search를 검증한다. 저장 결과는 HTTP 응답뿐 아니라 DB와 재기동 후
   다시 읽어 확인한다.
5. collaboration 기능이면 gateway를 통한 실제 WebSocket 두 세션과
   commit/reset/archive 경로를 검증한다.

저장소에 이미 `scripts/test-mcp-http.ts`, `scripts/test-mcp-oauth-http.ts`,
`scripts/test-codex-e2e.ts`가 있어 실제 MCP HTTP/OAuth/Codex 경로의 출발점으로
사용할 수 있다. 현재 작업 트리의 `scripts/test-agent-connect-http.ts`도 실제
sign-up, agent/workspace 연결, DB 검증을 수행하는 HTTP 회귀 시나리오다. 이
스크립트들은 임시 문서나 admin request를 만들 수 있으므로
L3에서는 disposable DB/volume과 테스트 계정만 사용하고, production에서는
실행하지 않는다. 테스트 URL은 항상 Compose의 gateway를 가리킨다.

### L4 — Compose lifecycle

설치·업데이트 계약은 기능 테스트와 별도로 판정한다.

- `scripts/install.sh --build` 또는 후보 이미지 설치;
- `scripts/uninstall.sh` 후 data volume과 backup이 보존되는지 확인;
- 재설치 후 같은 문서, media, 사용자, revision이 보이는지 확인;
- schema migration 전후의 실제 DB integrity와 서비스 health 확인;
- `backup:create`, `backup:verify`, 격리 경로 `backup:restore` rehearsal.

현재 GitHub의 `compose-lifecycle`은 설치/보존 uninstall/재설치/purge까지
자동으로 확인한다. 이는 중요한 회귀 게이트지만, historical vertical과
후보 버전의 업그레이드 qualification 전체를 포함하지는 않는다.

## Gate matrix

| 게이트 | 환경·입력 | 현재 실행 위치 | PR/릴리스 판정 |
|---|---|---|---|
| 정적·L0/L1 | clean checkout, Node 24, in-memory SQLite | GitHub `test`, Forgejo `test`, release `quality` | PR blocking; 릴리스 필수 |
| 브라우저 계약 L2 | local dev server, Chromium | GitHub `editor-e2e` | PR blocking; 단독 release 근거 아님 |
| HTTP/DB/auth vertical 일부 | 임시 SQLite 파일, Next dev, 실제 HTTP/auth/MCP OAuth | GitHub `integration` | PR blocking; Compose/릴리스 lifecycle 대체 불가 |
| Compose lifecycle L4 | Docker Compose, 실제 volume | GitHub `compose-lifecycle` | PR blocking; 기능 vertical을 대체하지 않음 |
| Compose vertical L3 | 후보 이미지, 실제 HTTP/DB/auth, disposable volume | release qualification 절차 | 릴리스 blocking |
| long-lived staging | 누적 상태의 장기 staging VM | 운영자 수동 탐색 | advisory; 실패는 조사 신호 |
| ephemeral VM lifecycle | 후보마다 새 Linux VM, exact image/Compose/env | release qualification 절차 | 릴리스 정본·blocking |
| production smoke | 운영 endpoint와 read-only 계정 | 배포 직후/변경 후 | 안전 신호; qualification 대체 불가 |

릴리스 후보는 최소한 L0/L1, 필요한 L2, L3, L4, ephemeral VM을 통과해야 한다.
어느 한 계층의 “green”이 다른 계층의 실패를 상쇄하지 않는다. 특히 L2의
mocked browser pass나 production smoke pass만으로 L3/L4/VM 실패를 무시할 수
없다.

## Mocking 규칙

허용 범위는 테스트 계층으로 분리한다.

- L1에서는 시간, 외부 메일 전송, 외부 provider처럼 결정적 규칙과 무관한
  의존성을 mock할 수 있다. SQLite·migration·권한 계산 자체를 fake 객체로
  바꾼 테스트는 DB vertical로 보고하지 않는다.
- L2에서는 API 응답, EventSource, browser storage를 mock하여 특정 렌더링이나
  상호작용 상태를 고정할 수 있다. mock을 사용하는 spec은 그 사실과 검증하지
  않는 경계를 설명해야 한다.
- L3/L4와 ephemeral VM에서는 Nyxdoc API, Better Auth, SQLite, gateway,
  collaboration WebSocket, migration을 mock하지 않는다. test double로 받은
  `200`은 release evidence에 포함하지 않는다.
- 외부 provider가 정말 필요한 테스트는 disposable sandbox 또는 실패 가능한
  명시적 test adapter를 사용하고, “Nyxdoc 앱 경계를 통과한 결과”와 분리해
  보고한다. production secret, production DB, private document, real mail
  recipient는 어떤 계층에서도 사용하지 않는다.

## Historical fixture 정책

현재 `src/test/fixture.ts`는 매번 빈 in-memory DB에 일반적인 테스트 사용자와
personal workspace를 만드는 공통 fixture다. 이는 historical fixture 저장소가
아니다. 사건 회귀를 위해 다음 형태의 별도, 버전이 지정된 fixture bundle을
유지한다.

- 사건 ID, 발생한 release/commit, schema/migration 버전;
- 최소화·비식별화한 user/workspace/organization/agent/권한 상태;
- 문서 AST, block ID, working draft와 revision 이력, 필요한 media metadata;
- 재현 순서와 입력, 기대하는 HTTP status·DB invariant·최종 문서 상태;
- collaboration 사건이면 두 세션의 연결/변경 순서와 기대하는 commit 결과.

fixture에는 credential, bearer token, 실제 이메일, private document, 운영 DB,
운영 로그 원문을 넣지 않는다. ID·시간·randomness는 고정하거나 주입 가능하게
하여 재현성을 보장하고, migration이 바뀌면 원래 schema 버전을 보존한 뒤 명시적
변환을 거친다. 이미 고쳐졌다는 이유로 fixture를 삭제하거나 기대값을 현재
출력에 맞춰 조용히 바꾸지 않는다.

사건이 발생하면 다음 순서로 환원한다.

1. 원인 입력과 데이터를 최소 재현 가능한 synthetic fixture로 정제한다.
2. 실패를 가장 좁은 L1/L2 테스트에 먼저 고정한다.
3. 인증·DB·HTTP·Compose 경계가 원인에 포함되면 같은 fixture를 실제 L3
   vertical로 실행한다.
4. migration, restart, WebSocket 또는 release lifecycle이 원인에 포함되면
   L4/ephemeral VM 시나리오에도 추가한다.
5. 수정 후 fixture를 모든 관련 게이트에 남기고, 다음 release의 회귀 집합으로
   승격한다.

즉 사건의 최종 산출물은 “한 번 통과한 테스트”가 아니라, 재현 가능한
historical fixture와 그 사건이 침범한 경계에 대한 실제 vertical이다.

## VM 역할

### Long-lived staging VM

장기 staging VM에는 되돌릴 수 있는 오프라인 기준 스냅샷을 두어 테스트 중
상태를 자유롭게 망가뜨리고 복구할 수 있게 한다. 다음 용도로만 사용한다.

- main 또는 후보 빌드의 수동 탐색;
- 장시간 실행, 실제 브라우저, 다중 세션 collaboration, 로그·성능 관찰;
- historical fixture를 새로 다듬기 위한 재현과 디버깅;
- upgrade/restore 절차의 사전 rehearsal.

장기 VM의 volume, 환경변수, 이미지 cache, 수동 변경은 drift를 만든다. 따라서
이 VM의 green 상태는 release sign-off가 아니며, 실패도 곧바로 제품 결함으로
판정하지 않는다. 재현 결과는 clean Compose 또는 ephemeral VM에서 다시 확인한
뒤에만 release evidence로 승격한다. production data와 production secret은
절대 복사하지 않는다.

### Ephemeral release VM

각 릴리스 후보마다 새 Linux VM을 만들고, 후보 이미지 digest와 저장소의
`compose.yaml`을 함께 기록한다. 최소 lifecycle은 다음과 같다.

1. 빈 호스트에 최소 권한의 테스트 환경과 synthetic/historical fixture를
   준비한다.
2. fresh install → 두 health endpoint → 실제 auth/session → L3 vertical을
   실행한다.
3. 이전 stable 버전의 데이터가 있는 상태에서 후보 버전으로 update하고,
   migration rehearsal, restart, health, 문서·media·revision 보존을 확인한다.
4. verified backup 생성/검증과 빈 격리 경로 restore를 실행한다.
5. 필요한 collaboration WebSocket 및 MCP/OAuth vertical을 실행한다.
6. 로그, image digest, fixture ID, DB integrity 결과를 보관한 뒤 VM과 volume을
   폐기한다.

설치·업데이트가 실패하면 자동으로 production을 rollback하거나 데이터를
   덮어쓰지 않는다. 실패한 VM과 증거를 보존하고 원인을 조사한 뒤 새 VM에서
   재검증한다. 이 lifecycle이 통과하기 전에는 후보를 production에 적용하지
   않는다.

## Production smoke

Production에서는 비파괴 확인만 한다.

- gateway의 `GET /api/health`;
- collaboration host의 `GET /health`;
- 실제 공개 URL/HTTPS와 기본 응답·보안 헤더;
- 필요할 때 별도 read-only 계정으로 기존 workspace/document의 GET, 인증된
  세션 유지, read-only MCP capability 확인.

문서 생성·수정·삭제, admin request 생성, media upload, OAuth grant 발급/폐기,
migration rehearsal, backup restore, `scripts/test-mcp-http.ts` 같은 쓰기
smoke는 production에서 실행하지 않는다. smoke가 실패하면 배포 상태와
관찰 신호를 중단·조사하지만, smoke가 성공했다고 historical vertical과
ephemeral VM을 생략하지 않는다.

## 판정 기록

모든 릴리스 기록에는 최소한 다음을 남긴다: commit와 image digest, 실행한
fixture ID/버전, L0~L4 결과, ephemeral VM의 install/update/restart/restore
결과, 실패와 예외 승인, production smoke 결과. 예외 승인은 어떤 게이트를
왜 생략했는지와 후속 기한을 적어야 하며, mocked browser pass를 예외 승인으로
대체할 수 없다.
