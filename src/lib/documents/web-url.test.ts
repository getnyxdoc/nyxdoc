import { describe, expect, it } from "vitest";
import { getDocumentWebUrl } from "@/lib/documents/web-url";

describe("getDocumentWebUrl", () => {
  it("builds an absolute human-facing URL from the configured public base URL", () => {
    expect(getDocumentWebUrl(
      "f0c9eeb9-bf30-4aa1-a73a-7859f87b8c28",
      "b77c28a3-5659-46f4-8f16-f905f5cf86b6",
      "https://app.nyxdoc.com/",
    )).toBe(
      "https://app.nyxdoc.com/app?workspace=f0c9eeb9-bf30-4aa1-a73a-7859f87b8c28&document=b77c28a3-5659-46f4-8f16-f905f5cf86b6",
    );
  });

  it("does not preserve an unrelated path from the public base URL", () => {
    expect(getDocumentWebUrl("workspace", "document", "https://example.test/install/"))
      .toBe("https://example.test/app?workspace=workspace&document=document");
  });
});
