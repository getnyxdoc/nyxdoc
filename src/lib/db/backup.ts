import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import {
  assertDatabaseFingerprintEqual,
  assertDatabaseIntegrity,
  captureDatabaseFingerprint,
  captureTableInventory,
  type DatabaseFingerprint,
  type DatabaseIntegrity,
} from "@/lib/db/integrity";

type BackupFile = {
  path: string;
  byteSize: number;
  sha256: string;
};

type AppliedMigration = {
  id: string;
  appliedAt: string;
  checksumSha256: string | null;
};

export type BackupManifest = {
  format: "nyxdoc-backup/v1";
  generationId: string;
  createdAt: string;
  sourceRevision: string;
  database: {
    path: "nyxdoc.db";
    byteSize: number;
    sha256: string;
    integrity: DatabaseIntegrity;
    tableInventory: Record<string, number>;
    dataFingerprint: DatabaseFingerprint;
  };
  media: {
    path: "media";
    fileCount: number;
    totalBytes: number;
    treeSha256: string;
    files: BackupFile[];
  };
  migrations: AppliedMigration[];
};

export type BackupVerification = {
  generationPath: string;
  manifest: BackupManifest;
};

function normalizedRelative(value: string) {
  return value.split(path.sep).join("/");
}

function normalizedMediaStorageKey(value: string) {
  if (
    !value
    || value.includes("\0")
    || value.includes("\\")
    || value.includes(":")
    || path.posix.isAbsolute(value)
  ) {
    throw new Error(`Unsafe media storage key ${JSON.stringify(value)} in backup database.`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error(`Unsafe media storage key ${JSON.stringify(value)} in backup database.`);
  }
  return normalized;
}

function pathIsInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function sha256File(filename: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function walkFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && relative === "") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Backup refuses symbolic link ${child}.`);
    }
    if (metadata.isDirectory()) files.push(...await walkFiles(root, childRelative));
    else if (metadata.isFile()) files.push(childRelative);
    else throw new Error(`Backup refuses unsupported filesystem entry ${child}.`);
  }
  return files;
}

async function exists(filename: string) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function mediaTreeSha256(files: BackupFile[]) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(JSON.stringify(file));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function sortedBackupFiles(files: BackupFile[]) {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

function sameBackupFiles(left: BackupFile[], right: BackupFile[]) {
  const leftSorted = sortedBackupFiles(left);
  const rightSorted = sortedBackupFiles(right);
  return leftSorted.length === rightSorted.length
    && leftSorted.every((file, index) => (
      file.path === rightSorted[index]?.path
      && file.byteSize === rightSorted[index]?.byteSize
      && file.sha256 === rightSorted[index]?.sha256
    ));
}

function tableExists(database: Database.Database, table: string) {
  return Boolean(database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table));
}

function expectedMediaFilesFromSnapshot(database: Database.Database): BackupFile[] {
  if (!tableExists(database, "media_assets")) return [];
  const rows = database
    .prepare("SELECT storage_key, byte_size, sha256 FROM media_assets ORDER BY storage_key")
    .all() as Array<{ storage_key: string; byte_size: number; sha256: string }>;
  const seenPaths = new Set<string>();
  return rows.map((row) => {
    const storageKey = normalizedMediaStorageKey(row.storage_key);
    const byteSize = Number(row.byte_size);
    const sha256 = String(row.sha256);
    if (!Number.isSafeInteger(byteSize) || byteSize < 1) {
      throw new Error(`Invalid media byte size for ${storageKey} in backup database.`);
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Invalid media SHA-256 for ${storageKey} in backup database.`);
    }
    if (seenPaths.has(storageKey)) {
      throw new Error(`Duplicate media storage key ${storageKey} in backup database.`);
    }
    seenPaths.add(storageKey);
    return { path: storageKey, byteSize, sha256 };
  });
}

function resolveMediaStoragePath(mediaRoot: string, storageKey: string) {
  const resolved = path.resolve(mediaRoot, ...storageKey.split("/"));
  if (!pathIsInside(resolved, mediaRoot) || resolved === mediaRoot) {
    throw new Error(`Unsafe media storage key ${JSON.stringify(storageKey)}.`);
  }
  return resolved;
}

async function copyExpectedMediaFiles(input: {
  sourceMediaRoot: string;
  destinationMediaRoot: string;
  expectedFiles: BackupFile[];
}) {
  const copied: BackupFile[] = [];
  for (const expected of sortedBackupFiles(input.expectedFiles)) {
    const sourceFile = resolveMediaStoragePath(input.sourceMediaRoot, expected.path);
    const sourceMetadata = await lstat(sourceFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(`Backup media is missing from storage: ${expected.path}.`);
      }
      throw error;
    });
    if (!sourceMetadata.isFile()) {
      throw new Error(`Backup media is not a regular file: ${expected.path}.`);
    }
    const destinationFile = resolveMediaStoragePath(input.destinationMediaRoot, expected.path);
    await mkdir(path.dirname(destinationFile), { recursive: true });
    await copyFile(sourceFile, destinationFile);
    const destinationStat = await stat(destinationFile);
    const copiedFile: BackupFile = {
      path: expected.path,
      byteSize: destinationStat.size,
      sha256: await sha256File(destinationFile),
    };
    if (
      copiedFile.byteSize !== expected.byteSize
      || copiedFile.sha256 !== expected.sha256
    ) {
      throw new Error(`Backup media mismatch for ${expected.path}.`);
    }
    copied.push(copiedFile);
  }
  return copied;
}

function readAppliedMigrations(database: Database.Database): AppliedMigration[] {
  if (!tableExists(database, "_nyxdoc_migrations")) return [];
  const hasChecksums = tableExists(database, "_nyxdoc_migration_checksums");
  if (!hasChecksums) {
    return (database
      .prepare("SELECT id, applied_at FROM _nyxdoc_migrations ORDER BY id")
      .all() as Array<{ id: string; applied_at: string }>).map((row) => ({
      id: row.id,
      appliedAt: row.applied_at,
      checksumSha256: null,
    }));
  }
  return (database
    .prepare(
      `SELECT m.id, m.applied_at, c.checksum_sha256
       FROM _nyxdoc_migrations m
       LEFT JOIN _nyxdoc_migration_checksums c ON c.migration_id = m.id
       ORDER BY m.id`,
    )
    .all() as Array<{
    id: string;
    applied_at: string;
    checksum_sha256: string | null;
  }>).map((row) => ({
    id: row.id,
    appliedAt: row.applied_at,
    checksumSha256: row.checksum_sha256,
  }));
}

function generationName(createdAt: string) {
  return `${createdAt.replaceAll(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
}

export async function createBackupGeneration(input: {
  databasePath: string;
  mediaRoot: string;
  backupRoot: string;
  sourceRevision: string;
}): Promise<BackupVerification> {
  if (input.databasePath === ":memory:") throw new Error("Cannot back up an in-memory database.");
  const databasePath = path.resolve(input.databasePath);
  const mediaRoot = path.resolve(input.mediaRoot);
  const backupRoot = path.resolve(input.backupRoot);
  if (pathIsInside(backupRoot, mediaRoot)) {
    throw new Error("Backup root must not be inside the media directory.");
  }

  const createdAt = new Date().toISOString();
  const generationId = generationName(createdAt);
  const staging = path.join(backupRoot, `.${generationId}.tmp`);
  const destination = path.join(backupRoot, generationId);
  const destinationDatabase = path.join(staging, "nyxdoc.db");
  const destinationMedia = path.join(staging, "media");
  await mkdir(backupRoot, { recursive: true });
  await mkdir(destinationMedia, { recursive: true });

  try {
    const source = new Database(databasePath, { readonly: true, fileMustExist: true });
    source.pragma("busy_timeout = 5000");
    try {
      await source.backup(destinationDatabase);
    } finally {
      source.close();
    }

    const backupDatabase = new Database(destinationDatabase, {
      readonly: true,
      fileMustExist: true,
    });
    let integrity: DatabaseIntegrity;
    let tableInventory: Record<string, number>;
    let dataFingerprint: DatabaseFingerprint;
    let migrations: AppliedMigration[];
    let expectedMediaFiles: BackupFile[] = [];
    try {
      backupDatabase.pragma("foreign_keys = ON");
      integrity = assertDatabaseIntegrity(backupDatabase);
      tableInventory = captureTableInventory(backupDatabase);
      dataFingerprint = captureDatabaseFingerprint(backupDatabase);
      migrations = readAppliedMigrations(backupDatabase);
      expectedMediaFiles = expectedMediaFilesFromSnapshot(backupDatabase);
    } finally {
      backupDatabase.close();
    }
    const mediaFiles = await copyExpectedMediaFiles({
      sourceMediaRoot: mediaRoot,
      destinationMediaRoot: destinationMedia,
      expectedFiles: expectedMediaFiles,
    });
    const databaseStat = await stat(destinationDatabase);
    const manifest: BackupManifest = {
      format: "nyxdoc-backup/v1",
      generationId,
      createdAt,
      sourceRevision: input.sourceRevision || "unknown",
      database: {
        path: "nyxdoc.db",
        byteSize: databaseStat.size,
        sha256: await sha256File(destinationDatabase),
        integrity,
        tableInventory,
        dataFingerprint,
      },
      media: {
        path: "media",
        fileCount: mediaFiles.length,
        totalBytes: mediaFiles.reduce((total, file) => total + file.byteSize, 0),
        treeSha256: mediaTreeSha256(sortedBackupFiles(mediaFiles)),
        files: sortedBackupFiles(mediaFiles),
      },
      migrations,
    };
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(staging, destination);
    return { generationPath: destination, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(value: unknown): BackupManifest {
  const manifest = value as Partial<BackupManifest>;
  if (
    manifest.format !== "nyxdoc-backup/v1"
    || typeof manifest.generationId !== "string"
    || typeof manifest.createdAt !== "string"
    || typeof manifest.database?.sha256 !== "string"
    || !Array.isArray(manifest.media?.files)
  ) {
    throw new Error("Invalid Nyxdoc backup manifest.");
  }
  return manifest as BackupManifest;
}

function resolveManifestPath(generationPath: string, relative: string) {
  const resolved = path.resolve(generationPath, relative);
  if (!pathIsInside(resolved, generationPath)) throw new Error(`Unsafe manifest path ${relative}.`);
  return resolved;
}

export async function verifyBackupGeneration(generationPathInput: string): Promise<BackupVerification> {
  const generationPath = path.resolve(generationPathInput);
  const manifest = parseManifest(JSON.parse(await readFile(
    path.join(generationPath, "manifest.json"),
    "utf8",
  )) as unknown);
  if (path.basename(generationPath) !== manifest.generationId) {
    throw new Error("Backup generation directory does not match manifest generationId.");
  }

  const databasePath = resolveManifestPath(generationPath, manifest.database.path);
  const databaseStat = await stat(databasePath);
  if (databaseStat.size !== manifest.database.byteSize) throw new Error("Backup database size mismatch.");
  if (await sha256File(databasePath) !== manifest.database.sha256) {
    throw new Error("Backup database SHA-256 mismatch.");
  }

  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let expectedMediaFiles: BackupFile[] = [];
  try {
    database.pragma("foreign_keys = ON");
    assertDatabaseIntegrity(database);
    const inventory = captureTableInventory(database);
    if (JSON.stringify(inventory) !== JSON.stringify(manifest.database.tableInventory)) {
      throw new Error("Backup table inventory mismatch.");
    }
    const fingerprint = captureDatabaseFingerprint(database, manifest.database.dataFingerprint);
    assertDatabaseFingerprintEqual(manifest.database.dataFingerprint, fingerprint);
    if (JSON.stringify(readAppliedMigrations(database)) !== JSON.stringify(manifest.migrations)) {
      throw new Error("Backup migration inventory mismatch.");
    }
    expectedMediaFiles = expectedMediaFilesFromSnapshot(database);
  } finally {
    database.close();
  }
  if (!sameBackupFiles(manifest.media.files, expectedMediaFiles)) {
    throw new Error("Backup media manifest does not match the database-referenced media set.");
  }

  const mediaRoot = resolveManifestPath(generationPath, manifest.media.path);
  const actualMedia = await walkFiles(mediaRoot);
  const expectedPaths = expectedMediaFiles.map((file) => file.path).sort();
  const actualPaths = actualMedia.map(normalizedRelative).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error("Backup media file inventory mismatch.");
  }
  const verifiedMedia: BackupFile[] = [];
  for (const expected of sortedBackupFiles(expectedMediaFiles)) {
    const filename = resolveMediaStoragePath(mediaRoot, expected.path);
    const fileStat = await stat(filename);
    const actual: BackupFile = {
      path: expected.path,
      byteSize: fileStat.size,
      sha256: await sha256File(filename),
    };
    if (actual.byteSize !== expected.byteSize || actual.sha256 !== expected.sha256) {
      throw new Error(`Backup media mismatch for ${expected.path}.`);
    }
    verifiedMedia.push(actual);
  }
  if (
    verifiedMedia.length !== manifest.media.fileCount
    || verifiedMedia.reduce((total, file) => total + file.byteSize, 0) !== manifest.media.totalBytes
    || mediaTreeSha256(sortedBackupFiles(verifiedMedia)) !== manifest.media.treeSha256
  ) {
    throw new Error("Backup media aggregate mismatch.");
  }

  return { generationPath, manifest };
}

export async function restoreBackupGeneration(input: {
  generationPath: string;
  databasePath: string;
  mediaRoot: string;
  confirmedGenerationId: string;
}) {
  const verified = await verifyBackupGeneration(input.generationPath);
  if (input.confirmedGenerationId !== verified.manifest.generationId) {
    throw new Error("Restore confirmation does not match the backup generation ID.");
  }
  const databasePath = path.resolve(input.databasePath);
  const mediaRoot = path.resolve(input.mediaRoot);
  if (
    pathIsInside(databasePath, verified.generationPath)
    || pathIsInside(mediaRoot, verified.generationPath)
  ) {
    throw new Error("Restore targets must be outside the backup generation.");
  }
  if (await exists(databasePath)) throw new Error(`Restore database target already exists: ${databasePath}`);
  if (await exists(mediaRoot)) throw new Error(`Restore media target already exists: ${mediaRoot}`);

  const suffix = `.restore-${randomUUID()}.tmp`;
  const stagingDatabase = `${databasePath}${suffix}`;
  const stagingMedia = `${mediaRoot}${suffix}`;
  let mediaInstalled = false;
  try {
    await mkdir(path.dirname(databasePath), { recursive: true });
    await mkdir(path.dirname(mediaRoot), { recursive: true });
    await mkdir(stagingMedia, { recursive: true });
    await copyFile(path.join(verified.generationPath, verified.manifest.database.path), stagingDatabase);
    for (const file of verified.manifest.media.files) {
      const source = resolveManifestPath(
        path.join(verified.generationPath, verified.manifest.media.path),
        file.path,
      );
      const destination = path.join(stagingMedia, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      const destinationStat = await stat(destination);
      if (destinationStat.size !== file.byteSize || await sha256File(destination) !== file.sha256) {
        throw new Error(`Restored media verification failed for ${file.path}.`);
      }
    }
    const databaseStat = await stat(stagingDatabase);
    if (
      databaseStat.size !== verified.manifest.database.byteSize
      || await sha256File(stagingDatabase) !== verified.manifest.database.sha256
    ) {
      throw new Error("Restored database hash verification failed.");
    }
    const restoredDatabase = new Database(stagingDatabase, { readonly: true, fileMustExist: true });
    try {
      restoredDatabase.pragma("foreign_keys = ON");
      assertDatabaseIntegrity(restoredDatabase);
      const fingerprint = captureDatabaseFingerprint(
        restoredDatabase,
        verified.manifest.database.dataFingerprint,
      );
      assertDatabaseFingerprintEqual(verified.manifest.database.dataFingerprint, fingerprint);
    } finally {
      restoredDatabase.close();
    }

    await rename(stagingMedia, mediaRoot);
    mediaInstalled = true;
    await rename(stagingDatabase, databasePath);
    return {
      generationId: verified.manifest.generationId,
      databasePath,
      mediaRoot,
      databaseSha256: verified.manifest.database.sha256,
      mediaTreeSha256: verified.manifest.media.treeSha256,
    };
  } catch (error) {
    await rm(stagingDatabase, { force: true });
    await rm(stagingMedia, { recursive: true, force: true });
    if (mediaInstalled) await rm(mediaRoot, { recursive: true, force: true });
    throw error;
  }
}
