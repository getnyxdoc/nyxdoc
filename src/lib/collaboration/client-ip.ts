import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export const COLLABORATION_CLIENT_IP_HEADER = "x-nyxdoc-client-ip";
export const COLLABORATION_CLIENT_IP_PROOF_HEADER = "x-nyxdoc-client-ip-proof";

function firstHeader(
  headers: IncomingMessage["headers"],
  name: typeof COLLABORATION_CLIENT_IP_HEADER | typeof COLLABORATION_CLIENT_IP_PROOF_HEADER,
) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizedClientIp(value: string | undefined) {
  if (!value) return null;
  const candidate = value.trim().replace(/^\[|\]$/g, "");
  if (candidate.toLowerCase().startsWith("::ffff:") && isIP(candidate.slice(7)) === 4) {
    return candidate.slice(7);
  }
  return isIP(candidate) ? candidate : null;
}

/**
 * Direct collaboration traffic must be attributed to its TCP peer. The
 * forwarded client IP is accepted only when the in-network gateway proves it
 * knows the collaboration secret; a caller-controlled header is never proof.
 */
export function collaborationClientIp(
  request: IncomingMessage,
  trustedGatewaySecret: string,
) {
  const forwardedIp = firstHeader(request.headers, COLLABORATION_CLIENT_IP_HEADER);
  const proof = firstHeader(request.headers, COLLABORATION_CLIENT_IP_PROOF_HEADER);
  if (forwardedIp && proof && constantTimeEquals(proof, trustedGatewaySecret)) {
    return normalizedClientIp(forwardedIp)
      ?? normalizedClientIp(request.socket.remoteAddress);
  }
  return normalizedClientIp(request.socket.remoteAddress);
}
