# Lightweight Nyxdoc connections

Nyxdoc 0.25.22 supports compact MCP and a standalone CLI. All existing
operations remain available, with schemas loaded only when needed.

## Compact MCP

Use your normal MCP URL with `profile=compact`:

```text
https://YOUR-NYXDOC-HOST/mcp?profile=compact
https://YOUR-NYXDOC-HOST/mcp?profile=compact&workspace=WORKSPACE-ID
```

Authentication and workspace routing are unchanged. New settings handoffs
use compact mode. URLs without a profile, or with `profile=full`, keep the
original native tool surface for existing integrations.

- `nyxdoc_discover`: search names/descriptions, or inspect an exact operation.
- `nyxdoc_read`: execute a read-only operation.
- `nyxdoc_write`: execute a non-destructive write.
- `nyxdoc_destructive`: execute a destructive operation.

First call `nyxdoc_discover({operation:"list_agent_workspaces"})`, then
`nyxdoc_read({operation:"list_agent_workspaces",args:{}})`.
Use the returned `inputSchema`, `workflow` and `tool` for other operations.
Search uses English operation names and descriptions; results are bounded
and paginated through `offset`. Only exact operation inspection returns a schema.

All original schemas and guarded handlers are reused. Credential permissions,
document-tree scope, requestId, draftVersion, sectionHash and explicit commits
still apply. Discovery does not grant access or start an Agent To-do.
The regression gate keeps initial definitions plus instructions below 5,000
UTF-8 bytes and below 7% of full mode. These are wire bytes, not model tokens
or total task savings; host lazy loading/caching affects actual context use.

## Standalone CLI

Requires Node.js 22+. `cli/nyxdoc.mjs` has no third-party dependencies. Copy it
from a versioned checkout and run it directly:

```sh
export NYXDOC_MCP_URL='https://YOUR-NYXDOC-HOST/mcp?workspace=WORKSPACE-ID'
# Supply NYXDOC_MCP_BEARER_TOKEN through your environment/secret store.
node cli/nyxdoc.mjs status
node cli/nyxdoc.mjs discover 'search documents'
node cli/nyxdoc.mjs inspect search_documents
node cli/nyxdoc.mjs call search_documents --file args.json
```

PowerShell uses `$env:NYXDOC_MCP_URL='https://YOUR-NYXDOC-HOST/mcp'`.
The CLI selects compact mode and preserves workspace routing. Use an existing
connection key. It accepts valid OAuth access tokens but does not implement
browser login or refresh; use an OAuth-capable MCP client for that workflow.
Non-loopback endpoints require HTTPS, and redirects are rejected.

`--args` accepts a JSON object; `--file` avoids shell quoting and long arguments.
`--out result.json` saves a long result and prints only its path. Output uses
structuredContent once. Errors exit nonzero. Inspect operations before use.
Re-read after conflicts. A timeout does not prove a write failed: inspect state
or retry with the same requestId, never a new ID for the same uncertain write.

## Small agent skill

Install [skills/nyxdoc/SKILL.md](../../skills/nyxdoc/SKILL.md) in the agent's
skill directory. Make `nyxdoc` invoke the CLI, or replace its entrypoint command
with the absolute CLI path. It loads only relevant operation instructions.

Verify the CLI first, then disable automatic full Nyxdoc MCP registration and
start a new conversation. Keep the CLI URL and credential independently of
that disabled entry. Only the short skill description needs to remain
discoverable during unrelated work. Shell-less clients should use compact MCP.
Do not register both full and compact profiles for the same server.
