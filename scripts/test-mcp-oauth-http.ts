import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { createAccountAgent } from "../src/lib/agents/service";

async function waitForHealth(baseUrl: string, child: ChildProcess) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js exited before the OAuth smoke test (${child.exitCode}).`);
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
  throw new Error("Timed out waiting for the OAuth smoke server.");
}

function responseCookies(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "nyxdoc-oauth-http-"));
  const port = 31_190;
  const baseUrl = `http://127.0.0.1:${port}`;
  const databasePath = path.join(root, "nyxdoc.db");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development" as const,
    NYXDOC_DB_PATH: databasePath,
    NYXDOC_MEDIA_ROOT: path.join(root, "media"),
    NYXDOC_BACKUP_ROOT: path.join(root, "backups"),
    NYXDOC_NEXT_DIST_DIR: ".next-mcp-oauth-http",
    NYXDOC_TSCONFIG_PATH: "tsconfig.integration.json",
    BETTER_AUTH_URL: baseUrl,
    BETTER_AUTH_SECRET: "nyxdoc-oauth-http-secret-at-least-32-characters",
    NYXDOC_COLLABORATION_SECRET: "nyxdoc-oauth-http-collaboration-secret",
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
    throw new Error(`OAuth smoke migration failed:\n${migration.stderr || migration.stdout}`);
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
      logs = `${logs}${String(chunk)}`.slice(-12_000);
    });
  }

  try {
    await waitForHealth(baseUrl, child);
    const resourceResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.equal(resourceResponse.status, 200);
    const resource = await resourceResponse.json() as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    assert.equal(resource.resource, `${baseUrl}/mcp`);
    assert.deepEqual(resource.authorization_servers, [baseUrl]);
    assert(resource.scopes_supported.includes("documents:read"));

    const providerResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(providerResponse.status, 200);
    const provider = await providerResponse.json() as {
      authorization_endpoint: string;
      registration_endpoint: string;
      token_endpoint: string;
      code_challenge_methods_supported: string[];
      scopes_supported: string[];
    };
    assert.deepEqual(provider.code_challenge_methods_supported, ["S256"]);
    assert(
      provider.scopes_supported.includes("documents:write"),
      `Provider scopes are incomplete: ${JSON.stringify(provider.scopes_supported)}`,
    );

    const registrationResponse = await fetch(provider.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:19876/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Nyxdoc OAuth smoke",
        scope: "openid profile offline_access documents:read changes:read",
      }),
    });
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json() as { client_id?: string };
    assert(registration.client_id);

    const signUpResponse = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: "OAuth Smoke Owner",
        email: "oauth-smoke@example.com",
        password: "OAuth-smoke-password-123!",
      }),
      redirect: "manual",
    });
    assert.equal(signUpResponse.status, 200);
    const cookie = responseCookies(signUpResponse);
    assert(cookie, "The OAuth smoke account did not receive a session cookie.");

    const database = new Database(databasePath);
    const account = database.prepare(
      `SELECT workspace.id AS workspace_id, account.id AS user_id
       FROM workspaces workspace
       JOIN workspace_members membership ON membership.workspace_id = workspace.id
       JOIN user account ON account.id = membership.user_id
       WHERE account.email = ?`,
    ).get("oauth-smoke@example.com") as {
      workspace_id: string;
      user_id: string;
    } | undefined;
    assert(account);
    const existingAgent = createAccountAgent(database, {
      userId: account.user_id,
      displayName: "Existing OAuth smoke agent",
    });
    database.close();
    const workspace = { id: account.workspace_id };

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const callbackUrl = "http://127.0.0.1:19876/callback";
    const authorizationUrl = new URL(provider.authorization_endpoint);
    authorizationUrl.searchParams.set("client_id", registration.client_id);
    authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set(
      "scope",
      "openid profile offline_access documents:read changes:read",
    );
    authorizationUrl.searchParams.set("state", "oauth-smoke-state");
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    const authorizeResponse = await fetch(authorizationUrl, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    assert.equal(authorizeResponse.status, 302);
    const providerLocation = authorizeResponse.headers.get("location");
    assert(providerLocation);
    const providerAuthorizeUrl = new URL(providerLocation, baseUrl);
    assert.equal(providerAuthorizeUrl.pathname, "/api/auth/mcp/authorize");
    assert.equal(providerAuthorizeUrl.searchParams.get("prompt"), "consent");
    const providerAuthorizeResponse = await fetch(providerAuthorizeUrl, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    assert.equal(providerAuthorizeResponse.status, 302);
    const consentLocation = providerAuthorizeResponse.headers.get("location");
    assert(consentLocation);
    const consentUrl = new URL(consentLocation, baseUrl);
    assert.equal(consentUrl.pathname, "/oauth/authorize");
    const consentCode = consentUrl.searchParams.get("consent_code");
    assert(consentCode);

    const consentPage = await fetch(consentUrl, { headers: { Cookie: cookie } });
    assert.equal(consentPage.status, 200);
    const consentHtml = await consentPage.text();
    assert.match(consentHtml, /Connect an external agent|외부 에이전트 연결/);
    assert.match(consentHtml, /Agent identity|에이전트 신원/);
    assert.match(consentHtml, /Existing OAuth smoke agent/);

    const consentResponse = await fetch(`${baseUrl}/api/mcp/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        accept: true,
        consentCode,
        workspaceIds: [workspace.id],
        accessProfile: "reader",
        agent: { mode: "existing", agentId: existingAgent.id },
      }),
    });
    assert.equal(consentResponse.status, 200);
    const consent = await consentResponse.json() as { redirectURI?: string };
    assert(consent.redirectURI);
    const callback = new URL(consent.redirectURI);
    const code = callback.searchParams.get("code");
    assert(code);
    assert.equal(callback.searchParams.get("state"), "oauth-smoke-state");

    const tokenResponse = await fetch(provider.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        client_id: registration.client_id,
        code_verifier: verifier,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json() as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
    };
    assert(token.access_token);
    assert(token.refresh_token);
    assert.match(token.scope ?? "", /documents:read/);

    const grantDatabase = new Database(databasePath, { readonly: true });
    const initialGrant = grantDatabase.prepare(
      `SELECT agent_id, credential_id
       FROM mcp_oauth_grants
       WHERE user_id = ? AND client_id = ?`,
    ).get(account.user_id, registration.client_id) as {
      agent_id: string;
      credential_id: string;
    } | undefined;
    grantDatabase.close();
    assert(initialGrant);
    assert.equal(initialGrant.agent_id, existingAgent.id);

    const oauthEndpoint = new URL("/mcp", baseUrl);
    oauthEndpoint.searchParams.set("workspace", workspace.id);
    const oauthTransport = new StreamableHTTPClientTransport(oauthEndpoint, {
      requestInit: {
        headers: { Authorization: `Bearer ${token.access_token}` },
      },
    });
    const oauthClient = new Client({ name: "nyxdoc-oauth-smoke", version: "1.0.0" });
    try {
      await oauthClient.connect(oauthTransport);
      const capabilityResult = await oauthClient.callTool({
        name: "get_capabilities",
        arguments: {},
      });
      expectCapabilityVersion(capabilityResult.structuredContent);
    } finally {
      await oauthClient.close();
    }

    const refreshResponse = await fetch(provider.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: registration.client_id,
      }),
    });
    assert.equal(refreshResponse.status, 200);
    const refreshedToken = await refreshResponse.json() as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
    };
    assert(refreshedToken.access_token);
    assert(refreshedToken.refresh_token);
    assert.notEqual(refreshedToken.access_token, token.access_token);

    const reauthorizeVerifier = randomBytes(32).toString("base64url");
    const reauthorizeChallenge = createHash("sha256")
      .update(reauthorizeVerifier)
      .digest("base64url");
    const reauthorizeUrl = new URL(provider.authorization_endpoint);
    reauthorizeUrl.searchParams.set("client_id", registration.client_id);
    reauthorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    reauthorizeUrl.searchParams.set("response_type", "code");
    reauthorizeUrl.searchParams.set(
      "scope",
      "openid profile offline_access documents:read changes:read",
    );
    reauthorizeUrl.searchParams.set("state", "oauth-reauthorize-state");
    reauthorizeUrl.searchParams.set("code_challenge", reauthorizeChallenge);
    reauthorizeUrl.searchParams.set("code_challenge_method", "S256");
    const reauthorizeResponse = await fetch(reauthorizeUrl, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    assert.equal(reauthorizeResponse.status, 302);
    const reauthorizeProviderLocation = reauthorizeResponse.headers.get("location");
    assert(reauthorizeProviderLocation);
    const reauthorizeProviderResponse = await fetch(
      new URL(reauthorizeProviderLocation, baseUrl),
      {
        headers: { Cookie: cookie },
        redirect: "manual",
      },
    );
    assert.equal(reauthorizeProviderResponse.status, 302);
    const reauthorizeConsentLocation = reauthorizeProviderResponse.headers.get("location");
    assert(reauthorizeConsentLocation);
    const reauthorizeConsentUrl = new URL(reauthorizeConsentLocation, baseUrl);
    const reauthorizeConsentCode = reauthorizeConsentUrl.searchParams.get("consent_code");
    assert(reauthorizeConsentCode);

    const reauthorizeConsentResponse = await fetch(`${baseUrl}/api/mcp/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        accept: true,
        consentCode: reauthorizeConsentCode,
        workspaceIds: [workspace.id],
        accessProfile: "reader",
        agent: { mode: "new", displayName: "Reauthorized OAuth smoke agent" },
      }),
    });
    assert.equal(reauthorizeConsentResponse.status, 200);
    const reauthorizeConsent = await reauthorizeConsentResponse.json() as {
      redirectURI?: string;
    };
    assert(reauthorizeConsent.redirectURI);
    const reauthorizeCallback = new URL(reauthorizeConsent.redirectURI);
    const reauthorizeCode = reauthorizeCallback.searchParams.get("code");
    assert(reauthorizeCode);

    const reauthorizedTokenResponse = await fetch(provider.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: reauthorizeCode,
        redirect_uri: callbackUrl,
        client_id: registration.client_id,
        code_verifier: reauthorizeVerifier,
      }),
    });
    assert.equal(reauthorizedTokenResponse.status, 200);
    const reauthorizedToken = await reauthorizedTokenResponse.json() as {
      access_token?: string;
      refresh_token?: string;
    };
    assert(reauthorizedToken.access_token);
    assert(reauthorizedToken.refresh_token);

    const staleTokenResponse = await fetch(oauthEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshedToken.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oauth-stale-token-smoke", version: "1.0.0" },
        },
      }),
    });
    assert.equal(staleTokenResponse.status, 401);

    const staleRefreshResponse = await fetch(provider.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshedToken.refresh_token,
        client_id: registration.client_id,
      }),
    });
    assert.notEqual(staleRefreshResponse.status, 200);

    const reauthorizedDatabase = new Database(databasePath, { readonly: true });
    const reauthorizedGrant = reauthorizedDatabase.prepare(
      `SELECT agent_id, credential_id
       FROM mcp_oauth_grants
       WHERE user_id = ? AND client_id = ?`,
    ).get(account.user_id, registration.client_id) as {
      agent_id: string;
      credential_id: string;
    } | undefined;
    const priorCredential = reauthorizedDatabase.prepare(
      "SELECT revoked_at FROM agent_credentials WHERE id = ?",
    ).get(initialGrant.credential_id) as { revoked_at: string | null } | undefined;
    reauthorizedDatabase.close();
    assert(reauthorizedGrant);
    assert.notEqual(reauthorizedGrant.agent_id, initialGrant.agent_id);
    assert.notEqual(reauthorizedGrant.credential_id, initialGrant.credential_id);
    assert(priorCredential?.revoked_at);

    const reauthorizedTransport = new StreamableHTTPClientTransport(oauthEndpoint, {
      requestInit: {
        headers: { Authorization: `Bearer ${reauthorizedToken.access_token}` },
      },
    });
    const reauthorizedClient = new Client({
      name: "nyxdoc-oauth-reauthorized-smoke",
      version: "1.0.0",
    });
    try {
      await reauthorizedClient.connect(reauthorizedTransport);
      const capabilityResult = await reauthorizedClient.callTool({
        name: "get_capabilities",
        arguments: {},
      });
      expectCapabilityVersion(capabilityResult.structuredContent);
    } finally {
      await reauthorizedClient.close();
    }

    const writableDatabase = new Database(databasePath);
    writableDatabase.prepare(
      `UPDATE mcp_oauth_grants
       SET status = 'revoked', revoked_at = ?, updated_at = ?`,
    ).run(new Date().toISOString(), new Date().toISOString());
    writableDatabase.close();
    const revokedResponse = await fetch(oauthEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reauthorizedToken.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oauth-revocation-smoke", version: "1.0.0" },
        },
      }),
    });
    assert.equal(revokedResponse.status, 401);

    const mcpResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oauth-smoke", version: "1.0.0" },
        },
      }),
    });
    assert.equal(mcpResponse.status, 401);
    assert.match(mcpResponse.headers.get("www-authenticate") ?? "", /resource_metadata=/);

    console.log(JSON.stringify({
      status: "passed",
      resource: resource.resource,
      authorizationEndpoint: provider.authorization_endpoint,
      registrationEndpoint: provider.registration_endpoint,
      pkce: provider.code_challenge_methods_supported,
      dynamicClientRegistration: true,
      authorizationCodeFlow: true,
      refreshTokenFlow: true,
      workspaceGrant: true,
      existingAgentSelection: true,
      reauthorizationRevokesPriorTokens: true,
      agentSwitchRevokesPriorCredential: true,
      revokedGrantRejected: true,
      authenticatedMcp: true,
      unauthenticatedMcpStatus: mcpResponse.status,
    }, null, 2));
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nNext.js output:\n${logs}`,
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
    await rm(path.join(process.cwd(), ".next-mcp-oauth-http"), {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 250,
    });
  }
}

function expectCapabilityVersion(value: unknown) {
  const content = value as {
    capabilities?: { protocolVersion?: string };
  };
  assert.equal(content.capabilities?.protocolVersion, "5.0.0");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
