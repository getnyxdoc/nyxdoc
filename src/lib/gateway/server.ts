import {
  createServer,
  request as createProxyRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { BlockList, isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
  COLLABORATION_CLIENT_IP_HEADER,
  COLLABORATION_CLIENT_IP_PROOF_HEADER,
} from "@/lib/collaboration/client-ip";

export type GatewayOptions = {
  appUrl: string;
  collaborationUrl: string;
  collaborationClientIpSecret?: string;
  publishedHost?: string;
  trustedProxyCidrs?: string | readonly string[];
};

export type GatewayTrustedProxyPolicy = {
  blockList: BlockList;
  cidrs: readonly string[];
  trustsNonLoopback: boolean;
};

function parseUpstream(value: string, name: string) {
  const url = new URL(value);
  if (url.protocol !== "http:") {
    throw new Error(`${name} must use http:// inside the Docker network.`);
  }
  return url;
}

export function isCollaborationPath(requestUrl: string | undefined) {
  return new URL(requestUrl ?? "/", "http://gateway.local").pathname === "/collaboration";
}

function normalizedIp(value: string | undefined) {
  if (!value) return null;
  const candidate = value.trim().replace(/^\[|\]$/g, "");
  if (candidate.toLowerCase().startsWith("::ffff:") && isIP(candidate.slice(7)) === 4) {
    return candidate.slice(7);
  }
  return isIP(candidate) ? candidate : null;
}

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

function isLoopbackIp(value: string) {
  const family = isIP(value);
  return family === 4
    ? loopbackAddresses.check(value, "ipv4")
    : family === 6 && loopbackAddresses.check(value, "ipv6");
}

function trustedProxyCidrEntries(value: string | readonly string[] | undefined) {
  if (value === undefined) return [];
  const values = typeof value === "string" ? [value] : value;
  const entries = values.flatMap((entry) => entry.split(/[\s,]+/u))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0 && values.some((entry) => entry.trim().length > 0)) {
    throw new Error("Invalid NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS value.");
  }
  return entries;
}

function parseTrustedProxyCidr(value: string) {
  const separator = value.lastIndexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS entry must use CIDR notation: ${value}`,
    );
  }
  const address = normalizedIp(value.slice(0, separator));
  const prefixText = value.slice(separator + 1);
  const family = address ? isIP(address) : 0;
  const maximumPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
  if (!address || !/^\d+$/u.test(prefixText)) {
    throw new Error(`Invalid NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS entry: ${value}`);
  }
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximumPrefix) {
    throw new Error(`Invalid NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS prefix: ${value}`);
  }
  return { address, family, prefix } as const;
}

function cidrContainsOnlyLoopback({
  address,
  family,
  prefix,
}: ReturnType<typeof parseTrustedProxyCidr>) {
  if (family === 4) return prefix >= 8 && address.startsWith("127.");
  return prefix === 128 && isLoopbackIp(address);
}

export function createGatewayTrustedProxyPolicy(
  value?: string | readonly string[],
): GatewayTrustedProxyPolicy {
  const blockList = new BlockList();
  blockList.addSubnet("127.0.0.0", 8, "ipv4");
  blockList.addAddress("::1", "ipv6");
  const cidrs: string[] = [];
  let trustsNonLoopback = false;
  for (const entry of trustedProxyCidrEntries(value)) {
    const parsed = parseTrustedProxyCidr(entry);
    blockList.addSubnet(
      parsed.address,
      parsed.prefix,
      parsed.family === 4 ? "ipv4" : "ipv6",
    );
    cidrs.push(`${parsed.address}/${parsed.prefix}`);
    if (!cidrContainsOnlyLoopback(parsed)) trustsNonLoopback = true;
  }
  return { blockList, cidrs, trustsNonLoopback };
}

export function assertGatewayTrustedProxyConfiguration(
  publishedHost: string | undefined,
  policy: GatewayTrustedProxyPolicy,
) {
  if (!policy.trustsNonLoopback) return;
  const publishedIp = normalizedIp(publishedHost);
  if (!publishedIp || !isLoopbackIp(publishedIp)) {
    throw new Error(
      "NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS may trust non-loopback peers only "
      + "when NYXDOC_HTTP_HOST is an explicit loopback address.",
    );
  }
}

const loopbackOnlyProxyPolicy = createGatewayTrustedProxyPolicy();

function isTrustedProxyPeer(peerIp: string, policy: GatewayTrustedProxyPolicy) {
  const family = isIP(peerIp);
  return family === 4
    ? policy.blockList.check(peerIp, "ipv4")
    : family === 6 && policy.blockList.check(peerIp, "ipv6");
}

export function resolveGatewayClientIp(
  realIpHeader: string | string[] | undefined,
  peerAddress: string | undefined,
  trustedProxyPolicy = loopbackOnlyProxyPolicy,
) {
  const peerIp = normalizedIp(peerAddress);
  if (!peerIp) return null;
  if (!isTrustedProxyPeer(peerIp, trustedProxyPolicy)) return peerIp;
  const realIp = Array.isArray(realIpHeader) ? realIpHeader[0] : realIpHeader;
  return normalizedIp(realIp) ?? peerIp;
}

function proxyHeaders(
  request: IncomingMessage,
  upgrade: boolean,
  trustedProxyPolicy: GatewayTrustedProxyPolicy,
  collaborationClientIpSecret?: string,
) {
  const headers = request.headers;
  const forwarded = { ...headers };
  delete forwarded["proxy-connection"];
  delete forwarded[COLLABORATION_CLIENT_IP_HEADER];
  delete forwarded[COLLABORATION_CLIENT_IP_PROOF_HEADER];
  if (!upgrade) {
    delete forwarded.connection;
    delete forwarded.upgrade;
  }
  const clientIp = resolveGatewayClientIp(
    headers["x-real-ip"],
    request.socket.remoteAddress,
    trustedProxyPolicy,
  );
  if (clientIp) forwarded[COLLABORATION_CLIENT_IP_HEADER] = clientIp;
  if (clientIp && collaborationClientIpSecret) {
    forwarded[COLLABORATION_CLIENT_IP_PROOF_HEADER] = collaborationClientIpSecret;
  }
  return forwarded;
}

function requestOptions(
  request: IncomingMessage,
  upstream: URL,
  upgrade: boolean,
  trustedProxyPolicy: GatewayTrustedProxyPolicy,
  collaborationClientIpSecret?: string,
): RequestOptions {
  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || 80,
    method: request.method,
    path: request.url || "/",
    headers: proxyHeaders(
      request,
      upgrade,
      trustedProxyPolicy,
      collaborationClientIpSecret,
    ),
    agent: false,
  };
}

function sendGatewayError(response: ServerResponse) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Nyxdoc upstream is unavailable.", code: "BAD_GATEWAY" }));
}

function writeUpgradeResponseHead(socket: Duplex, response: IncomingMessage) {
  socket.write(
    `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}\r\n`,
  );
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
  }
  socket.write("\r\n");
}

function sendSocketGatewayError(socket: Duplex) {
  if (socket.destroyed) return;
  socket.end(
    "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
}

export function createGatewayServer(options: GatewayOptions) {
  const trustedProxyPolicy = createGatewayTrustedProxyPolicy(options.trustedProxyCidrs);
  assertGatewayTrustedProxyConfiguration(options.publishedHost, trustedProxyPolicy);
  const app = parseUpstream(options.appUrl, "NYXDOC_GATEWAY_APP_URL");
  const collaboration = parseUpstream(
    options.collaborationUrl,
    "NYXDOC_GATEWAY_COLLABORATION_URL",
  );
  const selectUpstream = (request: IncomingMessage) => (
    isCollaborationPath(request.url) ? collaboration : app
  );
  const collaborationClientIpSecretFor = (request: IncomingMessage) => (
    isCollaborationPath(request.url) ? options.collaborationClientIpSecret : undefined
  );

  const server = createServer((request, response) => {
    const proxyRequest = createProxyRequest(
      requestOptions(
        request,
        selectUpstream(request),
        false,
        trustedProxyPolicy,
        collaborationClientIpSecretFor(request),
      ),
      (proxyResponse) => {
        response.writeHead(
          proxyResponse.statusCode ?? 502,
          proxyResponse.statusMessage,
          proxyResponse.headers,
        );
        proxyResponse.pipe(response);
      },
    );

    proxyRequest.on("error", () => sendGatewayError(response));
    request.on("aborted", () => proxyRequest.destroy());
    request.pipe(proxyRequest);
  });

  server.on("upgrade", (request, socket, head) => {
    let connected = false;
    const proxyRequest = createProxyRequest(
      requestOptions(
        request,
        selectUpstream(request),
        true,
        trustedProxyPolicy,
        collaborationClientIpSecretFor(request),
      ),
    );

    proxyRequest.once("upgrade", (proxyResponse, upstreamSocket, upstreamHead) => {
      connected = true;
      writeUpgradeResponseHead(socket, proxyResponse);
      if (head.length > 0) upstreamSocket.write(head);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });

    proxyRequest.once("response", (proxyResponse) => {
      connected = true;
      writeUpgradeResponseHead(socket, proxyResponse);
      proxyResponse.pipe(socket);
    });

    proxyRequest.once("error", () => {
      if (!connected) sendSocketGatewayError(socket);
      else socket.destroy();
    });
    proxyRequest.end();
  });

  return server;
}
