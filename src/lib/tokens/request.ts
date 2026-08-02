import { requestClientIp } from "@/lib/http/client-ip";
import type { NyxDatabase } from "@/lib/db/client";
import { authenticateApiToken } from "@/lib/tokens/service";

export function authenticateRequestApiToken(database: NyxDatabase, request: Request) {
  const url = new URL(request.url);
  return authenticateApiToken(database, request.headers.get("authorization"), {
    workspaceId: request.headers.get("x-nyxdoc-workspace-id") || url.searchParams.get("workspace"),
    clientIp: requestClientIp(request),
  });
}
