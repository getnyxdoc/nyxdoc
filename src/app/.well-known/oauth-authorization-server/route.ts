import { auth } from "@/lib/auth";
import {
  assertRuntimeConfiguration,
  getAuthBaseUrl,
} from "@/lib/config";
import { MCP_OAUTH_SCOPES } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  assertRuntimeConfiguration();
  const metadata = await auth.api.getMcpOAuthConfig({
    request,
    asResponse: false,
  });
  return Response.json(
    {
      ...metadata,
      authorization_endpoint:
        `${getAuthBaseUrl().replace(/\/$/, "")}/oauth/mcp/authorize`,
      scopes_supported: [...MCP_OAUTH_SCOPES],
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}
