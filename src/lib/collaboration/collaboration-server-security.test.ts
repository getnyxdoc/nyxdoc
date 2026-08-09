import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { MessageType } from "@hocuspocus/server";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { connectAgentToWorkspace, createAccountAgent } from "@/lib/agents/service";
import {
  collaborationDocumentFromYDoc,
  ensureCollaborationState,
  loadCollaborationStateByRoom,
  replaceWorkingDocument,
} from "@/lib/collaboration/drafts";
import type { CollaborationTokenClaims } from "@/lib/collaboration/token";
import {
  createLiveBackupGeneration,
  verifyBackupGeneration,
  withCollaborationBackupBarrier,
  type BackupCollaborationBarrier,
} from "@/lib/db/backup";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import { runAppMigrations } from "@/lib/db/migrations";
import { createDocument } from "@/lib/documents/service";
import { createOrganization } from "@/lib/organizations/service";
import { createWorkspace } from "@/lib/workspaces/service";
import { createTestUser } from "@/test/fixture";

const COLLABORATION_SECRET = "collaboration-server-security-test-secret";
const providers: HocuspocusProvider[] = [];
const websocketProviders: HocuspocusProviderWebsocket[] = [];
const servers: RunningServer[] = [];
const temporaryDirectories: string[] = [];

type Fixture = ReturnType<typeof createFixture>;

type RunningServer = {
  process: ChildProcessWithoutNullStreams;
  port: number;
  logs: () => string;
};

type ServerOptions = {
  applyFailureMarker?: string;
  barrierLeaseMs?: number;
  barrierQuiesceTimeoutMs?: number;
  updatePersistenceInterlock?: string;
};

type ProviderHarness = {
  provider: HocuspocusProvider;
  websocketProvider: HocuspocusProviderWebsocket;
  document: Y.Doc;
  closeReasons: string[];
  authenticationFailures: string[];
  stateless: string[];
};

afterEach(async () => {
  while (providers.length > 0) providers.pop()?.destroy();
  while (websocketProviders.length > 0) websocketProviders.pop()?.destroy();
  while (servers.length > 0) await stopServer(servers.pop()!);
  while (temporaryDirectories.length > 0) {
    removeTemporaryDirectory(temporaryDirectories.pop()!);
  }
});

function removeTemporaryDirectory(directory: string) {
  const remove = () => rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
  try {
    remove();
  } catch (error) {
    // Windows can retain the SQLite handle until the Vitest worker itself
    // exits even after the child server has terminated. Do not turn a product
    // assertion into a false failure; make one final best-effort cleanup when
    // that worker releases all inherited handles.
    if (
      process.platform !== "win32"
      || typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "EPERM"
    ) {
      throw error;
    }
    process.once("exit", () => {
      try {
        remove();
      } catch {
        // The operating system will reclaim the isolated temp tree later.
      }
    });
  }
}

function createPersistentTestDatabase(databasePath: string) {
  const database = openDatabase(databasePath);
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
    CREATE TABLE verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  runAppMigrations(database);
  return database;
}

function createFixture(options: { organization?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "nyxdoc-collaboration-security-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "nyxdoc.db");
  const mediaRoot = path.join(directory, "media");
  const backupRoot = path.join(directory, "backups");
  mkdirSync(mediaRoot, { recursive: true });
  const database = createPersistentTestDatabase(databasePath);
  try {
    const owner = createTestUser(database, {
      name: "Collaboration owner",
      email: `collaboration-owner-${randomUUID()}@example.com`,
    });
    const editor = createTestUser(database, {
      name: "Collaboration editor",
      email: `collaboration-editor-${randomUUID()}@example.com`,
    });
    let organizationId: string | null = null;
    let workspaceId = owner.workspace.id;
    if (options.organization) {
      const organization = createOrganization(database, {
        userId: owner.user.id,
        actorLabel: owner.user.name,
        name: `Collaboration organization ${randomUUID()}`,
      });
      organizationId = organization.id;
      const now = new Date().toISOString();
      database.prepare(
        `INSERT INTO organization_members
         (id, organization_id, user_id, role, created_at, updated_at)
         VALUES (?, ?, ?, 'member', ?, ?)`,
      ).run(randomUUID(), organization.id, editor.user.id, now, now);
      workspaceId = createWorkspace(
        database,
        owner.user,
        `Collaboration organization workspace ${randomUUID()}`,
        "en",
        { organizationId: organization.id },
      ).id;
    }
    const created = createDocument(database, workspaceId, {
      type: "human",
      userId: owner.user.id,
      principalId: owner.user.id,
      label: owner.user.name,
      source: "web",
    }, {
      title: "Protected collaboration draft",
      content: {
        schemaVersion: 2,
        blocks: [{ id: randomUUID(), type: "p", children: [{ text: "baseline" }] }],
      },
    });
    const state = ensureCollaborationState(
      database,
      workspaceId,
      created.document.id,
    );
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO workspace_members
       (id, workspace_id, user_id, role, created_at, access_role)
       VALUES (?, ?, ?, 'member', ?, 'editor')`,
    ).run(randomUUID(), workspaceId, editor.user.id, now);

    const outsideRoot = createDocument(database, workspaceId, {
      type: "human",
      userId: owner.user.id,
      principalId: owner.user.id,
      label: owner.user.name,
      source: "web",
    }, {
      title: "Outside collaboration root",
      content: {
        schemaVersion: 2,
        blocks: [{ id: randomUUID(), type: "p", children: [{ text: "outside" }] }],
      },
    });

    const personalOrganizationAgent = options.organization
      ? createAccountAgent(database, {
          userId: owner.user.id,
          displayName: "Collaboration test personal agent",
        })
      : null;
    const connectedAgent = connectAgentToWorkspace(database, {
      userId: owner.user.id,
      workspaceId,
      agent: personalOrganizationAgent
        ? { mode: "existing", agentId: personalOrganizationAgent.id }
        : { mode: "new", displayName: "Collaboration test agent" },
      accessProfile: "writer",
      rootDocumentId: null,
      credential: {
        mode: "new",
        name: "Collaboration test credential",
        restrictToWorkspace: false,
      },
    });
    if (!connectedAgent.credential) throw new Error("Agent credential was not created");

    const foreignMediaId = randomUUID();
    const foreignMediaBytes = Buffer.from([0]);
    const foreignMediaStorageKey = `${foreignMediaId}.png`;
    writeFileSync(path.join(mediaRoot, foreignMediaStorageKey), foreignMediaBytes);
    database.prepare(
      `INSERT INTO media_assets
       (id, workspace_id, storage_key, sha256, mime_type, byte_size,
        original_filename, uploaded_by_user_id, uploaded_by_token_id, created_at)
       VALUES (?, ?, ?, ?, 'image/png', 1, NULL, ?, NULL, ?)`,
    ).run(
      foreignMediaId,
      editor.workspace.id,
      foreignMediaStorageKey,
      createHash("sha256").update(foreignMediaBytes).digest("hex"),
      editor.user.id,
      now,
    );

    return {
      databasePath,
      directory,
      mediaRoot,
      backupRoot,
      workspaceId,
      organizationId,
      documentId: created.document.id,
      outsideRootDocumentId: outsideRoot.document.id,
      roomName: state.roomName,
      owner: owner.user,
      editor: editor.user,
      agent: {
        id: connectedAgent.agent.id,
        label: connectedAgent.agent.displayName,
        credentialId: connectedAgent.credential.id,
        grantId: connectedAgent.membership.membershipId,
        bindingId: connectedAgent.binding?.id
          ?? (() => { throw new Error("Agent credential binding was not created"); })(),
      },
      foreignMediaId,
    };
  } finally {
    database.close();
  }
}

function signCollaborationToken(
  fixture: Fixture,
  actor: CollaborationTokenClaims["actor"],
  write = true,
) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const claims: CollaborationTokenClaims = {
    version: 1,
    tokenId: randomUUID(),
    roomName: fixture.roomName,
    workspaceId: fixture.workspaceId,
    documentId: fixture.documentId,
    generation: 1,
    actor,
    permissions: { read: true, write, commit: write },
    issuedAt,
    expiresAt: issuedAt + 300,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", COLLABORATION_SECRET)
    .update(payload, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

async function availablePort() {
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
  return address.port;
}

async function startServer(databasePath: string, options: ServerOptions = {}) {
  const port = await availablePort();
  const tsxCli = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "scripts/collaboration-server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      NYXDOC_DB_PATH: databasePath,
      NYXDOC_COLLABORATION_PORT: String(port),
      NYXDOC_COLLABORATION_SECRET: COLLABORATION_SECRET,
      ...(options.applyFailureMarker
        ? { NYXDOC_TEST_APPLY_FAILURE_MARKER: options.applyFailureMarker }
        : {}),
      ...(options.barrierLeaseMs
        ? { NYXDOC_BACKUP_BARRIER_LEASE_MS: String(options.barrierLeaseMs) }
        : {}),
      ...(options.barrierQuiesceTimeoutMs
        ? { NYXDOC_BACKUP_BARRIER_QUIESCE_TIMEOUT_MS: String(options.barrierQuiesceTimeoutMs) }
        : {}),
      ...(options.updatePersistenceInterlock
        ? { NYXDOC_TEST_UPDATE_PERSISTENCE_INTERLOCK: options.updatePersistenceInterlock }
        : {}),
    },
    stdio: "pipe",
  });
  let output = "";
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const running = { process: child, port, logs: () => output } satisfies RunningServer;
  servers.push(running);

  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Collaboration server exited early:\n${output}`);
    }
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }, "collaboration server health", 20_000);
  return running;
}

async function stopServer(server: RunningServer) {
  if (server.process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.process.once("exit", () => resolve()));
  server.process.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (server.process.exitCode === null) {
    server.process.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function connectProvider(
  server: RunningServer,
  fixture: Fixture,
  token: string,
) {
  const document = new Y.Doc();
  const closeReasons: string[] = [];
  const authenticationFailures: string[] = [];
  const stateless: string[] = [];
  const websocketProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${server.port}/collaboration`,
    WebSocketPolyfill: WebSocket,
    delay: 25,
    minDelay: 25,
    initialDelay: 0,
    maxAttempts: 1,
    jitter: false,
  });
  websocketProviders.push(websocketProvider);
  const provider = new HocuspocusProvider({
    websocketProvider,
    name: fixture.roomName,
    document,
    token,
    onAuthenticationFailed: ({ reason }) => authenticationFailures.push(reason),
    onClose: ({ event }) => closeReasons.push(event.reason),
    onStateless: ({ payload }) => stateless.push(payload),
  });
  providers.push(provider);
  provider.attach();
  await waitFor(
    () => provider.synced || authenticationFailures.length > 0,
    "provider synchronization",
  );
  if (!provider.synced) {
    throw new Error(`Provider authentication failed: ${authenticationFailures.join(", ")}\n${server.logs()}`);
  }
  return {
    provider,
    websocketProvider,
    document,
    closeReasons,
    authenticationFailures,
    stateless,
  } satisfies ProviderHarness;
}

function collaborationUpdateMessage(documentName: string, update: Uint8Array) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, MessageType.Sync);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function replacementUpdates(
  baseline: Y.Doc,
  firstTitle: string,
  secondTitle?: string,
) {
  const source = new Y.Doc();
  try {
    Y.applyUpdate(source, Y.encodeStateAsUpdate(baseline), "mutation-accounting-baseline");
    const baselineVector = Y.encodeStateVector(source);
    replaceWorkingDocument(source, { title: firstTitle }, `mutation-${randomUUID()}`);
    const first = Y.encodeStateAsUpdate(source, baselineVector);
    if (!secondTitle) return { first };
    replaceWorkingDocument(source, { title: secondTitle }, `mutation-${randomUUID()}`);
    return {
      first,
      combined: Y.encodeStateAsUpdate(source, baselineVector),
    };
  } finally {
    source.destroy();
  }
}

async function acquireAndReleaseBarrier(server: RunningServer) {
  const acquired = await internalPost(
    server,
    "/internal/backup/barrier/acquire",
    {},
  ) as unknown as BackupCollaborationBarrier;
  await internalPost(server, "/internal/backup/barrier/release", {
    barrierId: acquired.barrierId,
  });
  return acquired;
}

function withDatabase<T>(databasePath: string, callback: (database: NyxDatabase) => T) {
  const database = openDatabase(databasePath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function persistedDraftSnapshot(fixture: Fixture) {
  return withDatabase(fixture.databasePath, (database) => {
    const state = database.prepare(
      `SELECT hex(yjs_state) AS yjs_state, draft_version, updated_at,
              last_actor_type, last_actor_principal_id, last_actor_label
       FROM document_collaboration_states WHERE document_id = ?`,
    ).get(fixture.documentId);
    const contributors = database.prepare(
      `SELECT contributor_key, update_count FROM document_draft_contributors
       WHERE document_id = ? ORDER BY contributor_key`,
    ).all(fixture.documentId);
    return { state, contributors };
  });
}

function persistedCollaborationDocument(fixture: Fixture) {
  return withDatabase(fixture.databasePath, (database) => {
    const state = loadCollaborationStateByRoom(database, fixture.roomName);
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, state.state, "disconnect-test-load");
      return collaborationDocumentFromYDoc(document);
    } finally {
      document.destroy();
    }
  });
}

function workingDocumentFromBackup(generationPath: string, fixture: Fixture) {
  const database = openDatabase(path.join(generationPath, "nyxdoc.db"));
  try {
    const state = loadCollaborationStateByRoom(database, fixture.roomName);
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, state.state, "backup-test-load");
      return collaborationDocumentFromYDoc(document);
    } finally {
      document.destroy();
    }
  } finally {
    database.close();
  }
}

async function authoritativeDraftSnapshot(server: RunningServer, fixture: Fixture) {
  const response = await fetch(`http://127.0.0.1:${server.port}/internal/drafts/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${COLLABORATION_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
    }),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Failed to read authoritative draft: ${JSON.stringify(payload)}\n${server.logs()}`);
  }
  const workingDocument = payload.workingDocument as Record<string, unknown> | undefined;
  if (!workingDocument) {
    throw new Error(`Authoritative draft response omitted workingDocument: ${JSON.stringify(payload)}`);
  }
  return {
    title: workingDocument.title,
    content: workingDocument.content,
    generation: workingDocument.generation,
    draftVersion: workingDocument.draftVersion,
    hasUncommittedChanges: workingDocument.hasUncommittedChanges,
  };
}

async function internalPost(
  server: RunningServer,
  pathname: string,
  body: unknown,
  expectedStatus = 200,
) {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${COLLABORATION_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (response.status !== expectedStatus) {
    throw new Error(
      `Expected ${expectedStatus} from ${pathname}, received ${response.status}: `
      + `${JSON.stringify(payload)}\n${server.logs()}`,
    );
  }
  return payload;
}

function ownerToken(fixture: Fixture) {
  return signCollaborationToken(fixture, {
    type: "human",
    userId: fixture.owner.id,
    principalId: fixture.owner.id,
    label: fixture.owner.name,
    source: "web",
  });
}

function readOnlyOwnerToken(fixture: Fixture) {
  return signCollaborationToken(fixture, {
    type: "human",
    userId: fixture.owner.id,
    principalId: fixture.owner.id,
    label: fixture.owner.name,
    source: "web",
  }, false);
}

function editorToken(fixture: Fixture) {
  return signCollaborationToken(fixture, {
    type: "human",
    userId: fixture.editor.id,
    principalId: fixture.editor.id,
    label: fixture.editor.name,
    source: "web",
  });
}

function agentToken(fixture: Fixture) {
  return signCollaborationToken(fixture, {
    type: "agent",
    tokenId: fixture.agent.credentialId,
    principalId: fixture.agent.id,
    label: fixture.agent.label,
    source: "mcp",
  });
}

function startDocumentBroadcastCounter(harness: ProviderHarness) {
  let count = 0;
  harness.document.on("update", () => {
    count += 1;
  });
  return () => count;
}

function requireOrganizationId(fixture: Fixture) {
  if (!fixture.organizationId) throw new Error("Organization fixture is required");
  return fixture.organizationId;
}

function createSecondOrganization(database: NyxDatabase, fixture: Fixture) {
  const organization = createOrganization(database, {
    userId: fixture.owner.id,
    actorLabel: fixture.owner.name,
    name: `Second collaboration organization ${randomUUID()}`,
  });
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO organization_members
     (id, organization_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, 'member', ?, ?)`,
  ).run(randomUUID(), organization.id, fixture.editor.id, now, now);
  return organization.id;
}

type CurrentAgentAuthorizationRevocation = {
  name: string;
  revoke: (database: NyxDatabase, fixture: Fixture) => void;
};

const currentAgentAuthorizationRevocations: CurrentAgentAuthorizationRevocation[] = [
  {
    name: "organization lifecycle",
    revoke(database, fixture) {
      database.prepare(
        "UPDATE organizations SET lifecycle_state = 'trashed' WHERE id = ?",
      ).run(requireOrganizationId(fixture));
    },
  },
  {
    name: "personal-agent organization approval",
    revoke(database, fixture) {
      database.prepare(
        `UPDATE organization_agent_approvals SET revoked_at = ?
         WHERE organization_id = ? AND agent_id = ?`,
      ).run(new Date().toISOString(), requireOrganizationId(fixture), fixture.agent.id);
    },
  },
  {
    name: "personal-agent owner organization membership",
    revoke(database, fixture) {
      database.prepare(
        "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?",
      ).run(requireOrganizationId(fixture), fixture.owner.id);
    },
  },
  {
    name: "workspace ownership",
    revoke(database, fixture) {
      const secondOrganizationId = createSecondOrganization(database, fixture);
      database.prepare(
        `UPDATE workspace_ownership SET organization_id = ?, updated_at = ?
         WHERE workspace_id = ?`,
      ).run(secondOrganizationId, new Date().toISOString(), fixture.workspaceId);
    },
  },
  {
    name: "agent ownership",
    revoke(database, fixture) {
      const secondOrganizationId = createSecondOrganization(database, fixture);
      database.prepare(
        `UPDATE agent_ownership
         SET owner_type = 'organization', owner_user_id = NULL,
             organization_id = ?, updated_at = ?
         WHERE agent_id = ?`,
      ).run(secondOrganizationId, new Date().toISOString(), fixture.agent.id);
    },
  },
  {
    name: "workspace lifecycle",
    revoke(database, fixture) {
      database.prepare(
        "UPDATE workspaces SET lifecycle_state = 'trashed' WHERE id = ?",
      ).run(fixture.workspaceId);
    },
  },
  {
    name: "workspace agent grant",
    revoke(database, fixture) {
      database.prepare(
        `UPDATE workspace_agents SET status = 'disabled', updated_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), fixture.agent.grantId);
    },
  },
  {
    name: "credential-grant binding",
    revoke(database, fixture) {
      database.prepare(
        `UPDATE agent_credential_grant_bindings
         SET status = 'revoked', revoked_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), fixture.agent.bindingId);
    },
  },
  {
    name: "document-tree root",
    revoke(database, fixture) {
      database.prepare(
        `UPDATE workspace_agents
         SET scope_mode = 'document_tree', root_document_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        fixture.outsideRootDocumentId,
        new Date().toISOString(),
        fixture.agent.grantId,
      );
    },
  },
  {
    name: "workspace capability",
    revoke(database, fixture) {
      database.prepare(
        `UPDATE workspace_agents SET capabilities_json = '["documents.read"]', updated_at = ?
         WHERE id = ?`,
      ).run(new Date().toISOString(), fixture.agent.grantId);
    },
  },
  {
    name: "global agent lifecycle",
    revoke(database, fixture) {
      database.prepare(
        "UPDATE agents SET status = 'disabled', updated_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), fixture.agent.id);
    },
  },
  {
    name: "credential active state",
    revoke(database, fixture) {
      database.prepare(
        "UPDATE agent_credentials SET revoked_at = ?, updated_at = ? WHERE id = ?",
      ).run(
        new Date().toISOString(),
        new Date().toISOString(),
        fixture.agent.credentialId,
      );
    },
  },
  {
    name: "credential expiry",
    revoke(database, fixture) {
      database.prepare(
        "UPDATE agent_credentials SET expires_at = ?, updated_at = ? WHERE id = ?",
      ).run(
        new Date(Date.now() - 60_000).toISOString(),
        new Date().toISOString(),
        fixture.agent.credentialId,
      );
    },
  },
  {
    name: "credential scopes",
    revoke(database, fixture) {
      database.prepare(
        `UPDATE agent_credentials SET scopes_json = '["documents:read"]', updated_at = ?
         WHERE id = ?`,
      ).run(new Date().toISOString(), fixture.agent.credentialId);
    },
  },
  {
    name: "credential IP restriction",
    revoke(database, fixture) {
      database.prepare(
        `UPDATE agent_credentials SET ip_allowlist_json = '["203.0.113.0/24"]', updated_at = ?
         WHERE id = ?`,
      ).run(new Date().toISOString(), fixture.agent.credentialId);
    },
  },
];

describe("collaboration server pre-apply security", () => {
  it("preserves an OAuth actor scope ceiling through internal request parsing", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath);
    const before = await authoritativeDraftSnapshot(server, fixture);

    const denied = await internalPost(server, "/internal/drafts/replace", {
      roomName: fixture.roomName,
      actor: {
        type: "agent",
        tokenId: fixture.agent.credentialId,
        principalId: fixture.agent.id,
        label: fixture.agent.label,
        source: "mcp",
        scopeCeiling: ["documents:read"],
      },
      expectedDraftVersion: before.draftVersion,
      requestId: "oauth-internal-scope-ceiling-denied-001",
      replacement: { title: "Must not cross the internal parser" },
    }, 403);

    expect(denied).toMatchObject({ code: "FORBIDDEN" });
    expect(await authoritativeDraftSnapshot(server, fixture)).toEqual(before);
  });

  it("preserves only authenticated internal request IP context through command parsing", async () => {
    const fixture = createFixture();
    withDatabase(fixture.databasePath, (database) => {
      database.prepare(
        "UPDATE agent_credentials SET ip_allowlist_json = ? WHERE id = ?",
      ).run(JSON.stringify(["203.0.113.0/24"]), fixture.agent.credentialId);
    });
    const server = await startServer(fixture.databasePath);
    const before = await authoritativeDraftSnapshot(server, fixture);
    const beforeDraftVersion = Number(before.draftVersion);
    expect(Number.isInteger(beforeDraftVersion)).toBe(true);
    const actor = {
      type: "agent",
      tokenId: fixture.agent.credentialId,
      principalId: fixture.agent.id,
      label: fixture.agent.label,
      source: "mcp",
    };

    const allowed = await internalPost(server, "/internal/drafts/replace", {
      roomName: fixture.roomName,
      actor: {
        ...actor,
        requestContext: { clientIp: "203.0.113.42" },
      },
      expectedDraftVersion: beforeDraftVersion,
      requestId: "internal-ip-context-allowed-001",
      replacement: { title: "Allowed internal IP context" },
    });
    const allowedWorking = allowed.workingDocument as { draftVersion: number };
    expect(allowedWorking.draftVersion).toBe(beforeDraftVersion + 1);

    const deniedSpoof = await internalPost(server, "/internal/drafts/replace", {
      roomName: fixture.roomName,
      actor: {
        ...actor,
        // A legacy/unsigned top-level field is deliberately ignored. Only the
        // authenticated internal requestContext shape is propagated.
        clientIp: "203.0.113.42",
      },
      expectedDraftVersion: allowedWorking.draftVersion,
      requestId: "internal-ip-context-spoof-denied-001",
      replacement: { title: "Must remain denied" },
    }, 403);
    expect(deniedSpoof).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a foreign-media Yjs update before Y.Doc, draft persistence, or broadcast changes", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath);
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const actor = await connectProvider(server, fixture, ownerToken(fixture));
    observer.stateless.length = 0;
    const observerBroadcasts = startDocumentBroadcastCounter(observer);
    const beforeObserver = collaborationDocumentFromYDoc(observer.document);
    const beforeAuthoritative = await authoritativeDraftSnapshot(server, fixture);
    const beforePersisted = persistedDraftSnapshot(fixture);

    replaceWorkingDocument(actor.document, {
      content: {
        schemaVersion: 2,
        blocks: [{
          id: randomUUID(),
          type: "img",
          mediaId: fixture.foreignMediaId,
          url: `/api/media/${fixture.foreignMediaId}`,
          children: [{ text: "" }],
        }],
      },
    }, "foreign-media-test-update");

    expect(collaborationDocumentFromYDoc(actor.document).content.blocks[0]).toMatchObject({
      type: "img",
      mediaId: fixture.foreignMediaId,
    });
    await waitFor(
      () => actor.closeReasons.includes("Invalid collaboration update"),
      "invalid-update rejection",
    );

    expect(await authoritativeDraftSnapshot(server, fixture)).toEqual(beforeAuthoritative);
    expect(persistedDraftSnapshot(fixture)).toEqual(beforePersisted);
    expect(collaborationDocumentFromYDoc(observer.document)).toEqual(beforeObserver);
    expect(observerBroadcasts()).toBe(0);
    expect(observer.stateless).toEqual([]);
    expect(observer.closeReasons).toEqual([]);
  }, 20_000);

  it.each(currentAgentAuthorizationRevocations)(
    "rechecks current $name authorization before an already-open agent mutation",
    async ({ name, revoke }) => {
      const fixture = createFixture({ organization: true });
      const server = await startServer(fixture.databasePath);
      const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
      const agent = await connectProvider(server, fixture, agentToken(fixture));
      const observerBroadcasts = startDocumentBroadcastCounter(observer);
      const beforeObserver = collaborationDocumentFromYDoc(observer.document);
      const beforePersisted = persistedDraftSnapshot(fixture);

      withDatabase(fixture.databasePath, (database) => revoke(database, fixture));
      replaceWorkingDocument(
        agent.document,
        { title: `revoked ${name} mutation` },
        `revoked-${name}`,
      );

      await waitFor(
        () => agent.closeReasons.includes("Collaboration authorization is no longer valid"),
        `${name} rejection`,
      );
      expect(persistedDraftSnapshot(fixture)).toEqual(beforePersisted);
      expect(collaborationDocumentFromYDoc(observer.document)).toEqual(beforeObserver);
      expect(observerBroadcasts()).toBe(0);
      expect(observer.closeReasons).toEqual([]);
    },
    30_000,
  );

  it("denies an agent revoked after WebSocket preflight but before durable persistence", async () => {
    const fixture = createFixture();
    const interlock = path.join(fixture.directory, "update-persistence-interlock");
    const server = await startServer(fixture.databasePath, {
      updatePersistenceInterlock: interlock,
      barrierQuiesceTimeoutMs: 500,
    });
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const agent = await connectProvider(server, fixture, agentToken(fixture));
    observer.stateless.length = 0;
    const observerBroadcasts = startDocumentBroadcastCounter(observer);
    const beforeObserver = collaborationDocumentFromYDoc(observer.document);
    const beforeAuthoritative = await authoritativeDraftSnapshot(server, fixture);
    const beforePersisted = persistedDraftSnapshot(fixture);
    const update = replacementUpdates(
      observer.document,
      "must be denied after successful preflight",
    ).first;

    writeFileSync(`${interlock}.arm`, "armed", "utf8");
    agent.websocketProvider.send(collaborationUpdateMessage(fixture.roomName, update));
    await waitFor(
      () => existsSync(`${interlock}.reached`),
      "post-preflight persistence interlock",
    );
    withDatabase(fixture.databasePath, (database) => {
      database.prepare(
        "UPDATE agent_credentials SET revoked_at = ?, updated_at = ? WHERE id = ?",
      ).run(
        new Date().toISOString(),
        new Date().toISOString(),
        fixture.agent.credentialId,
      );
    });
    writeFileSync(`${interlock}.release`, "released", "utf8");

    await waitFor(
      () => agent.closeReasons.includes("Collaboration authorization is no longer valid"),
      "in-transaction authorization rejection",
    );
    await acquireAndReleaseBarrier(server);
    expect(await authoritativeDraftSnapshot(server, fixture)).toEqual(beforeAuthoritative);
    expect(persistedDraftSnapshot(fixture)).toEqual(beforePersisted);
    expect(collaborationDocumentFromYDoc(observer.document)).toEqual(beforeObserver);
    expect(observerBroadcasts()).toBe(0);
    expect(observer.stateless).toEqual([]);
    expect(observer.closeReasons).toEqual([]);
  }, 20_000);

  it("rechecks revoked human and agent access before mutation while preserving awareness", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath);
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const human = await connectProvider(server, fixture, editorToken(fixture));
    const agent = await connectProvider(server, fixture, agentToken(fixture));
    observer.stateless.length = 0;
    const observerBroadcasts = startDocumentBroadcastCounter(observer);
    const beforeObserver = collaborationDocumentFromYDoc(observer.document);
    const beforeAuthoritative = await authoritativeDraftSnapshot(server, fixture);
    const beforePersisted = persistedDraftSnapshot(fixture);

    withDatabase(fixture.databasePath, (database) => {
      database.prepare(
        `UPDATE workspace_members SET access_role = 'viewer'
         WHERE workspace_id = ? AND user_id = ?`,
      ).run(fixture.workspaceId, fixture.editor.id);
    });

    human.provider.setAwarenessField("revokedActorProbe", "awareness-still-works");
    await waitFor(
      () => Array.from(observer.provider.awareness?.getStates().values() ?? [])
        .some((state) => state.revokedActorProbe === "awareness-still-works"),
      "revoked actor awareness broadcast",
    );
    expect(human.closeReasons).toEqual([]);

    replaceWorkingDocument(human.document, { title: "revoked human mutation" }, "revoked-human");
    await waitFor(
      () => human.closeReasons.includes("Collaboration authorization is no longer valid"),
      "revoked-human rejection",
    );

    withDatabase(fixture.databasePath, (database) => {
      database.prepare(
        "UPDATE agent_credentials SET revoked_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), fixture.agent.credentialId);
    });
    replaceWorkingDocument(agent.document, { title: "revoked agent mutation" }, "revoked-agent");
    await waitFor(
      () => agent.closeReasons.includes("Collaboration authorization is no longer valid"),
      "revoked-agent rejection",
    );

    expect(await authoritativeDraftSnapshot(server, fixture)).toEqual(beforeAuthoritative);
    expect(persistedDraftSnapshot(fixture)).toEqual(beforePersisted);
    expect(collaborationDocumentFromYDoc(observer.document)).toEqual(beforeObserver);
    expect(observerBroadcasts()).toBe(0);
    expect(observer.stateless).toEqual([]);
    expect(observer.closeReasons).toEqual([]);
  }, 20_000);

  it("holds mutations, flushes loaded Yjs documents, and snapshots an accepted debounce-pending update", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath);
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const actor = await connectProvider(server, fixture, ownerToken(fixture));

    replaceWorkingDocument(actor.document, { title: "accepted immediately before backup" }, "backup-race");
    await waitFor(
      () => collaborationDocumentFromYDoc(observer.document).title === "accepted immediately before backup",
      "accepted update broadcast",
    );

    const generation = await withCollaborationBackupBarrier({
      baseUrl: `http://127.0.0.1:${server.port}`,
      secret: COLLABORATION_SECRET,
      heartbeatMs: 50,
      callback: async ({ receipt, assertHeld }) => {
        expect(receipt.loadedDocumentCount).toBeGreaterThanOrEqual(1);
        expect(receipt.flushWatermark).toBeGreaterThanOrEqual(1);

        replaceWorkingDocument(actor.document, { title: "must not cross backup barrier" }, "backup-blocked");
        await waitFor(
          () => actor.closeReasons.includes("Verified backup in progress"),
          "mutation rejection while backup barrier is held",
        );
        expect(collaborationDocumentFromYDoc(observer.document).title)
          .toBe("accepted immediately before backup");

        const created = await createLiveBackupGeneration({
          databasePath: fixture.databasePath,
          mediaRoot: fixture.mediaRoot,
          backupRoot: fixture.backupRoot,
          sourceRevision: "collaboration-backup-race-test",
          collaborationBarrier: receipt,
          assertCollaborationBarrierHeld: assertHeld,
        });
        await verifyBackupGeneration(created.generationPath);
        return created;
      },
    });

    expect(generation.manifest.collaborationBarrier).toMatchObject({
      barrierId: expect.any(String),
      flushWatermark: expect.any(Number),
      loadedDocumentCount: expect.any(Number),
    });
    expect(workingDocumentFromBackup(generation.generationPath, fixture).title)
      .toBe("accepted immediately before backup");
    expect((await authoritativeDraftSnapshot(server, fixture)).title)
      .toBe("accepted immediately before backup");
  }, 30_000);

  it("settles duplicate updates from the same and different open sockets before backup", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath, { barrierQuiesceTimeoutMs: 500 });
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const firstActor = await connectProvider(server, fixture, ownerToken(fixture));
    const secondActor = await connectProvider(server, fixture, editorToken(fixture));

    const sameSocket = replacementUpdates(observer.document, "duplicate from one socket").first;
    const sameSocketMessage = collaborationUpdateMessage(fixture.roomName, sameSocket);
    firstActor.websocketProvider.send(sameSocketMessage);
    firstActor.websocketProvider.send(sameSocketMessage);
    await waitFor(
      async () => (await authoritativeDraftSnapshot(server, fixture)).title
        === "duplicate from one socket",
      "same-socket duplicate persistence",
    );
    const firstBarrier = await acquireAndReleaseBarrier(server);
    expect(firstBarrier.flushWatermark).toBeGreaterThanOrEqual(1);

    const differentSockets = replacementUpdates(
      observer.document,
      "duplicate from different sockets",
    ).first;
    const differentSocketMessage = collaborationUpdateMessage(
      fixture.roomName,
      differentSockets,
    );
    firstActor.websocketProvider.send(differentSocketMessage);
    secondActor.websocketProvider.send(differentSocketMessage);
    await waitFor(
      async () => (await authoritativeDraftSnapshot(server, fixture)).title
        === "duplicate from different sockets",
      "different-socket duplicate persistence",
    );
    const secondBarrier = await acquireAndReleaseBarrier(server);
    expect(secondBarrier.flushWatermark).toBeGreaterThan(firstBarrier.flushWatermark);
    expect(firstActor.closeReasons).toEqual([]);
    expect(secondActor.closeReasons).toEqual([]);
  }, 30_000);

  it("serializes a partially overlapping update and releases its mutation token", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath, { barrierQuiesceTimeoutMs: 500 });
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const firstActor = await connectProvider(server, fixture, ownerToken(fixture));
    const secondActor = await connectProvider(server, fixture, editorToken(fixture));
    const updates = replacementUpdates(
      observer.document,
      "partial overlap first",
      "partial overlap complete",
    );
    if (!updates.combined) throw new Error("Combined partial update was not created");

    firstActor.websocketProvider.send(collaborationUpdateMessage(fixture.roomName, updates.first));
    secondActor.websocketProvider.send(collaborationUpdateMessage(fixture.roomName, updates.combined));
    await waitFor(
      async () => (await authoritativeDraftSnapshot(server, fixture)).title
        === "partial overlap complete",
      "partially overlapping update persistence",
    );

    const barrier = await acquireAndReleaseBarrier(server);
    expect(barrier.flushWatermark).toBeGreaterThanOrEqual(2);
    expect(firstActor.closeReasons).toEqual([]);
    expect(secondActor.closeReasons).toEqual([]);
  }, 20_000);

  it("settles an accepted mutation when pre-apply processing throws", async () => {
    const fixture = createFixture();
    const applyFailureMarker = path.join(fixture.directory, "fail-next-collaboration-apply");
    const server = await startServer(fixture.databasePath, {
      applyFailureMarker,
      barrierQuiesceTimeoutMs: 500,
    });
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const actor = await connectProvider(server, fixture, ownerToken(fixture));
    const before = await authoritativeDraftSnapshot(server, fixture);
    const update = replacementUpdates(observer.document, "must not survive apply failure").first;

    writeFileSync(applyFailureMarker, "fail", "utf8");
    actor.websocketProvider.send(collaborationUpdateMessage(fixture.roomName, update));
    try {
      await waitFor(() => actor.closeReasons.length > 0, "apply failure disconnect");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; `
        + `markerExists=${existsSync(applyFailureMarker)}\n${server.logs()}`,
      );
    }

    await acquireAndReleaseBarrier(server);
    expect(await authoritativeDraftSnapshot(server, fixture)).toEqual(before);
    expect(collaborationDocumentFromYDoc(observer.document).title).toBe(before.title);
  }, 20_000);

  it("durably applies an accepted mutation when its socket disconnects immediately", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath, { barrierQuiesceTimeoutMs: 500 });
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const actor = await connectProvider(server, fixture, ownerToken(fixture));
    const update = replacementUpdates(observer.document, "update immediately before disconnect").first;

    actor.websocketProvider.send(collaborationUpdateMessage(fixture.roomName, update));
    actor.websocketProvider.disconnect();
    await waitFor(() => actor.closeReasons.length > 0, "immediate sender disconnect");

    const barrier = await acquireAndReleaseBarrier(server);
    expect(barrier.barrierId).toEqual(expect.any(String));
    expect(barrier.flushWatermark).toBeGreaterThanOrEqual(1);
    expect(persistedCollaborationDocument(fixture).title)
      .toBe("update immediately before disconnect");
  }, 20_000);

  it("does not expose a websocket mutation until its draft state is durable", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath);
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const actor = await connectProvider(server, fixture, ownerToken(fixture));
    const beforePersisted = persistedDraftSnapshot(fixture);
    const beforeTitle = collaborationDocumentFromYDoc(observer.document).title;
    const update = replacementUpdates(observer.document, "durable before websocket acknowledgement").first;

    withDatabase(fixture.databasePath, (database) => database.exec(`
      CREATE TRIGGER fail_websocket_draft_persistence
      BEFORE UPDATE OF yjs_state ON document_collaboration_states
      BEGIN
        SELECT RAISE(ABORT, 'injected websocket draft persistence failure');
      END;
    `));
    actor.websocketProvider.send(collaborationUpdateMessage(fixture.roomName, update));

    await waitFor(() => actor.closeReasons.length > 0, "draft persistence failure disconnect");
    expect(collaborationDocumentFromYDoc(observer.document).title).toBe(beforeTitle);
    expect(persistedDraftSnapshot(fixture)).toEqual(beforePersisted);

    withDatabase(fixture.databasePath, (database) => {
      database.exec("DROP TRIGGER fail_websocket_draft_persistence");
    });
    const retryingActor = await connectProvider(server, fixture, ownerToken(fixture));
    retryingActor.websocketProvider.send(collaborationUpdateMessage(fixture.roomName, update));
    await waitFor(
      () => persistedCollaborationDocument(fixture).title
        === "durable before websocket acknowledgement",
      "retried websocket draft persistence",
    );

    for (const harness of [observer, actor, retryingActor]) {
      harness.provider.destroy();
      harness.websocketProvider.destroy();
    }
    await stopServer(server);
    const restarted = await startServer(fixture.databasePath);
    const reloaded = await connectProvider(restarted, fixture, readOnlyOwnerToken(fixture));
    expect(collaborationDocumentFromYDoc(reloaded.document).title)
      .toBe("durable before websocket acknowledgement");
  }, 30_000);

  it("releases the mutation gate when backup work fails", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath);
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const actor = await connectProvider(server, fixture, ownerToken(fixture));

    await expect(withCollaborationBackupBarrier({
      baseUrl: `http://127.0.0.1:${server.port}`,
      secret: COLLABORATION_SECRET,
      heartbeatMs: 50,
      callback: async () => {
        throw new Error("deliberate snapshot failure");
      },
    })).rejects.toThrow("deliberate snapshot failure");

    replaceWorkingDocument(actor.document, { title: "mutation after failed backup" }, "released-error");
    await waitFor(
      () => collaborationDocumentFromYDoc(observer.document).title === "mutation after failed backup",
      "mutation after explicit backup release",
    );
    await waitFor(
      async () => (await authoritativeDraftSnapshot(server, fixture)).title === "mutation after failed backup",
      "persistence after explicit backup release",
    );
  }, 20_000);

  it("automatically releases an abandoned backup barrier after its lease expires", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.databasePath, { barrierLeaseMs: 150 });
    const observer = await connectProvider(server, fixture, readOnlyOwnerToken(fixture));
    const actor = await connectProvider(server, fixture, ownerToken(fixture));
    const acquired = await internalPost(
      server,
      "/internal/backup/barrier/acquire",
      {},
    ) as unknown as BackupCollaborationBarrier;
    expect(acquired.barrierId).toEqual(expect.any(String));

    await waitFor(
      () => server.logs().includes("backup barrier lease expired"),
      "backup barrier lease expiry",
      3_000,
    );
    replaceWorkingDocument(actor.document, { title: "mutation after lease expiry" }, "released-timeout");
    await waitFor(
      () => collaborationDocumentFromYDoc(observer.document).title === "mutation after lease expiry",
      "mutation after automatic backup release",
    );
    expect(actor.closeReasons).toEqual([]);
  }, 20_000);
});
