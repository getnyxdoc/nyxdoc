import { describe, expect, it } from "vitest";
import {
  IpAllowlistError,
  ipMatchesAllowlist,
  normalizeIpAllowlist,
} from "@/lib/security/ip-allowlist";

describe("agent credential IP allowlists", () => {
  it("normalizes exact addresses and CIDR entries", () => {
    expect(normalizeIpAllowlist([
      "203.0.113.7",
      "203.0.113.0/24, 2001:DB8::/48",
      "203.0.113.7/32",
    ])).toEqual([
      "203.0.113.7/32",
      "203.0.113.0/24",
      "2001:db8::/48",
    ]);
  });

  it("matches IPv4, IPv6, and IPv4-mapped addresses without trusting malformed input", () => {
    const allowlist = normalizeIpAllowlist(["203.0.113.0/24", "2001:db8:42::/48"]);
    expect(ipMatchesAllowlist("203.0.113.99", allowlist)).toBe(true);
    expect(ipMatchesAllowlist("::ffff:203.0.113.99", allowlist)).toBe(true);
    expect(ipMatchesAllowlist("203.0.114.1", allowlist)).toBe(false);
    expect(ipMatchesAllowlist("2001:db8:42::abcd", allowlist)).toBe(true);
    expect(ipMatchesAllowlist("2001:db8:43::1", allowlist)).toBe(false);
    expect(ipMatchesAllowlist("not-an-ip", allowlist)).toBe(false);
  });

  it("rejects malformed entries and unsafe prefix lengths", () => {
    expect(() => normalizeIpAllowlist(["203.0.113.7/33"]))
      .toThrowError(IpAllowlistError);
    expect(() => normalizeIpAllowlist(["2001:db8::/129"]))
      .toThrowError(IpAllowlistError);
    expect(() => normalizeIpAllowlist(["example.com"]))
      .toThrowError(IpAllowlistError);
  });
});
