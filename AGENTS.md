# 운영 배포까지 완료

- 사용자 요청으로 코드를 수정하면 별도 재확인 없이 필요한 검증, 형상 반영, 정식 릴리스, 운영 배포, 실제 운영 동작 확인까지 완료한다.
- 로컬 수정이나 테스트 통과만으로 작업을 끝내지 않는다. 사용자가 운영에서 수정 결과를 확인할 수 있어야 완료다.
- 필요한 검증을 통과하면 바로 기존 정식 배포 절차를 진행한다. `docs/testing-and-release-qualification.md`의 릴리스 검증, 백업, 데이터 보존, 배포 후 확인을 생략하지 않는다.
- 사용자가 명시적으로 배포를 제외하거나 중단한 경우에는 그 지시를 우선한다. 실제 차단 사유가 있으면 완료한 범위와 막힌 지점을 정확히 보고한다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
