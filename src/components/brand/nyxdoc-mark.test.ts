import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Nyxdoc brand assets", () => {
  it("uses the shared-spark mark everywhere the product lockup is rendered", async () => {
    const [mark, layout, landing, auth, workspace, settings, dockerfile] = await Promise.all([
      readFile(path.join(root, "public", "nyxdoc-mark.svg"), "utf8"),
      readFile(path.join(root, "src", "app", "layout.tsx"), "utf8"),
      readFile(path.join(root, "src", "app", "page.tsx"), "utf8"),
      readFile(path.join(root, "src", "components", "auth", "auth-shell.tsx"), "utf8"),
      readFile(path.join(root, "src", "components", "workspace", "workspace-shell.tsx"), "utf8"),
      readFile(path.join(root, "src", "components", "settings", "settings-shell.tsx"), "utf8"),
      readFile(path.join(root, "Dockerfile"), "utf8"),
    ]);

    expect(mark).toContain("<title>Nyxdoc</title>");
    expect(mark).toContain("#389F7B");
    expect(layout).toContain("/site.webmanifest");
    expect(layout).toContain("/og.png");
    expect(dockerfile).toContain("/app/public ./public");

    for (const source of [landing, auth, workspace, settings]) {
      expect(source).toContain("<NyxdocMark");
      expect(source).not.toMatch(/<Sparkles/);
    }
  });

  it("ships favicon, install, and social preview assets", async () => {
    await Promise.all([
      access(path.join(root, "src", "app", "favicon.ico")),
      access(path.join(root, "public", "apple-touch-icon.png")),
      access(path.join(root, "public", "nyxdoc-icon-192.png")),
      access(path.join(root, "public", "nyxdoc-icon-512.png")),
      access(path.join(root, "public", "og.png")),
    ]);

    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "site.webmanifest"), "utf8"),
    ) as { name: string; icons: Array<{ sizes: string }> };

    expect(manifest.name).toBe("Nyxdoc");
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
  });
});
