---
name: nyxdoc
description: Read, search, and edit documents in Nyxdoc when the user asks to work with Nyxdoc. Uses the CLI and loads individual operation schemas on demand.
---

# Nyxdoc

Use `nyxdoc` (or `node cli/nyxdoc.mjs` from the installed Nyxdoc checkout).
Connection settings are `NYXDOC_MCP_URL` and `NYXDOC_MCP_BEARER_TOKEN` in the environment. Never print the token. Run `nyxdoc status` to verify the connection when needed.

1. Find operations with `nyxdoc discover "English search terms"`.
2. Read only the needed schema and workflow with `nyxdoc inspect <operation>`.
3. Call it with `nyxdoc call <operation> --file args.json` or `--args '<JSON>'`. Use `--out result.json` for long results and read only the needed portion.

Choose the workspace with `list_agent_workspaces`; read `get_workspace_context` and `list_my_work` before document work. Pass workspaceId for list/search/create. For prose, search or read an outline, read the target Markdown section, dry-run a section patch, then apply and explicitly commit the reviewed result. Preserve requestId on retries and use the returned draftVersion and sectionHash. After a conflict, re-read. Return the server's webUrl to the user.

Connecting or listing tasks does not authorize doing them. Process Agent To-dos only when the user asks. Never bypass permission denials. Load AST schemas only for AST work.

Do not enable the full MCP server or dump the entire operation catalog to use this CLI. An unrelated task needs no Nyxdoc call.
