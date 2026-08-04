# Changelog

All notable user-facing changes are recorded here.

## 0.25.8 - 2026-08-04

- Resolve stable updates from canonical origin tags in a private mirror ref so
  tag-triggered CI checkouts and user-local tags cannot block or redirect the
  updater.
- Added a real Git repository regression test for a conflicting local release
  tag while preserving the user's local tag unchanged.

## 0.25.7 - 2026-08-04

- Made the isolated MCP HTTP smoke test accept a real workspace membership
  when email verification is disabled instead of requiring Better Auth's
  email-verification flag.
- Run release-candidate MCP database checks as the same unprivileged user as
  the application so SQLite WAL ownership remains consistent.
- Align the human-approved administration smoke request with the canonical
  workspace-access update contract.
- Route release-candidate media smoke requests through the internal gateway
  while preserving the public upload URL path, query, and authorization.
- Validate idempotent MCP retries through their explicit replay receipt instead
  of requiring byte-identical first-run and replay envelopes.

## 0.25.6 - 2026-08-04

- Fixed fresh-install release qualification to treat an empty optional
  existing-account email as unset and exercise first-owner sign-up with a
  generated address.

## 0.25.5 - 2026-08-04

- Fixed the isolated release harness to consume its project-directory argument
  before forwarding Docker Compose subcommands.
- Made disposable runner cleanup best-effort when container-owned backup
  evidence remains after an intentionally failed qualification run.

## 0.25.4 - 2026-08-04

- Made release qualification wait for an immutable candidate digest and image
  pull to become visible before starting isolated upgrade and browser checks.
- Always create qualification evidence before registry access so an early
  release-gate failure remains diagnosable without weakening promotion rules.

## 0.25.3 - 2026-08-04

- Made GHCR digest verification tolerate temporary registry visibility errors
  without weakening the exact-digest release gate.
- Made upgrade qualification select the newest previously published container
  image, skipping Git tags whose release never reached image promotion.

## 0.25.2 - 2026-08-04

- Centralized human and agent authorization at shared service boundaries so
  REST, MCP, collaboration, media, task, and workspace routes no longer make
  independent trust decisions.
- Made document-tree grants fail closed, preserved credential and media
  bindings across mutations, and added database constraints for invalid active
  grant roots.
- Consolidated draft, canonical revision, and MCP response projections so
  writes report one authoritative document state and stable identifiers.
- Hardened origin, OAuth, token rotation, revision restore, trash, and
  collaboration boundaries with regression tests for both current and
  preserved legacy agent identities.
- Added real HTTP and browser vertical tests plus fresh-install and historical
  database upgrade rehearsals without first-party route mocks.
- Changed public releases to build one immutable multi-architecture image,
  qualify its exact digest, and promote that same digest only after all release
  evidence passes.

## 0.25.1 - 2026-08-03

- Fixed workspace assignment and OAuth consent for agent identities preserved
  from pre-global-agent releases. Migrated IDs such as `legacy-agent-<uuid>` are
  opaque internal identifiers and are no longer rejected by UUID-only request
  validation.
- Added regression coverage for both current UUID identities and preserved
  legacy identities at the shared API validation boundary.

## 0.25.0 - 2026-08-03

- Replaced the ambiguous agent `admin | editor | viewer` model with global agent
  identities, workspace-local grants, canonical capability sets, and explicit
  credential-to-grant bindings.
- Added `reader`, `drafter`, `writer`, and `custom` access profiles while keeping
  authorization fail-closed on the stored capability set; legacy role fields are
  rejected by public agent-management and OAuth contracts.
- Made effective agent access the intersection of active identity, active workspace
  grant capabilities, active credential binding and scopes, document boundary, and
  IP allowlist. The workspace open in a human browser never affects agent routing.
- Made workspace connection setup atomic for existing and new credentials, with
  structured field-level errors and explicit reuse or creation of a grant binding.
- Preserved every active workspace binding during credential rotation instead of
  rebuilding access from the legacy allowlist mirror.
- Updated OAuth consent to select a global agent identity and workspace access
  profile, preserve an existing workspace grant on re-consent, and update only the
  OAuth credential binding.
- Made OAuth consent provider-first so a failed provider consent cannot mutate
  Nyxdoc grants, credentials, bindings, or previously issued tokens.
- Hardened inactive, revoked, tenant, organization, document, media, sharing, task,
  transfer, and collaboration boundaries around the canonical authorization model.
- Made legacy credential migration fail closed on malformed workspace allowlists
  and preserve editor revision-restore capability as a custom grant.
- Prioritized Agent To-do assignees by their effective capabilities instead of a
  legacy role label.
- Published Agent Protocol 5.0.0 and server version 0.25.0 for the breaking agent
  authorization contract.

## 0.24.1 - 2026-08-02

- Reuse legacy editor credentials in new workspace assignments by applying the
  same implicit `documents:commit` compatibility used during authentication.
- Resolve agent- or Markdown-authored `[URL](URL)` links to the public page
  title in authenticated workspace readers, keep the raw URL as a safe
  fallback, and open external links in a separate browser tab.
- Relicensed Nyxdoc from the Elastic License 2.0 to the MIT License, allowing
  unrestricted commercial use, redistribution, paid products, and hosted or
  managed services subject to the MIT notice requirement.
- Added a browser-save synchronization fence using the collaboration
  generation, acknowledged draft version, and Yjs state vector so an explicit
  save cannot silently omit the editor's latest input.
- Expire live collaboration connections at their token boundary and reject
  post-expiry updates before they can mutate the shared document.
- Seal and rotate every collaboration room both when a document tree enters
  trash and when it is restored, preserve the latest open draft for recovery,
  and reject pre-trash and trash-era room updates.
- Recheck current human and agent authorization when a draft first requests a
  document move and again inside the canonical commit transaction, including
  destination scope and permissions changed after editing.
- Return deterministic document-scoped node-ID remaps from agent writes so
  follow-up block operations can use the effective IDs safely.
- Build and verify media backups from the exact asset inventory in the SQLite
  snapshot, failing closed on missing, extra, or mismatched files.
- Let self-host operators disable all new in-app diagnostic collection and its
  UI with `NYXDOC_DIAGNOSTICS_ENABLED=false`.

## 0.23.2

- Normalize every draft-aware MCP read and mutation response to expose the
  latest `draftVersion` at the top level while retaining nested state fields.
- Let editor agents move only document trees they created to the recoverable
  trash while keeping other documents and permanent purge protected.
- Explicitly forbid agents from borrowing a person's logged-in browser session
  to bypass Nyxdoc permission decisions.
- Prepared Nyxdoc for its first public source release under the Elastic
  License 2.0 (ELv2).
- Added English, Korean, and Japanese interfaces and account locale
  preferences.
- Added secure first-owner setup, invite-only registration by default,
  one-time invitation links, and no-mail password-recovery links.
- Generalized self-host configuration and Docker Compose deployment.
- Preserved the existing workspace, agent, editor, MCP, revision, backup, and
  trash data models during the public-release migration.
- Added optional organizations with owner/admin/member roles, email or
  one-time-link invitations, flat teams, and explicit person/team workspace
  grants that do not expose documents through organization membership alone.
- Added organization-owned workspaces and agents, approved personal-agent
  BYOA, cross-organization database guards, lifecycle audit records, and
  reversible organization trash.
- Decoupled MCP routing from the browser's active workspace. One credential
  can now use every allowed workspace: resource-ID tools infer the tenant,
  ambiguous tools accept `workspaceId`, and the connection workspace is only
  a fallback default.
- Added Agent Protocol 4.7 image uploads. External agents can request a
  five-minute, single-use, workspace/document-bound upload URL, PUT raw image
  bytes outside MCP JSON, and insert the returned canonical image block without
  storing base64 in a document.
- Revalidate credential, membership, document scope, and `media.upload`
  permission when an agent upload is consumed, with decoded-image, size, MIME,
  and optional SHA-256 checks before persistence.
- Preserved collaborative editor node identities and the active caret when an
  agent-side AST replacement arrives during human editing, including inside
  table cells.
- Added an opt-in caret incident recorder with a short incident code and
  30-day structural trace retention. It records selection paths and event
  categories only, never document text, typed characters, URLs, or raw user
  agent strings.
