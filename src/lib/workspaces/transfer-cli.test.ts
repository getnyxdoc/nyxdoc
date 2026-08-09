import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { runAppMigrations } from "@/lib/db/migrations";
import { createDocument } from "@/lib/documents/service";
import { authenticateApiToken, createWorkspaceToken } from "@/lib/tokens/service";
import { createTestUser } from "@/test/fixture";
import { createWorkspace } from "@/lib/workspaces/service";

const temporaryDirectories: string[] = [];
const barrierSidecars: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  while (barrierSidecars.length) {
    await barrierSidecars.pop()!.stop();
  }
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

async function startBarrierSidecar(secret: string) {
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
      const write = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.headers.authorization !== "Bearer " + secret) {
        return write(401, { error: "unauthorized" });
      }
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
      if (request.url === "/internal/backup/barrier/status"
          || request.url === "/internal/backup/barrier/renew") {
        return write(200, receipt());
      }
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
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error(
      `Test collaboration barrier did not start. ${stderr}`,
    )), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        resolve(Number(JSON.parse(stdout.slice(0, newline)).port));
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
        reject(new Error(`Test collaboration barrier exited (${code}). ${stderr}`));
      }
    });
  });
  let stopped = false;
  const sidecar = {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (stopped || child.exitCode !== null) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
        const deadline = setTimeout(() => reject(new Error(
          "Test collaboration barrier did not stop within 5 seconds.",
        )), 5_000);
        child.once("exit", () => {
          clearTimeout(force);
          clearTimeout(deadline);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
  barrierSidecars.push(sidecar);
  return sidecar;
}

function runTransferCli(environment: NodeJS.ProcessEnv, args: string[]) {
  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(process.cwd(), "scripts", "transfer-workspace-tree.ts"),
    ...args,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error(`workspace transfer CLI failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("workspace transfer CLI", () => {
  it("dry-runs without a backup, then backs up, preflights, transfers, and records a receipt", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nyxdoc-transfer-cli-test-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nyxdoc.db");
    const mediaRoot = path.join(directory, "media");
    const backupRoot = path.join(directory, "backups");
    mkdirSync(mediaRoot, { recursive: true });

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
    runAppMigrations(database, { sourceRevision: "transfer-cli-test" });
    const { user, workspace: source } = createTestUser(database);
    const target = createWorkspace(database, user, "gameroom");
    const starter = database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? AND title = 'Getting started'",
    ).get(target.id) as { id: string };
    const credential = createWorkspaceToken(database, {
      workspaceId: source.id,
      userId: user.id,
      name: "gameroom",
      role: "editor",
    });
    const human = {
      type: "human" as const,
      userId: user.id,
      label: user.name,
      source: "web" as const,
    };
    const root = createDocument(database, source.id, human, {
      title: "gameroom",
      content: { schemaVersion: 2, blocks: [{ id: randomUUID(), type: "h1", children: [{ text: "정본" }] }] },
    });
    const agentActor = {
      type: "agent",
      userId: user.id,
      tokenId: credential.summary.id,
      principalId: credential.summary.agentId,
      label: "gameroom",
      source: "mcp",
    } as const;
    const child = createDocument(database, source.id, agentActor, {
      requestId: "transfer-cli-child",
      title: "운영",
      parentDocumentId: root.document.id,
      content: { schemaVersion: 2, blocks: [{ id: randomUUID(), type: "p", children: [{ text: "운영 기록" }] }] },
    });
    const archivedQa = createDocument(database, source.id, agentActor, {
      requestId: "transfer-cli-archived-qa",
      title: "QA-ARCHIVED",
      content: { schemaVersion: 2, blocks: [{ id: randomUUID(), type: "p", children: [{ text: "과거 QA 기록" }] }] },
    });
    database.prepare(
      "UPDATE documents SET status = 'archived', lifecycle_state = 'archived' WHERE id = ?",
    ).run(archivedQa.document.id);
    database.close();

    const commonArgs = [
      "--source", source.id,
      "--target", target.id,
      "--root", root.document.id,
      "--agent", credential.summary.agentId,
      "--archive-target-document", starter.id,
      "--archive-outside-history",
      "--archive-history-name", "gameroom QA archive",
    ];
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      BETTER_AUTH_SECRET: "transfer-cli-test-secret-with-more-than-32-characters",
      NODE_ENV: "test",
      NYXDOC_BACKUP_ROOT: backupRoot,
      NYXDOC_DB_PATH: databasePath,
      NYXDOC_MEDIA_ROOT: mediaRoot,
      NYXDOC_SOURCE_REVISION: "transfer-cli-test",
    };
    const preview = runTransferCli(environment, commonArgs);
    expect(preview).toMatchObject({
      mode: "dry-run",
      plan: {
        status: "blocked",
        counts: {
          documents: 2,
          blocks: 2,
          revisions: 2,
          events: 2,
          internalReferences: 0,
          media: 0,
          credentials: 1,
          writeReceipts: 2,
        },
      },
      historyArchive: {
        requested: true,
        displayName: "gameroom QA archive",
        plan: {
          status: "ready",
          counts: {
            documents: 1,
            revisions: 1,
            events: 1,
            writeReceipts: 1,
            media: 0,
          },
        },
        resolvesCurrentTransferBlockers: true,
        projectedTransferCounts: { writeReceipts: 1 },
      },
    });
    expect(() => readdirSync(backupRoot)).toThrow();

    const barrierSecret = "transfer-cli-collaboration-secret-0123456789-abcdef";
    const barrier = await startBarrierSidecar(barrierSecret);
    const result = runTransferCli({
      ...environment,
      NYXDOC_COLLABORATION_SECRET: barrierSecret,
      NYXDOC_COLLABORATION_INTERNAL_URL: barrier.baseUrl,
    }, [
      ...commonArgs,
      "--expect-documents", "2",
      "--expect-blocks", "2",
      "--expect-revisions", "2",
      "--expect-events", "2",
      "--expect-internal-references", "0",
      "--expect-media", "0",
      "--expect-credentials", "1",
      "--expect-write-receipts", "1",
      "--expect-archived-documents", "1",
      "--expect-archived-revisions", "1",
      "--expect-archived-events", "1",
      "--expect-archived-write-receipts", "1",
      "--expect-archived-media", "0",
      "--confirm-root", root.document.id,
      "--apply",
    ]);
    expect(result.status).toBe("transferred");
    const generations = readdirSync(backupRoot);
    expect(generations).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(
      path.join(backupRoot, generations[0], "workspace-transfer-receipt.json"),
      "utf8",
    )) as { outcome: string; expected: { documents: number } };
    expect(receipt).toMatchObject({ outcome: "succeeded", expected: { documents: 2 } });

    const verified = openDatabase(databasePath);
    try {
      expect(verified.prepare(
        "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ? AND id IN (?, ?)",
      ).get(target.id, root.document.id, child.document.id)).toEqual({ count: 2 });
      expect(verified.prepare(
        "SELECT lifecycle_state FROM documents WHERE id = ?",
      ).get(starter.id)).toEqual({ lifecycle_state: "trashed" });
      expect(authenticateApiToken(verified, `Bearer ${credential.token}`).workspaceId).toBe(target.id);
      expect(verified.prepare(
        "SELECT workspace_id, status, lifecycle_state FROM documents WHERE id = ?",
      ).get(archivedQa.document.id)).toEqual({
        workspace_id: source.id,
        status: "archived",
        lifecycle_state: "archived",
      });
      expect(verified.prepare(
        "SELECT COUNT(*) AS count FROM workspace_agents WHERE workspace_id = ? AND display_name = ? AND status = 'disabled'",
      ).get(source.id, "gameroom QA archive")).toEqual({ count: 1 });
      expect(verified.prepare(
        "SELECT COUNT(*) AS count FROM agent_write_requests WHERE token_id = ?",
      ).get(credential.summary.id)).toEqual({ count: 1 });
    } finally {
      verified.close();
    }
  }, 30_000);
});
