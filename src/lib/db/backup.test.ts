import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveBackupGeneration,
  createOfflineBackupGeneration,
  recoverStaleOfflineOperationLock,
  restoreBackupGeneration,
  verifyBackupGeneration,
  withCollaborationBackupBarrier,
  withVerifiedDestructiveOperationBackup,
  withVerifiedMaintenanceOperationBackup,
  withVerifiedOfflineOperationBackup,
  type BackupCollaborationBarrier,
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

async function closedCollaborationBaseUrl() {
  // Bind and release a loopback port without accepting any connections. The
  // subsequent health probe therefore receives an explicit ECONNREFUSED
  // instead of relying on an ambiguous DNS failure as offline proof.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve refusal port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return `http://127.0.0.1:${address.port}`;
}

async function createOfflineTestBackup(
  input: Omit<Parameters<typeof createOfflineBackupGeneration>[0], "collaborationBaseUrl">,
) {
  return createOfflineBackupGeneration({
    ...input,
    collaborationBaseUrl: await closedCollaborationBaseUrl(),
    offlineCheckTimeoutMs: 500,
  });
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

    const generation = await createOfflineTestBackup({
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
    })).resolves.toMatchObject({
      generationId: generation.manifest.generationId,
      databasePath: restoredDatabasePath,
      mediaRoot: restoredMediaRoot,
    });

    const mediaOnlyDatabasePath = path.join(root, "media-only", "nyxdoc.db");
    const mediaOnlyRoot = path.join(root, "media-only", "media");
    await mkdir(path.join(mediaOnlyRoot, "a8"), { recursive: true });
    await copyFile(
      path.join(generation.generationPath, "media", storageKey),
      path.join(mediaOnlyRoot, storageKey),
    );
    await expect(restoreBackupGeneration({
      generationPath: generation.generationPath,
      databasePath: mediaOnlyDatabasePath,
      mediaRoot: mediaOnlyRoot,
      confirmedGenerationId: generation.manifest.generationId,
    })).resolves.toMatchObject({ generationId: generation.manifest.generationId });
    const mediaOnlyDatabase = openDatabase(mediaOnlyDatabasePath);
    expect(mediaOnlyDatabase.prepare("SELECT COUNT(*) AS count FROM documents").get())
      .toEqual({ count: 1 });
    mediaOnlyDatabase.close();

    const emptyMediaDatabasePath = path.join(root, "empty-media", "nyxdoc.db");
    const emptyMediaRoot = path.join(root, "empty-media", "media");
    await mkdir(emptyMediaRoot, { recursive: true });
    await expect(restoreBackupGeneration({
      generationPath: generation.generationPath,
      databasePath: emptyMediaDatabasePath,
      mediaRoot: emptyMediaRoot,
      confirmedGenerationId: generation.manifest.generationId,
    })).resolves.toMatchObject({ generationId: generation.manifest.generationId });
    await expect(readFile(path.join(emptyMediaRoot, storageKey))).resolves.toEqual(mediaBytes);

    const databaseOnlyPath = path.join(root, "database-only", "nyxdoc.db");
    const databaseOnlyMediaRoot = path.join(root, "database-only", "media");
    await mkdir(path.dirname(databaseOnlyPath), { recursive: true });
    await copyFile(path.join(generation.generationPath, "nyxdoc.db"), databaseOnlyPath);
    await expect(restoreBackupGeneration({
      generationPath: generation.generationPath,
      databasePath: databaseOnlyPath,
      mediaRoot: databaseOnlyMediaRoot,
      confirmedGenerationId: generation.manifest.generationId,
    })).resolves.toMatchObject({ generationId: generation.manifest.generationId });
    await expect(readFile(path.join(databaseOnlyMediaRoot, storageKey))).resolves.toEqual(mediaBytes);

    const mismatchedDatabasePath = path.join(root, "mismatched", "nyxdoc.db");
    await mkdir(path.dirname(mismatchedDatabasePath), { recursive: true });
    await writeFile(mismatchedDatabasePath, "not-the-confirmed-backup");
    await expect(restoreBackupGeneration({
      generationPath: generation.generationPath,
      databasePath: mismatchedDatabasePath,
      mediaRoot: path.join(root, "mismatched", "media"),
      confirmedGenerationId: generation.manifest.generationId,
    })).rejects.toThrow(/does not match the confirmed backup/);

    await writeFile(path.join(generation.generationPath, "media", storageKey), "tampered");
    await expect(verifyBackupGeneration(generation.generationPath)).rejects.toThrow(
      /media mismatch/,
    );
  });

  it("fails closed on stale SQLite sidecars and verifies the final installed database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-stale-wal-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    const originalDocument = database.prepare(
      "SELECT id, title FROM documents ORDER BY id LIMIT 1",
    ).get() as { id: string; title: string };
    database.close();

    const generation = await createOfflineTestBackup({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "backup-test",
    });
    const backupDatabasePath = path.join(generation.generationPath, "nyxdoc.db");
    const restoredDatabasePath = path.join(root, "restored", "nyxdoc.db");
    const restoredMediaRoot = path.join(root, "restored", "media");
    const savedWalPath = path.join(root, "compatible-stale.wal");
    const savedShmPath = path.join(root, "compatible-stale.shm");
    await mkdir(path.dirname(restoredDatabasePath), { recursive: true });
    await copyFile(backupDatabasePath, restoredDatabasePath);

    const staleWriter = openDatabase(restoredDatabasePath);
    staleWriter.pragma("wal_autocheckpoint = 0");
    staleWriter.prepare("UPDATE documents SET title = ? WHERE id = ?")
      .run("replayed-from-stale-wal", originalDocument.id);
    expect(sha256(await readFile(restoredDatabasePath)))
      .toBe(generation.manifest.database.sha256);
    await copyFile(`${restoredDatabasePath}-wal`, savedWalPath);
    await copyFile(`${restoredDatabasePath}-shm`, savedShmPath);
    staleWriter.close();
    await rm(restoredDatabasePath, { force: true });
    await rm(`${restoredDatabasePath}-wal`, { force: true });
    await rm(`${restoredDatabasePath}-shm`, { force: true });

    const replayProbePath = path.join(root, "replay-probe", "nyxdoc.db");
    await mkdir(path.dirname(replayProbePath), { recursive: true });
    await copyFile(backupDatabasePath, replayProbePath);
    await copyFile(savedWalPath, `${replayProbePath}-wal`);
    const replayProbe = openDatabase(replayProbePath);
    expect(replayProbe.prepare("SELECT title FROM documents WHERE id = ?")
      .get(originalDocument.id)).toEqual({ title: "replayed-from-stale-wal" });
    replayProbe.close();

    await copyFile(savedWalPath, `${restoredDatabasePath}-wal`);
    await copyFile(savedShmPath, `${restoredDatabasePath}-shm`);
    await expect(restoreBackupGeneration({
      generationPath: generation.generationPath,
      databasePath: restoredDatabasePath,
      mediaRoot: restoredMediaRoot,
      confirmedGenerationId: generation.manifest.generationId,
    })).rejects.toThrow(/SQLite sidecar target already exists: .*nyxdoc\.db-wal/);
    await expect(readFile(restoredDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(restoredMediaRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await rm(`${restoredDatabasePath}-wal`);
    await expect(restoreBackupGeneration({
      generationPath: generation.generationPath,
      databasePath: restoredDatabasePath,
      mediaRoot: restoredMediaRoot,
      confirmedGenerationId: generation.manifest.generationId,
    })).rejects.toThrow(/SQLite sidecar target already exists: .*nyxdoc\.db-shm/);

    await rm(`${restoredDatabasePath}-shm`);
    await expect(restoreBackupGeneration({
      generationPath: generation.generationPath,
      databasePath: restoredDatabasePath,
      mediaRoot: restoredMediaRoot,
      confirmedGenerationId: generation.manifest.generationId,
    })).resolves.toMatchObject({ generationId: generation.manifest.generationId });
    expect(sha256(await readFile(restoredDatabasePath)))
      .toBe(generation.manifest.database.sha256);
    const installedDatabase = openDatabase(restoredDatabasePath);
    expect(installedDatabase.prepare("SELECT title FROM documents WHERE id = ?")
      .get(originalDocument.id)).toEqual({ title: originalDocument.title });
    installedDatabase.close();
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

    await expect(createOfflineTestBackup({
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

    const generation = await createOfflineTestBackup({
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

    await expect(createOfflineTestBackup({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "backup-test",
    })).rejects.toThrow(/media mismatch/);
  });

  it("persists the collaboration flush watermark in a verified generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-barrier-receipt-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const now = Date.now();
    const collaborationBarrier: BackupCollaborationBarrier = {
      barrierId: randomUUID(),
      acquiredAt: new Date(now - 1_000).toISOString(),
      flushedAt: new Date(now - 500).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      flushWatermark: 42,
      loadedDocumentCount: 3,
    };
    let assertions = 0;

    const generation = await createLiveBackupGeneration({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "backup-barrier-test",
      collaborationBarrier,
      assertCollaborationBarrierHeld: async () => {
        assertions += 1;
      },
    });
    const verified = await verifyBackupGeneration(generation.generationPath);

    expect(assertions).toBe(4);
    expect(verified.manifest.collaborationBarrier).toMatchObject(collaborationBarrier);
    expect(verified.manifest.collaborationBarrier).toMatchObject({
      checkpointRecordedAt: expect.any(String),
    });
    const snapshot = openDatabase(path.join(generation.generationPath, "nyxdoc.db"));
    expect(snapshot.prepare(
      `SELECT barrier_id AS barrierId, flush_watermark AS flushWatermark,
              checkpoint_recorded_at AS checkpointRecordedAt
       FROM collaboration_backup_checkpoints WHERE checkpoint_slot = 1`,
    ).get()).toEqual({
      barrierId: collaborationBarrier.barrierId,
      flushWatermark: collaborationBarrier.flushWatermark,
      checkpointRecordedAt: verified.manifest.collaborationBarrier
        && "checkpointRecordedAt" in verified.manifest.collaborationBarrier
        ? verified.manifest.collaborationBarrier.checkpointRecordedAt
        : undefined,
    });
    snapshot.close();
  });

  it("rejects a snapshot whose SQLite checkpoint is below the acquired flush watermark", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-stale-checkpoint-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const now = Date.now();
    let assertions = 0;

    await expect(createLiveBackupGeneration({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "stale-checkpoint-test",
      collaborationBarrier: {
        barrierId: randomUUID(),
        acquiredAt: new Date(now - 1_000).toISOString(),
        flushedAt: new Date(now - 500).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        flushWatermark: 42,
        loadedDocumentCount: 1,
      },
      assertCollaborationBarrierHeld: async () => {
        assertions += 1;
        if (assertions === 2) {
          const live = openDatabase(databasePath);
          live.prepare(
            "UPDATE collaboration_backup_checkpoints SET flush_watermark = 41 WHERE checkpoint_slot = 1",
          ).run();
          live.close();
        }
      },
    })).rejects.toThrow(/checkpoint does not cover/);

    expect(assertions).toBe(2);
    expect(await readdir(backupRoot)).toEqual([]);
  });

  it("does not finalize a generation when the collaboration barrier is no longer held", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-barrier-lost-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const now = Date.now();

    await expect(createLiveBackupGeneration({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "backup-barrier-test",
      collaborationBarrier: {
        barrierId: randomUUID(),
        acquiredAt: new Date(now - 1_000).toISOString(),
        flushedAt: new Date(now - 500).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        flushWatermark: 7,
        loadedDocumentCount: 1,
      },
      assertCollaborationBarrierHeld: async () => {
        throw new Error("barrier lease lost");
      },
    })).rejects.toThrow("barrier lease lost");

    expect(await readdir(backupRoot)).toEqual([]);
  });

  it("verifies staging and the live lease immediately before publishing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-final-status-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const now = Date.now();
    let assertions = 0;

    await expect(createLiveBackupGeneration({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "backup-final-status-test",
      collaborationBarrier: {
        barrierId: randomUUID(),
        acquiredAt: new Date(now - 1_000).toISOString(),
        flushedAt: new Date(now - 500).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        flushWatermark: 9,
        loadedDocumentCount: 1,
      },
      assertCollaborationBarrierHeld: async () => {
        assertions += 1;
        if (assertions === 4) throw new Error("final barrier status failed");
      },
    })).rejects.toThrow("final barrier status failed");

    expect(assertions).toBe(4);
    expect(await readdir(backupRoot)).toEqual([]);
  });

  it("removes a published generation when the pre-operation barrier check fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-post-publish-status-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const now = Date.now();
    const receipt: BackupCollaborationBarrier = {
      barrierId: randomUUID(),
      acquiredAt: new Date(now - 1_000).toISOString(),
      flushedAt: new Date(now - 500).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      flushWatermark: 10,
      loadedDocumentCount: 1,
    };
    let statusCalls = 0;
    const operation = vi.fn();
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname.endsWith("/release")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ barrierId: receipt.barrierId, released: true }));
        return;
      }
      if (pathname.endsWith("/status")) {
        statusCalls += 1;
        if (statusCalls === 5) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "barrier expired after publish" }));
          return;
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(receipt));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start barrier server");

    try {
      await expect(withVerifiedDestructiveOperationBackup({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "post-publish-status-test",
        databasePath,
        mediaRoot,
        backupRoot,
        sourceRevision: "post-publish-status-test",
        operation,
      })).rejects.toThrow(/barrier expired after publish/);
      expect(statusCalls).toBe(5);
      expect(operation).not.toHaveBeenCalled();
      expect(await readdir(backupRoot)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a partial live-barrier contract instead of silently creating an offline backup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-partial-barrier-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();

    await expect(createLiveBackupGeneration({
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "partial-live-contract",
      collaborationBarrier: {
        barrierId: randomUUID(),
        acquiredAt: new Date().toISOString(),
        flushedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        flushWatermark: 1,
        loadedDocumentCount: 1,
      },
    } as Parameters<typeof createLiveBackupGeneration>[0])).rejects.toThrow(
      /both a collaboration barrier receipt and a held assertion/,
    );
    await expect(readdir(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a lost release response after a completed operation as a warning, not a retryable failure", async () => {
    const warning = vi.fn();
    const now = Date.now();
    const receipt: BackupCollaborationBarrier = {
      barrierId: randomUUID(),
      acquiredAt: new Date(now - 1_000).toISOString(),
      flushedAt: new Date(now - 500).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      flushWatermark: 12,
      loadedDocumentCount: 2,
    };
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname.endsWith("/release")) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(receipt));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start barrier server");

    try {
      await expect(withCollaborationBackupBarrier({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "release-loss-test",
        onReleaseWarning: warning,
        callback: async ({ assertHeld }) => {
          await assertHeld();
          return "completed";
        },
      })).resolves.toBe("completed");
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps a verified published generation authoritative when only release acknowledgement is lost", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-release-ack-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const now = Date.now();
    const receipt: BackupCollaborationBarrier = {
      barrierId: randomUUID(),
      acquiredAt: new Date(now - 1_000).toISOString(),
      flushedAt: new Date(now - 500).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      flushWatermark: 13,
      loadedDocumentCount: 1,
    };
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname.endsWith("/release")) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(receipt));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start barrier server");

    try {
      const protectedOperation = await withVerifiedDestructiveOperationBackup({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "release-ack-test",
        databasePath,
        mediaRoot,
        backupRoot,
        sourceRevision: "release-ack-test",
        operation: () => "completed",
      });
      expect(protectedOperation.result).toBe("completed");
      expect(protectedOperation.warnings).toHaveLength(1);
      await expect(verifyBackupGeneration(protectedOperation.backup.generationPath))
        .resolves.toMatchObject({
          manifest: { generationId: protectedOperation.backup.manifest.generationId },
        });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves the verified pre-operation backup and forwards a destructive operation error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-backup-operation-error-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const now = Date.now();
    const receipt: BackupCollaborationBarrier = {
      barrierId: randomUUID(),
      acquiredAt: new Date(now - 1_000).toISOString(),
      flushedAt: new Date(now - 500).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      flushWatermark: 14,
      loadedDocumentCount: 1,
    };
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(pathname.endsWith("/release")
        ? { barrierId: receipt.barrierId, released: true }
        : receipt));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start barrier server");
    const operation = vi.fn(() => {
      throw new Error("destructive mutation failed");
    });

    try {
      await expect(withVerifiedDestructiveOperationBackup({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "operation-error-test",
        databasePath,
        mediaRoot,
        backupRoot,
        sourceRevision: "operation-error-test",
        operation,
      })).rejects.toThrow("destructive mutation failed");
      expect(operation).toHaveBeenCalledOnce();
      const generations = await readdir(backupRoot);
      expect(generations).toHaveLength(1);
      await expect(verifyBackupGeneration(path.join(backupRoot, generations[0]!)))
        .resolves.toMatchObject({
          manifest: { sourceRevision: "operation-error-test" },
        });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed before offline snapshot work when the collaboration service is reachable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-offline-backup-online-server-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const operation = vi.fn();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: "nyxdoc-collaboration" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start health server");

    try {
      await expect(withVerifiedOfflineOperationBackup({
        collaborationBaseUrl: `http://127.0.0.1:${address.port}`,
        databasePath,
        mediaRoot,
        backupRoot,
        sourceRevision: "offline-reachable-test",
        operation,
      })).rejects.toThrow(/collaboration server is online/i);
      expect(operation).not.toHaveBeenCalled();
      await expect(readdir(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed when collaboration availability is ambiguous instead of treating a timeout as offline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-offline-backup-health-timeout-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const operation = vi.fn();
    const server = createServer(() => {
      // Intentionally leave the health request unanswered. A timeout is not
      // mechanical proof that collaboration is stopped.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start health server");

    try {
      await expect(withVerifiedOfflineOperationBackup({
        collaborationBaseUrl: `http://127.0.0.1:${address.port}`,
        databasePath,
        mediaRoot,
        backupRoot,
        sourceRevision: "offline-health-timeout-test",
        offlineCheckTimeoutMs: 100,
        operation,
      })).rejects.toThrow(/could not mechanically prove/i);
      expect(operation).not.toHaveBeenCalled();
      await expect(readdir(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["ENOTFOUND", "EAI_NONAME"])(
    "fails closed on %s DNS failure without starting the maintenance callback",
    async (code) => {
      const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-maintenance-dns-failure-"));
      temporaryPaths.push(root);
      const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
      database.close();
      const operation = vi.fn();
      const resolutionError = Object.assign(new Error("name resolution failed"), { code });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
        Object.assign(new TypeError("fetch failed"), { cause: resolutionError }),
      );

      try {
        await expect(withVerifiedMaintenanceOperationBackup({
          baseUrl: "http://collaboration.invalid:3101",
          secret: "unused-on-dns-failure",
          databasePath,
          mediaRoot,
          backupRoot,
          sourceRevision: "maintenance-dns-failure-test",
          offlineCheckTimeoutMs: 100,
          operation,
        })).rejects.toThrow(/could not mechanically prove/i);
        expect(operation).not.toHaveBeenCalled();
        await expect(readdir(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        fetchMock.mockRestore();
      }
    },
  );

  it("serializes explicit offline operations with a fail-closed database lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-offline-backup-lock-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const lockPath = `${path.resolve(databasePath)}.offline-operation.lock`;
    await writeFile(lockPath, "operator-owned\n", "utf8");
    const operation = vi.fn();

    await expect(withVerifiedOfflineOperationBackup({
      collaborationBaseUrl: await closedCollaborationBaseUrl(),
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "offline-lock-test",
      offlineCheckTimeoutMs: 500,
      operation,
    })).rejects.toThrow(/another offline database operation is active/i);
    expect(operation).not.toHaveBeenCalled();
    await expect(readdir(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe("operator-owned\n");
  });

  it("recovers an abruptly abandoned stale lock only with its verified matching backup receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-offline-lock-abrupt-recovery-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const collaborationBaseUrl = await closedCollaborationBaseUrl();
    const lockPath = `${path.resolve(databasePath)}.offline-operation.lock`;
    let preparedLock = "";

    const protectedOperation = await withVerifiedOfflineOperationBackup({
      collaborationBaseUrl,
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "abrupt-lock-recovery-test",
      offlineCheckTimeoutMs: 500,
      operation: async () => {
        preparedLock = await readFile(lockPath, "utf8");
        return "operation-started";
      },
    });
    expect(protectedOperation.result).toBe("operation-started");
    const abandoned = JSON.parse(preparedLock) as {
      pid: number;
      createdAt: string;
      phase: string;
      backup: { generationId: string };
    };
    expect(abandoned.phase).toBe("backup-verified");
    expect(abandoned.backup.generationId).toBe(protectedOperation.backup.manifest.generationId);
    // Model SIGKILL/power loss after the operation callback began: the owner is
    // gone, the lock is old, and finally-cleanup never ran.
    abandoned.pid = 2_000_000_000;
    abandoned.createdAt = "2020-01-01T00:00:00.000Z";
    await writeFile(lockPath, `${JSON.stringify(abandoned)}\n`, "utf8");

    await expect(recoverStaleOfflineOperationLock({
      databasePath,
      backupGenerationPath: protectedOperation.backup.generationPath,
      confirmedGenerationId: protectedOperation.backup.manifest.generationId,
      collaborationBaseUrl,
      minimumStaleMs: 60_000,
      offlineCheckTimeoutMs: 500,
    })).resolves.toMatchObject({
      backupGenerationId: protectedOperation.backup.manifest.generationId,
      databasePath: path.resolve(databasePath),
    });
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(verifyBackupGeneration(protectedOperation.backup.generationPath))
      .resolves.toMatchObject({
        manifest: { sourceRevision: "abrupt-lock-recovery-test" },
      });

    // The documented db:migrate CLI path supplies the same confirmation via
    // environment. Exercise that acquisition-time path, not just the direct
    // recovery API.
    await writeFile(lockPath, `${JSON.stringify(abandoned)}\n`, "utf8");
    const recoveryEnvironment = {
      generation: process.env.NYXDOC_RECOVER_STALE_OFFLINE_LOCK,
      confirmation: process.env.NYXDOC_RECOVER_STALE_OFFLINE_LOCK_CONFIRM,
      staleSeconds: process.env.NYXDOC_RECOVER_STALE_OFFLINE_LOCK_MIN_AGE_SECONDS,
    };
    process.env.NYXDOC_RECOVER_STALE_OFFLINE_LOCK = protectedOperation.backup.generationPath;
    process.env.NYXDOC_RECOVER_STALE_OFFLINE_LOCK_CONFIRM =
      protectedOperation.backup.manifest.generationId;
    process.env.NYXDOC_RECOVER_STALE_OFFLINE_LOCK_MIN_AGE_SECONDS = "60";
    try {
      await expect(withVerifiedOfflineOperationBackup({
        collaborationBaseUrl,
        databasePath,
        mediaRoot,
        backupRoot,
        sourceRevision: "documented-cli-lock-recovery-test",
        offlineCheckTimeoutMs: 500,
        operation: () => "recovered-and-ran",
      })).resolves.toMatchObject({ result: "recovered-and-ran" });
    } finally {
      for (const [key, value] of Object.entries({
        NYXDOC_RECOVER_STALE_OFFLINE_LOCK: recoveryEnvironment.generation,
        NYXDOC_RECOVER_STALE_OFFLINE_LOCK_CONFIRM: recoveryEnvironment.confirmation,
        NYXDOC_RECOVER_STALE_OFFLINE_LOCK_MIN_AGE_SECONDS: recoveryEnvironment.staleSeconds,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a stale lock when its owner is alive or its recovery receipt does not match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-offline-lock-refusal-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const collaborationBaseUrl = await closedCollaborationBaseUrl();
    const lockPath = `${path.resolve(databasePath)}.offline-operation.lock`;
    let preparedLock = "";
    const protectedOperation = await withVerifiedOfflineOperationBackup({
      collaborationBaseUrl,
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "stale-lock-refusal-test",
      offlineCheckTimeoutMs: 500,
      operation: async () => {
        preparedLock = await readFile(lockPath, "utf8");
      },
    });
    const abandoned = JSON.parse(preparedLock) as {
      lockId: string;
      pid: number;
      createdAt: string;
    };
    abandoned.createdAt = "2020-01-01T00:00:00.000Z";
    await writeFile(lockPath, `${JSON.stringify(abandoned)}\n`, "utf8");

    await expect(recoverStaleOfflineOperationLock({
      databasePath,
      backupGenerationPath: protectedOperation.backup.generationPath,
      confirmedGenerationId: protectedOperation.backup.manifest.generationId,
      collaborationBaseUrl,
      minimumStaleMs: 60_000,
      offlineCheckTimeoutMs: 500,
    })).rejects.toThrow(/owner PID .* is still alive/i);
    await expect(readFile(lockPath, "utf8")).resolves.toContain("backup-verified");

    abandoned.pid = 2_000_000_000;
    await writeFile(lockPath, `${JSON.stringify(abandoned)}\n`, "utf8");
    const receiptPath = path.join(
      protectedOperation.backup.generationPath,
      "offline-operation-recovery.json",
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { lockId: string };
    receipt.lockId = randomUUID();
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    await expect(recoverStaleOfflineOperationLock({
      databasePath,
      backupGenerationPath: protectedOperation.backup.generationPath,
      confirmedGenerationId: protectedOperation.backup.manifest.generationId,
      collaborationBaseUrl,
      minimumStaleMs: 60_000,
      offlineCheckTimeoutMs: 500,
    })).rejects.toThrow(/do not match the stale lock/i);
    await expect(readFile(lockPath, "utf8")).resolves.toContain("backup-verified");

    receipt.lockId = abandoned.lockId;
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    await writeFile(databasePath, "not-a-sqlite-database\n", "utf8");
    await expect(recoverStaleOfflineOperationLock({
      databasePath,
      backupGenerationPath: protectedOperation.backup.generationPath,
      confirmedGenerationId: protectedOperation.backup.manifest.generationId,
      collaborationBaseUrl,
      minimumStaleMs: 60_000,
      offlineCheckTimeoutMs: 500,
    })).rejects.toThrow();
    await expect(readFile(lockPath, "utf8")).resolves.toContain("backup-verified");
  });

  it("uses the explicit offline maintenance path only after connection refusal is proven", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-offline-maintenance-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const collaborationBaseUrl = await closedCollaborationBaseUrl();

    const protectedOperation = await withVerifiedMaintenanceOperationBackup({
      baseUrl: collaborationBaseUrl,
      secret: "unused-while-offline",
      databasePath,
      mediaRoot,
      backupRoot,
      sourceRevision: "offline-maintenance-test",
      offlineCheckTimeoutMs: 500,
      operation: () => "migrated",
    });

    expect(protectedOperation.result).toBe("migrated");
    expect(protectedOperation.backup.manifest.collaborationBarrier).toBeUndefined();
    expect(protectedOperation.warnings).toEqual([]);
    await expect(verifyBackupGeneration(protectedOperation.backup.generationPath))
      .resolves.toBeDefined();
  });

  it("does not fall back to offline mutation when an online barrier acquisition fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-maintenance-no-fallback-"));
    temporaryPaths.push(root);
    const { backupRoot, database, databasePath, mediaRoot } = await createBackupSource(root);
    database.close();
    const operation = vi.fn();
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "barrier unavailable" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start health server");

    try {
      await expect(withVerifiedMaintenanceOperationBackup({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "maintenance-no-fallback-test",
        databasePath,
        mediaRoot,
        backupRoot,
        sourceRevision: "maintenance-no-fallback-test",
        operation,
      })).rejects.toThrow(/barrier unavailable/);
      expect(operation).not.toHaveBeenCalled();
      await expect(readdir(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("backs up a just-flushed accepted draft, blocks mutation during purge, and restores it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-destructive-backup-"));
    temporaryPaths.push(root);
    const databasePath = path.join(root, "source", "nyxdoc.db");
    const mediaRoot = path.join(root, "source", "media");
    const backupRoot = path.join(root, "backups");
    await mkdir(path.dirname(databasePath), { recursive: true });
    await mkdir(mediaRoot, { recursive: true });
    const database = openDatabase(databasePath);
    database.exec(`
      CREATE TABLE accepted_drafts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE collaboration_backup_checkpoints (
        checkpoint_slot INTEGER PRIMARY KEY CHECK (checkpoint_slot = 1),
        barrier_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        flushed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        flush_watermark INTEGER NOT NULL CHECK (flush_watermark >= 0),
        loaded_document_count INTEGER NOT NULL CHECK (loaded_document_count >= 0),
        checkpoint_recorded_at TEXT NOT NULL
      );
    `);
    database.prepare("INSERT INTO accepted_drafts (id, body) VALUES ('draft-1', 'stale')").run();
    database.close();

    const now = Date.now();
    const receipt: BackupCollaborationBarrier = {
      barrierId: randomUUID(),
      acquiredAt: new Date(now - 1_000).toISOString(),
      flushedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      flushWatermark: 1,
      loadedDocumentCount: 1,
    };
    let active = false;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname.endsWith("/acquire")) {
        const flushed = openDatabase(databasePath);
        flushed.prepare("UPDATE accepted_drafts SET body = 'latest-accepted' WHERE id = 'draft-1'").run();
        flushed.close();
        active = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(receipt));
        return;
      }
      if (pathname === "/mutation") {
        response.writeHead(active ? 423 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: !active }));
        return;
      }
      if (pathname.endsWith("/release")) {
        active = false;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ barrierId: receipt.barrierId, released: true }));
        return;
      }
      response.writeHead(active ? 200 : 409, { "content-type": "application/json" });
      response.end(JSON.stringify(active ? receipt : { error: "expired" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start barrier server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const protectedOperation = await withVerifiedDestructiveOperationBackup({
        baseUrl,
        secret: "destructive-backup-test",
        databasePath,
        mediaRoot,
        backupRoot,
        sourceRevision: "destructive-backup-test",
        operation: async () => {
          const mutation = await fetch(`${baseUrl}/mutation`, { method: "POST" });
          expect(mutation.status).toBe(423);
          const live = openDatabase(databasePath);
          live.prepare("DELETE FROM accepted_drafts WHERE id = 'draft-1'").run();
          live.close();
          return "purged";
        },
      });
      expect(protectedOperation.result).toBe("purged");
      expect(protectedOperation.warnings).toEqual([]);

      const restoredDatabasePath = path.join(root, "restored", "nyxdoc.db");
      await restoreBackupGeneration({
        generationPath: protectedOperation.backup.generationPath,
        databasePath: restoredDatabasePath,
        mediaRoot: path.join(root, "restored", "media"),
        confirmedGenerationId: protectedOperation.backup.manifest.generationId,
      });
      const restored = openDatabase(restoredDatabasePath);
      expect(restored.prepare("SELECT body FROM accepted_drafts WHERE id = 'draft-1'").get())
        .toEqual({ body: "latest-accepted" });
      restored.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed before snapshot work when the collaboration server is unavailable", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to reserve a test port");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    let callbackInvoked = false;

    await expect(withCollaborationBackupBarrier({
      baseUrl: `http://127.0.0.1:${address.port}`,
      secret: "offline-collaboration-test",
      requestTimeoutMs: 500,
      callback: async () => {
        callbackInvoked = true;
      },
    })).rejects.toThrow(/requires a live collaboration barrier/);
    expect(callbackInvoked).toBe(false);
  });
});
