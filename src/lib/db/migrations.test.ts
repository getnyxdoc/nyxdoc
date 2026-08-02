import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import {
  APP_MIGRATIONS,
  getAppMigrationPlan,
  runAppMigrations,
} from "@/lib/db/migrations";
import { captureDatabaseFingerprint } from "@/lib/db/integrity";
import { ensurePersonalWorkspace } from "@/lib/workspaces/bootstrap";
import { authenticateApiToken, createWorkspaceToken } from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function createUserTable(database: NyxDatabase) {
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
}

function applyThrough(database: NyxDatabase, lastMigrationId: string) {
  database.exec(`
    CREATE TABLE _nyxdoc_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const record = database.prepare(
    "INSERT INTO _nyxdoc_migrations (id, applied_at) VALUES (?, '2026-07-15T00:00:00.000Z')",
  );
  for (const migration of APP_MIGRATIONS) {
    database.exec(migration.sql);
    record.run(migration.id);
    if (migration.id === lastMigrationId) return;
  }
  throw new Error(`Unknown migration ${lastMigrationId}.`);
}

describe("application migration safety", () => {
  it("records immutable checksums and a successful preservation receipt", () => {
    const database = createTestDatabase();
    databases.push(database);
    expect(database.prepare("SELECT COUNT(*) AS count FROM _nyxdoc_migration_checksums").get())
      .toEqual({ count: APP_MIGRATIONS.length });
    expect(database.prepare("SELECT outcome FROM _nyxdoc_migration_runs").all())
      .toEqual([{ outcome: "succeeded" }]);
    expect(getAppMigrationPlan(database).pending).toEqual([]);
  });

  it("refuses an applied migration whose recorded checksum changed", () => {
    const database = createTestDatabase();
    databases.push(database);
    database.prepare(
      "UPDATE _nyxdoc_migration_checksums SET checksum_sha256 = 'tampered' WHERE migration_id = ?",
    ).run("0001_nyxdoc_core");
    expect(() => getAppMigrationPlan(database)).toThrow(/checksum changed/);
  });

  it("adds safety metadata without changing a populated canonical database", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0011_canonical_ast_v2_only");
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1, 1)",
    ).run();
    ensurePersonalWorkspace(database, {
      id: "u1",
      name: "Owner",
      email: "owner@example.com",
    });
    const legacyArchived = database.prepare("SELECT id FROM documents ORDER BY created_at, id LIMIT 1")
      .get() as { id: string };
    database.prepare("UPDATE documents SET status = 'archived' WHERE id = ?")
      .run(legacyArchived.id);
    const before = captureDatabaseFingerprint(database);

    const result = runAppMigrations(database, { sourceRevision: "production-shaped-test" });
    const after = captureDatabaseFingerprint(database, before);

    expect(result.appliedIds).toEqual([
      "0012_migration_safety_metadata",
      "0013_workspace_agents_and_rbac",
      "0014_document_trash_lifecycle",
      "0015_admin_action_requests",
      "0016_workspace_boundary_guards",
      "0017_crdt_shared_drafts",
      "0018_collaboration_commit_snapshots",
      "0019_global_agents_and_credentials",
      "0020_agent_lifecycle",
      "0021_workspace_lifecycle",
      "0022_document_tasks",
      "0023_document_public_shares",
      "0024_document_human_grants",
      "0025_task_attachments",
      "0026_site_administration",
      "0027_site_owner_role",
      "0028_open_source_onboarding_and_i18n",
      "0029_preserve_existing_registration_policy",
      "0030_first_owner_setup_lock",
      "0031_organizations_teams_and_namespaces",
      "0032_organization_boundary_guards",
      "0033_agent_media_upload_tickets",
      "0034_editor_caret_incidents",
      "0035_mcp_oauth_grants",
      "0036_app_bug_reports",
      "0037_user_workspace_navigation_preferences",
      "0038_navigation_preference_versions",
    ]);
    expect(after).toEqual(before);
    expect(database.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM document_revisions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT access_role FROM workspace_members WHERE user_id = 'u1'").get())
      .toEqual({ access_role: "owner" });
    expect(database.prepare(
      "SELECT lifecycle_state FROM documents WHERE id = ?",
    ).get(legacyArchived.id)).toEqual({ lifecycle_state: "archived" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_trash_batches",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workspace_admin_action_requests",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_tasks",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_public_shares",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_human_grants",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_media_bindings",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_task_attachments",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM editor_caret_incidents",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM mcp_oauth_grants",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM app_bug_reports",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM user_workspace_navigation_preferences",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM site_administrators",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT user_id, role FROM site_administrators",
    ).get()).toEqual({ user_id: "u1", role: "owner" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM site_settings",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT workspace_id, owner_type, owner_user_id, organization_id
       FROM workspace_ownership`,
    ).all()).toEqual([{
      workspace_id: (database.prepare("SELECT id FROM workspaces").get() as { id: string }).id,
      owner_type: "personal",
      owner_user_id: "u1",
      organization_id: null,
    }]);
  });

  it("backfills stable agent identities without changing legacy token fields", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0011_canonical_ast_v2_only");
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1, 1)",
    ).run();
    const workspace = ensurePersonalWorkspace(database, {
      id: "u1",
      name: "Owner",
      email: "owner@example.com",
    });
    const originalToken = "nyx_live_existing_gameroom_key_material_123456789";
    const originalHash = createHash("sha256").update(originalToken, "utf8").digest("hex");
    database.prepare(
      `INSERT INTO workspace_api_tokens
       (id, workspace_id, created_by_user_id, name, token_prefix, token_hash,
         scopes_json, last_event_cursor, created_at)
       VALUES ('t1', ?, 'u1', 'gameroom-main', 'nyx_live_demo', ?,
                '["documents:read","documents:write","changes:read"]', 7, 'now')`,
    ).run(workspace.id, originalHash);
    const before = captureDatabaseFingerprint(database);

    runAppMigrations(database, { sourceRevision: "agent-backfill-test" });
    const after = captureDatabaseFingerprint(database, before);

    expect(after).toEqual(before);
    expect(database.prepare(
      `SELECT t.agent_id, a.display_name, a.role, a.status
       FROM workspace_api_tokens t JOIN workspace_agents a ON a.id = t.agent_id
       WHERE t.id = 't1'`,
    ).get()).toEqual({
      agent_id: "legacy-agent-t1",
      display_name: "gameroom-main",
      role: "editor",
      status: "active",
    });
    expect(database.prepare(
      `SELECT credential.id, credential.agent_id, credential.token_hash,
              credential.default_workspace_id, agent.owner_user_id,
              agent.deleted_at, agent.purge_after, agent.purged_at,
              membership.id AS membership_id
       FROM agent_credentials credential
       JOIN agents agent ON agent.id = credential.agent_id
       JOIN workspace_agents membership ON membership.agent_identity_id = agent.id
       WHERE credential.id = 't1'`,
    ).get()).toEqual({
      id: "t1",
      agent_id: "legacy-agent-t1",
      token_hash: originalHash,
      default_workspace_id: workspace.id,
      owner_user_id: "u1",
      deleted_at: null,
      purge_after: null,
      purged_at: null,
      membership_id: "legacy-agent-t1",
    });
    expect(authenticateApiToken(database, `Bearer ${originalToken}`)).toMatchObject({
      id: "t1",
      globalAgentId: "legacy-agent-t1",
      agentId: "legacy-agent-t1",
      workspaceId: workspace.id,
      lastEventCursor: 7,
    });
    expect(database.prepare(
      `SELECT workspace_id, owner_type, owner_user_id, organization_id
       FROM workspace_ownership WHERE workspace_id = ?`,
    ).get(workspace.id)).toEqual({
      workspace_id: workspace.id,
      owner_type: "personal",
      owner_user_id: "u1",
      organization_id: null,
    });
    expect(database.prepare(
      `SELECT agent_id, owner_type, owner_user_id, organization_id
       FROM agent_ownership WHERE agent_id = 'legacy-agent-t1'`,
    ).get()).toEqual({
      agent_id: "legacy-agent-t1",
      owner_type: "personal",
      owner_user_id: "u1",
      organization_id: null,
    });
  });

  it("rejects a credential boundary that points at another workspace", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = createTestUser(database, { name: "First owner" });
    const second = createTestUser(database, { name: "Second owner" });
    const foreignDocument = database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at LIMIT 1",
    ).get(second.workspace.id) as { id: string };
    const connection = createWorkspaceToken(database, {
      workspaceId: first.workspace.id,
      userId: first.user.id,
      name: "First agent",
      role: "editor",
    });

    expect(() => database.prepare(
      "UPDATE workspace_api_tokens SET root_document_id = ? WHERE id = ?",
    ).run(foreignDocument.id, connection.summary.id)).toThrow(/same workspace/);
  });

  it("refuses the legacy destructive reset when canonical rows exist", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0010_scoped_agent_connections");
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1, 1)",
    ).run();
    database.prepare(
      `INSERT INTO workspaces
       (id, name, slug, created_by_user_id, created_at, updated_at)
       VALUES ('w1', 'Canonical', 'canonical', 'u1', 'now', 'now')`,
    ).run();
    database.prepare(
      `INSERT INTO documents
       (id, workspace_id, title, slug, status, current_revision_id,
        created_by_user_id, created_at, updated_at, parent_document_id,
        tree_order, content_schema_version, document_type, workflow_status, tags_json)
       VALUES ('d1', 'w1', 'Canonical document', 'canonical-document', 'active', NULL,
               'u1', 'now', 'now', NULL, 100, 2, NULL, 'draft', '[]')`,
    ).run();

    expect(() => runAppMigrations(database)).toThrow(/Refusing legacy destructive reset/);
    expect(database.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT 1 FROM _nyxdoc_migrations WHERE id = '0011_canonical_ast_v2_only'").get())
      .toBeUndefined();
  });
});
