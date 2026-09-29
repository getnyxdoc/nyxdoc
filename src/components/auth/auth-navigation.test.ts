import { describe, expect, it } from "vitest";
import { buildAuthPageHref, normalizeAuthCallbackURL } from "./auth-navigation";

describe("auth callback navigation", () => {
  it.each([
    "/app?workspace=workspace-a&document=document-b#section-c",
    "/organization-invite?invite=synthetic-invite",
    "/oauth/authorize?client_id=synthetic-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&state=original-state",
  ])("preserves a local destination through verification and sign-in: %s", (destination) => {
    const verification = new URL(buildAuthPageHref("/verify-email", { callbackURL: destination, email: "fixture@example.com" }), "https://nyxdoc.test");
    expect(verification.pathname).toBe("/verify-email");
    expect(verification.searchParams.get("email")).toBe("fixture@example.com");
    expect(verification.searchParams.get("callbackURL")).toBe(destination);
    const signIn = new URL(buildAuthPageHref("/sign-in", { callbackURL: verification.searchParams.get("callbackURL") }), "https://nyxdoc.test");
    expect(signIn.searchParams.get("callbackURL")).toBe(destination);
  });

  it.each([
    "https://outside.example/app", "//outside.example/app", "javascript:alert(1)",
    "/\\outside.example/app", "/.//outside.example/app", "/%2foutside.example/app",
    "/%5coutside.example/app", "/app\n", "/app%0a", "/%E0%A4%A",
    ["/app", "https://outside.example"], null, undefined,
  ])("rejects unsafe callback values: %j", (destination) => {
    expect(normalizeAuthCallbackURL(destination)).toBe("/app");
    expect(buildAuthPageHref("/sign-in", { callbackURL: destination })).toBe("/sign-in");
  });

  it("keeps default auth links concise", () => {
    expect(buildAuthPageHref("/verify-email", { email: "fixture@example.com" }))
      .toBe("/verify-email?email=fixture%40example.com");
    expect(buildAuthPageHref("/sign-up", { callbackURL: "/app" })).toBe("/sign-up");
  });
});
