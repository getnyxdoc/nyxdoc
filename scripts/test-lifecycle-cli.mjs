#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32"
  ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];

function runNpm(args, env, expectedStatus = 0) {
  const result = spawnSync(npm, [...npmPrefix, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, expectedStatus, output);
  return output;
}

function parseJsonOutput(output) {
  const start = output.indexOf("{\n");
  assert.notEqual(start, -1, `Expected JSON output:\n${output}`);
  return JSON.parse(output.slice(start));
}

function assertInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  assert(relative && !relative.startsWith(`..${path.sep}`) && relative !== "..", `${candidate} is outside ${parent}`);
}

function databaseSummary(filename) {
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    return {
      integrity: database.pragma("integrity_check", { simple: true }),
      migrations: database.prepare("SELECT COUNT(*) AS count FROM _nyxdoc_migrations").get().count,
      users: database.prepare("SELECT COUNT(*) AS count FROM user").get().count,
    };
  } finally {
    database.close();
  }
}

async function isolatedClosedCollaborationUrl() {
  const reservation = createTcpServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert(address && typeof address !== "string", "failed to reserve an isolated collaboration port");
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  assert.notEqual(address.port, 3101, "the lifecycle test must never inherit the developer collaboration port");
  return `http://127.0.0.1:${address.port}`;
}

async function startCollaborationBarrierSidecar(secret) {
  // backup:create must prove that collaboration writes were flushed before it
  // snapshots SQLite and media. Run a deliberately tiny, process-isolated
  // contract server rather than weakening the production backup command for
  // this filesystem-only lifecycle test.
  const source = String.raw`
    const http = require("node:http");
    const { randomUUID } = require("node:crypto");
    const secret = process.env.NYXDOC_TEST_BARRIER_SECRET;
    let active = null;

    function receipt() {
      return {
        barrierId: active.id,
        acquiredAt: active.acquiredAt,
        flushedAt: active.flushedAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        flushWatermark: 0,
        loadedDocumentCount: 0,
      };
    }

    const server = http.createServer((request, response) => {
      if (request.headers.authorization !== "Bearer " + secret) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const write = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method !== "POST") return write(405, { error: "method" });
      if (request.url === "/internal/backup/barrier/acquire") {
        if (active) return write(409, { error: "already acquired" });
        const now = new Date().toISOString();
        active = { id: randomUUID(), acquiredAt: now, flushedAt: now };
        return write(200, receipt());
      }
      if (!active) return write(409, { error: "missing barrier" });
      if (request.url === "/internal/backup/barrier/release") {
        const result = { ...receipt(), released: true };
        active = null;
        return write(200, result);
      }
      if (
        request.url === "/internal/backup/barrier/status"
        || request.url === "/internal/backup/barrier/renew"
      ) return write(200, receipt());
      return write(404, { error: "not found" });
    });

    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n");
    });
    const close = () => server.close(() => process.exit(0));
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  `;
  const child = spawn(process.execPath, ["-e", source], {
    env: { ...process.env, NYXDOC_TEST_BARRIER_SECRET: secret },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startupError = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { startupError += chunk; });
  let port;
  try {
    port = await new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error(
      `Collaboration backup barrier sidecar did not start.${startupError ? ` ${startupError}` : ""}`,
    )), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)).port);
      } catch (error) {
        reject(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Collaboration backup barrier sidecar exited (${code}). ${startupError}`));
      }
    });
    });
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise((resolve, reject) => {
        const forceTimeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
        const completionTimeout = setTimeout(() => {
          reject(new Error("Collaboration backup barrier sidecar did not stop within 5 seconds."));
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(forceTimeout);
          clearTimeout(completionTimeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}

async function main() {
  const temporary = await mkdtemp(path.join(tmpdir(), "nyxdoc-lifecycle-cli-"));
  const live = path.join(temporary, "live");
  const backups = path.join(temporary, "backups");
  const restored = path.join(temporary, "restored");
  const databasePath = path.join(live, "nyxdoc.db");
  const mediaRoot = path.join(live, "media");
  const restoredDatabasePath = path.join(restored, "nyxdoc.db");
  const restoredMediaRoot = path.join(restored, "media");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "lifecycle-cli-auth-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
    NYXDOC_COLLABORATION_SECRET: "lifecycle-cli-collaboration-secret-0123456789-abcdefghijkl",
    NYXDOC_DB_PATH: databasePath,
    NYXDOC_MEDIA_ROOT: mediaRoot,
    NYXDOC_BACKUP_ROOT: backups,
    NYXDOC_SOURCE_REVISION: "lifecycle-cli-contract",
    NYXDOC_COLLABORATION_INTERNAL_URL: await isolatedClosedCollaborationUrl(),
  };
  let collaborationBarrier;

  try {
    await mkdir(backups, { recursive: true });
    const migrated = runNpm(["run", "db:migrate"], env);
    assert.match(migrated, /"status": "migrated"/);

    const retried = runNpm(["run", "db:migrate"], env);
    assert.match(retried, /database is up to date; no backup generation was required/);

    // The first migration intentionally created its own safety backup. Clear
    // that setup artifact so the next assertion observes only the verified
    // backup command's fail-closed barrier behavior.
    await rm(backups, { recursive: true, force: true });
    await mkdir(backups, { recursive: true });

    const missingBarrier = runNpm([
      "run",
      "backup:create",
      "--",
      "--output",
      backups,
    ], env, 1);
    assert.match(missingBarrier, /requires a live collaboration barrier/i);
    assert.deepEqual(
      await readdir(backups),
      [],
      "a failed collaboration barrier must not finalize a backup generation",
    );

    collaborationBarrier = await startCollaborationBarrierSidecar(env.NYXDOC_COLLABORATION_SECRET);
    env.NYXDOC_COLLABORATION_INTERNAL_URL = collaborationBarrier.baseUrl;
    const backup = parseJsonOutput(runNpm([
      "run",
      "backup:create",
      "--",
      "--output",
      backups,
    ], env));
    assert.equal(backup.status, "verified");
    assertInside(backup.generationPath, backups);
    assert.equal(typeof backup.collaborationBarrierId, "string");
    assert.equal(backup.collaborationLoadedDocuments, 0);

    const verified = parseJsonOutput(runNpm([
      "run",
      "backup:verify",
      "--",
      backup.generationPath,
    ], env));
    assert.equal(verified.status, "verified");
    assert.equal(verified.generationId, backup.generationId);

    const wrongConfirmationDatabase = path.join(temporary, "wrong-confirm", "nyxdoc.db");
    const wrongConfirmationMedia = path.join(temporary, "wrong-confirm", "media");
    const wrongConfirmation = runNpm([
      "run",
      "backup:restore",
      "--",
      backup.generationPath,
      "--database",
      wrongConfirmationDatabase,
      "--media",
      wrongConfirmationMedia,
      "--confirm-generation",
      "not-the-confirmed-generation",
    ], env, 1);
    assert.match(wrongConfirmation, /confirmation does not match/i);

    const tamperedParent = path.join(temporary, "tampered-backup");
    const tamperedGeneration = path.join(tamperedParent, backup.generationId);
    await mkdir(tamperedParent, { recursive: true });
    await cp(backup.generationPath, tamperedGeneration, { recursive: true, errorOnExist: true });
    await appendFile(path.join(tamperedGeneration, "nyxdoc.db"), "tampered");
    const tamperedVerification = runNpm([
      "run",
      "backup:verify",
      "--",
      tamperedGeneration,
    ], env, 1);
    assert.match(tamperedVerification, /size mismatch|SHA-256 mismatch/i);

    const restoredOutput = parseJsonOutput(runNpm([
      "run",
      "backup:restore",
      "--",
      backup.generationPath,
      "--database",
      restoredDatabasePath,
      "--media",
      restoredMediaRoot,
      "--confirm-generation",
      backup.generationId,
    ], env));
    assert.equal(restoredOutput.status, "restored-and-verified");

    assert.deepEqual(databaseSummary(restoredDatabasePath), databaseSummary(databasePath));

    const repeatedRestore = parseJsonOutput(runNpm([
      "run",
      "backup:restore",
      "--",
      backup.generationPath,
      "--database",
      restoredDatabasePath,
      "--media",
      restoredMediaRoot,
      "--confirm-generation",
      backup.generationId,
    ], env));
    assert.equal(repeatedRestore.status, "restored-and-verified");
    assert.equal(repeatedRestore.generationId, backup.generationId);

    const databaseFirstRoot = path.join(temporary, "database-first");
    const databaseFirstPath = path.join(databaseFirstRoot, "nyxdoc.db");
    const databaseFirstMedia = path.join(databaseFirstRoot, "media");
    await mkdir(databaseFirstRoot, { recursive: true });
    await copyFile(path.join(backup.generationPath, "nyxdoc.db"), databaseFirstPath);
    const databaseFirstRestore = parseJsonOutput(runNpm([
      "run",
      "backup:restore",
      "--",
      backup.generationPath,
      "--database",
      databaseFirstPath,
      "--media",
      databaseFirstMedia,
      "--confirm-generation",
      backup.generationId,
    ], env));
    assert.equal(databaseFirstRestore.status, "restored-and-verified");
    assert.deepEqual(databaseSummary(databaseFirstPath), databaseSummary(databasePath));

    const mediaFirstRoot = path.join(temporary, "media-first");
    const mediaFirstPath = path.join(mediaFirstRoot, "nyxdoc.db");
    const mediaFirstMedia = path.join(mediaFirstRoot, "media");
    await mkdir(mediaFirstRoot, { recursive: true });
    await cp(path.join(backup.generationPath, "media"), mediaFirstMedia, { recursive: true });
    const mediaFirstRestore = parseJsonOutput(runNpm([
      "run",
      "backup:restore",
      "--",
      backup.generationPath,
      "--database",
      mediaFirstPath,
      "--media",
      mediaFirstMedia,
      "--confirm-generation",
      backup.generationId,
    ], env));
    assert.equal(mediaFirstRestore.status, "restored-and-verified");
    assert.deepEqual(databaseSummary(mediaFirstPath), databaseSummary(databasePath));

    const corruptTargetRoot = path.join(temporary, "corrupt-target");
    const corruptTargetDatabase = path.join(corruptTargetRoot, "nyxdoc.db");
    const corruptTargetMedia = path.join(corruptTargetRoot, "media");
    await mkdir(corruptTargetRoot, { recursive: true });
    await copyFile(path.join(backup.generationPath, "nyxdoc.db"), corruptTargetDatabase);
    await appendFile(corruptTargetDatabase, "not-the-confirmed-database");
    const corruptBytesBefore = await readFile(corruptTargetDatabase);
    const corruptTargetRestore = runNpm([
      "run",
      "backup:restore",
      "--",
      backup.generationPath,
      "--database",
      corruptTargetDatabase,
      "--media",
      corruptTargetMedia,
      "--confirm-generation",
      backup.generationId,
    ], env, 1);
    assert.match(corruptTargetRestore, /does not match the confirmed backup/i);
    assert.deepEqual(await readFile(corruptTargetDatabase), corruptBytesBefore);

    const foreignValidRoot = path.join(temporary, "foreign-valid-target");
    const foreignValidDatabase = path.join(foreignValidRoot, "nyxdoc.db");
    const foreignValidMedia = path.join(foreignValidRoot, "media");
    await mkdir(foreignValidRoot, { recursive: true });
    await copyFile(path.join(backup.generationPath, "nyxdoc.db"), foreignValidDatabase);
    const foreignDatabase = new Database(foreignValidDatabase);
    try {
      foreignDatabase.pragma("user_version = 999");
      assert.equal(foreignDatabase.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      foreignDatabase.close();
    }
    const foreignValidBytesBefore = await readFile(foreignValidDatabase);
    const foreignValidRestore = runNpm([
      "run",
      "backup:restore",
      "--",
      backup.generationPath,
      "--database",
      foreignValidDatabase,
      "--media",
      foreignValidMedia,
      "--confirm-generation",
      backup.generationId,
    ], env, 1);
    assert.match(foreignValidRestore, /does not match the confirmed backup/i);
    assert.deepEqual(await readFile(foreignValidDatabase), foreignValidBytesBefore);
    await assert.rejects(stat(foreignValidMedia));

    const foreignMediaRoot = path.join(temporary, "foreign-media");
    const foreignMediaDatabase = path.join(foreignMediaRoot, "nyxdoc.db");
    const foreignMedia = path.join(foreignMediaRoot, "media");
    await mkdir(foreignMedia, { recursive: true });
    await writeFile(path.join(foreignMedia, "unrelated.txt"), "preserve-me");
    const foreignMediaRestore = runNpm([
      "run",
      "backup:restore",
      "--",
      backup.generationPath,
      "--database",
      foreignMediaDatabase,
      "--media",
      foreignMedia,
      "--confirm-generation",
      backup.generationId,
    ], env, 1);
    assert.match(foreignMediaRestore, /does not match the confirmed backup/i);
    assert.equal(await readFile(path.join(foreignMedia, "unrelated.txt"), "utf8"), "preserve-me");
    await assert.rejects(stat(foreignMediaDatabase));

    console.log("Lifecycle CLI migration, tamper detection, partial recovery, idempotent restore, and retry contracts passed.");
  } finally {
    await collaborationBarrier?.stop();
    if (path.dirname(temporary) === path.resolve(tmpdir()) && path.basename(temporary).startsWith("nyxdoc-lifecycle-cli-")) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
