import "server-only";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertRuntimeConfiguration } from "@/lib/config";
import { sqlite } from "@/lib/db/client";
import { getSiteSettings } from "@/lib/site-settings/service";

export class AppAuthError extends Error {
  constructor(public readonly code: "UNAUTHORIZED" | "EMAIL_NOT_VERIFIED") {
    super(code === "UNAUTHORIZED" ? "로그인이 필요합니다." : "이메일 인증이 필요합니다.");
    this.name = "AppAuthError";
  }
}

export async function getCurrentSession() {
  assertRuntimeConfiguration();
  return auth.api.getSession({ headers: await headers() });
}

export async function requireVerifiedSession() {
  const session = await getCurrentSession();
  if (!session) throw new AppAuthError("UNAUTHORIZED");
  if (!sessionEmailIsAccepted(session)) throw new AppAuthError("EMAIL_NOT_VERIFIED");
  return session;
}

export function sessionEmailIsAccepted(session: {
  user: { emailVerified: boolean };
}) {
  return session.user.emailVerified || !getSiteSettings(sqlite).emailVerificationEnabled;
}
