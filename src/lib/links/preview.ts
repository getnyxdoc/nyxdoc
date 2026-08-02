import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 4_000;

const nonPublicAddresses = new BlockList();
const publicIpv6Addresses = new BlockList();
publicIpv6Addresses.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

export class LinkPreviewError extends Error {
  constructor(
    public readonly code:
      | "INVALID_URL"
      | "PRIVATE_ADDRESS"
      | "UNSUPPORTED_CONTENT"
      | "FETCH_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "LinkPreviewError";
  }
}

function normalizedHostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
}

function assertAllowedUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new LinkPreviewError("INVALID_URL", "올바른 웹 주소가 아닙니다.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== "80" && parsed.port !== "443")
  ) {
    throw new LinkPreviewError(
      "INVALID_URL",
      "외부 링크 제목은 일반 HTTP 또는 HTTPS 주소에서만 확인할 수 있습니다.",
    );
  }
  if (normalizedHostname(parsed) === "localhost") {
    throw new LinkPreviewError("PRIVATE_ADDRESS", "내부 네트워크 주소는 확인할 수 없습니다.");
  }
  return parsed;
}

function isNonPublicAddress(address: string, family: 4 | 6) {
  if (family === 6) {
    // Public IPv6 unicast currently lives in 2000::/3. Requiring that range
    // also rejects IPv4-mapped/compatible and translation addresses before
    // Node can route them back into an internal IPv4 network.
    if (!publicIpv6Addresses.check(address, "ipv6")) return true;
  }
  return nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

async function resolvePublicAddress(url: URL) {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0
    || addresses.some((entry) =>
      (entry.family !== 4 && entry.family !== 6)
      || isNonPublicAddress(entry.address, entry.family as 4 | 6))
  ) {
    throw new LinkPreviewError("PRIVATE_ADDRESS", "내부 네트워크 주소는 확인할 수 없습니다.");
  }
  return addresses.find((entry) => entry.family === 4) ?? addresses[0];
}

function decodeHtml(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  function decodeCodePoint(entity: string, code: number) {
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : entity;
  }
  return value
    .replace(/&#(\d+);/g, (entity, code: string) => decodeCodePoint(entity, Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (entity, code: string) =>
      decodeCodePoint(entity, Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLocaleLowerCase()] ?? entity)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractLinkTitle(html: string) {
  const attribute = (tag: string, name: string) => {
    const match = new RegExp(
      `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    ).exec(tag);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  };
  const openGraphTitle = Array.from(html.matchAll(/<meta\b[^>]*>/gi))
    .find((match) => {
      const tag = match[0];
      return (attribute(tag, "property") || attribute(tag, "name"))
        .toLocaleLowerCase() === "og:title";
    });
  const documentTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const raw = openGraphTitle
    ? attribute(openGraphTitle[0], "content")
    : documentTitle;
  return decodeHtml(raw).slice(0, 200);
}

async function fetchHtml(url: URL, redirectsLeft = MAX_REDIRECTS): Promise<{
  body: string;
  finalUrl: URL;
}> {
  const address = await resolvePublicAddress(url);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: { body: string; finalUrl: URL }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transport.request({
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: normalizedHostname(url),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "identity",
        Host: url.host,
        "User-Agent": "Nyxdoc-Link-Preview/1.0",
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          rejectOnce(new LinkPreviewError("FETCH_FAILED", "리디렉션이 너무 많습니다."));
          return;
        }
        void fetchHtml(assertAllowedUrl(new URL(location, url).toString()), redirectsLeft - 1)
          .then(resolveOnce, rejectOnce);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        rejectOnce(new LinkPreviewError("FETCH_FAILED", "링크에서 제목을 확인하지 못했습니다."));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "").toLocaleLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        response.resume();
        rejectOnce(new LinkPreviewError("UNSUPPORTED_CONTENT", "웹 문서 링크만 제목을 확인할 수 있습니다."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () => {
        if (settled) return;
        resolveOnce({ body: Buffer.concat(chunks).toString("utf8"), finalUrl: url });
        response.destroy();
      };
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        const remaining = MAX_RESPONSE_BYTES - size;
        if (remaining <= 0) {
          finish();
          return;
        }
        const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(accepted);
        size += accepted.length;
        const partialHtml = Buffer.concat(chunks).toString("utf8");
        if (extractLinkTitle(partialHtml) || size >= MAX_RESPONSE_BYTES) finish();
      });
      response.on("end", () => {
        finish();
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      if (settled) return;
      request.destroy(new LinkPreviewError("FETCH_FAILED", "링크 제목 확인 시간이 초과되었습니다."));
    });
    request.on("error", (error) => {
      if (settled) return;
      rejectOnce(error instanceof LinkPreviewError
        ? error
        : new LinkPreviewError("FETCH_FAILED", "링크에서 제목을 확인하지 못했습니다."));
    });
    request.end();
  });
}

export async function fetchLinkPreview(rawUrl: string) {
  const url = assertAllowedUrl(rawUrl);
  const { body, finalUrl } = await fetchHtml(url);
  const title = extractLinkTitle(body) || finalUrl.hostname.replace(/^www\./i, "");
  return { title, url: finalUrl.toString() };
}
