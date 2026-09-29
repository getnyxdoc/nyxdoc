import { describe, expect, it } from "vitest";
import { buildAgentConnectionHref, buildAppReturnHref, buildSettingsHref, normalizeSettingsReturnTo } from "./navigation";

describe("settings navigation context", () => {
  it("preserves the selected agent, document, and initiating organization panel", () => {
    const origin = buildSettingsHref({
      area: "organization",
      workspaceId: "original-workspace",
      documentId: "original-document",
      organizationId: "organization-a",
      anchor: "organization-agents",
    });
    const connection = new URL(buildAgentConnectionHref({
      workspaceId: "target-workspace",
      agentId: "agent-b",
      documentId: "original-document",
      returnTo: origin,
    }), "https://nyxdoc.test");
    expect(connection.pathname).toBe("/settings/agents");
    expect(connection.searchParams.get("workspace")).toBe("target-workspace");
    expect(connection.searchParams.get("agent")).toBe("agent-b");
    expect(connection.searchParams.get("document")).toBe("original-document");
    expect(connection.searchParams.get("returnTo")).toBe(origin);
    expect(connection.hash).toBe("#workspace-agents");
  });

  it("preserves document-dialog restoration context", () => {
    const origin = `${buildAppReturnHref("workspace-a", "document-b")}&assignAgents=1`;
    expect(normalizeSettingsReturnTo(origin)).toBe(origin);
  });

  it("removes automatic connection, onboarding and nested return flags", () => {
    expect(normalizeSettingsReturnTo("/settings/workspace?workspace=a&connectAgent=1&workspaceOnboarding=1&returnTo=%2Fapp#workspace-agents"))
      .toBe("/settings/workspace?workspace=a#workspace-agents");
  });

  it("ignores malformed or repeated return parameters", () => {
    expect(normalizeSettingsReturnTo(["/app", "/settings/agents"])).toBeUndefined();
    expect(normalizeSettingsReturnTo(null)).toBeUndefined();
  });

  it.each([
    "https://outside.example/app", "//outside.example/app", "/\\outside.example/app",
    "javascript:alert(1)", "/sign-in", "/api/account", "/app/other", "/settings/unknown",
    "/%2foutside.example/app", "/app\n", "/settings/agents\u0000", "app",
  ])("rejects an unsafe or unrelated return destination: %s", (destination) => {
    expect(normalizeSettingsReturnTo(destination)).toBeUndefined();
    expect(buildAgentConnectionHref({ workspaceId: "a", returnTo: destination })).not.toContain("returnTo=");
  });

  it("keeps return context when switching settings sections", () => {
    const href = new URL(buildSettingsHref({
      area: "organization",
      workspaceId: "workspace-a",
      documentId: "document-b",
      organizationId: "organization-c",
      returnTo: "/app?workspace=workspace-a&document=document-b",
    }), "https://nyxdoc.test");
    expect(href.searchParams.get("document")).toBe("document-b");
    expect(href.searchParams.get("organization")).toBe("organization-c");
    expect(href.searchParams.get("returnTo")).toBe("/app?workspace=workspace-a&document=document-b");
  });
});
