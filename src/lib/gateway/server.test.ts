import { createServer, get, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createGatewayServer, isCollaborationPath } from "@/lib/gateway/server";

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

  it("proxies app HTTP and collaboration WebSocket traffic", async () => {
    const app = createServer((request, response) => {
      response.end(JSON.stringify({
        clientIp: request.headers["x-nyxdoc-client-ip"],
        url: request.url,
      }));
    });
    servers.push(app);
    const appPort = await listen(app);

    const collaboration = createServer((_request, response) => {
      response.writeHead(404);
      response.end("collaboration-http");
    });
    const webSockets = new WebSocketServer({ noServer: true });
    collaboration.on("upgrade", (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.send("collaboration-ready");
        webSocket.on("message", (message) => webSocket.send(`echo:${message.toString()}`));
      });
    });
    servers.push(collaboration);
    const collaborationPort = await listen(collaboration);

    const gateway = createGatewayServer({
      appUrl: `http://127.0.0.1:${appPort}`,
      collaborationUrl: `http://127.0.0.1:${collaborationPort}`,
    });
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    expect(JSON.parse(await getText(`http://127.0.0.1:${gatewayPort}/api/health`, {
      "x-nyxdoc-client-ip": "198.51.100.200",
      "x-real-ip": "203.0.113.17",
    }))).toEqual({ clientIp: "203.0.113.17", url: "/api/health" });

    const socket = new WebSocket(
      `ws://127.0.0.1:${gatewayPort}/collaboration?token=test`,
    );
    const [firstMessage] = await once(socket, "message");
    expect(firstMessage.toString()).toBe("collaboration-ready");
    socket.send("hello");
    const [secondMessage] = await once(socket, "message");
    expect(secondMessage.toString()).toBe("echo:hello");
    socket.close();
    await once(socket, "close");
    webSockets.close();
  });
});
