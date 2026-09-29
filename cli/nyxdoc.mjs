#!/usr/bin/env node
// Standalone Nyxdoc client. Node.js 22+; no npm install or MCP auto-registration required.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HELP = `Nyxdoc CLI — load only the operation you need

  nyxdoc status                       Verify connection and compact footprint
  nyxdoc discover [query]              Find up to five operations
  nyxdoc inspect <operation>           Read one schema and its workflow
  nyxdoc call <operation> [options]    Execute with existing server permissions

Options for call:
  --args '<JSON object>'   Small arguments (never put credentials here)
  --file <path>           Read arguments from a UTF-8 JSON file
  --out <path>            Save the result to a file; print only the file path

Environment:
  NYXDOC_MCP_URL            Your instance's MCP URL (workspace query is preserved)
  NYXDOC_MCP_BEARER_TOKEN   Existing connection key, kept out of output

Inspect before use. Draft writes do not commit; commit explicitly after review.
Use the same requestId only to retry the same write. Errors exit nonzero.
`;

/** @param {string[]} argv @param {Record<string, string | undefined>} env @param {(text: string) => void} output */
export async function run(argv, env = process.env, output = text => console.log(text)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") { output(HELP); return; }
  if (!["status", "discover", "inspect", "call"].includes(command)) throw new Error("Unknown command. Run nyxdoc --help.");
  let operation;
  let args = {};
  let outPath;
  let query;
  if (command === "discover") query = rest.join(" ");
  else if (command === "status" && rest.length) throw new Error("status takes no arguments.");
  else if (command === "inspect") {
    if (rest.length !== 1) throw new Error("Usage: nyxdoc inspect <operation>");
    operation = rest[0];
  } else if (command === "call") {
    operation = rest.shift();
    if (!operation || operation.startsWith("--")) throw new Error("Usage: nyxdoc call <operation> [--args JSON | --file path] [--out path]");
    let inputSet = false;
    for (let i = 0; i < rest.length; i += 2) {
      const [flag, value] = rest.slice(i, i + 2);
      if (!value) throw new Error("Every option needs a value.");
      if (flag === "--out" && !outPath) outPath = value;
      else if ((flag === "--args" || flag === "--file") && !inputSet) {
        inputSet = true;
        try { args = JSON.parse(flag === "--file" ? await readFile(value, "utf8") : value); }
        catch { throw new Error("Cannot read arguments. Supply valid UTF-8 JSON with --args or --file."); }
      } else throw new Error("Unknown or duplicate option. Run nyxdoc --help.");
    }
    if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("Arguments must be a JSON object.");
  }

  if (!env.NYXDOC_MCP_URL || !env.NYXDOC_MCP_BEARER_TOKEN) throw new Error("Set NYXDOC_MCP_URL and NYXDOC_MCP_BEARER_TOKEN from your existing Nyxdoc connection.");
  const url = new URL(env.NYXDOC_MCP_URL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) {
    throw new Error("Use an HTTPS MCP URL (HTTP is allowed only on loopback), without credentials or fragments.");
  }
  url.searchParams.set("profile", "compact");
  let id = 0;
  let version = "2025-06-18";
  const headers = {
    Authorization: `Bearer ${env.NYXDOC_MCP_BEARER_TOKEN}`,
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  };
  async function rpc(method, params, notification = false) {
    const requestId = ++id;
    const response = await fetch(url, {
      method: "POST", headers: { ...headers, "MCP-Protocol-Version": version }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: requestId }), method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Nyxdoc HTTP ${response.status}. Check the endpoint, credential and access scope.`);
    if (notification) return;
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Expected the Nyxdoc stateless JSON MCP endpoint.");
    const body = await response.json();
    if (body.id !== requestId || body.jsonrpc !== "2.0") throw new Error("Invalid MCP response envelope.");
    if (body.error) throw new Error(`MCP request failed (${body.error.code ?? "unknown"}). Inspect the operation and retry only with the same requestId for the same write.`);
    return body.result;
  }
  const initialized = await rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "nyxdoc-cli", version: "1.0.0" } });
  if (initialized.serverInfo?.name !== "nyxdoc") throw new Error("Endpoint is not a Nyxdoc MCP server.");
  version = initialized.protocolVersion;
  await rpc("notifications/initialized", {}, true);
  async function tool(name, toolArgs = {}) {
    const response = await rpc("tools/call", { name, arguments: toolArgs });
    if (response.isError) {
      const code = response.structuredContent?.code ?? "TOOL_ERROR";
      throw new Error(`Nyxdoc ${code}. Inspect the operation; re-read after a conflict. Do not retry writes with a new requestId.`);
    }
    return response.structuredContent ?? response;
  }
  let value;
  if (command === "status") {
    const listed = await rpc("tools/list", {});
    if (!listed.tools?.some(t => t.name === "nyxdoc_discover")) throw new Error("This server needs an update for compact MCP. No operation was executed.");
    value = { server: initialized.serverInfo, profile: "compact", tools: listed.tools.map(t => t.name), initialBytes: Buffer.byteLength(JSON.stringify(listed.tools) + (initialized.instructions ?? "")) };
  } else if (command === "discover") value = await tool("nyxdoc_discover", { query });
  else {
    const detail = await tool("nyxdoc_discover", { operation });
    if (command === "inspect") value = detail;
    else {
      if (!["nyxdoc_read", "nyxdoc_write", "nyxdoc_destructive"].includes(detail.tool)) throw new Error("Invalid operation route returned by server.");
      value = await tool(detail.tool, { operation, args });
    }
  }
  const serialized = JSON.stringify(value, null, 2);
  if (outPath) { await writeFile(outPath, serialized + "\n", { mode: 0o600 }); output(JSON.stringify({ saved: outPath })); }
  else output(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch(error => {
    const message = error instanceof Error ? error.message : "Nyxdoc request failed.";
    const token = process.env.NYXDOC_MCP_BEARER_TOKEN;
    console.error(token ? message.replaceAll(token, "[redacted]") : message);
    process.exitCode = 1;
  });
}
