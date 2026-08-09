import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { createCollaborationYDoc } from "@/lib/collaboration/drafts";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import {
  APP_MIGRATIONS,
  appMigrationChecksum,
  getAppMigrationPlan,
  isPristineDatabaseForInitialization,
  runAppMigrations,
} from "@/lib/db/migrations";
import { captureDatabaseFingerprint } from "@/lib/db/integrity";
import { createDocument, updateDocument } from "@/lib/documents/service";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";
import { ensurePersonalWorkspace } from "@/lib/workspaces/bootstrap";
import { authenticateApiToken, createWorkspaceToken } from "@/lib/tokens/service";
import { createWorkspace } from "@/lib/workspaces/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

type FrozenMigrationLedger = {
  format: string;
  release: string;
  sourceRevision: string;
  checksums: Record<string, string>;
};

const V02517_MIGRATION_LEDGER = JSON.parse(readFileSync(
  new URL("../../../scripts/test-fixtures/v0.25.17-migration-checksums.json", import.meta.url),
  "utf8",
)) as FrozenMigrationLedger;

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

describe("pristine database initialization boundary", () => {
  it("accepts only a database with no user state and an empty migration ledger", () => {
    const database = openDatabase(":memory:");
    databases.push(database);

    expect(isPristineDatabaseForInitialization(database)).toBe(true);
    getAppMigrationPlan(database);
    expect(isPristineDatabaseForInitialization(database)).toBe(true);
  });

  it("rejects a recorded migration or any other application table", () => {
    const migrated = openDatabase(":memory:");
    databases.push(migrated);
    getAppMigrationPlan(migrated);
    migrated.prepare(
      "INSERT INTO _nyxdoc_migrations (id, applied_at) VALUES ('existing', '2026-08-09T00:00:00.000Z')",
    ).run();
    expect(isPristineDatabaseForInitialization(migrated)).toBe(false);

    const populated = openDatabase(":memory:");
    databases.push(populated);
    getAppMigrationPlan(populated);
    populated.exec("CREATE TABLE user_state (id TEXT PRIMARY KEY)");
    expect(isPristineDatabaseForInitialization(populated)).toBe(false);
  });
});

function imageDocumentContent(mediaId: string): NyxdocDocumentV2 {
  return {
    schemaVersion: 2,
    blocks: [{
      id: randomUUID(),
      type: "img",
      mediaId,
      url: `/api/media/${mediaId}`,
      children: [{ text: "" }],
    }],
  };
}

function insertMigrationMediaAsset(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
) {
  const mediaId = randomUUID();
  database.prepare(
    `INSERT INTO media_assets
     (id, workspace_id, storage_key, sha256, mime_type, byte_size,
      original_filename, uploaded_by_user_id, uploaded_by_token_id, created_at)
     VALUES (?, ?, ?, ?, 'image/png', 1, NULL, ?, NULL, ?)`,
  ).run(
    mediaId,
    workspaceId,
    `${mediaId}.png`,
    `sha-${mediaId}`,
    userId,
    "2026-08-09T00:00:00.000Z",
  );
  return mediaId;
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
  const applied: Array<(typeof APP_MIGRATIONS)[number]> = [];
  for (const migration of APP_MIGRATIONS) {
    database.exec(migration.sql);
    migration.transform?.apply(database);
    record.run(migration.id);
    applied.push(migration);
    const hasChecksumLedger = Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_nyxdoc_migration_checksums'",
    ).get());
    if (hasChecksumLedger) {
      const recordChecksum = database.prepare(
        `INSERT OR REPLACE INTO _nyxdoc_migration_checksums
         (migration_id, checksum_sha256, source_revision, recorded_at)
         VALUES (?, ?, 'test-fixture', '2026-07-15T00:00:00.000Z')`,
      );
      for (const appliedMigration of applied) {
        recordChecksum.run(appliedMigration.id, appMigrationChecksum(appliedMigration));
      }
    }
    if (migration.id === lastMigrationId) return;
  }
  throw new Error(`Unknown migration ${lastMigrationId}.`);
}

function createRevisionPointerMigrationFixture() {
  const database = openDatabase(":memory:");
  databases.push(database);
  createUserTable(database);
  applyThrough(database, "0042_bug_report_image_attachments");
  const user = {
    id: "revision-pointer-owner",
    name: "Revision Pointer Owner",
    email: "revision-pointer-owner@example.com",
  };
  database.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)",
  ).run(user.id, user.name, user.email);
  const firstWorkspace = ensurePersonalWorkspace(database, user);
  const secondWorkspace = createWorkspace(database, user, "Revision Pointer Target");
  const findDocument = database.prepare(
    `SELECT document.id, document.current_revision_id AS revision_id,
            revision.revision_number
     FROM documents document
     JOIN document_revisions revision ON revision.id = document.current_revision_id
     WHERE document.workspace_id = ?
     ORDER BY document.created_at, document.id
     LIMIT 1`,
  );
  const firstDocument = findDocument.get(firstWorkspace.id) as {
    id: string;
    revision_id: string;
    revision_number: number;
  };
  const secondDocument = findDocument.get(secondWorkspace.id) as {
    id: string;
    revision_id: string;
    revision_number: number;
  };
  database.prepare(
    `INSERT INTO document_collaboration_states
     (document_id, workspace_id, generation, yjs_state, committed_yjs_state,
      base_revision_id, base_revision_number, draft_version, committed_draft_version,
      seeded_at, updated_at, committed_at)
     VALUES (?, ?, 1, X'', X'', ?, ?, 0, 0, 'now', 'now', 'now')`,
  ).run(
    firstDocument.id,
    firstWorkspace.id,
    firstDocument.revision_id,
    firstDocument.revision_number,
  );
  return {
    database,
    user,
    firstWorkspace,
    secondWorkspace,
    firstDocument,
    secondDocument,
  };
}

describe("application migration safety", () => {
  it("accepts the frozen v0.25.17 checksum ledger and migrates it through 0046", () => {
    expect(V02517_MIGRATION_LEDGER).toMatchObject({
      format: "nyxdoc-migration-checksums/v0.25.17",
      release: "v0.25.17",
      sourceRevision: "2612385641bcb64cb29f5909c94b8f735068c066",
    });
    expect(Object.keys(V02517_MIGRATION_LEDGER.checksums)).toHaveLength(42);

    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0042_bug_report_image_attachments");
    const replaceChecksum = database.prepare(
      `UPDATE _nyxdoc_migration_checksums
       SET checksum_sha256 = ?, source_revision = ?
       WHERE migration_id = ?`,
    );
    for (const [id, checksum] of Object.entries(V02517_MIGRATION_LEDGER.checksums)) {
      replaceChecksum.run(checksum, V02517_MIGRATION_LEDGER.sourceRevision, id);
    }

    const historicalMigrations = APP_MIGRATIONS.filter(
      (migration) => migration.id in V02517_MIGRATION_LEDGER.checksums,
    );
    expect(Object.fromEntries(historicalMigrations.map((migration) => [
      migration.id,
      appMigrationChecksum(migration),
    ]))).toEqual(V02517_MIGRATION_LEDGER.checksums);
    expect(getAppMigrationPlan(database).pending.map((migration) => migration.id)).toEqual([
      "0043_document_revision_pointer_guards",
      "0044_document_media_binding_provenance",
      "0045_collaboration_backup_checkpoint",
      "0046_workspace_media_cleanup_queue",
    ]);
    expect(runAppMigrations(database, { sourceRevision: "candidate-after-v0.25.17" }).appliedIds)
      .toEqual([
        "0043_document_revision_pointer_guards",
        "0044_document_media_binding_provenance",
        "0045_collaboration_backup_checkpoint",
        "0046_workspace_media_cleanup_queue",
      ]);
    expect(getAppMigrationPlan(database).pending).toEqual([]);
  });

  it("uses a separate checksum version for executable transforms", () => {
    const transformed = APP_MIGRATIONS.find(
      (migration) => migration.id === "0044_document_media_binding_provenance",
    );
    expect(transformed?.transform).toBeDefined();
    expect(appMigrationChecksum(transformed!)).toBe(
      "5ffe72b23fa3624f79640cc95c2b57a90aa373f00095977a200c5532d5620d04",
    );
    expect(appMigrationChecksum({
      id: transformed!.id,
      sql: transformed!.sql,
    })).not.toBe(appMigrationChecksum(transformed!));
  });

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
      "0039_agent_access_grants_and_bindings",
      "0040_media_upload_ticket_binding_guards",
      "0041_document_tree_grants_fail_closed",
      "0042_bug_report_image_attachments",
      "0043_document_revision_pointer_guards",
      "0044_document_media_binding_provenance",
      "0045_collaboration_backup_checkpoint",
      "0046_workspace_media_cleanup_queue",
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
      "SELECT COUNT(*) AS count FROM app_bug_report_attachments",
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

  it("adds revision pointer guards without rewriting valid canonical or draft rows", () => {
    const fixture = createRevisionPointerMigrationFixture();
    const { database, firstDocument, firstWorkspace, secondDocument, secondWorkspace, user } = fixture;
    const before = captureDatabaseFingerprint(database);

    expect(runAppMigrations(database, { sourceRevision: "revision-pointer-guard-test" }).appliedIds)
      .toEqual([
        "0043_document_revision_pointer_guards",
        "0044_document_media_binding_provenance",
        "0045_collaboration_backup_checkpoint",
        "0046_workspace_media_cleanup_queue",
      ]);
    expect(captureDatabaseFingerprint(database, before)).toEqual(before);
    expect(database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name IN (
         'documents_current_revision_insert',
         'documents_current_revision_update',
         'document_revisions_current_pointer_update',
         'document_revisions_current_pointer_delete',
         'collaboration_state_base_revision_insert',
         'collaboration_state_base_revision_update',
         'document_revisions_collaboration_pointer_update',
         'document_revisions_collaboration_pointer_delete',
         'documents_collaboration_workspace_update'
       ) ORDER BY name`,
    ).all()).toHaveLength(9);

    expect(() => database.prepare(
      `INSERT INTO documents
       (id, workspace_id, title, slug, current_revision_id, created_by_user_id,
        created_at, updated_at)
       VALUES ('invalid-current-insert', ?, 'Invalid', 'invalid-current-insert', ?, ?, 'now', 'now')`,
    ).run(firstWorkspace.id, secondDocument.revision_id, user.id))
      .toThrow(/current revision must belong to the same document/);
    expect(() => database.prepare(
      "UPDATE documents SET current_revision_id = ? WHERE id = ?",
    ).run(secondDocument.revision_id, firstDocument.id))
      .toThrow(/current revision must belong to the same document/);
    expect(() => database.prepare(
      `INSERT INTO document_collaboration_states
       (document_id, workspace_id, generation, yjs_state, committed_yjs_state,
        base_revision_id, base_revision_number, draft_version, committed_draft_version,
        seeded_at, updated_at, committed_at)
       VALUES (?, ?, 1, X'', X'', ?, ?, 0, 0, 'now', 'now', 'now')`,
    ).run(
      secondDocument.id,
      firstWorkspace.id,
      secondDocument.revision_id,
      secondDocument.revision_number,
    )).toThrow(/collaboration state must belong to the document workspace/);
    expect(() => database.prepare(
      `INSERT INTO document_collaboration_states
       (document_id, workspace_id, generation, yjs_state, committed_yjs_state,
        base_revision_id, base_revision_number, draft_version, committed_draft_version,
        seeded_at, updated_at, committed_at)
       VALUES (?, ?, 1, X'', X'', ?, ?, 0, 0, 'now', 'now', 'now')`,
    ).run(
      secondDocument.id,
      secondWorkspace.id,
      firstDocument.revision_id,
      firstDocument.revision_number,
    )).toThrow(/base revision id and number must match the same document/);
    expect(() => database.prepare(
      `UPDATE document_collaboration_states
       SET base_revision_id = ?, base_revision_number = ?
       WHERE document_id = ?`,
    ).run(firstDocument.revision_id, firstDocument.revision_number + 1, firstDocument.id))
      .toThrow(/base revision id and number must match the same document/);
    expect(() => database.prepare(
      `UPDATE document_collaboration_states
       SET base_revision_id = NULL, base_revision_number = 1
       WHERE document_id = ?`,
    ).run(firstDocument.id)).toThrow(/base revision id and number must match the same document/);
    expect(() => database.prepare(
      "UPDATE document_revisions SET revision_number = revision_number + 1 WHERE id = ?",
    ).run(firstDocument.revision_id)).toThrow(/base revision cannot be moved or renumbered/);
    expect(() => database.prepare(
      "DELETE FROM document_revisions WHERE id = ?",
    ).run(firstDocument.revision_id)).toThrow(/revision cannot be deleted/);

    database.prepare("UPDATE documents SET slug = 'revision-pointer-transfer-source' WHERE id = ?")
      .run(firstDocument.id);
    database.prepare("UPDATE documents SET workspace_id = ? WHERE id = ?")
      .run(secondWorkspace.id, firstDocument.id);
    expect(database.prepare(
      "SELECT workspace_id FROM document_collaboration_states WHERE document_id = ?",
    ).get(firstDocument.id)).toEqual({ workspace_id: secondWorkspace.id });

    expect(() => database.prepare("DELETE FROM documents WHERE id = ?").run(firstDocument.id))
      .not.toThrow();
    expect(database.prepare(
      "SELECT 1 FROM document_revisions WHERE document_id = ?",
    ).get(firstDocument.id)).toBeUndefined();
    expect(database.prepare(
      "SELECT 1 FROM document_collaboration_states WHERE document_id = ?",
    ).get(firstDocument.id)).toBeUndefined();
  });

  it("backfills populated legacy media bindings without conflating current drafts and retained revisions", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0043_document_revision_pointer_guards");
    const user = {
      id: "media-provenance-owner",
      name: "Media Provenance Owner",
      email: "media-provenance-owner@example.com",
    };
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)",
    ).run(user.id, user.name, user.email);
    const workspace = ensurePersonalWorkspace(database, user);
    const historyMediaId = insertMigrationMediaAsset(database, workspace.id, user.id);
    const canonicalMediaId = insertMigrationMediaAsset(database, workspace.id, user.id);
    const draftMediaId = insertMigrationMediaAsset(database, workspace.id, user.id);
    const staleMediaId = insertMigrationMediaAsset(database, workspace.id, user.id);
    const actor = {
      type: "human" as const,
      userId: user.id,
      label: user.name,
      source: "web" as const,
    };
    const created = createDocument(database, workspace.id, actor, {
      title: "Legacy media provenance",
      content: imageDocumentContent(historyMediaId),
    }).document;
    const updated = updateDocument(database, workspace.id, actor, created.id, {
      baseRevision: created.revisionNumber,
      content: imageDocumentContent(canonicalMediaId),
    }).document;
    const draft = createCollaborationYDoc({
      title: updated.title,
      parentDocumentId: updated.parentDocumentId,
      documentType: updated.documentType,
      workflowStatus: updated.workflowStatus,
      tags: updated.tags,
      content: imageDocumentContent(draftMediaId),
    });
    const draftState = Buffer.from(Y.encodeStateAsUpdate(draft));
    database.prepare(
      `INSERT INTO document_collaboration_states
       (document_id, workspace_id, generation, yjs_state, committed_yjs_state,
        base_revision_id, base_revision_number, draft_version, committed_draft_version,
        seeded_at, updated_at, committed_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, 1, 0, 'now', 'now', 'now')`,
    ).run(
      updated.id,
      workspace.id,
      draftState,
      draftState,
      updated.revisionId,
      updated.revisionNumber,
    );
    database.prepare(
      `INSERT INTO document_media_bindings
       (workspace_id, document_id, media_id, created_at)
       VALUES (?, ?, ?, '2026-08-09T00:00:00.000Z')`,
    ).run(workspace.id, updated.id, staleMediaId);
    // A normal draft upload already had a legacy binding before 0044; the
    // migration must reclassify it without creating or deleting any rows.
    database.prepare(
      `INSERT INTO document_media_bindings
       (workspace_id, document_id, media_id, created_at)
       VALUES (?, ?, ?, '2026-08-09T00:00:00.000Z')`,
    ).run(workspace.id, updated.id, draftMediaId);

    const before = captureDatabaseFingerprint(database);
    const rowCountBefore = database.prepare(
      "SELECT COUNT(*) AS count FROM document_media_bindings WHERE document_id = ?",
    ).get(updated.id);
    expect(runAppMigrations(database, { sourceRevision: "media-provenance-backfill-test" }).appliedIds)
      .toEqual([
        "0044_document_media_binding_provenance",
        "0045_collaboration_backup_checkpoint",
        "0046_workspace_media_cleanup_queue",
      ]);
    expect(captureDatabaseFingerprint(database, before)).toEqual(before);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM document_media_bindings WHERE document_id = ?",
    ).get(updated.id)).toEqual(rowCountBefore);

    const flags = database.prepare(
      `SELECT media_id, current_binding, revision_binding
       FROM document_media_bindings
       WHERE document_id = ?
       ORDER BY media_id`,
    ).all(updated.id) as Array<{
      media_id: string;
      current_binding: number;
      revision_binding: number;
    }>;
    expect(new Map(flags.map((row) => [row.media_id, {
      current: row.current_binding,
      revision: row.revision_binding,
    }]))).toEqual(new Map([
      [historyMediaId, { current: 0, revision: 1 }],
      [canonicalMediaId, { current: 0, revision: 1 }],
      [draftMediaId, { current: 1, revision: 0 }],
      [staleMediaId, { current: 0, revision: 0 }],
    ]));
  });

  it("adds an empty backup checkpoint without rewriting existing application data", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0044_document_media_binding_provenance");
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('checkpoint-owner', 'Checkpoint Owner', 'checkpoint@example.com', 1, 1, 1)",
    ).run();
    const workspace = ensurePersonalWorkspace(database, {
      id: "checkpoint-owner",
      name: "Checkpoint Owner",
      email: "checkpoint@example.com",
    });
    const before = captureDatabaseFingerprint(database);
    const documentCount = database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
    ).get(workspace.id);

    expect(runAppMigrations(database, { sourceRevision: "backup-checkpoint-test" }).appliedIds)
      .toEqual([
        "0045_collaboration_backup_checkpoint",
        "0046_workspace_media_cleanup_queue",
      ]);
    expect(captureDatabaseFingerprint(database, before)).toEqual(before);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
    ).get(workspace.id)).toEqual(documentCount);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_backup_checkpoints",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_backup_checkpoints'",
    ).get()).toEqual({ name: "collaboration_backup_checkpoints" });
  });

  it("adds the workspace media cleanup queue without rewriting existing application data", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0045_collaboration_backup_checkpoint");
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('cleanup-owner', 'Cleanup Owner', 'cleanup@example.com', 1, 1, 1)",
    ).run();
    const workspace = ensurePersonalWorkspace(database, {
      id: "cleanup-owner",
      name: "Cleanup Owner",
      email: "cleanup@example.com",
    });
    const before = captureDatabaseFingerprint(database);
    const documentCount = database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
    ).get(workspace.id);

    expect(runAppMigrations(database, { sourceRevision: "workspace-cleanup-queue-test" }).appliedIds)
      .toEqual(["0046_workspace_media_cleanup_queue"]);
    expect(captureDatabaseFingerprint(database, before)).toEqual(before);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
    ).get(workspace.id)).toEqual(documentCount);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workspace_media_cleanup_queue",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name = 'workspace_media_cleanup_queue_boundary_insert'`,
    ).get()).toEqual({ name: "workspace_media_cleanup_queue_boundary_insert" });
  });

  it("rolls back the pointer-guard migration for an invalid historical current revision", () => {
    const { database, firstDocument, secondDocument } = createRevisionPointerMigrationFixture();
    database.prepare("UPDATE documents SET current_revision_id = ? WHERE id = ?")
      .run(secondDocument.revision_id, firstDocument.id);

    expect(() => runAppMigrations(database, { sourceRevision: "invalid-current-pointer-test" }))
      .toThrow(/document current revision must belong to the same document/);
    expect(database.prepare(
      "SELECT current_revision_id FROM documents WHERE id = ?",
    ).get(firstDocument.id)).toEqual({ current_revision_id: secondDocument.revision_id });
    expect(database.prepare(
      "SELECT 1 FROM _nyxdoc_migrations WHERE id = '0043_document_revision_pointer_guards'",
    ).get()).toBeUndefined();
    expect(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'documents_current_revision_insert'",
    ).get()).toBeUndefined();
  });

  it("rolls back the pointer-guard migration for a historical collaboration workspace mismatch", () => {
    const { database, firstDocument, secondWorkspace } = createRevisionPointerMigrationFixture();
    database.prepare("UPDATE documents SET slug = 'historical-workspace-mismatch' WHERE id = ?")
      .run(firstDocument.id);
    database.prepare("UPDATE documents SET workspace_id = ? WHERE id = ?")
      .run(secondWorkspace.id, firstDocument.id);

    expect(() => runAppMigrations(database, { sourceRevision: "invalid-draft-workspace-test" }))
      .toThrow(/collaboration state must belong to the document workspace/);
    expect(database.prepare(
      "SELECT 1 FROM _nyxdoc_migrations WHERE id = '0043_document_revision_pointer_guards'",
    ).get()).toBeUndefined();
    expect(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'documents_current_revision_insert'",
    ).get()).toBeUndefined();
  });

  it("rolls back the pointer-guard migration for a historical cross-document draft base", () => {
    const { database, firstDocument, secondDocument } = createRevisionPointerMigrationFixture();
    database.prepare(
      `UPDATE document_collaboration_states
       SET base_revision_id = ?, base_revision_number = ?
       WHERE document_id = ?`,
    ).run(secondDocument.revision_id, secondDocument.revision_number, firstDocument.id);

    expect(() => runAppMigrations(database, { sourceRevision: "invalid-draft-base-test" }))
      .toThrow(/collaboration base revision id and number must match the same document/);
    expect(database.prepare(
      "SELECT 1 FROM _nyxdoc_migrations WHERE id = '0043_document_revision_pointer_guards'",
    ).get()).toBeUndefined();
    expect(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'documents_current_revision_insert'",
    ).get()).toBeUndefined();
  });

  it("migrates legacy agent roles and key allowlists into explicit grants and bindings", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0038_navigation_preference_versions");
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1, 1)",
    ).run();
    const first = ensurePersonalWorkspace(database, {
      id: "u1",
      name: "Owner",
      email: "owner@example.com",
    });
    const second = createWorkspace(database, {
      id: "u1",
      name: "Owner",
      email: "owner@example.com",
    }, "Second");
    const third = createWorkspace(database, {
      id: "u1",
      name: "Owner",
      email: "owner@example.com",
    }, "Third");
    database.prepare(
      `INSERT INTO agents
       (id, owner_user_id, display_name, avatar_media_id, status, created_by_user_id,
        created_at, updated_at, deleted_at, purge_after, purged_at)
       VALUES ('agent-1', 'u1', 'Agent', NULL, 'active', 'u1', ?, ?, NULL, NULL, NULL)`,
    ).run("2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
    database.prepare(
      `INSERT INTO agent_ownership
       (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
       VALUES ('agent-1', 'personal', 'u1', NULL, ?, ?)`,
    ).run("2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
    const insertGrant = database.prepare(
      `INSERT INTO workspace_agents
       (id, workspace_id, display_name, avatar_media_id, role, status,
        created_by_user_id, created_at, updated_at, agent_identity_id,
        permission_allow_json, permission_deny_json, root_document_id)
       VALUES (?, ?, 'Agent', NULL, ?, 'active', 'u1', ?, ?, 'agent-1', ?, ?, NULL)`,
    );
    insertGrant.run(
      "grant-1",
      first.id,
      "editor",
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
      JSON.stringify(["audit.read"]),
      JSON.stringify(["documents.commit"]),
    );
    insertGrant.run(
      "grant-2",
      second.id,
      "viewer",
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
      "[]",
      "[]",
    );
    insertGrant.run(
      "grant-3",
      third.id,
      "editor",
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
      "[]",
      "[]",
    );
    const insertCredential = database.prepare(
      `INSERT INTO agent_credentials
       (id, agent_id, created_by_user_id, name, token_prefix, token_hash,
        scopes_json, default_workspace_id, workspace_allowlist_json,
        ip_allowlist_json, last_used_at, last_used_ip, expires_at, revoked_at,
        created_at, updated_at)
       VALUES (?, 'agent-1', 'u1', ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, NULL, NULL, ?, ?)`,
    );
    insertCredential.run(
      "credential-all",
      "Legacy all",
      "nyx_live_all",
      "hash-all",
      JSON.stringify(["documents:read"]),
      first.id,
      "[]",
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
    );
    insertCredential.run(
      "credential-one",
      "Legacy one",
      "nyx_live_one",
      "hash-one",
      JSON.stringify(["documents:read"]),
      first.id,
      JSON.stringify([first.id]),
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
    );

    runAppMigrations(database, { sourceRevision: "agent-grant-backfill-test" });

    const grants = database.prepare(
      `SELECT id, access_profile, capabilities_json, scope_mode, policy_version, revoked_at
       FROM workspace_agents WHERE agent_identity_id = 'agent-1' ORDER BY id`,
    ).all() as Array<{
      id: string;
      access_profile: string;
      capabilities_json: string;
      scope_mode: string;
      policy_version: number;
      revoked_at: string | null;
    }>;
    expect(grants.map((grant) => ({
      id: grant.id,
      profile: grant.access_profile,
      scope: grant.scope_mode,
      policyVersion: grant.policy_version,
      revokedAt: grant.revoked_at,
    }))).toEqual([
      { id: "grant-1", profile: "custom", scope: "workspace", policyVersion: 1, revokedAt: null },
      { id: "grant-2", profile: "reader", scope: "workspace", policyVersion: 1, revokedAt: null },
      { id: "grant-3", profile: "custom", scope: "workspace", policyVersion: 1, revokedAt: null },
    ]);
    const editorCapabilities = JSON.parse(grants[0].capabilities_json) as string[];
    expect(editorCapabilities).toContain("audit.read");
    expect(editorCapabilities).not.toContain("documents.commit");
    expect(editorCapabilities).toContain("revisions.restore");
    expect(JSON.parse(grants[2].capabilities_json) as string[]).toContain("revisions.restore");
    expect(database.prepare(
      `SELECT credential_id, grant_id FROM agent_credential_grant_bindings
       WHERE status = 'active' ORDER BY credential_id, grant_id`,
    ).all()).toEqual([
      { credential_id: "credential-all", grant_id: "grant-1" },
      { credential_id: "credential-all", grant_id: "grant-2" },
      { credential_id: "credential-all", grant_id: "grant-3" },
      { credential_id: "credential-one", grant_id: "grant-1" },
    ]);
  });

  it("fails closed for an invalid historical document-tree grant without mutating stored data", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0040_media_upload_ticket_binding_guards");
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1, 1)",
    ).run();
    const workspace = ensurePersonalWorkspace(database, {
      id: "u1",
      name: "Owner",
      email: "owner@example.com",
    });
    const rootDocumentId = (database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1",
    ).get(workspace.id) as { id: string }).id;
    const created = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: "u1",
      name: "Legacy scoped agent",
      rootDocumentId,
    });

    database.prepare("DELETE FROM documents WHERE id = ?").run(rootDocumentId);
    expect(database.prepare(
      "SELECT status, scope_mode, root_document_id, revoked_at FROM workspace_agents WHERE id = ?",
    ).get(created.summary.agentId)).toEqual({
      status: "active",
      scope_mode: "document_tree",
      root_document_id: null,
      revoked_at: null,
    });

    expect(runAppMigrations(database, { sourceRevision: "document-tree-fail-closed-test" }).appliedIds)
      .toEqual([
        "0041_document_tree_grants_fail_closed",
        "0042_bug_report_image_attachments",
        "0043_document_revision_pointer_guards",
        "0044_document_media_binding_provenance",
        "0045_collaboration_backup_checkpoint",
        "0046_workspace_media_cleanup_queue",
      ]);
    expect(database.prepare(
      "SELECT status, scope_mode, root_document_id, revoked_at FROM workspace_agents WHERE id = ?",
    ).get(created.summary.agentId)).toEqual({
      status: "active",
      scope_mode: "document_tree",
      root_document_id: null,
      revoked_at: null,
    });
    expect(() => authenticateApiToken(database, `Bearer ${created.token}`))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("fails closed with the credential id when an active legacy allowlist is invalid JSON", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createUserTable(database);
    applyThrough(database, "0038_navigation_preference_versions");
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1, 1)",
    ).run();
    const workspace = ensurePersonalWorkspace(database, {
      id: "u1",
      name: "Owner",
      email: "owner@example.com",
    });
    database.prepare(
      `INSERT INTO agents
       (id, owner_user_id, display_name, avatar_media_id, status, created_by_user_id,
        created_at, updated_at, deleted_at, purge_after, purged_at)
       VALUES ('agent-invalid', 'u1', 'Invalid', NULL, 'active', 'u1', ?, ?, NULL, NULL, NULL)`,
    ).run("2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
    database.prepare(
      `INSERT INTO agent_ownership
       (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
       VALUES ('agent-invalid', 'personal', 'u1', NULL, ?, ?)`,
    ).run("2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
    database.prepare(
      `INSERT INTO workspace_agents
       (id, workspace_id, display_name, avatar_media_id, role, status,
        created_by_user_id, created_at, updated_at, agent_identity_id,
        permission_allow_json, permission_deny_json, root_document_id)
       VALUES ('grant-invalid', ?, 'Invalid', NULL, 'editor', 'active', 'u1', ?, ?,
        'agent-invalid', '[]', '[]', NULL)`,
    ).run(workspace.id, "2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
    database.prepare(
      `INSERT INTO agent_credentials
       (id, agent_id, created_by_user_id, name, token_prefix, token_hash,
        scopes_json, default_workspace_id, workspace_allowlist_json,
        ip_allowlist_json, last_used_at, last_used_ip, expires_at, revoked_at,
        created_at, updated_at)
       VALUES ('credential-invalid-json', 'agent-invalid', 'u1', 'Invalid',
        'nyx_live_invalid', 'hash-invalid', '["documents:read"]', ?, '{not-json',
        '[]', NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      workspace.id,
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
    );

    expect(() => runAppMigrations(database, { sourceRevision: "invalid-allowlist-test" }))
      .toThrow(/0039 invalid workspace_allowlist_json for active credential credential-invalid-json/);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM _nyxdoc_migrations WHERE id = '0039_agent_access_grants_and_bindings'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM pragma_table_info('workspace_agents') WHERE name = 'access_profile'",
    ).get()).toEqual({ count: 0 });
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
