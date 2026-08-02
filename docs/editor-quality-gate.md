# Nyxdoc editor quality gate

상태: **P0 기본기 통과**  
최종 실행일: 2026-07-17

이 문서는 사용자가 누락 기능을 하나씩 발견한 뒤 고치는 방식을 반복하지 않기 위한
편집기 출시 체크리스트다. 구현 함수의 존재가 아니라 실제 브라우저 조작 후 저장되는
Nyxdoc AST를 기준으로 판정한다.

## 기준으로 삼은 제품과 엔진

하나의 제품을 그대로 복제하지 않고, 사람들이 이미 익숙한 편집기의 공통 계약을
Nyxdoc의 P0로 묶었다.

- [Notion 키보드 단축키](https://www.notion.com/help/keyboard-shortcuts): Markdown 입력 규칙,
  `/` 명령, 목록과 블록 중심 조작
- [Confluence 편집기 단축키](https://support.atlassian.com/confluence-cloud/docs/keyboard-shortcuts-markdown-and-autocomplete/):
  서식, 표, 자동 완성과 키보드 접근
- [Tiptap 표 명령](https://tiptap.dev/docs/editor/extensions/nodes/table): 표 삽입·행/열
  추가/삭제·표 삭제·셀 병합/분할·탐색
- [Plate 표 기능](https://next.platejs.org/docs/table): 셀 범위 선택, 복사/붙여넣기,
  병합/분할, 키보드 이동과 정규화
- [Lexical 저장소와 테스트](https://github.com/facebook/lexical): 단위 테스트와 실제 Chromium
  E2E를 함께 두는 편집기 회귀 전략

## 자동 출시 게이트

| 영역 | 사용자 계약 | 검증 위치 | 상태 |
|---|---|---|---|
| 입력 | Enter와 Shift+Enter가 블록/줄바꿈 의미를 보존한다 | `e2e/editor.spec.ts` | 통과 |
| 선택·서식 | 선택 범위에 글자 크기, 굵게, 기울임, 밑줄, 취소선, 코드, 색을 적용한다 | `e2e/editor.spec.ts` | 통과 |
| 선택 동기화 | 선택 직후 툴바나 단축키를 눌러도 DOM 선택과 Plate 선택이 어긋나지 않는다 | `e2e/editor.spec.ts` | 통과 |
| 문단 | H1~H3/본문 계열 변환과 정렬 후에도 블록 ID가 유지된다 | E2E + `schema.test.ts` | 통과 |
| 링크 | 링크 생성·주소 수정·해제가 표시 문자열을 바꾸지 않는다 | E2E + `commands.test.ts` | 통과 |
| 단축키 | `Ctrl/⌘+S`, 서식, 링크, 본문/H1~H3, 목록, 블록 복제·이동, 실행 취소를 실제 키 입력으로 검증한다 | `e2e/editor.spec.ts` | 통과 |
| 단축키 안내 | 현재 구현된 키만 도움말에 표시하고 미지원 블록을 지원하는 것처럼 안내하지 않는다 | `e2e/editor.spec.ts` | 통과 |
| 목록 | `- ` 입력, Enter 연속 작성, Tab 중첩이 AST에 반영된다 | `e2e/editor.spec.ts` | 통과 |
| 슬래시 명령 | 빈 최상위 문단에서 `/`를 열고 메뉴 선택으로 블록을 만든다 | `e2e/editor.spec.ts` | 통과 |
| 이미지 | 클립보드 이미지를 multipart 바이너리로 올리고 내부 미디어 링크만 저장한다 | E2E + `media/service.test.ts` | 통과 |
| 작업 첨부 | Agent To-do 설명·완료 조건에 붙인 이미지를 업로드하고 media 참조만 저장한다 | `e2e/workspace.spec.ts` + `tasks/service.test.ts` | 통과 |
| 표 범위 | 마우스 드래그로 여러 셀을 선택하고 범위가 시각적으로 표시된다 | `e2e/editor.spec.ts` | 통과 |
| 표 구조 | 행/열 추가·삭제, 셀 병합·분할, 표 전체 삭제가 가능하다 | E2E + `commands.test.ts` | 통과 |
| 표 복구 | 표 삭제를 실행 취소/다시 실행하고 뒤 문단과 커서를 보존한다 | E2E + `commands.test.ts` | 통과 |
| 경계 | 표 뒤 빈 문단에 키보드로 접근해 목록이나 명령을 시작할 수 있다 | `e2e/editor.spec.ts` | 통과 |
| 저장 계약 | 허용 노드·속성·ID·미디어 URL만 수락하고 알 수 없는 값은 거절한다 | `schema.test.ts` | 통과 |
| 단일 계약 | 생성·수정·조회·검색이 AST v2 `content`와 canonical `nodeType`만 사용한다 | `schemas.test.ts` + `server.test.ts` | 통과 |
| 접근성 | 핵심 툴바와 입력을 역할과 접근 가능한 이름으로 조작할 수 있다 | role 기반 E2E | 통과 |
| 리비전 조회 | 과거 리비전 보기는 읽기 전용이며 명시적 복원 전에는 쓰기 요청을 만들지 않는다 | `e2e/workspace.spec.ts` + `service.test.ts` | 통과 |
| 공유 초안 | Yjs 초안은 입력 중 자동 보존되고 두 브라우저·재접속 사이에 동기화되지만 정본 리비전은 만들지 않는다 | 실제 브라우저 2세션 + `collaboration/commands.test.ts` | 통과 |
| 명시적 확정 | `Ctrl/⌘+S`, 저장 버튼 또는 에이전트 `commit_document`만 정본 리비전을 만들며 오프라인 저장은 예약하지 않는다 | 실제 브라우저 온라인/오프라인 + `collaboration/commands.test.ts` | 통과 |
| CRDT 초기화 | 서버만 Yjs 문서를 시드해 IndexedDB와 서버의 같은 정본이 중복 병합되지 않는다 | 실제 브라우저 신규 세션 + `collaboration/commands.test.ts` | 통과 |
| 과거 복원 | 과거 리비전은 공유 초안으로만 불러오고, 별도의 명시적 저장 전까지 리비전 번호가 고정된다 | `e2e/workspace.spec.ts` + 실제 브라우저 | 통과 |
| 사이트 설정 | 전역 사이트 관리와 워크스페이스 설정을 분리하고 비밀값을 API payload에 포함하지 않는다 | `e2e/settings.spec.ts` + `site-settings/service.test.ts` | 통과 |

브라우저 시나리오는 Windows에서 설치된 Chrome과 Edge에 각각 동일하게 실행한다.
비 Windows 환경에서는 설치된 Playwright Chromium 프로젝트 하나를 실행한다.

```bash
npm run typecheck
npm run lint
npm test
npm run test:editor-e2e
npm run build
```

## 이번 게이트가 잡아낸 실제 회귀

- 표 전체를 없앨 수 있는 UI가 없었다.
- 마지막 행/열만 삭제할 때 한 칸짜리 표와 뒤 문단을 안전하게 처리해야 했다.
- 링크 입력의 브라우저 기본 URL 검증이 `nyxdoc.com/...` 정규화보다 먼저 막았다.
- 포커스를 가져가는 선택 상자가 텍스트 선택 범위를 잃을 수 있었다.
- 텍스트를 선택한 직후 툴바나 단축키를 빠르게 누르면 브라우저 DOM 선택과 Plate 내부 선택이
  잠시 어긋날 수 있었다. 실행 직전과 마우스·키보드 선택 종료 시 두 범위를 동기화한다.
- 기본 Blockquote 플러그인은 인용 안에 문단을 중첩하지만 Nyxdoc AST는 평면 인용 블록을
  사용한다. 전용 평면 플러그인과 실제 스키마 검증으로 교체했다.
- `Shift+숫자`가 키보드 레이아웃에 따라 `1`이 아니라 `!`로 보고되어 제목 단축키가
  빠질 수 있었다. 물리 키 코드와 문자 값을 함께 해석한다.
- 변경 기록의 과거 항목이 곧바로 정본 복원을 실행해, 단순 조회도 리비전을 늘리는 것처럼
  보였다. 읽기 전용 미리보기와 공유 초안 불러오기를 분리하고, 명시적 저장 때만 새
  리비전이 생기도록 고쳤다.
- 브라우저와 서버가 같은 정본을 서로 다른 Yjs 클라이언트 ID로 각각 시드하면 본문이
  두 번 합쳐질 수 있었다. 협업 서버를 유일한 초기화 주체로 고정했다.
- Yjs 바이너리는 편집 후 실행 취소해도 tombstone 이력이 남아 달라질 수 있다. 초안
  변경 여부는 CRDT 바이트가 아니라 렌더링되는 Nyxdoc 문서 계약을 비교한다.
- 표 직후 빈 문단의 `/`가 이전 셀의 마지막 글자를 같은 문단의 앞 글자로 오인했다.
- 슬래시 메뉴를 마우스로 누를 때 입력 blur가 명령 실행보다 먼저 일어났다.
- E2E가 `127.0.0.1`로 접속하면 Next 개발 서버의 하이드레이션 없이 SSR 화면만
  조작할 수 있었다. 테스트는 `localhost`와 명시적인 준비 신호를 사용한다.

## 환경 수동 게이트

자동화가 운영체제 입력기나 다른 앱의 클립보드를 완전히 재현하지 못하므로 배포 전
다음 항목은 실제 브라우저에서 짧게 확인한다.

- Windows 한글 IME 조합 중 Enter, Backspace, 한/영 전환
- 캡처 도구와 메신저에서 복사한 PNG/JPEG 붙여넣기
- 긴 문서에서 툴바 고정, 표 가로 스크롤, 읽기/편집 줄 간격
- 키보드만으로 서식, 목록, 표 뒤 문단, 저장과 닫기 접근

Firefox·Safari, 블록 드래그 이동, 표 머리글 전환, 대형 문서 성능은 별도 호환성
게이트다. 현재 기본기 통과를 과장하지 않도록 이 범위는 P0 자동 통과 수치에 포함하지 않는다.
