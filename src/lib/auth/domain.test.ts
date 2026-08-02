import { describe, expect, it } from "vitest";
import { emailDomain, isAllowedEmail, normalizeEmail } from "@/lib/auth/domain";

describe("email domain policy", () => {
  it("normalizes casing and whitespace", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
    expect(emailDomain("Person@Example.COM")).toBe("example.com");
  });

  it("accepts only the exact configured domain", () => {
    expect(isAllowedEmail("person@example.com", "example.com")).toBe(true);
    expect(isAllowedEmail("person@sub.example.com", "example.com")).toBe(false);
    expect(isAllowedEmail("person@example.com.invalid", "example.com")).toBe(false);
    expect(isAllowedEmail("person+tag@example.com", "example.com")).toBe(true);
    expect(isAllowedEmail("not-an-email", "example.com")).toBe(false);
  });
});
