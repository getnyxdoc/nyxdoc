export class OriginError extends Error {
  constructor() {
    super("허용되지 않은 요청 출처입니다.");
    this.name = "OriginError";
  }
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin) {
    if (fetchSite === "cross-site") throw new OriginError();
    return;
  }
  try {
    const allowed = new Set(getTrustedOrigins().map((value) => new URL(value).origin));
    if (!allowed.has(new URL(origin).origin)) throw new OriginError();
  } catch (error) {
    if (error instanceof OriginError) throw error;
    throw new OriginError();
  }
}
import { getTrustedOrigins } from "@/lib/config";
