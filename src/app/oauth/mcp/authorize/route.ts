import { getAuthBaseUrl } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const source = new URL(request.url);
  const target = new URL("/api/auth/mcp/authorize", getAuthBaseUrl());
  for (const [key, value] of source.searchParams) {
    target.searchParams.append(key, value);
  }
  target.searchParams.set("prompt", "consent");
  return Response.redirect(target, 302);
}
