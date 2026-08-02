import { describe, expect, it } from "vitest";
import { extractLinkTitle, fetchLinkPreview, LinkPreviewError } from "@/lib/links/preview";

describe("link preview", () => {
  it("prefers Open Graph titles and decodes safe entities", () => {
    expect(extractLinkTitle(`
      <html><head>
        <title>Fallback</title>
        <meta property="og:title" content="Nyxdoc &amp; Agents">
      </head></html>
    `)).toBe("Nyxdoc & Agents");
    expect(extractLinkTitle(
      '<meta content="Content first" property="og:title">',
    )).toBe("Content first");
  });

  it("falls back to the HTML title", () => {
    expect(extractLinkTitle("<title>  문서   제목  </title>")).toBe("문서 제목");
    expect(extractLinkTitle("<title>Safe &#99999999; title</title>"))
      .toBe("Safe &#99999999; title");
  });

  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.4/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[64:ff9b::7f00:1]/",
    "ftp://example.com/file",
    "https://user:password@example.com/",
    "https://example.com:8443/",
  ])("rejects unsafe preview target %s", async (url) => {
    await expect(fetchLinkPreview(url)).rejects.toBeInstanceOf(LinkPreviewError);
  });
});
