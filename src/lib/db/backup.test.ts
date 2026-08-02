import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBackupGeneration,
  restoreBackupGeneration,
  verifyBackupGeneration,
} from "@/lib/db/backup";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import { APP_MIGRATIONS, runAppMigrations } from "@/lib/db/migrations";
import { createTestUser } from "@/test/fixture";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((entry) => rm(entry, {
    recursive: true,
    force: true,
  })));
});

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function registerMediaAsset(input: {
  database: NyxDatabase;
  workspaceId: string;
  storageKey: string;
  bytes: Buffer;
  sha256Override?: string;
}) {
  input.database.prepare(
    `INSERT INTO media_assets
       (id, workspace_id, storage_key, sha256, mime_type, byte_size, original_filename, created_at)
     VALUES (?, ?, ?, ?, 'image/webp', ?, 'backup-test.webp', ?)`,
  ).run(
    randomUUID(),
    input.workspaceId,
    input.storageKey,
    input.sha256Override ?? sha256(input.bytes),
    input.bytes.length,
    new Date().toISOString(),
  );
}

async function createBackupSource(root: string) {
  const databasePath = path.join(root, "source", "nyxdoc.db");
  const mediaRoot = path.join(root, "source", "media");
  const backupRoot = path.join(root, "generations");
  await mkdir(path.dirname(databasePath), { recursive: true });
  await mkdir(mediaRoot, { recursive: true });
  const database = openDatabase(databasePath);
  database.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
  runAppMigrations(database, { sourceRevision: "backup-test" });
  const { workspace } = createTestUser(database);
  return { backupRoot, database, databasePath, mediaRoot, workspaceId: workspace.id };
}

describe("backup generations", () => {
  it("backs up and verifies SQLite, migrations, fingerprints, and media hashes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-test-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot, workspaceId } = await createBackupSource(root);
    const mediaBytes = Buffer.from("immutable-media");
    const storageKey = "a8/backup-test.webp";
    registerMediaAsset({ database, workspaceId, storageKey, bytes: mediaBytes });
    database.close();
    await mkdir(path.join(mediaRoot, "a8"), { recursive: true });
    await writeFile(path.join(mediaRoot, storageKey), mediaBytes);

    const generation = await createBackupGeneration({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "backup-test",
    });
    const verified = await verifyBackupGeneration(generation.generationPath);

    expect(verified.manifest.sourceRevision).toBe("backup-test");
    expect(verified.manifest.media).toMatchObject({ fileCount: 1 });
    expect(verified.manifest.media.files).toEqual([{
      path: storageKey,
      byteSize: mediaBytes.length,
      sha256: sha256(mediaBytes),
    }]);
    expect(verified.manifest.database.tableInventory.documents).toBe(1);
    expect(verified.manifest.migrations).toHaveLength(APP_MIGRATIONS.length);

    const restoredDatabasePath = path.join(root, "restored", "nyxdoc.db");
    const restoredMediaRoot = path.join(root, "restored", "media");
    const restored = await restoreBackupGeneration({
      generationPath: generation.generationPath,
      databasePath: restoredDatabasePath,
      mediaRoot: restoredMediaRoot,
      confirmedGenerationId: generation.manifest.generationId,
    });
    expect(restored.databaseSha256).toBe(generation.manifest.database.sha256);
    const restoredDatabase = openDatabase(restoredDatabasePath);
    expect(restoredDatabase.prepare("SELECT COUNT(*) AS count FROM documents").get())
      .toEqual({ count: 1 });
    restoredDatabase.close();
    await expect(readFile(path.join(restoredMediaRoot, storageKey))).resolves.toEqual(mediaBytes);

    await expect(restoreBackupGeneration({
      generationPath: generation.generationPath,
      databasePath: restoredDatabasePath,
      mediaRoot: restoredMediaRoot,
      confirmedGenerationId: generation.manifest.generationId,
    })).rejects.toThrow(/target already exists/);

    await writeFile(path.join(generation.generationPath, "media", storageKey), "tampered");
    await expect(verifyBackupGeneration(generation.generationPath)).rejects.toThrow(
      /media mismatch/,
    );
  });

  it("fails closed when the database snapshot references media removed from storage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-missing-media-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot, workspaceId } = await createBackupSource(root);
    registerMediaAsset({
      database,
      workspaceId,
      storageKey: "de/deleted-after-snapshot.webp",
      bytes: Buffer.from("expected-at-snapshot"),
    });
    database.close();

    await expect(createBackupGeneration({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "backup-test",
    })).rejects.toThrow(/missing from storage/);
  });

  it("excludes live media that is not referenced by the database snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-extra-media-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot, workspaceId } = await createBackupSource(root);
    const expectedBytes = Buffer.from("referenced-media");
    const expectedStorageKey = "ef/referenced.webp";
    registerMediaAsset({ database, workspaceId, storageKey: expectedStorageKey, bytes: expectedBytes });
    database.close();
    await mkdir(path.join(mediaRoot, "ef"), { recursive: true });
    await mkdir(path.join(mediaRoot, "new"), { recursive: true });
    await writeFile(path.join(mediaRoot, expectedStorageKey), expectedBytes);
    await writeFile(path.join(mediaRoot, "new", "created-after-snapshot.webp"), "not-in-snapshot");

    const generation = await createBackupGeneration({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "backup-test",
    });
    expect(generation.manifest.media.files.map((file) => file.path)).toEqual([expectedStorageKey]);
    await expect(readFile(path.join(
      generation.generationPath,
      "media",
      "new",
      "created-after-snapshot.webp",
    ))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(verifyBackupGeneration(generation.generationPath)).resolves.toBeDefined();
  });

  it("fails closed when live media does not match the snapshot hash", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-hash-mismatch-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot, workspaceId } = await createBackupSource(root);
    const expectedBytes = Buffer.from("snapshot-media");
    const storageKey = "ba/hash-mismatch.webp";
    registerMediaAsset({ database, workspaceId, storageKey, bytes: expectedBytes });
    database.close();
    await mkdir(path.join(mediaRoot, "ba"), { recursive: true });
    await writeFile(path.join(mediaRoot, storageKey), "tampered-live-media");

    await expect(createBackupGeneration({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "backup-test",
    })).rejects.toThrow(/media mismatch/);
  });
});
