import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../cli/nyxdoc.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("Nyxdoc CLI", () => {
  it("has no connection overhead for help and rejects invalid input before connecting", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const output = vi.fn();
    await run(["--help"], {}, output);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("inspect <operation>"));
    await expect(run(["call", "create_document", "--args", "[]"], {})).rejects.toThrow("JSON object");
    await expect(run(["call", "create_document", "--args", "secret-bad-json"], {})).rejects.toThrow("valid UTF-8 JSON");
    await expect(run(["status"], { NYXDOC_MCP_URL: "http://example.com/mcp", NYXDOC_MCP_BEARER_TOKEN: "secret" })).rejects.toThrow("HTTPS");
    expect(network).not.toHaveBeenCalled();
  });

  it("loads one operation instead of the entire tool catalog and preserves workspace routing", async () => {
    const methods: string[] = [];
    const network = vi.fn(async (url: URL, options: RequestInit) => {
      expect(url.searchParams.get("workspace")).toBe("chosen-workspace");
      expect(url.searchParams.get("profile")).toBe("compact");
      expect(options.redirect).toBe("error");
      const body = JSON.parse(options.body as string);
      methods.push(body.method);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const value = body.method === "initialize"
        ? { serverInfo: { name: "nyxdoc", version: "test" }, protocolVersion: "2025-06-18" }
        : body.params.name === "nyxdoc_discover"
          ? { structuredContent: { tool: "nyxdoc_read", operation: "list_documents" } }
          : { structuredContent: { documents: [], hasMore: false } };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: value });
    });
    vi.stubGlobal("fetch", network);
    const output = vi.fn();
    await run(["call", "list_documents"], { NYXDOC_MCP_URL: "https://example.com/mcp?workspace=chosen-workspace", NYXDOC_MCP_BEARER_TOKEN: "secret" }, output);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"documents": []'));
    expect(JSON.stringify(output.mock.calls)).not.toContain("secret");
  });
});
