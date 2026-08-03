import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function productionTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (!/\.(?:ts|tsx)$/u.test(entry.name) || entry.name.includes(".test.")) return [];
    return [absolute];
  });
}

describe("canonical revision writer boundary", () => {
  it("keeps runtime revision insertion behind the document service writer", () => {
    const sourceRoot = path.join(process.cwd(), "src");
    const writers = productionTypeScriptFiles(sourceRoot)
      .filter((file) => !file.endsWith(path.join("lib", "db", "migrations.ts")))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        const insertions = source.match(/INSERT\s+INTO\s+document_revisions/giu)?.length ?? 0;
        return insertions === 0
          ? []
          : [{ file: path.relative(process.cwd(), file).replaceAll("\\", "/"), insertions }];
      });

    expect(writers).toEqual([{
      file: "src/lib/documents/service.ts",
      insertions: 1,
    }]);
  });
});
