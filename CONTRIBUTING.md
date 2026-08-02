# Contributing to Nyxdoc

Thank you for helping make documents work better for people and their agents.

## Before you start

- Search existing issues before opening a new one.
- For a substantial feature or data-model change, open an issue first so the
  direction and migration boundary can be discussed.
- Never include real connection keys, passwords, private documents, database
  files, or production logs in an issue or pull request.

## Development

Nyxdoc uses Node.js 24 and npm.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Before submitting a change, run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Editor changes should also pass:

```bash
npm run test:editor-e2e
```

Add or update tests for behavior changes. Database changes must be forward-only
app migrations and must preserve existing user data unless the change is
explicitly documented as destructive.

## Pull requests

Keep a pull request focused, explain the user-facing outcome, and call out:

- schema or migration effects;
- authentication, authorization, or secret-handling changes;
- editor document-contract changes; and
- deployment or environment-variable changes.

By submitting a contribution, you confirm that you have the right to submit it
and agree that it is provided under this repository's MIT License.
Nyxdoc does not require a separate contributor license agreement or sign-off
line.

The project is maintained on a best-effort basis. Review and release timing are
not guaranteed.
