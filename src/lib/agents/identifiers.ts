import { z } from "zod";

/**
 * Agent identity IDs are opaque internal identifiers.
 *
 * New identities use UUIDs, while identities migrated from the workspace-era
 * model intentionally retain values such as `legacy-agent-<uuid>`. API
 * boundaries must therefore validate their size, not reinterpret them as
 * UUID-only values.
 */
export const agentIdentityIdSchema = z.string().trim().min(1).max(128);
