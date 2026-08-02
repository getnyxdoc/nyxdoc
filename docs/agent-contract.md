# External agent contract

Nyxdoc에는 내장 에이전트가 없다. Codex, OpenClaw, Claude Code 같은 외부 에이전트가
Bearer 연결 키 또는 OAuth 2.1로 설치한 Nyxdoc의 `/mcp`를 사용한다. REST `/api/v1`은
Bearer 연결 키를 사용한다. 연결 직후
`get_capabilities`의 기본 `summary` 프로필을 호출한 결과가 기능·제한의 정본이다. 전체 AST
스키마는 실제로 필요할 때만 `get_schema`로 조회한다.

## MCP 도구

### 발견과 조회

- `get_capabilities`: 기본은 작은 `summary`. 필요할 때 `document`, `tasks`, `full` 프로필 선택.
  JSON Schema는 기본 응답에 포함하지 않음
- `get_schema`: `document_content` 또는 `patch_operation` 스키마를 명시적으로 조회
- `list_documents`: 트리·유형·상태·태그·수정일 필터와 페이지네이션
- `get_document`, `batch_get_documents`: 현재 불변 정본 AST v2와 리비전, 현재 에이전트의
  해당 문서 담당 역할과 기대 행동, 사람이 열 수 있는 절대 `webUrl` 조회
- `get_working_document`: 전체 AST 또는 문서 메타데이터 작업에 사용하는 Yjs 공유 초안 조회.
  글 중심의 부분 수정에는 사용하지 않음
- `get_document_outline`: 안정적인 제목 블록 ID를 `sectionId`로 사용하는 작은 문서 개요.
  `rootSectionId`, `maxDepth`로 범위를 줄이고 제목 경로·블록 범위는 필요할 때만 포함
- `get_document_markdown`: 전체 문서 또는 선택한 제목 섹션만 간결한 Markdown으로 조회
- `search_documents`: 일치 블록 ID, AST v2 `nodeType`, 문맥, 리비전과 가장 가까운
  `sectionId`·제목 경로·섹션 해시를 한 `results` 구조로 반환. 기본 경로는 `pathText`이며
  전체 경로 객체·메타데이터·태그는 선택적으로 포함
- `get_backlinks`: 현재 문서를 참조하는 문서와 원본 블록 ID
- `get_changes`: 연결별 커서 이후 사람·다른 에이전트의 변경. 명시 커서는 연결 상태를 바꾸지
  않고 미래 커서는 현재 헤드로 보정됨
- `list_agent_workspaces`: 현재 전역 에이전트와 키로 접근 가능한 워크스페이스, 멤버십 ID,
  역할·실제 허용 행동·문서 범위와 요청 선택 방법
- `get_workspace_context`, `list_workspace_agents`: 명시한 `workspaceId` 또는 연결 기본
  워크스페이스의 실제 허용 행동,
  연결 키 범위, 워크스페이스 정책, 현재 활성 담당 및 Agent To-do 요약과 공동작업 에이전트 조회
- `list_saved_views`, `run_saved_view`: 워크스페이스에 저장된 구조화 필터 실행
- `list_my_work`: 현재 에이전트에게 지정된 접근 가능한 담당 문서, 역할별 기대 행동과 진행 상태 조회
- `list_my_tasks`: 현재 선택 워크스페이스와 무관하게 이 전역 에이전트에게 할당된 모든 허용
  워크스페이스의 Agent To-do 조회. 각 항목은 `workspaceId`, `workspaceName`,
  `workspaceSlug`를 포함하며 미할당 작업은 명시적으로 요청한 경우에만 포함
- `get_task`: Task ID에서 워크스페이스를 자동 판별해 작업 이력 조회. 조회와 연결만으로
  작업을 자동 시작하지 않음
- `list_assignments`: 문서별 담당 에이전트와 역할 조회. 담당 지정은 접근 권한을 만들지 않음
- `list_trash`: 관리 에이전트가 복구 가능한 문서 트리와 자동 삭제 예정 시각 조회
- `list_revisions`, `get_revision`, `diff_revisions`: 불변 이력과 블록·메타데이터 diff
- `export_document`: Markdown 또는 Nyxdoc JSON bundle

### 쓰기

- `create_document`: `content`의 AST v2 본문으로 문서와 초기 정본 리비전 1 생성
- `update_document`: 최신 `expectedDraftVersion`을 기준으로 공유 초안 전체 상태 변경
- `patch_document`: 안정적인 최상위 블록 ID에 공유 초안 부분 수정 적용
- `patch_document_markdown`: 선택한 제목 섹션만 Markdown으로 교체. `dryRun` 미리보기와
  섹션 해시 충돌 검사를 지원하고, `commit`을 명시했을 때만 후속 정본 리비전까지 저장.
  기본 `section` 동시성에서는 대상 `sectionHash`가 같으면 오래된 관찰 `draftVersion`이어도
  관련 없는 다른 섹션 변경 위에 안전하게 다시 적용. `document` 모드는 정확한 버전을 요구
- `commit_document`: 검토한 최신 공유 초안을 명시적으로 불변 정본 리비전으로 저장
- `create_document_from_markdown`, `update_document_from_markdown`: CommonMark/GFM 편의 입력
- `capture_handoff`: 사람이 명시적으로 요청한 대화를 구조화된 인계 문서와 선택적인
  시작 전 Agent To-do로 원자적으로 보존. 대상이나 작업 분해가 불확실하면 `dryRun` 사용
- `restore_revision`: 과거 스냅샷을 검토 가능한 공유 초안으로 불러옴. 정본 저장은 별도
- `create_saved_view`, `update_saved_view`, `delete_saved_view`: 재사용할 문서 필터 관리
- `assign_document`, `update_assignment`: owner/contributor/reviewer 책임과 진행 상태 관리
- `create_task`: 명시한 `workspaceId`에 시작하지 않은 Agent To-do 생성
- `claim_task`: Task ID에서 워크스페이스를 판별하고 최신 작업 `version`을 기준으로
  현재 에이전트가 원자적으로 선점
- `report_task`: 진행률, 막힌 이유 또는 대기 복귀를 작업 이력에 기록
- `complete_task`: 결과 요약과 선택적인 불변 결과 리비전을 제출. 기본은 사람 검토 상태
- `set_presence`, `end_presence`: 현재 읽기·수정·초안·검토 위치를 45초 만료 상태로 게시
- `trash_document`: 에디터 에이전트는 최초 리비전 기준으로 자신이 모두 만든 문서 트리만
  soft delete하고, 관리 에이전트는 허용 범위의 문서 트리를 삭제. 다른 사람의 로그인 세션으로
  권한 거부를 우회하지 않음
- `restore_trashed_document`: 관리 에이전트가 삭제된 문서 트리를 복구.
  영구 삭제는 에이전트에 공개하지 않음

### 관리 요청

`admin` 에이전트도 워크스페이스 정책, 에이전트 역할, 연결 키를 직접 바꿀 수 없다.
`propose_admin_action`으로 다음 작업을 검증·미리보기한 뒤 사람의 승인을 기다린다.

- `workspace.create`, `workspace.update`
- `agent.connect`, `agent.update`
- `credential.rotate`, `credential.revoke`

요청에는 UUID `requestId`와 이유가 필요하며 같은 요청의 재시도는 하나로 합쳐진다.
요청은 7일 뒤 만료된다. 승인 전에는 상태를 바꾸지 않고, 승인 시 대상이 요청 이후
변경되었으면 실패 폐쇄한다. 새 연결 키 원문은 승인한 사람에게 한 번만 보이고 요청·감사
로그에는 저장하지 않는다. 에이전트는 `list_admin_action_requests`로 결과만 확인할 수 있고
자기 요청을 승인하거나 자기 권한을 올릴 수 없다.

웹·MCP·REST의 초안 쓰기와 commit은 같은 협업 명령 엔진을 거친다. 초안 변경은 계속
보존되지만 리비전과 변경 이벤트를 만들지 않는다. `commit_document`에서 정본 내용이 실제로
달라질 때만 후속 리비전 하나와 이벤트 하나를 만들며, 같으면 `unchanged: true`다. 새 문서 생성은
예외적으로 문서와 초기 리비전 1을 한 번에 만든다.

문서 변경 도구의 `structuredContent`는 기본 `responseMode=summary`다. 문서 ID, 리비전,
`draftVersion`, 블록 수, `contentDigest`, 변환 경고를 유지하되 전체 AST는 생략한다. 제목 개요가
필요하면 `outline`, 전체 결과가 꼭 필요하면 `full`을 명시한다.
초안 상태를 포함하는 모든 읽기·변경 응답은 최신 `draftVersion`을 최상위에 공통으로 제공한다.
`document.draftVersion`과 `workingDocument.draftVersion`은 기존 클라이언트 호환을 위해
유지하지만, 다음 쓰기의 `expectedDraftVersion`에는 최상위 값을 사용한다.

핵심 문서 읽기·검색·리비전 응답은 `resultVersion`, `operation`, `response`를 공통으로 제공한다.
`response.omittedFields`로 기본 응답에서 빠진 선택 필드를, `response.estimatedBytes`로 예상 직렬화
크기를 확인한다. 검색·outline·부분 Markdown 응답의 `next`는 권장 후속 도구를 안내하는 힌트이며,
호출 전에는 반환된 실제 ID·해시·버전을 사용해야 한다.

활성 문서를 나타내는 생성·목록·검색·조회·수정 응답에는 Nyxdoc가 공개 기준 주소와 실제
워크스페이스·문서 ID로 만든 절대 `webUrl`이 포함된다. 에이전트가 사람에게 문서 링크를
전달할 때는 이 값을 그대로 사용한다. URL 모양을 추측하거나 로그인된 브라우저를 열어 주소를
알아내지 않는다. `webUrl`을 알고 있다는 사실은 별도 접근 권한을 만들지 않는다.

문서의 `title`은 본문과 분리된 페이지 메타데이터이며 화면에서 유일한 최상위 페이지 제목으로
표시된다. AST `content`와 Markdown은 본문만 담는다. 본문 첫 H1이나 다른 제목 블록에 같은
페이지 제목을 다시 쓰지 않는다. 본문은 도입 문단으로 시작하거나 첫 하위 절을 H2 이하로 쓴다.

## 안전한 쓰기 순서

1. 연결하면 워크스페이스 선택과 무관한 `list_my_tasks`로 전역 에이전트의 유한 작업을 확인하고,
   문서 작업을 시작할 워크스페이스에서 `get_workspace_context`, `list_my_work`로 장기 담당을
   확인한다. 연결, 목록 조회, 상세 읽기 또는 발견만으로 작업을 시작하지 않는다.
2. 사람이 Nyxdoc Agent To-do 처리를 명시적으로 요청했다면 `claim_task`로 하나를 선점한다.
   그런 요청이 없으면 대기하며 해당 To-do를 위해 문서를 변경하지 않는다.
3. 검색 또는 `get_document_outline`으로 대상 문서·섹션을 찾고
   `get_document_markdown(sectionId)`으로 대상 섹션만 읽는다. AST 조작이 필요할 때만
   `get_working_document`로 전체 공유 초안을 읽는다. 읽기 도구는 `draftVersion`을 바꾸지 않는다.
4. 글 중심의 부분 변경은 `patch_document_markdown`, 블록 수준 변경은 `patch_document`,
   전체 재작성만 `update_document`를 사용한다.
5. 관찰한 `draftVersion`과 선택 섹션의 `sectionHash`를 함께 보내고, 먼저 `dryRun`으로 결과를
   확인한다. 기본 `section` 모드에서는 해시가 대상 범위의 전제조건이고 버전은 문서 관찰값이다.
   다른 섹션만 바뀌었다면 서버가 현재 초안에 안전하게 다시 적용한다.
6. 긴 작업은 `report_task`로 진행률 또는 막힌 이유를 기록한다.
7. 변경 결과를 다시 읽고 검토한 뒤에만 `commit_document`를 호출하거나
   `patch_document_markdown.commit`을 명시한다.
8. `complete_task`에 결과 요약과 결과 문서·리비전을 제출한다.
9. 모든 에이전트 쓰기에 연결 안에서 유일한 8~128자 `requestId`를 보내고 재시도 시 그대로 사용한다.
10. 같은 `requestId`와 같은 요청은 최초 결과를 돌려준다. 다른 요청에 재사용하면
   `IDEMPOTENCY_CONFLICT`다.
11. `DRAFT_CONFLICT`이면 최신 작업본을 다시 읽고 의도를 적용한다. `REVISION_CONFLICT`이면
   다른 정본 저장이 먼저 일어난 것이므로 현재 정본과 초안을 함께 검토한다. 서버는 rich AST를
   조용히 자동 병합하지 않는다.

`patch_document` 연산은 `replace_block`, `insert_before`, `insert_after`, `delete_block`,
`move_before`, `move_after`다. 한 호출의 연산은 순서대로 공유 초안에 적용되고 리비전을 만들지 않는다.
현재 patch 경계는 최상위 블록이다. 표 셀 변경은 해당 `table` 블록을 교체한다.

## AST v2

정본 본문은 다음 모양이다.

```json
{
  "schemaVersion": 2,
  "blocks": [
    {
      "id": "stable-block-id",
      "type": "p",
      "children": [
        { "text": "사람과 ", "bold": true },
        {
          "type": "doc_ref",
          "documentId": "00000000-0000-4000-8000-000000000000",
          "children": [{ "text": "관련 문서" }]
        }
      ]
    }
  ]
}
```

문서 읽기 응답의 본문 필드는 `content` 하나뿐이다. 생성도 `content`를 필수로 받고,
전체 수정은 선택적인 `content`로 본문을 교체한다. 별도의 평면 `blocks`, `blockType`,
`contentSchemaVersion` 호환 필드는 제공하지 않는다. 스키마 버전은 `content.schemaVersion`이
유일한 기준이다.
쓰기 도구와 `get_capabilities`는 이 구조의 전체 JSON Schema, 제한과 예시를 함께 공개한다.

- 최상위: `p`, `h1`, `h2`, `h3`, `h4`, `h5`, `h6`, `blockquote`, `callout`, `hr`, `img`, `code_block`, `table`
- 중첩: `code_line`, `tr`, `td`, `th`
- 인라인: text, `a`, `doc_ref`
- text mark: bold, italic, underline, strikethrough, code, fontSize, color, backgroundColor
- 문단 속성: align, indent, listStyleType, checked

일반 `a`는 제어 문자가 없는 절대 HTTP/HTTPS URL만 허용한다. Nyxdoc 내부 문서는 URL
스킴을 일반 링크에 넣지 않고 `doc_ref`로 표현한다.

이미지는 base64가 아니라 미디어 ID와 인증 링크만 저장한다. 에이전트는 이미지 바이트를
MCP JSON에 넣지 않고 다음 절차를 사용한다.

1. `create_image_upload`에 파일명과 선택적인 대상 `documentId`, MIME, 바이트 수,
   SHA-256, 대체 텍스트를 보낸다. 문서 ID가 있으면 워크스페이스를 자동 판별한다.
2. 반환된 5분 유효·일회용 URL로 이미지 원본 바이트를 그대로 `PUT`한다. multipart나
   base64로 감싸지 않고 반환된 `Authorization: NyxUpload ...` 헤더를 사용한다.
3. 성공 응답의 `imageBlock`을 `patch_document` 또는 문서 생성 도구에 넣는다.

업로드 권한은 발급한 연결 키·워크스페이스·선택한 문서에 묶이며, 사용 시점에도 연결 키와
멤버십의 활성 상태, `documents:write`, `documents.update`, `media.upload`, 문서 트리 범위를
다시 확인한다. 한 번 사용했거나 만료된 URL은 다시 쓸 수 없다. 일회용 Authorization 값은
문서·로그·답변에 저장하거나 재표시하지 않는다. 파일은 15MB 이하 PNG/JPEG/GIF/WebP만
허용하고, 선언한 크기·MIME·SHA-256이 있으면 실제 디코딩한 이미지와 일치해야 한다.

업로드 성공 응답은 바로 삽입할 수 있는 다음 형태의 블록을 포함한다.

```json
{
  "id": "image-block",
  "type": "img",
  "mediaId": "00000000-0000-4000-8000-000000000000",
  "url": "/api/media/00000000-0000-4000-8000-000000000000",
  "alt": "화면 설명",
  "children": [{ "text": "" }]
}
```

## 문서 트리와 메타데이터

문서는 폴더를 겸한다. `parentDocumentId: null`은 워크스페이스 최상위이고 문서 아래에
다른 문서를 둘 수 있다. 최소 메타데이터는 다음과 같다.

- `documentType`: 사용자가 정하는 문서 유형 또는 `null`
- `workflowStatus`: `draft | review | final`
- `tags`: 최대 30개

내부 링크는 `doc_ref`로 저장되고 `get_backlinks`에서 역방향으로 찾는다. 워크스페이스의
에이전트 멤버십에 루트 문서를 정하면 해당 문서와 하위 트리만 읽고 쓸 수 있다. 범위 제한 연결이 최상위 생성을
요청하면 허용된 루트 아래에 생성된다. `revisions:restore`는 별도로 선택해야 하는 권한이다.

담당 지정은 책임 정보이고 권한이 아니다. 실제 접근은 항상 키 scope·허용 워크스페이스·IP
제한, 워크스페이스 멤버십의 역할·세부 허용/제외, 선택적 루트 문서 범위의 교집합으로 계산한다.
내장 역할은 누적 권한 묶음인 `admin | editor | viewer`이며
관리 에이전트도 키 발급·권한 상승·영구 삭제·백업 실행 권한을 직접 갖지 않는다.

담당 역할은 에이전트에게 다음 기대 행동을 전달한다.

- `owner` (`주 담당`): 문서의 목표와 상태를 파악하고 작업을 주도하며 협업·검토를 조율해 완료까지 책임
- `contributor` (`공동 작업`): 지정 메모와 문서 상태에 따라 맡은 내용을 작성·수정·보완하고 결과를 기록
- `reviewer` (`검토`): 정확성·누락·일관성과 목적 부합 여부를 확인하고 검토 결과와 수정 사항을 기록

이 역할은 MCP 초기 지침에 포함된다. `get_workspace_context`는 활성 담당 업무를 최대 20개까지
요약하고, 전체 조회는 `list_my_work`를 사용한다. `get_document`, `get_working_document`,
`batch_get_documents`는 현재 에이전트의 접근 가능한 활성 담당만 `myWork`로 함께 반환한다.
담당이 없거나 담당 읽기 권한이 없어도 문서 권한 자체는 별도로 계산된다.

Agent To-do는 담당과 별도의 유한 문서 요청이다. 기본 상태 `ready`는 화면의 **To-do**이며,
선점 뒤 `in_progress`, 막히면 `blocked`, 결과 제출 뒤 기본적으로 사람이 확인하는
`review`(화면의 **확인 필요**), 사람 확인 뒤 `completed`로 이동한다.
작업에는 설명·완료 조건·우선순위·대상 문서·담당 에이전트·진행률·결과 요약과 결과 리비전을
기록할 수 있다. 미할당 작업은 접근 가능한 에이전트가 선점할 수 있지만 작업 자체가 문서
접근 권한을 만들지는 않는다. 문서 하위 범위 키에는 그 범위 안의 대상 문서가 있는 작업만
노출되고, 모든 변경은 작업 이력과 감사 로그에 남는다.

문서 삭제는 현재 리비전과 하위 트리를 한 묶음으로 휴지통에 옮긴다. 기본 보존 기간은
30일이며 원래 부모·정렬 순서, 첨부·리비전·이벤트를 유지한다. 복구는 같은 트리를 되살리고,
영구 삭제는 사람만 실행할 수 있으며 직전에 검증 가능한 DB/미디어 백업을 만든다.
에디터 에이전트의 기본 `documents.trash_own` 권한은 최초 불변 리비전의 에이전트 신원을
확인하며, 트리 안에 다른 사람이 만든 하위 문서가 하나라도 있으면 전체 작업을 거부한다.
모든 문서를 지울 수 있는 `documents.trash`는 관리 에이전트에만 기본 제공한다.

실시간 협업은 Yjs CRDT 공유 초안을 사용한다. 사람은 WebSocket으로 문자 단위 변경을 교환하고,
에이전트는 같은 초안을 `expectedDraftVersion` 명령으로 안전하게 바꾼다. 초안은 서버 SQLite에
지속 저장되고 사람의 브라우저에는 IndexedDB 사본이 남는다. presence는 현재 대상 문서/블록과
진행률을, SSE는 명시적으로 확정된 새 정본 리비전을 전달한다. 오프라인 `Ctrl/⌘+S`는 대기열에
넣지 않으며 재연결 후 자동 commit하지 않는다.

## 이력과 형식 경계

리비전은 본문뿐 아니라 제목, 부모 위치, 유형, 작업 상태, 태그를 함께 고정한다. 과거 조회와
diff는 현재 리비전을 만들지 않는다. 복원도 과거 상태를 공유 초안으로 불러올 뿐이며,
검토 후 명시적 commit에서만 새 리비전을 만든다.

- Nyxdoc AST v2: 저장·읽기 정본
- Markdown: CommonMark/GFM 편의 입출력. 정렬·색·글자 크기 같은 일부 서식은 손실될 수 있음
- Nyxdoc JSON bundle: 노드 ID, 메타데이터, 내부 링크, 미디어 참조를 보존하는 현재 상태 내보내기

Markdown 내부 문서 링크는 `nyxdoc://document/{uuid}`, 이미지는 미리 업로드된
`/api/media/{uuid}`를 사용한다. 새 이미지는 먼저 `create_image_upload` 흐름으로 올린다.
Markdown 가져오기 도구는 `requestId`를 요구하며 같은
요청의 새 노드 ID를 결정적으로 만들어 안전하게 재시도할 수 있다. 이미지 대체 텍스트와
인용문과 H1~H6 제목 단계는 왕복 보존한다. 표현할 수 없는 향후 변환이 생기면
`conversionWarnings`에 명시적으로 반환한다.

Markdown 직렬화는 의미가 같은 비순서 목록 표식을 `*`로 통일하고 주변 빈 줄과 표 정렬 공백을
정규화할 수 있다. `sectionHash`는 노드 ID를 제외한 섹션 AST의 의미 기반 SHA-256이다. 텍스트,
제목 단계, 목록 종류, 코드 언어와 내용, 링크 대상, 자동 제목 여부는 해시에 포함된다.

## 콘텐츠와 접근 보안

Nyxdoc는 문서 내용을 비밀번호·토큰 패턴으로 임의 판정하거나 차단하지 않는다. 어떤 내용을
기록할지는 사용자와 조직의 정책이다. 플랫폼은 인증, 워크스페이스 멤버십, 역할·세부 권한,
문서 트리 범위, 연결 키 상한과 IP/CIDR 제한을 일관되게 적용해 권한 없는 접근을 막는다.

## 연결 설정

하나의 키는 전역 에이전트를 인증하고 여러 워크스페이스에서 사용할 수 있다. 키에 기본
워크스페이스가 있으면 다음 설정만으로 연결된다. URL의 `?workspace=<workspace-id>` 또는
`x-nyxdoc-workspace-id` 헤더는 연결 기본값을 바꿀 뿐, 연결을 그 워크스페이스 하나로
제한하지 않는다. 연결 후 `list_agent_workspaces`로 허용된 목록을 확인한다.

`get_document`, 수정·commit·리비전처럼 문서 ID가 있는 도구는 문서에서 워크스페이스를
자동 판별한다. `run_saved_view`, `update_saved_view`, `delete_saved_view`와
`update_assignment`도 각 리소스 ID에서 판별한다. `list_documents`, `search_documents`,
`create_document`, `get_changes`, 워크스페이스 컨텍스트·관리·담당 목록처럼 대상이 모호한
도구는 `workspaceId`를 받으며, 생략했을 때만 연결 기본값을 사용한다. 부모 문서가 있는 생성은
부모 문서에서 워크스페이스를 추론한다. `batch_get_documents`는 서로 다른 허용
워크스페이스의 문서를 한 번에 읽을 수 있다.

`list_my_tasks`는 전역 에이전트 기준으로 허용된 모든 워크스페이스를 조회하고,
`get_task`, `claim_task`, `report_task`, `complete_task`는 Task ID에서 워크스페이스를
판별한다. 사람 브라우저에서 현재 열어둔 워크스페이스는 이 라우팅에 관여하지 않는다. 모든
호출은 키의 허용 워크스페이스·IP/CIDR 제한과 대상 워크스페이스의 최신 활성 멤버십·역할·문서
범위를 다시 통과해야 한다.

```json
{
  "url": "https://docs.example.com/mcp",
  "transport": "streamable-http",
  "headers": { "Authorization": "Bearer <NYXDOC_TOKEN>" }
}
```

Codex에서는 토큰을 환경 변수에 둔다.

```toml
[mcp_servers.nyxdoc]
url = "https://docs.example.com/mcp"
bearer_token_env_var = "NYXDOC_TOKEN"
```

OAuth를 지원하는 원격 MCP 클라이언트는 `/mcp`에서 시작해 well-known 메타데이터를
발견한다. 사용자는 로그인 후 연결할 워크스페이스와 역할을 승인한다. 자세한 계약은
[MCP OAuth](mcp/oauth.md)와 [클라이언트 호환성](mcp/compatibility.md)을 참고한다.

## REST 대응 경로

- `GET|POST /api/v1/documents`, `GET|PUT|PATCH /api/v1/documents/:id`
- `GET /api/v1/documents/:id/working`, `POST /api/v1/documents/:id/commit`
- `POST /api/v1/documents/batch`, `GET /api/v1/search`, `GET /api/v1/changes`
- `GET /api/v1/documents/:id/backlinks`
- `GET /api/v1/documents/:id/revisions`, `GET /api/v1/documents/:id/revisions/:number`
- `GET /api/v1/documents/:id/diff?from=&to=`
- `POST /api/v1/documents/:id/revisions/:number/restore`
- `POST /api/v1/import/markdown`, `PUT /api/v1/documents/:id/markdown`
- `GET /api/v1/documents/:id/export?format=markdown|nyxdoc_json`
- `GET|POST|DELETE /api/v1/presence`

연결 키 원문은 생성 직후 한 번만 보이며 프롬프트, 저장소, 셸 기록에 남기지 않는다.
