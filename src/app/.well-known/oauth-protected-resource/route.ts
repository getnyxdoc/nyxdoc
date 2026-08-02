import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { auth } from "@/lib/auth";
import { assertRuntimeConfiguration } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const protectedResource = oAuthProtectedResourceMetadata(auth);

export function GET(request: Request) {
  assertRuntimeConfiguration();
  return protectedResource(request);
}
