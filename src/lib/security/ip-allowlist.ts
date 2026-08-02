import { isIP } from "node:net";

export class IpAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpAllowlistError";
  }
}

function normalizeAddress(value: string) {
  const trimmed = value.trim().replace(/^\[|\]$/g, "");
  const zoneIndex = trimmed.indexOf("%");
  const withoutZone = zoneIndex >= 0 ? trimmed.slice(0, zoneIndex) : trimmed;
  if (withoutZone.toLowerCase().startsWith("::ffff:")) {
    const mapped = withoutZone.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }
  return withoutZone.toLowerCase();
}

function ipv4Value(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new IpAllowlistError(`유효하지 않은 IPv4 주소입니다: ${address}`);
  }
  return parts.reduce((value, part) => (value << BigInt(8)) | BigInt(part), BigInt(0));
}

function ipv6Value(address: string) {
  let normalized = address;
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const v4 = ipv4Value(ipv4Tail);
    normalized = normalized.slice(0, -ipv4Tail.length)
      + `${Number((v4 >> BigInt(16)) & BigInt(0xffff)).toString(16)}:${Number(v4 & BigInt(0xffff)).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) throw new IpAllowlistError(`유효하지 않은 IPv6 주소입니다: ${address}`);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    throw new IpAllowlistError(`유효하지 않은 IPv6 주소입니다: ${address}`);
  }
  const groups = [...left, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    throw new IpAllowlistError(`유효하지 않은 IPv6 주소입니다: ${address}`);
  }
  return groups.reduce((value, group) => (value << BigInt(16)) | BigInt(`0x${group}`), BigInt(0));
}

function addressValue(address: string, version: 4 | 6) {
  return version === 4 ? ipv4Value(address) : ipv6Value(address);
}

export function normalizeIpAllowlist(values: readonly string[]) {
  const normalized = values.flatMap((raw) => raw.split(/[\s,]+/)).map((value) => value.trim()).filter(Boolean);
  if (normalized.length > 32) throw new IpAllowlistError("허용 IP는 연결 키마다 최대 32개까지 등록할 수 있습니다.");
  return Array.from(new Set(normalized.map((entry) => {
    const [rawAddress, rawPrefix] = entry.split("/");
    const address = normalizeAddress(rawAddress);
    const version = isIP(address);
    if (version !== 4 && version !== 6) throw new IpAllowlistError(`유효하지 않은 IP 주소입니다: ${entry}`);
    const maxPrefix = version === 4 ? 32 : 128;
    const prefix = rawPrefix === undefined ? maxPrefix : Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new IpAllowlistError(`유효하지 않은 CIDR 범위입니다: ${entry}`);
    }
    addressValue(address, version);
    return `${address}/${prefix}`;
  })));
}

export function ipMatchesAllowlist(clientIp: string, allowlist: readonly string[]) {
  if (allowlist.length === 0) return true;
  const address = normalizeAddress(clientIp);
  const version = isIP(address);
  if (version !== 4 && version !== 6) return false;
  const value = addressValue(address, version);
  const bits = version === 4 ? 32 : 128;
  return allowlist.some((entry) => {
    try {
      const [networkAddress, prefixValue] = entry.split("/");
      const networkVersion = isIP(networkAddress);
      if (networkVersion !== version) return false;
      const prefix = Number(prefixValue);
      const shift = BigInt(bits - prefix);
      return (value >> shift) === (addressValue(networkAddress, version) >> shift);
    } catch {
      return false;
    }
  });
}
