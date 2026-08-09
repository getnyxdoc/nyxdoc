import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  collaborationClientIp,
  normalizedClientIp,
} from "@/lib/collaboration/client-ip";

const gatewaySecret = "collaboration-client-ip-test-secret";

function request(headers: Record<string, string | undefined>, peerIp = "127.0.0.1") {
  return {
    headers,
    socket: { remoteAddress: peerIp },
  } as unknown as IncomingMessage;
}

describe("collaboration client IP trust boundary", () => {
  it("uses the TCP peer for a direct request even when it supplies a client IP header", () => {
    expect(collaborationClientIp(request({
      "x-nyxdoc-client-ip": "203.0.113.12",
    }), gatewaySecret)).toBe("127.0.0.1");
  });

  it("accepts a normalized forwarded IP only with the gateway proof", () => {
    expect(collaborationClientIp(request({
      "x-nyxdoc-client-ip": "::ffff:203.0.113.12",
      "x-nyxdoc-client-ip-proof": gatewaySecret,
    }), gatewaySecret)).toBe("203.0.113.12");
  });

  it("falls back to the TCP peer for a malformed or unproven forwarded IP", () => {
    expect(collaborationClientIp(request({
      "x-nyxdoc-client-ip": "not-an-ip",
      "x-nyxdoc-client-ip-proof": gatewaySecret,
    }, "::ffff:192.0.2.44"), gatewaySecret)).toBe("192.0.2.44");
    expect(normalizedClientIp("not-an-ip")).toBeNull();
  });
});
