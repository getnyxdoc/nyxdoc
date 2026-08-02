import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  detectLocale,
  normalizeLocale,
} from "@/lib/i18n/locales";
import { en, ja, ko, translate } from "@/lib/i18n/messages";

describe("Nyxdoc locales", () => {
  it("detects supported browser languages by quality", () => {
    expect(detectLocale("fr-FR, ja-JP;q=0.9, en;q=0.8")).toBe("ja");
    expect(detectLocale("ko-KR, en;q=0.5")).toBe("ko");
    expect(detectLocale("de-DE")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("EN_us")).toBe("en");
  });

  it("keeps all locale dictionaries structurally complete", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    expect(translate("ja", "auth.allowedDomains", { domains: "@example.jp" }))
      .toContain("@example.jp");
  });
});
