import { createGatewayServer } from "@/lib/gateway/server";

function gatewayPort() {
  const value = Number(process.env.NYXDOC_GATEWAY_PORT || 3002);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("NYXDOC_GATEWAY_PORT must be a valid TCP port.");
  }
  return value;
}

const server = createGatewayServer({
  appUrl: process.env.NYXDOC_GATEWAY_APP_URL || "http://app:3000",
  collaborationUrl:
    process.env.NYXDOC_GATEWAY_COLLABORATION_URL || "http://collaboration:3101",
});
const port = gatewayPort();

server.listen(port, "0.0.0.0", () => {
  console.log(`[gateway] listening on 0.0.0.0:${port}`);
});

function shutdown(signal: string) {
  console.log(`[gateway] received ${signal}; shutting down`);
  server.close(() => process.exit(0));
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
