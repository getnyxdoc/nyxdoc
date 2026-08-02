import { GET as getProtectedResourceMetadata } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return getProtectedResourceMetadata(request);
}
