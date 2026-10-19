import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../cli/nyxdoc.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("Nyxdoc CLI", () => {
  it.each(["structured", "text", "rpc"])("reports bounded, redacted %s errors with actionable details", async (format) => {
    const detail = {
      code: "INVALID_INPUT",
      reason: "Markdown 변환 실패 secret-token\u001b\n",
      issues: [{ path: ["blocks", 0], message: "문서 형식을 확인하세요." }],
      privateData: "never-print-this",
    };
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "nyxdoc" }, protocolVersion: "2025-06-18" } });
      }
      if (format === "rpc") {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: detail.reason } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {
        isError: true,
        ...(format === "structured" ? { structuredContent: detail } : { content: [{ type: "text", text: JSON.stringify(detail) }] }),
      } });
    }));
    const output = vi.fn();
    const error = await run(["inspect", "create_document_from_markdown"], {
      NYXDOC_MCP_URL: "https://example.com/mcp", NYXDOC_MCP_BEARER_TOKEN: "secret-token",
    }, output).catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Markdown 변환 실패 [redacted]");
    expect(message).not.toMatch(/secret-token|never-print-this|[\u0000-\u001f]/);
    if (format !== "rpc") expect(message).toContain("blocks.0: 문서 형식을 확인하세요.");
    expect(message).toContain("same requestId");
    expect(output).not.toHaveBeenCalled();
  });

  it("caps unstructured server error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize"
        ? { serverInfo: { name: "nyxdoc" }, protocolVersion: "2025-06-18" }
        : { isError: true, content: [{ type: "text", text: "x".repeat(10000) }] } });
    }));
    const error = await run(["discover"], {
      NYXDOC_MCP_URL: "https://example.com/mcp", NYXDOC_MCP_BEARER_TOKEN: "secret",
    }).catch((failure: Error) => failure);
    expect((error as Error).message.length).toBeLessThan(900);
  });

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
