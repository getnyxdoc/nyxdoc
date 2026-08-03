import { z } from "zod";

/**
 * The global identity stored in `agents.id`.
 *
 * It identifies the same agent across every workspace. It is deliberately an
 * opaque stable ID: migrated identities can retain values such as
 * `legacy-agent-<uuid>` instead of being rewritten as UUIDs.
 */
export type AgentIdentityId = string;

/**
 * The workspace-local access grant stored in `workspace_agents.id`.
 *
 * A grant belongs to exactly one workspace and is the ID used by document
 * assignments. It is not interchangeable with an AgentIdentityId, even when
 * a legacy migration happened to give both records the same string value.
 */
export type WorkspaceAgentGrantId = string;

function opaqueStableIdSchema(maxLength: number) {
  return z.string().trim().min(1).max(maxLength);
}

export const agentIdentityIdSchema = opaqueStableIdSchema(128).describe(
  "Global AgentIdentityId (agents.id). Opaque stable ID; UUID and legacy-agent-* values are valid.",
);

export const workspaceAgentGrantIdSchema = opaqueStableIdSchema(160).describe(
  "WorkspaceAgentGrantId (workspace_agents.id). Opaque workspace-local grant ID used for assignments; UUID and legacy-agent-* values are valid.",
);
