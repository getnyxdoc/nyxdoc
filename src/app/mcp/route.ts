import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { auth } from "@/lib/auth";
import { getAuthBaseUrl } from "@/lib/config";
import { sqlite } from "@/lib/db/client";
import { requestClientIp } from "@/lib/http/client-ip";
import { McpOAuthError, resolveMcpOAuthIdentity } from "@/lib/mcp/oauth";
import { createNyxdocMcpServer } from "@/lib/mcp/server";
import {
  ApiTokenError,
  authenticateApiToken,
  type ApiTokenIdentity,
} from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authFailure(error: unknown) {
  const message = error instanceof ApiTokenError || error instanceof McpOAuthError
    ? error.message
    : "MCP authentication failed.";
  const resourceMetadata = `${getAuthBaseUrl().replace(/\/$/, "")}/.well-known/oauth-protected-resource`;
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="nyxdoc-mcp", resource_metadata="${resourceMetadata}"`,
        "Access-Control-Expose-Headers": "WWW-Authenticate",
        "Cache-Control": "no-store",
      },
    },
  );
}

async function authenticateMcpRequest(
  request: Request,
  workspaceId: string | null,
): Promise<ApiTokenIdentity> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? "";
  const clientIp = requestClientIp(request);
  if (bearer.startsWith("nyx_live_")) {
    return authenticateApiToken(sqlite, authorization, { workspaceId, clientIp });
  }
  const oauthSession = await auth.api.getMcpSession({
    request,
    headers: request.headers,
    asResponse: false,
  });
  if (!oauthSession) {
    throw new McpOAuthError("UNAUTHORIZED", "A valid Bearer connection key or OAuth session is required.");
  }
  return resolveMcpOAuthIdentity(sqlite, {
    userId: oauthSession.userId,
    clientId: oauthSession.clientId,
    tokenScopes: oauthSession.scopes,
    workspaceId,
    clientIp,
  });
}

async function handle(request: Request) {
  let identity: ApiTokenIdentity;
  try {
    const url = new URL(request.url);
    identity = await authenticateMcpRequest(
      request,
      request.headers.get("x-nyxdoc-workspace-id") || url.searchParams.get("workspace"),
    );
  } catch (error) {
    return authFailure(error);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createNyxdocMcpServer(sqlite, identity);
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Vary", "Authorization");
  return response;
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": [
        "Authorization",
        "Content-Type",
        "Mcp-Protocol-Version",
        "Mcp-Session-Id",
        "X-Nyxdoc-Workspace-Id",
      ].join(", "),
      "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
      "Access-Control-Max-Age": "86400",
    },
  });
}
