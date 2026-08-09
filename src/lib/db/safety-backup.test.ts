import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withVerifiedDestructiveOperationBackup: vi.fn(),
}));

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await productionTypeScriptFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(absolute);
    }
  }
  return files;
}

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/backup", () => ({
  withVerifiedDestructiveOperationBackup: mocks.withVerifiedDestructiveOperationBackup,
}));

vi.mock("@/lib/config", () => ({
  getBackupRoot: () => "C:/nyxdoc/backups",
  getCollaborationInternalUrl: () => "http://collaboration:3101",
  getCollaborationSecret: () => "test-collaboration-secret",
  getDatabasePath: () => "C:/nyxdoc/data/nyxdoc.db",
  getMediaRoot: () => "C:/nyxdoc/data/media",
}));

import {
  createDestructiveOperationBackup,
  withDestructiveOperationBackup,
} from "@/lib/db/safety-backup";

describe("destructive-operation safety backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NYXDOC_SOURCE_REVISION;
  });

  it("keeps the destructive callback inside one live verified backup contract", async () => {
    const backup = {
      generationPath: "C:/nyxdoc/backups/generation-1",
      manifest: { generationId: "generation-1" },
    };
    mocks.withVerifiedDestructiveOperationBackup.mockImplementation(async (input) => ({
      backup,
      result: await input.operation(backup),
      warnings: [],
    }));

    const result = await withDestructiveOperationBackup((verified) => ({
      usedGenerationId: verified.manifest.generationId,
    }));

    expect(result.result).toEqual({ usedGenerationId: "generation-1" });
    expect(mocks.withVerifiedDestructiveOperationBackup).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "http://collaboration:3101",
      secret: "test-collaboration-secret",
      databasePath: "C:/nyxdoc/data/nyxdoc.db",
      mediaRoot: "C:/nyxdoc/data/media",
      backupRoot: "C:/nyxdoc/backups",
      sourceRevision: "development",
      operation: expect.any(Function),
    }));
  });

  it("fails closed when a caller tries the former backup-then-delete split flow", async () => {
    await expect(createDestructiveOperationBackup()).rejects.toThrow(
      /must run inside withDestructiveOperationBackup/,
    );
    expect(mocks.withVerifiedDestructiveOperationBackup).not.toHaveBeenCalled();
  });

  it("keeps scheduled purge scripts on the same live protected-operation API", async () => {
    const scripts = await Promise.all([
      "scripts/purge-trash.ts",
      "scripts/purge-agents.ts",
    ].map((filename) => readFile(path.resolve(process.cwd(), filename), "utf8")));

    for (const source of scripts) {
      expect(source).toContain("withVerifiedDestructiveOperationBackup");
      expect(source).not.toContain("createBackupGeneration(");
      expect(source).not.toContain("verifyBackupGeneration(");
    }
  });

  it("keeps every production backup call site on an explicit live or verified-offline contract", async () => {
    const sources = Object.fromEntries(await Promise.all([
      "scripts/transfer-workspace-tree.ts",
      "scripts/repair-draft-node-ids.ts",
      "scripts/migrate.ts",
      "scripts/backup.ts",
    ].map(async (filename) => [
      filename,
      await readFile(path.resolve(process.cwd(), filename), "utf8"),
    ])));

    expect(sources["scripts/transfer-workspace-tree.ts"])
      .toContain("withVerifiedDestructiveOperationBackup");
    expect(sources["scripts/repair-draft-node-ids.ts"])
      .toContain("withVerifiedDestructiveOperationBackup");
    expect(sources["scripts/migrate.ts"])
      .toContain("withVerifiedMaintenanceOperationBackup");
    expect(sources["scripts/backup.ts"])
      .toContain("createLiveBackupGeneration");
    expect(sources["scripts/backup.ts"])
      .toContain("withCollaborationBackupBarrier");

    for (const [filename, source] of Object.entries(sources)) {
      expect(source, `${filename} must not call the generic backup primitive`)
        .not.toMatch(/\bcreateBackupGeneration\s*\(/);
      expect(source, `${filename} must not call an unguarded offline backup`)
        .not.toMatch(/\bcreateOfflineBackupGeneration\s*\(/);
    }
  });

  it("does not export the generic backup primitive for future production callers", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src/lib/db/backup.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+createBackupGeneration\b/);
    expect(source).toContain("async function createBackupGenerationInternal");
  });

  it("has no unsafe direct generic or offline backup callers anywhere in production TypeScript", async () => {
    const backupModule = path.resolve(process.cwd(), "src/lib/db/backup.ts");
    const files = (await Promise.all([
      productionTypeScriptFiles(path.resolve(process.cwd(), "scripts")),
      productionTypeScriptFiles(path.resolve(process.cwd(), "src")),
    ])).flat().filter((filename) => filename !== backupModule);

    for (const filename of files) {
      const source = await readFile(filename, "utf8");
      const relative = path.relative(process.cwd(), filename);
      expect(source, `${relative} must not call the generic backup primitive`)
        .not.toMatch(/\bcreateBackupGeneration\s*\(/);
      expect(source, `${relative} must not call the explicit offline backup primitive directly`)
        .not.toMatch(/\bcreateOfflineBackupGeneration\s*\(/);
    }
  });
});
