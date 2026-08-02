import "server-only";

import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { resolveUserWorkspace } from "@/lib/workspaces/service";

export const WORKSPACE_HEADER = "x-nyxdoc-workspace-id";

export async function requireWorkspaceSession(
  request?: Request,
  workspaceSelector?: string,
) {
  const session = await requireVerifiedSession();
  const workspace = resolveUserWorkspace(sqlite, {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  }, {
    selector: workspaceSelector ?? request?.headers.get(WORKSPACE_HEADER) ?? undefined,
  });
  return { session, workspace };
}
