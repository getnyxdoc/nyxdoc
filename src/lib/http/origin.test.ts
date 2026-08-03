import { describe, expect, it } from "vitest";
import { assertSameOrigin, OriginError } from "@/lib/http/origin";

describe("same-origin mutation guard", () => {
  it("allows configured app origins", () => {
    expect(() =>
      assertSameOrigin(
        new Request("http://localhost:3100/api/documents", {
          method: "POST",
          headers: { origin: "http://localhost:3100", "sec-fetch-site": "same-origin" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects cross-origin browser requests", () => {
    expect(() =>
      assertSameOrigin(
        new Request("http://localhost:3100/api/documents", {
          method: "POST",
          headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
        }),
      ),
    ).toThrow(OriginError);
  });

  it("accepts a runtime site origin supplied by the caller", () => {
    expect(() =>
      assertSameOrigin(
        new Request("https://runtime.example/api/auth/sign-up/email", {
          method: "POST",
          headers: { origin: "https://runtime.example", "sec-fetch-site": "same-origin" },
        }),
        ["https://runtime.example"],
      ),
    ).not.toThrow();
  });
});
