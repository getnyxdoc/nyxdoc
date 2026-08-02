# Agent Protocol 4.13.0

이 파일 경로의 `v4`는 안정적인 major 계약을 뜻한다. 정확한 현재 프로토콜
버전은 MCP `get_capabilities` 응답을 정본으로 사용한다.

Nyxdoc의 AST v2는 문서 형식이고, Yjs 공유 초안은 사람과 외부 에이전트가 함께 작업하는
표면이다. 새 문서는 초기 정본 리비전 1과 함께 생성되고, 이후 정본 리비전은 초안과 분리되어
명시적인 commit에서만 만들어진다.

## 불변 조건

1. `get_document`는 불변 정본, `get_working_document`는 현재 공유 초안을 반환한다.
2. 사람과 에이전트의 수정은 같은 Yjs 초안에 합쳐지고 계속 저장된다.
3. 유휴, 종료, 재접속, 오프라인 상태는 정본 commit으로 간주하지 않는다.
4. 전체 AST 쓰기는 최신 `expectedDraftVersion`을 요구한다. 섹션 Markdown 쓰기에서는
   `sectionHash`가 대상 범위의 전제조건이고 `expectedDraftVersion`은 관찰한 문서 버전이다.
5. 문서 생성은 초기 리비전 1을 만들며, 이후에는 `commit_document` 또는 명시적인 섹션
   `commit`만 새 정본 리비전과 변경 이벤트를 만든다.
6. 모든 에이전트 변경/commit/복원은 `requestId`로 멱등하게 재시도할 수 있다.
7. 같은 `requestId`를 다른 payload에 재사용하면 `IDEMPOTENCY_CONFLICT`다.
8. 초안 버전이 오래되면 `DRAFT_CONFLICT`, 초안 기준 뒤 정본이 바뀌면
   `REVISION_CONFLICT`다.
9. 서버는 충돌한 rich AST를 조용히 자동 병합하지 않는다.
10. 웹, MCP, REST는 같은 협업 명령 엔진을 사용한다.
11. 연결 키는 전역 에이전트를 인증하며 워크스페이스에 종속되지 않는다.
12. 문서·저장 보기·담당·Task처럼 안정 ID가 있는 요청은 리소스에서 워크스페이스를 판별하고,
    목록·검색·생성처럼 모호한 요청은 명시한 `workspaceId`를 사용한다. 연결 기본값은
    `workspaceId`가 없을 때만 쓰며, 사람 브라우저의 현재 워크스페이스는 관여하지 않는다.
13. 같은 에이전트와 키라도 워크스페이스마다 역할·세부 권한·문서 범위·변경 커서가 다르다.
14. 담당 지정은 권한이 아니라 작업 책임이며, 문서 조회 응답은 현재 에이전트의 담당 역할과
    기대 행동을 `myWork`로 함께 반환한다.
15. Agent To-do는 담당 지정과 분리된 유한 문서 요청이며, 요청 자체는 문서 접근 권한을 만들지 않는다.
16. MCP 연결, 작업 목록 조회, 상세 읽기 또는 발견은 실행 신호가 아니다. 사람이 에이전트에게
    Nyxdoc Agent To-do 처리를 명시적으로 요청한 뒤 `claim_task`가 성공한 작업만 시작한다.
    명시적인 사람 요청이 없으면 에이전트는 대기한다.
17. 이미지 원본은 문서나 MCP JSON에 base64로 넣지 않는다. `create_image_upload`가 발급한
    워크스페이스·선택 문서 결합형 5분 일회용 권한으로 바이너리를 직접 `PUT`하고, 응답의
    `imageBlock`만 공유 초안에 삽입한다.

## 권장 작업 순서

1. 작은 기본 `get_capabilities`와 `list_agent_workspaces`로 현재 계약, 키 상한과 워크스페이스별
   권한을 확인한다. AST 스키마는 필요할 때만 `get_schema`로 읽는다.
2. `list_my_tasks`로 연결 기본 워크스페이스와 무관하게 전역 에이전트에게 할당된 유한 작업을
   확인하고, 대상 `workspaceId`를 지정한 `get_workspace_context`, `list_my_work`로 장기 담당을
   확인한다.
3. 사람이 Agent To-do 처리를 명시적으로 요청했다면 최신 `version`으로 `claim_task`를 호출한다.
4. 글 수정은 검색 또는 outline → 선택 섹션 Markdown 읽기 → dry-run → 섹션 patch 순서로
   수행한다. 전체 AST를 읽지 않는다.
5. AST 블록 수정에만 `get_working_document`와 `patch_document`, 전체 교체에만
   `update_document`를 사용한다.
6. 이미지가 필요하면 `create_image_upload` → 반환 URL에 원본 바이트 `PUT` → 응답의
   `imageBlock` 삽입 순서로 처리한다. 일회용 Authorization 값은 기록하거나 재표시하지 않는다.
7. 긴 작업은 `report_task`로 진행률이나 막힘을 기록한다.
8. 응답의 새 작업본을 검토하고 필요하면 추가 수정한다.
9. 사람의 요청이나 에이전트 작업 경계가 명확할 때만 `commit_document`를 호출한다.
10. `complete_task`에 결과 요약과 결과 문서·리비전을 제출한다.
11. 다른 참여자가 먼저 초안을 수정했다면 최신 작업본에 자신의 의도를 다시 적용한다.

## 부분 수정

`patch_document`는 안정적인 최상위 블록 ID를 대상으로 `replace_block`, `insert_before`,
`insert_after`, `delete_block`, `move_before`, `move_after`를 순서대로 적용한다. 표 셀처럼
중첩된 요소를 바꿀 때는 현재 계약에서 상위 `table` 블록을 교체한다. patch는 리비전을 만들지
않고 응답의 `workingDocument.draftVersion`만 전진시킨다.

`patch_document_markdown`의 기본 `section` 모드는 다른 섹션의 변경으로 `draftVersion`이
증가했더라도 대상 `sectionHash`가 같으면 현재 공유 초안 위에 안전하게 다시 적용한다. 같은 섹션이
바뀌면 현재 해시·버전과 충돌 섹션 ID를 포함한 `DRAFT_CONFLICT`를 반환한다. 정확한 문서 전체
버전 잠금이 필요하면 `concurrencyMode=document`를 사용한다.

## 응답 계약

핵심 문서 읽기·검색·리비전 도구는 `resultVersion`, `operation`, `response`가 있는 공통 응답을
사용한다. `response`에는 생략한 필드와 직렬화 예상 크기가 포함된다. 검색·outline·부분 Markdown
응답의 `next`는 다음 권장 도구와 인자 출처를 알려준다.

문서 생성·수정·commit은 여기에 `responseMode`를 더한다. 기본 `summary`는 ID, 리비전, 초안 버전,
블록 수, `contentDigest`, 경고를 중심으로 반환한다. `outline`과 `full`은 명시적으로 선택하며 전체
AST와 전체 JSON Schema는 기본 응답에 포함되지 않는다.

## 복원

`restore_revision`은 과거 스냅샷을 최신 정본을 기준으로 한 새 공유 초안 generation에 싣고
기존 연결을 종료한다. 이 시점에는 정본 번호가 바뀌지 않는다. 사용자가 내용을 확인한 뒤
`commit_document`를 호출해야 과거 내용이 새 리비전으로 확정된다.

## 형식과 변경 피드

- Nyxdoc AST v2: 손실 없는 정본·초안 본문 형식
- Markdown: 편의 입출력이며 일부 서식과 안정 ID는 손실될 수 있음
- Nyxdoc JSON bundle: ID, 미디어 참조, 메타데이터를 보존하는 이동 형식
- `get_changes`: 명시적 commit으로 생성된 정본 이벤트만 전달
- presence: 에이전트의 현재 문서·블록·상태를 45초 만료로 전달

`get_capabilities`의 제한과 `get_schema`의 JSON Schema가 이 문서보다 우선하는 실행 시점의 정본이다.
Nyxdoc는 문서 내용의 비밀 패턴을 임의 검사·차단하지 않으며, 인증·워크스페이스·역할·문서 범위로
권한 없는 접근을 통제한다.
