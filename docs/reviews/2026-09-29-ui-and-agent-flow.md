# UI and agent connection refresh

Scope: nyxdoc.com and app.nyxdoc.com, including the September 8 product-flow work
that had remained unshipped. The release retains existing authorization and
document permission boundaries.

## Behavior

- Agent management contains the current workspace's connections and permissions,
  followed by account identities and keys. Workspace settings links to this hub.
- An automatic connection wizard returns to its explicit, validated source after
  completion or cancellation. A locally opened wizard stays in Agent management.
  Legacy workspace links finish on the canonical agent page. New-workspace
  onboarding still opens the newly created workspace.
- Authentication and email verification preserve the connection destination.
- A connection's guide can be reopened. MCP and CLI/skill instructions share the
  same identity, key and permissions. Prepared access is not called a verified
  connection; users check the agent's actual document read result.
- Document actions keep assignments, history, share and save near the document.
  PDF, child creation, draft discard and bug reports are grouped under More.
  Table controls appear when the selection is inside a table.
- Dialogs contain keyboard focus, recover after request failures, and return
  focus to their trigger. One-time keys and pending changes remain protected.

## Visual direction and research

Exa was used to discover and inspect primary references on September 29, 2026:

- [Linear UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui)
  and [design refresh](https://linear.app/now/behind-the-latest-design-refresh):
  reduce competing interface chrome, use consistent action placement and quieter
  surfaces. Applied as fewer persistent buttons and a shared paper/evergreen palette.
- [web.dev animation guide](https://web.dev/articles/animations-guide): short
  transform/opacity transitions without animating layout. Landing sections animate
  once on entry; content remains visible without JavaScript.
- [Reduced motion](https://web.dev/articles/prefers-reduced-motion): skip entrance
  motion and cancel in-flight landing animations when the preference changes.
- [Claude remote MCP](https://claude.com/docs/connectors/custom/remote-mcp) and
  [Claude Code MCP](https://code.claude.com/docs/en/mcp): distinguish access setup
  from the client-side registration and verification steps.

The homepage uses concise localized headings, an app entry point, a three-step
connection overview and restrained scroll entrances. Existing self-hosting and
GitHub entry points remain available.

## Verification

Validation artifacts are local under `debug/ui-refresh-20260929/`. Release gates
must additionally qualify the exact image through the official release workflow
before production update. No production data is used by the local UI fixtures.
