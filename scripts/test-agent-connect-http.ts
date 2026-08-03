import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import {
  assignAgentToWorkspace,
  createAgentCredential,
} from "../src/lib/agents/service";
import { createWorkspace } from "../src/lib/workspaces/service";

const LEGACY_AGENT_ID = "legacy-agent-550e8400-e29b-41d4-a716-446655440000";

async function waitForHealth(baseUrl: string, child: ChildProcess) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js exited before the agent connection test (${child.exitCode}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the agent connection test server.");
}

function responseCookies(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-agent-connect-http-"));
  const port = 31_191;
  const baseUrl = `http://127.0.0.1:${port}`;
  const databasePath = path.join(root, "nyxdoc.db");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development" as const,
    NYXDOC_DB_PATH: databasePath,
    NYXDOC_MEDIA_ROOT: path.join(root, "media"),
    NYXDOC_BACKUP_ROOT: path.join(root, "backups"),
    NYXDOC_NEXT_DIST_DIR: ".next-agent-connect-http",
    NYXDOC_TSCONFIG_PATH: "tsconfig.integration.json",
    BETTER_AUTH_URL: baseUrl,
    BETTER_AUTH_SECRET: "nyxdoc-agent-connect-http-secret-at-least-32-characters",
    NYXDOC_COLLABORATION_SECRET: "nyxdoc-agent-connect-http-collaboration-secret",
  };
  let logs = "";
  const migration = spawnSync(
    process.execPath,
    [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/migrate.ts"],
    {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    },
  );
  if (migration.status !== 0) {
    throw new Error(`Agent connection migration failed:\n${migration.stderr || migration.stdout}`);
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [path.join("node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(port)],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      logs = `${logs}${String(chunk)}`.slice(-16_000);
    });
  }

  try {
    await waitForHealth(baseUrl, child);
    const signUpResponse = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: "Legacy Agent Test Owner",
        email: "legacy-agent-http@example.com",
        password: "Legacy-agent-http-password-123!",
      }),
      redirect: "manual",
    });
    assert.equal(signUpResponse.status, 200);
    const cookie = responseCookies(signUpResponse);
    assert(cookie, "The test account did not receive a session cookie.");

    const database = new Database(databasePath);
    const account = database.prepare(
      `SELECT workspace.id AS workspace_id, account.id AS user_id,
              account.name, account.email
       FROM workspaces workspace
       JOIN workspace_members membership ON membership.workspace_id = workspace.id
       JOIN user account ON account.id = membership.user_id
       WHERE account.email = ?`,
    ).get("legacy-agent-http@example.com") as {
      workspace_id: string;
      user_id: string;
      name: string;
      email: string;
    } | undefined;
    assert(account);

    const targetWorkspace = createWorkspace(database, {
      id: account.user_id,
      name: account.name,
      email: account.email,
    }, "Threads HTTP regression");
    const now = new Date().toISOString();
    database.transaction(() => {
      database.prepare(
        `INSERT INTO agents
         (id, owner_user_id, display_name, avatar_media_id, status,
          created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`,
      ).run(
        LEGACY_AGENT_ID,
        account.user_id,
        "Legacy gameroom agent",
        account.user_id,
        now,
        now,
      );
      database.prepare(
        `INSERT INTO agent_ownership
         (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
         VALUES (?, 'personal', ?, NULL, ?, ?)`,
      ).run(LEGACY_AGENT_ID, account.user_id, now, now);
    })();
    assignAgentToWorkspace(database, {
      userId: account.user_id,
      workspaceId: account.workspace_id,
      agentId: LEGACY_AGENT_ID,
      accessProfile: "writer",
    });
    const createdCredential = createAgentCredential(database, {
      userId: account.user_id,
      agentId: LEGACY_AGENT_ID,
      name: "Existing legacy key",
      scopes: ["documents:read", "documents:write", "documents:commit", "changes:read"],
      defaultWorkspaceId: account.workspace_id,
      workspaceAllowlist: [account.workspace_id],
      ipAllowlist: ["127.0.0.1/32"],
    });
    const credentialBefore = database.prepare(
      `SELECT scopes_json, default_workspace_id, workspace_allowlist_json,
              ip_allowlist_json, expires_at
       FROM agent_credentials WHERE id = ?`,
    ).get(createdCredential.credential.id);
    database.close();

    const malformedResponse = await fetch(`${baseUrl}/api/workspace-agents/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: baseUrl,
        "x-nyxdoc-workspace-id": targetWorkspace.id,
      },
      body: JSON.stringify({
        agent: { mode: "existing", agentId: " " },
        accessProfile: "writer",
        rootDocumentId: null,
        credential: { mode: "later" },
      }),
    });
    assert.equal(malformedResponse.status, 400);
    const malformed = await malformedResponse.json() as {
      code?: string;
      details?: { issues?: Array<{ path?: unknown[] }> };
    };
    assert.equal(malformed.code, "INVALID_INPUT");
    assert(
      malformed.details?.issues?.some((issue) => issue.path?.join(".") === "agent.agentId"),
      `Expected a structured agentId validation issue, received ${JSON.stringify(malformed)}`,
    );

    const connectResponse = await fetch(`${baseUrl}/api/workspace-agents/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: baseUrl,
        "x-nyxdoc-workspace-id": targetWorkspace.id,
      },
      body: JSON.stringify({
        agent: { mode: "existing", agentId: LEGACY_AGENT_ID },
        accessProfile: "writer",
        rootDocumentId: null,
        credential: {
          mode: "existing",
          credentialId: createdCredential.credential.id,
        },
      }),
    });
    const connected = await connectResponse.json() as {
      agent?: { id?: string };
      membership?: { membershipId?: string; workspaceId?: string };
      credential?: { id?: string };
      binding?: { grantId?: string };
      code?: string;
      error?: string;
    };
    assert.equal(
      connectResponse.status,
      201,
      `Expected the legacy identity to pass the real HTTP route: ${JSON.stringify(connected)}`,
    );
    assert.equal(connected.agent?.id, LEGACY_AGENT_ID);
    assert.equal(connected.membership?.workspaceId, targetWorkspace.id);
    assert.equal(connected.credential?.id, createdCredential.credential.id);
    assert.equal(connected.binding?.grantId, connected.membership?.membershipId);

    const verification = new Database(databasePath, { readonly: true });
    const grantCount = verification.prepare(
      `SELECT COUNT(*) AS count FROM workspace_agents
       WHERE workspace_id = ? AND agent_identity_id = ?
         AND status = 'active' AND revoked_at IS NULL`,
    ).get(targetWorkspace.id, LEGACY_AGENT_ID) as { count: number };
    const bindingCount = verification.prepare(
      `SELECT COUNT(*) AS count
       FROM agent_credential_grant_bindings binding
       JOIN workspace_agents membership ON membership.id = binding.grant_id
       WHERE binding.credential_id = ? AND membership.workspace_id = ?
         AND binding.status = 'active' AND binding.revoked_at IS NULL`,
    ).get(createdCredential.credential.id, targetWorkspace.id) as { count: number };
    const credentialAfter = verification.prepare(
      `SELECT scopes_json, default_workspace_id, workspace_allowlist_json,
              ip_allowlist_json, expires_at
       FROM agent_credentials WHERE id = ?`,
    ).get(createdCredential.credential.id);
    const auditActions = verification.prepare(
      `SELECT action FROM workspace_audit_events
       WHERE workspace_id = ? AND target_id IN (?, ?)
       ORDER BY created_at`,
    ).all(
      targetWorkspace.id,
      LEGACY_AGENT_ID,
      createdCredential.credential.id,
    ) as Array<{ action: string }>;
    verification.close();
    assert.equal(grantCount.count, 1);
    assert.equal(bindingCount.count, 1);
    assert.deepEqual(credentialAfter, credentialBefore);
    assert(auditActions.some((row) => row.action === "agent.assigned"));
    assert(auditActions.some((row) => row.action === "agent.credential_bound"));

    const mcpEndpoint = new URL("/mcp", baseUrl);
    mcpEndpoint.searchParams.set("workspace", targetWorkspace.id);
    const transport = new StreamableHTTPClientTransport(mcpEndpoint, {
      requestInit: {
        headers: {
          Authorization: `Bearer ${createdCredential.token}`,
          "x-nyxdoc-client-ip": "127.0.0.1",
        },
      },
    });
    const client = new Client({ name: "legacy-agent-http-regression", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "get_capabilities", arguments: {} });
      const capabilities = result.structuredContent as {
        capabilities?: { protocolVersion?: string };
      };
      assert.equal(capabilities.capabilities?.protocolVersion, "5.0.0");
    } finally {
      await client.close();
    }

    console.log(JSON.stringify({
      status: "passed",
      legacyAgentId: LEGACY_AGENT_ID,
      targetWorkspaceId: targetWorkspace.id,
      realHttpRoute: true,
      realSessionAuth: true,
      realDatabasePostconditions: true,
      existingCredentialBinding: true,
      credentialPolicyPreserved: true,
      authenticatedMcp: true,
    }, null, 2));
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\nNext.js output:\n${logs}`,
    );
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      setTimeout(resolve, 3_000).unref();
    });
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 250,
    });
    await rm(path.join(process.cwd(), ".next-agent-connect-http"), {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 250,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
