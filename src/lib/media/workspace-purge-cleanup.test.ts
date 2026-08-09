import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import { runAppMigrations } from "@/lib/db/migrations";
import {
  processWorkspaceMediaCleanupQueue,
  storeMediaAsset,
} from "@/lib/media/service";
import {
  createWorkspace,
  purgeWorkspace,
  trashWorkspace,
} from "@/lib/workspaces/service";
import { createTestUser } from "@/test/fixture";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const databases: NyxDatabase[] = [];
const roots: string[] = [];

function createPersistentFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nyxdoc-workspace-media-cleanup-test-"));
  roots.push(root);
  const databasePath = path.join(root, "nyxdoc.db");
  const database = openDatabase(databasePath);
  databases.push(database);
  database.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 1,
      image TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
  runAppMigrations(database, { sourceRevision: "workspace-media-cleanup-test" });
  const { user, workspace: retainedWorkspace } = createTestUser(database);
  const purgedWorkspace = createWorkspace(database, user, "purged-media-workspace");
  return { database, databasePath, mediaRoot: root, purgedWorkspace, retainedWorkspace, user };
}

function closeTrackedDatabase(database: NyxDatabase) {
  const index = databases.indexOf(database);
  if (index >= 0) databases.splice(index, 1);
  database.close();
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (
      root
      && path.dirname(root) === path.resolve(os.tmpdir())
      && path.basename(root).startsWith("nyxdoc-workspace-media-cleanup-test-")
    ) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

describe("durable workspace purge media cleanup", () => {
  it("survives post-commit unlink failure and resumes safely after restart", async () => {
    const fixture = createPersistentFixture();
    const purgedMedia = await storeMediaAsset(fixture.database, {
      bytes: PNG_BYTES,
      userId: fixture.user.id,
      workspaceId: fixture.purgedWorkspace.id,
    }, fixture.mediaRoot);
    const retainedMedia = await storeMediaAsset(fixture.database, {
      bytes: PNG_BYTES,
      userId: fixture.user.id,
      workspaceId: fixture.retainedWorkspace.id,
    }, fixture.mediaRoot);
    trashWorkspace(fixture.database, {
      workspaceId: fixture.purgedWorkspace.id,
      userId: fixture.user.id,
      actorLabel: fixture.user.name,
      confirmationName: fixture.purgedWorkspace.name,
    });

    const purged = purgeWorkspace(fixture.database, {
      workspaceId: fixture.purgedWorkspace.id,
      userId: fixture.user.id,
      actorLabel: fixture.user.name,
      confirmationName: fixture.purgedWorkspace.name,
      backupGenerationId: "verified-cleanup-backup",
    });

    expect(purged.mediaCleanupPending).toBe(1);
    expect(fixture.database.prepare(
      "SELECT 1 FROM workspaces WHERE id = ?",
    ).get(fixture.purgedWorkspace.id)).toBeUndefined();
    expect(fixture.database.prepare(
      `SELECT workspace_id, media_asset_id, storage_key, status, attempt_count
       FROM workspace_media_cleanup_queue`,
    ).all()).toEqual([{
      workspace_id: fixture.purgedWorkspace.id,
      media_asset_id: purgedMedia.id,
      storage_key: purgedMedia.storageKey,
      status: "pending",
      attempt_count: 0,
    }]);
    expect(() => fixture.database.prepare(
      `INSERT INTO workspace_media_cleanup_queue
       (id, workspace_id, media_asset_id, storage_key, enqueued_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      fixture.purgedWorkspace.id,
      retainedMedia.id,
      retainedMedia.storageKey,
      new Date().toISOString(),
    )).toThrow(/must match a workspace purge asset/);

    const injectedFailure = vi.fn(async () => {
      throw new Error("injected unlink failure after database commit");
    });
    await expect(processWorkspaceMediaCleanupQueue(fixture.database, {
      workspaceId: fixture.purgedWorkspace.id,
      mediaRoot: fixture.mediaRoot,
      removeStorageKeys: injectedFailure,
    })).resolves.toMatchObject({
      processed: 1,
      completed: 0,
      pending: 1,
      failed: [{
        storageKey: purgedMedia.storageKey,
        error: "injected unlink failure after database commit",
      }],
    });
    expect(existsSync(path.join(fixture.mediaRoot, purgedMedia.storageKey))).toBe(true);
    expect(existsSync(path.join(fixture.mediaRoot, retainedMedia.storageKey))).toBe(true);
    expect(fixture.database.prepare(
      `SELECT status, attempt_count, completed_at, last_error
       FROM workspace_media_cleanup_queue WHERE storage_key = ?`,
    ).get(purgedMedia.storageKey)).toMatchObject({
      status: "pending",
      attempt_count: 1,
      completed_at: null,
      last_error: "injected unlink failure after database commit",
    });

    closeTrackedDatabase(fixture.database);
    const restarted = openDatabase(fixture.databasePath);
    databases.push(restarted);

    await expect(processWorkspaceMediaCleanupQueue(restarted, {
      mediaRoot: fixture.mediaRoot,
    })).resolves.toEqual({
      processed: 1,
      completed: 1,
      failed: [],
      pending: 0,
    });
    expect(existsSync(path.join(fixture.mediaRoot, purgedMedia.storageKey))).toBe(false);
    expect(existsSync(path.join(fixture.mediaRoot, retainedMedia.storageKey))).toBe(true);
    expect(restarted.prepare(
      `SELECT status, attempt_count, completed_at, last_error
       FROM workspace_media_cleanup_queue WHERE storage_key = ?`,
    ).get(purgedMedia.storageKey)).toMatchObject({
      status: "completed",
      attempt_count: 2,
      completed_at: expect.any(String),
      last_error: null,
    });

    await expect(processWorkspaceMediaCleanupQueue(restarted, {
      mediaRoot: fixture.mediaRoot,
    })).resolves.toEqual({
      processed: 0,
      completed: 0,
      failed: [],
      pending: 0,
    });
    expect(existsSync(path.join(fixture.mediaRoot, retainedMedia.storageKey))).toBe(true);
  });
});
