import { createServer, get, type Server } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  assertGatewayTrustedProxyConfiguration,
  createGatewayTrustedProxyPolicy,
  createGatewayServer,
  isCollaborationPath,
  resolveGatewayClientIp,
} from "@/lib/gateway/server";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server.");
  return address.port;
}

async function close(server: Server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function getText(url: string, headers: Record<string, string> = {}) {
  return await new Promise<string>((resolve, reject) => {
    get(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).once("error", reject);
  });
}

function environmentValue(contents: string, name: string) {
  const prefix = `${name}=`;
  const line = contents.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`Missing ${name} from environment example.`);
  return line.slice(prefix.length);
}

describe("Nyxdoc gateway", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => close(server)));
  });

  it("routes only the public collaboration endpoint to Hocuspocus", () => {
    expect(isCollaborationPath("/collaboration?token=secret")).toBe(true);
    expect(isCollaborationPath("/api/collaboration/token")).toBe(false);
    expect(isCollaborationPath("/internal/drafts/read")).toBe(false);
  });

  it.each([
    [undefined, "198.51.100.24", "198.51.100.24"],
    [undefined, "::ffff:198.51.100.24", "198.51.100.24"],
    ["203.0.113.17", "127.0.0.1", "203.0.113.17"],
    ["2001:db8::17", "::1", "2001:db8::17"],
    ["203.0.113.17", "::ffff:127.0.0.2", "203.0.113.17"],
    ["203.0.113.17", "198.51.100.24", "198.51.100.24"],
    ["not-an-ip", "127.0.0.1", "127.0.0.1"],
    ["203.0.113.17, 198.51.100.24", "::1", "::1"],
    ["203.0.113.17", undefined, null],
  ])(
    "resolves X-Real-IP %j from immediate peer %j as %j",
    (realIp, peerIp, expected) => {
      expect(resolveGatewayClientIp(realIp, peerIp)).toBe(expected);
    },
  );

  it("trusts configured Docker bridge peers only behind a loopback host publish", () => {
    const policy = createGatewayTrustedProxyPolicy(
      "172.16.0.0/12, 192.168.0.0/16",
    );
    expect(() => assertGatewayTrustedProxyConfiguration("127.0.0.1", policy))
      .not.toThrow();
    expect(resolveGatewayClientIp("203.0.113.17", "172.19.0.1", policy))
      .toBe("203.0.113.17");
    expect(resolveGatewayClientIp("203.0.113.18", "::ffff:172.19.0.1", policy))
      .toBe("203.0.113.18");
    expect(resolveGatewayClientIp("203.0.113.19", "10.0.0.1", policy))
      .toBe("10.0.0.1");
  });

  it("keeps fresh-install Compose proxy trust behind the guarded loopback publish", () => {
    const productionEnvironment = readFileSync(".env.production.example", "utf8");
    const developmentEnvironment = readFileSync(".env.example", "utf8");
    const publishedHost = environmentValue(productionEnvironment, "NYXDOC_HTTP_HOST");
    const trustedProxyCidrs = environmentValue(
      productionEnvironment,
      "NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS",
    );
    expect(publishedHost).toBe("127.0.0.1");
    expect(trustedProxyCidrs).toBe("172.16.0.0/12,192.168.0.0/16");
    expect(environmentValue(developmentEnvironment, "NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS"))
      .toBe(trustedProxyCidrs);

    const policy = createGatewayTrustedProxyPolicy(trustedProxyCidrs);
    expect(() => assertGatewayTrustedProxyConfiguration(publishedHost, policy)).not.toThrow();
    expect(resolveGatewayClientIp("203.0.113.17", "172.19.0.1", policy))
      .toBe("203.0.113.17");

    const compose = readFileSync("compose.yaml", "utf8");
    expect(compose).toContain(
      "NYXDOC_HTTP_HOST: ${NYXDOC_HTTP_HOST:-127.0.0.1}",
    );
    expect(compose).toContain(
      "NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS: "
      + "${NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS-172.16.0.0/12,192.168.0.0/16}",
    );
    expect(compose).toContain(
      '- "${NYXDOC_HTTP_HOST:-127.0.0.1}:${NYXDOC_HTTP_PORT:-3191}:3002"',
    );
  });

  it.each(["0.0.0.0", "::", "198.51.100.24", undefined])(
    "refuses non-loopback proxy trust with published host %j",
    (publishedHost) => {
      const policy = createGatewayTrustedProxyPolicy("172.16.0.0/12");
      expect(() => assertGatewayTrustedProxyConfiguration(publishedHost, policy))
        .toThrow(/only when NYXDOC_HTTP_HOST is an explicit loopback address/u);
      expect(() => createGatewayServer({
        appUrl: "http://app:3000",
        collaborationUrl: "http://collaboration:3101",
        publishedHost,
        trustedProxyCidrs: "172.16.0.0/12",
      })).toThrow(/only when NYXDOC_HTTP_HOST is an explicit loopback address/u);
    },
  );

  it("keeps a directly published gateway fail-closed without bridge trust", () => {
    const policy = createGatewayTrustedProxyPolicy("");
    expect(() => assertGatewayTrustedProxyConfiguration("0.0.0.0", policy)).not.toThrow();
    expect(resolveGatewayClientIp("203.0.113.17", "172.19.0.1", policy))
      .toBe("172.19.0.1");
  });

  it.each([
    "172.16.0.0",
    "not-an-ip/24",
    "172.16.0.0/not-a-prefix",
    "172.16.0.0/33",
    "2001:db8::/129",
    ",",
  ])("rejects invalid trusted proxy CIDR %j", (cidr) => {
    expect(() => createGatewayTrustedProxyPolicy(cidr))
      .toThrow(/NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS/u);
  });

  it("proxies app HTTP and collaboration WebSocket traffic", async () => {
    const app = createServer((request, response) => {
      response.end(JSON.stringify({
        clientIp: request.headers["x-nyxdoc-client-ip"],
        url: request.url,
      }));
    });
    servers.push(app);
    const appPort = await listen(app);

    const collaboration = createServer((request, response) => {
      response.end(JSON.stringify({
        clientIp: request.headers["x-nyxdoc-client-ip"],
        proof: request.headers["x-nyxdoc-client-ip-proof"],
        url: request.url,
      }));
    });
    const webSockets = new WebSocketServer({ noServer: true });
    collaboration.on("upgrade", (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.send(JSON.stringify({
          clientIp: request.headers["x-nyxdoc-client-ip"],
          proof: request.headers["x-nyxdoc-client-ip-proof"],
        }));
        webSocket.on("message", (message) => webSocket.send(`echo:${message.toString()}`));
      });
    });
    servers.push(collaboration);
    const collaborationPort = await listen(collaboration);

    const gateway = createGatewayServer({
      appUrl: `http://127.0.0.1:${appPort}`,
      collaborationUrl: `http://127.0.0.1:${collaborationPort}`,
      collaborationClientIpSecret: "gateway-test-secret",
    });
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    expect(JSON.parse(await getText(`http://127.0.0.1:${gatewayPort}/api/health`, {
      "x-nyxdoc-client-ip": "198.51.100.200",
      "x-real-ip": "203.0.113.17",
    }))).toEqual({ clientIp: "203.0.113.17", url: "/api/health" });
    expect(JSON.parse(await getText(`http://127.0.0.1:${gatewayPort}/collaboration`, {
      "x-nyxdoc-client-ip": "198.51.100.200",
      "x-nyxdoc-client-ip-proof": "caller-controlled-proof",
      "x-real-ip": "203.0.113.17",
    }))).toEqual({
      clientIp: "203.0.113.17",
      proof: "gateway-test-secret",
      url: "/collaboration",
    });

    const socket = new WebSocket(
      `ws://127.0.0.1:${gatewayPort}/collaboration?token=test`,
      {
        headers: {
          "x-nyxdoc-client-ip": "198.51.100.200",
          "x-nyxdoc-client-ip-proof": "caller-controlled-proof",
          "x-real-ip": "203.0.113.18",
        },
      },
    );
    const [firstMessage] = await once(socket, "message");
    expect(JSON.parse(firstMessage.toString())).toEqual({
      clientIp: "203.0.113.18",
      proof: "gateway-test-secret",
    });
    socket.send("hello");
    const [secondMessage] = await once(socket, "message");
    expect(secondMessage.toString()).toBe("echo:hello");
    socket.close();
    await once(socket, "close");
    webSockets.close();
  });
});
