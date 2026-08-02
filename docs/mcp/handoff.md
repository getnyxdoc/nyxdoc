# 대화 인계

`capture_handoff`는 사람이 명시적으로 “이 대화를 Nyxdoc에 정리해줘”라고 요청했을 때,
긴 대화를 다음 에이전트가 바로 이어받을 수 있는 프로젝트 기억으로 바꾼다. 채팅 기록 자체가
정본이 되는 것이 아니라, 구조화된 Nyxdoc 문서가 정본이 된다.

## 결과

한 번의 호출로 다음을 원자적으로 만든다.

- 구조화된 인계 문서 1개와 초기 정본 리비전 1
- 선택적인 Agent To-do 0개 이상
- 재시도에 안전한 문서·작업 request ID

인계 문서는 필요한 섹션만 포함한다.

- Summary
- Background
- Decisions
- Requirements
- Acceptance Criteria
- Agent To-do
- Risks
- Open Questions
- References
- Raw Conversation(선택)

원문 대화는 기본 필수가 아니다. 다음 작업에 필요한 결정과 근거를 구조화하는 것이 우선이며,
감사나 정확한 인용이 필요한 경우에만 `rawTranscript`를 포함한다.

## 안전 규칙

- 대상 워크스페이스나 작업 분해가 불확실하면 먼저 `dryRun: true`로 미리 본다.
- 실제 호출은 문서와 To-do를 모두 만들거나 모두 만들지 않는다.
- 생성된 To-do 상태는 `ready`다. 연결 또는 생성만으로 실행을 시작하지 않는다.
- 사람에게 Nyxdoc Agent To-do 처리를 명시적으로 요청받은 에이전트만 `claim_task`를
  호출한다.
- 일반 에이전트는 자신에게 할당하거나 담당 미지정으로만 To-do를 만들 수 있다.
- 문서 scope와 `tasks.create` permission을 모두 통과해야 한다.

## 권장 흐름

1. 대화에서 결정, 요구, 완료 조건, 미결 사항과 출처를 추출한다.
2. 대상 워크스페이스와 부모 문서를 확인한다.
3. 불확실하면 `capture_handoff(dryRun=true)`로 문서·작업 계획을 검토한다.
4. 같은 안정적 `requestId`로 실제 호출한다.
5. 다음 에이전트는 `list_my_tasks`를 발견 목적으로 조회할 수 있지만, 사람이 실행을
   명시하기 전에는 기다린다.
