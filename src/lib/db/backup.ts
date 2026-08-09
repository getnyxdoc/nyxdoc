import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
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
  collaborationBarrier?: BackupCollaborationBarrier | BackupCollaborationCheckpoint;
};

export type BackupCollaborationBarrier = {
  barrierId: string;
  acquiredAt: string;
  flushedAt: string;
  expiresAt: string;
  flushWatermark: number;
  loadedDocumentCount: number;
};

export type BackupCollaborationCheckpoint = BackupCollaborationBarrier & {
  checkpointRecordedAt: string;
};

export type BackupVerification = {
  generationPath: string;
  manifest: BackupManifest;
};

type BackupGenerationInput = {
  databasePath: string;
  mediaRoot: string;
  backupRoot: string;
  sourceRevision: string;
};

type LiveBackupGenerationInput = BackupGenerationInput & {
  collaborationBarrier: BackupCollaborationBarrier;
  assertCollaborationBarrierHeld: () => Promise<void>;
};

type OfflineBackupGenerationInput = BackupGenerationInput & {
  collaborationBaseUrl: string;
  offlineCheckTimeoutMs?: number;
};

export type DestructiveOperationBackupResult<T> = {
  backup: BackupVerification;
  result: T;
  warnings: string[];
};

type CollaborationBarrierResponse = BackupCollaborationBarrier & {
  released?: boolean;
};

type CollaborationAvailability = "online" | "offline";

const OFFLINE_OPERATION_LOCK_FORMAT = "nyxdoc-offline-operation-lock/v2";
const OFFLINE_OPERATION_RECOVERY_FORMAT = "nyxdoc-offline-operation-recovery/v1";
const DEFAULT_OFFLINE_LOCK_STALE_MS = 15 * 60 * 1_000;

type OfflineOperationLock = {
  format: typeof OFFLINE_OPERATION_LOCK_FORMAT;
  lockId: string;
  pid: number;
  createdAt: string;
  databasePath: string;
  phase: "acquired" | "backup-verified";
  backup?: {
    generationId: string;
    generationPath: string;
    databaseSha256: string;
    recoveryReceiptPath: "offline-operation-recovery.json";
  };
};

type OfflineOperationRecoveryReceipt = {
  format: typeof OFFLINE_OPERATION_RECOVERY_FORMAT;
  lockId: string;
  databasePath: string;
  backupGenerationId: string;
  backupDatabaseSha256: string;
  sourceRevision: string;
  preparedAt: string;
};

type OfflineOperationLockController = {
  bindVerifiedBackup: (backup: BackupVerification) => Promise<void>;
};

function errorIncludesCode(error: unknown, codes: ReadonlySet<string>): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown[];
  };
  if (typeof candidate.code === "string" && codes.has(candidate.code)) return true;
  if (errorIncludesCode(candidate.cause, codes)) return true;
  return Array.isArray(candidate.errors)
    && candidate.errors.some((nested) => errorIncludesCode(nested, codes));
}

async function collaborationAvailability(
  baseUrl: string,
  timeoutMs = 2_000,
): Promise<CollaborationAvailability> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("A valid collaboration internal URL is required to prove offline backup safety.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The collaboration internal URL must use HTTP or HTTPS.");
  }

  try {
    await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return "online";
  } catch (error) {
    // A timeout, DNS failure, reset connection, TLS failure, or generic
    // transport error does not prove that the collaboration process is
    // stopped. Only an explicit connection refusal proves that this endpoint
    // is not accepting connections. Lifecycle callers that already proved a
    // stronger stopped-services boundary do not need this network inference.
    if (errorIncludesCode(error, new Set(["ECONNREFUSED"]))) {
      return "offline";
    }
    throw new Error(
      "Could not mechanically prove that the collaboration server is offline; no offline backup or mutation was started.",
      { cause: error },
    );
  }
}

async function assertCollaborationOffline(baseUrl: string, timeoutMs?: number) {
  if (await collaborationAvailability(baseUrl, timeoutMs) !== "offline") {
    throw new Error(
      "The collaboration server is online; an offline backup or mutation is not allowed.",
    );
  }
}

function parseOfflineOperationLock(value: unknown): OfflineOperationLock {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The offline database operation lock is malformed.");
  }
  const lock = value as Partial<OfflineOperationLock>;
  if (
    lock.format !== OFFLINE_OPERATION_LOCK_FORMAT
    || typeof lock.lockId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(lock.lockId)
    || !Number.isSafeInteger(lock.pid)
    || Number(lock.pid) < 1
    || typeof lock.createdAt !== "string"
    || !Number.isFinite(Date.parse(lock.createdAt))
    || typeof lock.databasePath !== "string"
    || (lock.phase !== "acquired" && lock.phase !== "backup-verified")
  ) {
    throw new Error("The offline database operation lock is malformed.");
  }
  if (lock.phase === "backup-verified") {
    const backup = lock.backup;
    if (
      !backup
      || typeof backup.generationId !== "string"
      || !/^[A-Za-z0-9._-]+$/.test(backup.generationId)
      || typeof backup.generationPath !== "string"
      || !path.isAbsolute(backup.generationPath)
      || typeof backup.databaseSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(backup.databaseSha256)
      || backup.recoveryReceiptPath !== "offline-operation-recovery.json"
    ) {
      throw new Error("The offline database operation lock backup binding is malformed.");
    }
  }
  return lock as OfflineOperationLock;
}

function parseOfflineOperationRecoveryReceipt(value: unknown): OfflineOperationRecoveryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The offline operation recovery receipt is malformed.");
  }
  const receipt = value as Partial<OfflineOperationRecoveryReceipt>;
  if (
    receipt.format !== OFFLINE_OPERATION_RECOVERY_FORMAT
    || typeof receipt.lockId !== "string"
    || typeof receipt.databasePath !== "string"
    || typeof receipt.backupGenerationId !== "string"
    || typeof receipt.backupDatabaseSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(receipt.backupDatabaseSha256)
    || typeof receipt.sourceRevision !== "string"
    || typeof receipt.preparedAt !== "string"
    || !Number.isFinite(Date.parse(receipt.preparedAt))
  ) {
    throw new Error("The offline operation recovery receipt is malformed.");
  }
  return receipt as OfflineOperationRecoveryReceipt;
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function statRegularFileOwnedByCurrentUser(filename: string, label: string) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file.`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current operator.`);
  }
  return metadata;
}

export async function recoverStaleOfflineOperationLock(input: {
  databasePath: string;
  backupGenerationPath: string;
  confirmedGenerationId: string;
  collaborationBaseUrl: string;
  minimumStaleMs?: number;
  offlineCheckTimeoutMs?: number;
}) {
  if (input.databasePath === ":memory:") {
    throw new Error("Offline lock recovery requires a file database.");
  }
  const databasePath = path.resolve(input.databasePath);
  const generationPath = path.resolve(input.backupGenerationPath);
  const lockPath = `${databasePath}.offline-operation.lock`;
  const recoveryGuardPath = `${lockPath}.recovery`;
  const minimumStaleMs = input.minimumStaleMs ?? DEFAULT_OFFLINE_LOCK_STALE_MS;
  if (!Number.isSafeInteger(minimumStaleMs) || minimumStaleMs < 0) {
    throw new Error("The offline lock minimum stale age is invalid.");
  }

  await assertCollaborationOffline(input.collaborationBaseUrl, input.offlineCheckTimeoutMs);
  let recoveryGuard: Awaited<ReturnType<typeof open>>;
  try {
    recoveryGuard = await open(recoveryGuardPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another operator is already validating this offline lock recovery.");
    }
    throw error;
  }

  try {
    await recoveryGuard.writeFile(`${JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");
    const initialStat = await statRegularFileOwnedByCurrentUser(
      lockPath,
      "The offline database operation lock",
    );
    const initialBytes = await readFile(lockPath, "utf8");
    const lock = parseOfflineOperationLock(JSON.parse(initialBytes));
    if (path.resolve(lock.databasePath) !== databasePath) {
      throw new Error("The offline database operation lock belongs to a different database.");
    }
    const lockAge = Date.now() - Date.parse(lock.createdAt);
    if (lockAge < minimumStaleMs) {
      throw new Error("The offline database operation lock has not reached the required stale age.");
    }
    if (processIsAlive(lock.pid)) {
      throw new Error(`The offline database operation lock owner PID ${lock.pid} is still alive.`);
    }

    const backup = await verifyBackupGeneration(generationPath);
    if (backup.manifest.generationId !== input.confirmedGenerationId) {
      throw new Error("The confirmed backup generation does not match the stale lock recovery backup.");
    }
    const recoveryReceiptPath = path.join(generationPath, "offline-operation-recovery.json");
    await statRegularFileOwnedByCurrentUser(
      recoveryReceiptPath,
      "The offline operation recovery receipt",
    );
    const receipt = parseOfflineOperationRecoveryReceipt(JSON.parse(
      await readFile(recoveryReceiptPath, "utf8"),
    ));
    if (
      receipt.lockId !== lock.lockId
      || path.resolve(receipt.databasePath) !== databasePath
      || receipt.backupGenerationId !== backup.manifest.generationId
      || receipt.backupDatabaseSha256 !== backup.manifest.database.sha256
      || receipt.sourceRevision !== backup.manifest.sourceRevision
    ) {
      throw new Error("The verified backup and offline operation recovery receipt do not match the stale lock.");
    }
    if (lock.backup && (
      path.resolve(lock.backup.generationPath) !== generationPath
      || lock.backup.generationId !== backup.manifest.generationId
      || lock.backup.databaseSha256 !== backup.manifest.database.sha256
    )) {
      throw new Error("The stale lock backup binding does not match the verified recovery backup.");
    }

    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      database.pragma("foreign_keys = ON");
      assertDatabaseIntegrity(database);
    } finally {
      database.close();
    }
    await assertCollaborationOffline(input.collaborationBaseUrl, input.offlineCheckTimeoutMs);

    const finalStat = await statRegularFileOwnedByCurrentUser(
      lockPath,
      "The offline database operation lock",
    );
    const finalBytes = await readFile(lockPath, "utf8");
    if (
      finalBytes !== initialBytes
      || finalStat.dev !== initialStat.dev
      || finalStat.ino !== initialStat.ino
      || finalStat.size !== initialStat.size
      || finalStat.mtimeMs !== initialStat.mtimeMs
    ) {
      throw new Error("The offline database operation lock changed during recovery validation.");
    }
    await rm(lockPath);
    return {
      lockId: lock.lockId,
      databasePath,
      backupGenerationId: backup.manifest.generationId,
      backupGenerationPath: generationPath,
    };
  } finally {
    await recoveryGuard.close();
    await rm(recoveryGuardPath, { force: true });
  }
}

async function recoverOfflineOperationLockFromEnvironment(input: {
  databasePath: string;
  collaborationBaseUrl: string;
  offlineCheckTimeoutMs?: number;
}) {
  const generationPath = process.env.NYXDOC_RECOVER_STALE_OFFLINE_LOCK?.trim();
  const confirmedGenerationId = process.env.NYXDOC_RECOVER_STALE_OFFLINE_LOCK_CONFIRM?.trim();
  if (!generationPath && !confirmedGenerationId) return false;
  if (!generationPath || !confirmedGenerationId) {
    throw new Error(
      "Stale lock recovery requires both NYXDOC_RECOVER_STALE_OFFLINE_LOCK and NYXDOC_RECOVER_STALE_OFFLINE_LOCK_CONFIRM.",
    );
  }
  const staleSeconds = process.env.NYXDOC_RECOVER_STALE_OFFLINE_LOCK_MIN_AGE_SECONDS?.trim();
  if (staleSeconds && !/^[0-9]+$/.test(staleSeconds)) {
    throw new Error("NYXDOC_RECOVER_STALE_OFFLINE_LOCK_MIN_AGE_SECONDS must be a non-negative integer.");
  }
  await recoverStaleOfflineOperationLock({
    databasePath: input.databasePath,
    backupGenerationPath: generationPath,
    confirmedGenerationId,
    collaborationBaseUrl: input.collaborationBaseUrl,
    minimumStaleMs: staleSeconds ? Number(staleSeconds) * 1_000 : undefined,
    offlineCheckTimeoutMs: input.offlineCheckTimeoutMs,
  });
  return true;
}

async function withOfflineOperationLock<T>(
  databasePath: string,
  recovery: { collaborationBaseUrl: string; offlineCheckTimeoutMs?: number },
  callback: (controller: OfflineOperationLockController) => Promise<T>,
): Promise<T> {
  if (databasePath === ":memory:") {
    throw new Error("Offline backup operations require a file database.");
  }
  const lockPath = `${path.resolve(databasePath)}.offline-operation.lock`;
  const recoveryGuardPath = `${lockPath}.recovery`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const lock: OfflineOperationLock = {
    format: OFFLINE_OPERATION_LOCK_FORMAT,
    lockId: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
    databasePath: path.resolve(databasePath),
    phase: "acquired",
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await lstat(recoveryGuardPath);
      throw new Error(`Offline database lock recovery is active: ${recoveryGuardPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (
        attempt === 0
        && await recoverOfflineOperationLockFromEnvironment({
          databasePath,
          collaborationBaseUrl: recovery.collaborationBaseUrl,
          offlineCheckTimeoutMs: recovery.offlineCheckTimeoutMs,
        })
      ) {
        continue;
      }
      throw new Error(
        `Another offline database operation is active or requires operator recovery: ${lockPath}`,
        { cause: error },
      );
    }
  }
  if (!handle) throw new Error(`Could not acquire the offline database operation lock: ${lockPath}`);
  const lockHandle = handle;
  const persistLock = async () => {
    await lockHandle.truncate(0);
    await lockHandle.write(`${JSON.stringify(lock)}\n`, 0, "utf8");
    await lockHandle.sync();
  };
  try {
    await persistLock();
    return await callback({
      bindVerifiedBackup: async (backup) => {
        const receipt: OfflineOperationRecoveryReceipt = {
          format: OFFLINE_OPERATION_RECOVERY_FORMAT,
          lockId: lock.lockId,
          databasePath: lock.databasePath,
          backupGenerationId: backup.manifest.generationId,
          backupDatabaseSha256: backup.manifest.database.sha256,
          sourceRevision: backup.manifest.sourceRevision,
          preparedAt: new Date().toISOString(),
        };
        await writeFile(
          path.join(backup.generationPath, "offline-operation-recovery.json"),
          `${JSON.stringify(receipt, null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        lock.phase = "backup-verified";
        lock.backup = {
          generationId: backup.manifest.generationId,
          generationPath: path.resolve(backup.generationPath),
          databaseSha256: backup.manifest.database.sha256,
          recoveryReceiptPath: "offline-operation-recovery.json",
        };
        await persistLock();
      },
    });
  } finally {
    try {
      await lockHandle.close();
    } finally {
      const observed = await readFile(lockPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (observed !== null) {
        const observedLock = parseOfflineOperationLock(JSON.parse(observed));
        if (observedLock.lockId !== lock.lockId) {
          throw new Error("The offline database operation lock ownership changed; it was not removed.");
        }
        await rm(lockPath);
      }
    }
  }
}

function parseCollaborationBarrier(value: unknown): BackupCollaborationBarrier {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Collaboration backup barrier returned an invalid receipt.");
  }
  const receipt = value as Partial<BackupCollaborationBarrier>;
  if (
    typeof receipt.barrierId !== "string"
    || !receipt.barrierId
    || typeof receipt.acquiredAt !== "string"
    || !Number.isFinite(Date.parse(receipt.acquiredAt))
    || typeof receipt.flushedAt !== "string"
    || !Number.isFinite(Date.parse(receipt.flushedAt))
    || typeof receipt.expiresAt !== "string"
    || !Number.isFinite(Date.parse(receipt.expiresAt))
    || !Number.isSafeInteger(receipt.flushWatermark)
    || Number(receipt.flushWatermark) < 0
    || !Number.isSafeInteger(receipt.loadedDocumentCount)
    || Number(receipt.loadedDocumentCount) < 0
  ) {
    throw new Error("Collaboration backup barrier returned an invalid receipt.");
  }
  return receipt as BackupCollaborationBarrier;
}

async function collaborationBarrierRequest(
  baseUrl: string,
  secret: string,
  pathName: string,
  body: unknown,
  timeoutMs: number,
) {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${pathName}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      "Verified backup requires a live collaboration barrier; no backup was finalized.",
      { cause: error },
    );
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? `Collaboration backup barrier failed: ${payload.error}`
        : "Collaboration backup barrier failed; no backup was finalized.",
    );
  }
  return payload;
}

export async function withCollaborationBackupBarrier<T>(input: {
  baseUrl: string;
  secret: string;
  callback: (barrier: {
    receipt: BackupCollaborationBarrier;
    assertHeld: () => Promise<void>;
  }) => Promise<T>;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  onReleaseWarning?: (error: Error) => void;
}) {
  const requestTimeoutMs = input.requestTimeoutMs ?? 30_000;
  const acquired = parseCollaborationBarrier(await collaborationBarrierRequest(
    input.baseUrl,
    input.secret,
    "/internal/backup/barrier/acquire",
    {},
    requestTimeoutMs,
  ));
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalFailure: unknown;
  let renewalInFlight: Promise<void> | null = null;
  let assertionCount = 0;
  const heartbeatMs = input.heartbeatMs ?? Math.max(
    1_000,
    Math.min(30_000, Math.floor((Date.parse(acquired.expiresAt) - Date.now()) / 3)),
  );
  const reportReleaseWarning = (warning: Error) => {
    try {
      (input.onReleaseWarning ?? console.warn)(warning);
    } catch (reportingError) {
      console.warn("Failed to report a collaboration barrier release warning.", reportingError);
    }
  };

  const scheduleHeartbeat = () => {
    if (stopped || renewalFailure) return;
    heartbeatTimer = setTimeout(() => {
      renewalInFlight = collaborationBarrierRequest(
        input.baseUrl,
        input.secret,
        "/internal/backup/barrier/renew",
        { barrierId: acquired.barrierId },
        requestTimeoutMs,
      ).then((payload) => {
        Object.assign(acquired, parseCollaborationBarrier(payload));
      }).catch((error) => {
        renewalFailure = error;
      }).finally(() => {
        renewalInFlight = null;
        scheduleHeartbeat();
      });
    }, heartbeatMs);
    heartbeatTimer.unref();
  };

  const assertHeld = async () => {
    assertionCount += 1;
    if (renewalInFlight) await renewalInFlight;
    if (renewalFailure) throw renewalFailure;
    const status = parseCollaborationBarrier(await collaborationBarrierRequest(
      input.baseUrl,
      input.secret,
      "/internal/backup/barrier/status",
      { barrierId: acquired.barrierId },
      requestTimeoutMs,
    ));
    if (
      status.barrierId !== acquired.barrierId
      || status.flushWatermark !== acquired.flushWatermark
      || status.flushedAt !== acquired.flushedAt
    ) {
      throw new Error("Collaboration backup barrier identity changed before finalization.");
    }
    Object.assign(acquired, status);
  };

  scheduleHeartbeat();
  let result!: T;
  let primaryError: unknown;
  try {
    result = await input.callback({ receipt: acquired, assertHeld });
    if (assertionCount === 0) {
      throw new Error("A live backup barrier must be checked before publishing or mutating data.");
    }
  } catch (error) {
    primaryError = error;
  } finally {
    stopped = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (renewalInFlight) await renewalInFlight;
    try {
      const released = await collaborationBarrierRequest(
        input.baseUrl,
        input.secret,
        "/internal/backup/barrier/release",
        { barrierId: acquired.barrierId },
        requestTimeoutMs,
      ) as CollaborationBarrierResponse;
      if (released.released !== true && !primaryError) {
        const warning = new Error(
          "The protected operation completed, but the collaboration barrier was already released. "
          + "The completed backup or destructive operation remains authoritative.",
        );
        reportReleaseWarning(warning);
      }
    } catch (error) {
      if (!primaryError) {
        const warning = new Error(
          "The protected operation completed, but the collaboration barrier release response was lost. "
          + "The barrier lease will expire automatically; do not retry the destructive operation.",
          { cause: error },
        );
        reportReleaseWarning(warning);
      }
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

export async function withVerifiedDestructiveOperationBackup<T>(input: {
  baseUrl: string;
  secret: string;
  databasePath: string;
  mediaRoot: string;
  backupRoot: string;
  sourceRevision: string;
  operation: (backup: BackupVerification) => Promise<T> | T;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  onWarning?: (warning: string) => void;
}): Promise<DestructiveOperationBackupResult<T>> {
  const warnings: string[] = [];
  const reportWarning = (error: unknown) => {
    const warning = error instanceof Error ? error.message : String(error);
    warnings.push(warning);
    input.onWarning?.(warning);
  };

  const protectedResult = await withCollaborationBackupBarrier({
    baseUrl: input.baseUrl,
    secret: input.secret,
    requestTimeoutMs: input.requestTimeoutMs,
    heartbeatMs: input.heartbeatMs,
    onReleaseWarning: reportWarning,
    callback: async ({ receipt, assertHeld }) => {
      const backup = await createLiveBackupGeneration({
        databasePath: input.databasePath,
        mediaRoot: input.mediaRoot,
        backupRoot: input.backupRoot,
        sourceRevision: input.sourceRevision,
        collaborationBarrier: receipt,
        assertCollaborationBarrierHeld: assertHeld,
      });
      try {
        await assertHeld();
      } catch (error) {
        try {
          await rm(backup.generationPath, { recursive: true, force: true });
        } catch (removalError) {
          const quarantinePath = path.join(
            path.dirname(backup.generationPath),
            `.${path.basename(backup.generationPath)}.invalid-${randomUUID().slice(0, 8)}`,
          );
          try {
            await rename(backup.generationPath, quarantinePath);
          } catch (quarantineError) {
            throw new AggregateError(
              [error, removalError, quarantineError],
              `Collaboration barrier was lost before the destructive operation, and backup generation ${backup.generationPath} could not be removed or quarantined.`,
            );
          }
          throw new Error(
            `Collaboration barrier was lost before the destructive operation; the unpublished backup was quarantined at ${quarantinePath}.`,
            { cause: error },
          );
        }
        throw error;
      }
      const result = await input.operation(backup);
      try {
        await assertHeld();
      } catch (error) {
        // The destructive operation has already returned and cannot be rolled back safely.
        // Preserve its verified pre-operation backup and surface a warning instead of
        // encouraging a retry that could repeat the destructive operation.
        reportWarning(error);
      }
      return { backup, result };
    },
  });

  return { ...protectedResult, warnings };
}

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

type CollaborationBackupCheckpointRow = {
  barrier_id: string;
  acquired_at: string;
  flushed_at: string;
  expires_at: string;
  flush_watermark: number;
  loaded_document_count: number;
  checkpoint_recorded_at: string;
};

function parseCollaborationBackupCheckpoint(
  row: CollaborationBackupCheckpointRow,
): BackupCollaborationCheckpoint {
  const checkpoint = parseCollaborationBarrier({
    barrierId: row.barrier_id,
    acquiredAt: row.acquired_at,
    flushedAt: row.flushed_at,
    expiresAt: row.expires_at,
    flushWatermark: Number(row.flush_watermark),
    loadedDocumentCount: Number(row.loaded_document_count),
  });
  if (!Number.isFinite(Date.parse(row.checkpoint_recorded_at))) {
    throw new Error("Backup snapshot contains an invalid collaboration checkpoint timestamp.");
  }
  return { ...checkpoint, checkpointRecordedAt: row.checkpoint_recorded_at };
}

function readCollaborationBackupCheckpoint(
  database: Database.Database,
): BackupCollaborationCheckpoint {
  if (!tableExists(database, "collaboration_backup_checkpoints")) {
    throw new Error(
      "Live backup requires migration 0045_collaboration_backup_checkpoint; no backup was finalized.",
    );
  }
  const row = database.prepare(
    `SELECT barrier_id, acquired_at, flushed_at, expires_at,
            flush_watermark, loaded_document_count, checkpoint_recorded_at
     FROM collaboration_backup_checkpoints
     WHERE checkpoint_slot = 1`,
  ).get() as CollaborationBackupCheckpointRow | undefined;
  if (!row) {
    throw new Error("Live backup snapshot does not contain a collaboration flush checkpoint.");
  }
  return parseCollaborationBackupCheckpoint(row);
}

function assertCheckpointCoversBarrier(
  checkpoint: BackupCollaborationCheckpoint,
  barrier: BackupCollaborationBarrier,
) {
  if (
    checkpoint.barrierId !== barrier.barrierId
    || checkpoint.acquiredAt !== barrier.acquiredAt
    || checkpoint.flushedAt !== barrier.flushedAt
    || checkpoint.loadedDocumentCount !== barrier.loadedDocumentCount
    || checkpoint.flushWatermark < barrier.flushWatermark
    || (
      isSnapshotCheckpoint(barrier)
      && checkpoint.checkpointRecordedAt !== barrier.checkpointRecordedAt
    )
  ) {
    throw new Error(
      "Backup snapshot collaboration checkpoint does not cover the acquired flush barrier.",
    );
  }
}

function recordCollaborationBackupCheckpoint(
  databasePath: string,
  barrierInput: BackupCollaborationBarrier,
): BackupCollaborationCheckpoint {
  const barrier = parseCollaborationBarrier(barrierInput);
  const checkpoint: BackupCollaborationCheckpoint = {
    ...barrier,
    checkpointRecordedAt: new Date().toISOString(),
  };
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.pragma("busy_timeout = 5000");
    if (!tableExists(database, "collaboration_backup_checkpoints")) {
      throw new Error(
        "Live backup requires migration 0045_collaboration_backup_checkpoint; no backup was finalized.",
      );
    }
    database.transaction(() => {
      database.prepare(
        `INSERT INTO collaboration_backup_checkpoints
         (checkpoint_slot, barrier_id, acquired_at, flushed_at, expires_at,
          flush_watermark, loaded_document_count, checkpoint_recorded_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(checkpoint_slot) DO UPDATE SET
           barrier_id = excluded.barrier_id,
           acquired_at = excluded.acquired_at,
           flushed_at = excluded.flushed_at,
           expires_at = excluded.expires_at,
           flush_watermark = excluded.flush_watermark,
           loaded_document_count = excluded.loaded_document_count,
           checkpoint_recorded_at = excluded.checkpoint_recorded_at`,
      ).run(
        checkpoint.barrierId,
        checkpoint.acquiredAt,
        checkpoint.flushedAt,
        checkpoint.expiresAt,
        checkpoint.flushWatermark,
        checkpoint.loadedDocumentCount,
        checkpoint.checkpointRecordedAt,
      );
    }).immediate();
    return checkpoint;
  } finally {
    database.close();
  }
}

function isSnapshotCheckpoint(
  barrier: BackupCollaborationBarrier | BackupCollaborationCheckpoint,
): barrier is BackupCollaborationCheckpoint {
  return "checkpointRecordedAt" in barrier;
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

async function createBackupGenerationInternal(input: BackupGenerationInput & {
  collaborationBarrier?: BackupCollaborationBarrier;
  assertCollaborationBarrierHeld?: () => Promise<void>;
}): Promise<BackupVerification> {
  const hasBarrierReceipt = input.collaborationBarrier !== undefined;
  const hasBarrierAssertion = input.assertCollaborationBarrierHeld !== undefined;
  if (hasBarrierReceipt !== hasBarrierAssertion) {
    throw new Error(
      "Live backups require both a collaboration barrier receipt and a held assertion.",
    );
  }
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
    await input.assertCollaborationBarrierHeld?.();
    const recordedCheckpoint = input.collaborationBarrier
      ? recordCollaborationBackupCheckpoint(databasePath, input.collaborationBarrier)
      : undefined;
    if (recordedCheckpoint) await input.assertCollaborationBarrierHeld?.();
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
    let snapshotCheckpoint: BackupCollaborationCheckpoint | undefined;
    let expectedMediaFiles: BackupFile[] = [];
    try {
      backupDatabase.pragma("foreign_keys = ON");
      integrity = assertDatabaseIntegrity(backupDatabase);
      tableInventory = captureTableInventory(backupDatabase);
      dataFingerprint = captureDatabaseFingerprint(backupDatabase);
      migrations = readAppliedMigrations(backupDatabase);
      expectedMediaFiles = expectedMediaFilesFromSnapshot(backupDatabase);
      if (recordedCheckpoint) {
        snapshotCheckpoint = readCollaborationBackupCheckpoint(backupDatabase);
        assertCheckpointCoversBarrier(snapshotCheckpoint, recordedCheckpoint);
      }
    } finally {
      backupDatabase.close();
    }
    const mediaFiles = await copyExpectedMediaFiles({
      sourceMediaRoot: mediaRoot,
      destinationMediaRoot: destinationMedia,
      expectedFiles: expectedMediaFiles,
    });
    await input.assertCollaborationBarrierHeld?.();
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
      ...(snapshotCheckpoint
        ? { collaborationBarrier: snapshotCheckpoint }
        : {}),
    };
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await verifyBackupGenerationAtPath(staging, {
      expectedGenerationId: generationId,
      requireDirectoryNameMatch: false,
    });
    await input.assertCollaborationBarrierHeld?.();
    await rename(staging, destination);
    return { generationPath: destination, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function createOfflineBackupGeneration(
  input: OfflineBackupGenerationInput,
): Promise<BackupVerification> {
  return withOfflineOperationLock(input.databasePath, {
    collaborationBaseUrl: input.collaborationBaseUrl,
    offlineCheckTimeoutMs: input.offlineCheckTimeoutMs,
  }, async ({ bindVerifiedBackup }) => {
    await assertCollaborationOffline(
      input.collaborationBaseUrl,
      input.offlineCheckTimeoutMs,
    );
    const generation = await createBackupGenerationInternal(input);
    await bindVerifiedBackup(generation);
    try {
      await assertCollaborationOffline(
        input.collaborationBaseUrl,
        input.offlineCheckTimeoutMs,
      );
      return generation;
    } catch (error) {
      await rm(generation.generationPath, { recursive: true, force: true });
      throw error;
    }
  });
}

export function createLiveBackupGeneration(
  input: LiveBackupGenerationInput,
): Promise<BackupVerification> {
  return createBackupGenerationInternal(input);
}

export async function withVerifiedOfflineOperationBackup<T>(input: {
  collaborationBaseUrl: string;
  databasePath: string;
  mediaRoot: string;
  backupRoot: string;
  sourceRevision: string;
  operation: (backup: BackupVerification) => Promise<T> | T;
  offlineCheckTimeoutMs?: number;
  onWarning?: (warning: string) => void;
}): Promise<DestructiveOperationBackupResult<T>> {
  const warnings: string[] = [];
  return withOfflineOperationLock(input.databasePath, {
    collaborationBaseUrl: input.collaborationBaseUrl,
    offlineCheckTimeoutMs: input.offlineCheckTimeoutMs,
  }, async ({ bindVerifiedBackup }) => {
    await assertCollaborationOffline(
      input.collaborationBaseUrl,
      input.offlineCheckTimeoutMs,
    );
    const backup = await createBackupGenerationInternal({
      databasePath: input.databasePath,
      mediaRoot: input.mediaRoot,
      backupRoot: input.backupRoot,
      sourceRevision: input.sourceRevision,
    });
    await bindVerifiedBackup(backup);
    try {
      await assertCollaborationOffline(
        input.collaborationBaseUrl,
        input.offlineCheckTimeoutMs,
      );
    } catch (error) {
      await rm(backup.generationPath, { recursive: true, force: true });
      throw error;
    }

    const result = await input.operation(backup);
    try {
      await assertCollaborationOffline(
        input.collaborationBaseUrl,
        input.offlineCheckTimeoutMs,
      );
    } catch (error) {
      // The operation has already completed. Preserve its pre-operation backup
      // and report a warning instead of encouraging a destructive retry.
      const warning = error instanceof Error ? error.message : String(error);
      warnings.push(warning);
      input.onWarning?.(warning);
    }
    return { backup, result, warnings };
  });
}

export async function withVerifiedMaintenanceOperationBackup<T>(input: {
  baseUrl: string;
  secret: string;
  databasePath: string;
  mediaRoot: string;
  backupRoot: string;
  sourceRevision: string;
  operation: (backup: BackupVerification) => Promise<T> | T;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  offlineCheckTimeoutMs?: number;
  onWarning?: (warning: string) => void;
}): Promise<DestructiveOperationBackupResult<T>> {
  const availability = await collaborationAvailability(
    input.baseUrl,
    input.offlineCheckTimeoutMs,
  );
  if (availability === "online") {
    return withVerifiedDestructiveOperationBackup(input);
  }
  return withVerifiedOfflineOperationBackup({
    collaborationBaseUrl: input.baseUrl,
    databasePath: input.databasePath,
    mediaRoot: input.mediaRoot,
    backupRoot: input.backupRoot,
    sourceRevision: input.sourceRevision,
    operation: input.operation,
    offlineCheckTimeoutMs: input.offlineCheckTimeoutMs,
    onWarning: input.onWarning,
  });
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
  if (manifest.collaborationBarrier !== undefined) {
    parseCollaborationBarrier(manifest.collaborationBarrier);
    if (
      isSnapshotCheckpoint(manifest.collaborationBarrier)
      && !Number.isFinite(Date.parse(manifest.collaborationBarrier.checkpointRecordedAt))
    ) {
      throw new Error("Invalid Nyxdoc backup collaboration checkpoint.");
    }
  }
  return manifest as BackupManifest;
}

function resolveManifestPath(generationPath: string, relative: string) {
  const resolved = path.resolve(generationPath, relative);
  if (!pathIsInside(resolved, generationPath)) throw new Error(`Unsafe manifest path ${relative}.`);
  return resolved;
}

async function verifyBackupGenerationAtPath(
  generationPathInput: string,
  options: {
    expectedGenerationId?: string;
    requireDirectoryNameMatch?: boolean;
  } = {},
): Promise<BackupVerification> {
  const generationPath = path.resolve(generationPathInput);
  const manifest = parseManifest(JSON.parse(await readFile(
    path.join(generationPath, "manifest.json"),
    "utf8",
  )) as unknown);
  if (
    options.expectedGenerationId !== undefined
    && manifest.generationId !== options.expectedGenerationId
  ) {
    throw new Error("Backup generation does not match the expected generationId.");
  }
  if (
    options.requireDirectoryNameMatch !== false
    && path.basename(generationPath) !== manifest.generationId
  ) {
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
    if (
      manifest.collaborationBarrier
      && isSnapshotCheckpoint(manifest.collaborationBarrier)
    ) {
      const snapshotCheckpoint = readCollaborationBackupCheckpoint(database);
      assertCheckpointCoversBarrier(snapshotCheckpoint, manifest.collaborationBarrier);
      if (
        snapshotCheckpoint.checkpointRecordedAt
        !== manifest.collaborationBarrier.checkpointRecordedAt
      ) {
        throw new Error("Backup manifest collaboration checkpoint does not match its snapshot.");
      }
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

export function verifyBackupGeneration(
  generationPathInput: string,
): Promise<BackupVerification> {
  return verifyBackupGenerationAtPath(generationPathInput);
}

async function verifyRestoredDatabase(
  databasePath: string,
  manifest: BackupManifest["database"],
) {
  const databaseMetadata = await lstat(databasePath);
  if (!databaseMetadata.isFile()) {
    throw new Error(`Restore database target is not a regular file: ${databasePath}`);
  }
  if (
    databaseMetadata.size !== manifest.byteSize
    || await sha256File(databasePath) !== manifest.sha256
  ) {
    throw new Error(`Restore database target does not match the confirmed backup: ${databasePath}`);
  }

  const restoredDatabase = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    restoredDatabase.pragma("foreign_keys = ON");
    assertDatabaseIntegrity(restoredDatabase);
    const fingerprint = captureDatabaseFingerprint(
      restoredDatabase,
      manifest.dataFingerprint,
    );
    assertDatabaseFingerprintEqual(manifest.dataFingerprint, fingerprint);
  } finally {
    restoredDatabase.close();
  }
}

async function assertNoRestoreDatabaseSidecars(databasePath: string) {
  for (const sidecarPath of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    if (await exists(sidecarPath)) {
      throw new Error(`Restore database SQLite sidecar target already exists: ${sidecarPath}`);
    }
  }
}

async function verifyRestoredMedia(
  mediaRoot: string,
  manifest: BackupManifest["media"],
) {
  const mediaMetadata = await lstat(mediaRoot);
  if (!mediaMetadata.isDirectory()) {
    throw new Error(`Restore media target is not a directory: ${mediaRoot}`);
  }

  const actualPaths = (await walkFiles(mediaRoot)).map(normalizedRelative).sort();
  const expectedPaths = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`Restore media target does not match the confirmed backup: ${mediaRoot}`);
  }

  const restoredMedia: BackupFile[] = [];
  for (const expected of sortedBackupFiles(manifest.files)) {
    const filename = resolveMediaStoragePath(mediaRoot, expected.path);
    const fileMetadata = await stat(filename);
    const actual: BackupFile = {
      path: expected.path,
      byteSize: fileMetadata.size,
      sha256: await sha256File(filename),
    };
    if (actual.byteSize !== expected.byteSize || actual.sha256 !== expected.sha256) {
      throw new Error(`Restore media target does not match the confirmed backup: ${expected.path}`);
    }
    restoredMedia.push(actual);
  }
  if (
    restoredMedia.length !== manifest.fileCount
    || restoredMedia.reduce((total, file) => total + file.byteSize, 0) !== manifest.totalBytes
    || mediaTreeSha256(sortedBackupFiles(restoredMedia)) !== manifest.treeSha256
  ) {
    throw new Error(`Restore media target does not match the confirmed backup: ${mediaRoot}`);
  }
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
  const databaseAlreadyInstalled = await exists(databasePath);
  let mediaAlreadyInstalled = await exists(mediaRoot);
  let emptyMediaPlaceholder = false;
  if (databaseAlreadyInstalled) {
    await verifyRestoredDatabase(databasePath, verified.manifest.database);
  } else {
    await assertNoRestoreDatabaseSidecars(databasePath);
  }
  if (mediaAlreadyInstalled) {
    const mediaMetadata = await lstat(mediaRoot);
    if (
      mediaMetadata.isDirectory()
      && verified.manifest.media.fileCount > 0
      && (await readdir(mediaRoot)).length === 0
    ) {
      // Docker copies empty directories baked into an image into a pristine
      // named volume on first mount. Treat that empty scaffold as an absent
      // restore target, but remove it with rmdir immediately before the
      // atomic rename so a concurrent writer makes the restore fail closed.
      mediaAlreadyInstalled = false;
      emptyMediaPlaceholder = true;
    } else {
      await verifyRestoredMedia(mediaRoot, verified.manifest.media);
    }
  }

  const result = {
    generationId: verified.manifest.generationId,
    databasePath,
    mediaRoot,
    databaseSha256: verified.manifest.database.sha256,
    mediaTreeSha256: verified.manifest.media.treeSha256,
  };
  if (databaseAlreadyInstalled && mediaAlreadyInstalled) return result;

  const suffix = `.restore-${randomUUID()}.tmp`;
  const stagingDatabase = `${databasePath}${suffix}`;
  const stagingMedia = `${mediaRoot}${suffix}`;
  let mediaInstalled = false;
  let databaseInstalled = false;
  try {
    await mkdir(path.dirname(databasePath), { recursive: true });
    await mkdir(path.dirname(mediaRoot), { recursive: true });
    if (!mediaAlreadyInstalled) {
      await mkdir(stagingMedia, { recursive: true });
      await copyExpectedMediaFiles({
        sourceMediaRoot: path.join(verified.generationPath, verified.manifest.media.path),
        destinationMediaRoot: stagingMedia,
        expectedFiles: verified.manifest.media.files,
      });
      await verifyRestoredMedia(stagingMedia, verified.manifest.media);
    }
    if (!databaseAlreadyInstalled) {
      await copyFile(
        path.join(verified.generationPath, verified.manifest.database.path),
        stagingDatabase,
      );
      await verifyRestoredDatabase(stagingDatabase, verified.manifest.database);
    }

    if (!mediaAlreadyInstalled) {
      if (emptyMediaPlaceholder) await rmdir(mediaRoot);
      await rename(stagingMedia, mediaRoot);
      mediaInstalled = true;
    }
    if (!databaseAlreadyInstalled) {
      await assertNoRestoreDatabaseSidecars(databasePath);
      await rename(stagingDatabase, databasePath);
      databaseInstalled = true;
      await verifyRestoredDatabase(databasePath, verified.manifest.database);
    }
    return result;
  } catch (error) {
    await rm(stagingDatabase, { force: true });
    await rm(stagingMedia, { recursive: true, force: true });
    if (databaseInstalled) await rm(databasePath, { force: true });
    if (mediaInstalled) await rm(mediaRoot, { recursive: true, force: true });
    throw error;
  }
}
