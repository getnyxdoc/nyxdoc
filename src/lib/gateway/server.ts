import {
  createServer,
  request as createProxyRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";

export type GatewayOptions = {
  appUrl: string;
  collaborationUrl: string;
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

function proxyHeaders(request: IncomingMessage, upgrade: boolean) {
  const headers = request.headers;
  const forwarded = { ...headers };
  delete forwarded["proxy-connection"];
  delete forwarded["x-nyxdoc-client-ip"];
  if (!upgrade) {
    delete forwarded.connection;
    delete forwarded.upgrade;
  }
  const realIpHeader = Array.isArray(headers["x-real-ip"])
    ? headers["x-real-ip"][0]
    : headers["x-real-ip"];
  const clientIp = normalizedIp(realIpHeader)
    ?? normalizedIp(request.socket.remoteAddress);
  if (clientIp) forwarded["x-nyxdoc-client-ip"] = clientIp;
  return forwarded;
}

function requestOptions(
  request: IncomingMessage,
  upstream: URL,
  upgrade: boolean,
): RequestOptions {
  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || 80,
    method: request.method,
    path: request.url || "/",
    headers: proxyHeaders(request, upgrade),
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
  const app = parseUpstream(options.appUrl, "NYXDOC_GATEWAY_APP_URL");
  const collaboration = parseUpstream(
    options.collaborationUrl,
    "NYXDOC_GATEWAY_COLLABORATION_URL",
  );
  const selectUpstream = (request: IncomingMessage) => (
    isCollaborationPath(request.url) ? collaboration : app
  );

  const server = createServer((request, response) => {
    const proxyRequest = createProxyRequest(
      requestOptions(request, selectUpstream(request), false),
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
      requestOptions(request, selectUpstream(request), true),
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
