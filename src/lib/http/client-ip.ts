import { isIP } from "node:net";

function validIp(value: string | null) {
  if (!value) return null;
  const normalized = value.trim().replace(/^\[|\]$/g, "");
  return isIP(normalized) ? normalized : null;
}
export function requestClientIp(request: Request) {
  return validIp(request.headers.get("x-nyxdoc-client-ip"));
}
