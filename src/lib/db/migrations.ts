import { createHash, randomUUID } from "node:crypto";
import type { NyxDatabase } from "@/lib/db/client";
import {
  assertDatabaseFingerprintEqual,
  assertDatabaseIntegrity,
  captureDatabaseFingerprint,
  type DatabaseFingerprint,
} from "@/lib/db/integrity";

export type AppMigration = {
  id: string;
  sql: string;
  safety?: "schema" | "transform" | "destructive-reset" | "operational";
};

export const APP_MIGRATIONS: readonly AppMigration[] = [
  {
    id: "0001_nyxdoc_core",
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE workspace_members (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, user_id)
      );

      CREATE INDEX workspace_members_user_idx
        ON workspace_members(user_id);

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        current_revision_id TEXT,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, slug)
      );

      CREATE INDEX documents_workspace_idx ON documents(workspace_id, updated_at);

      CREATE TABLE document_blocks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        block_type TEXT NOT NULL CHECK (block_type IN ('heading', 'paragraph', 'callout', 'list_item')),
        content TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX document_blocks_document_idx
        ON document_blocks(document_id, sort_order);

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX conversations_workspace_idx
        ON conversations(workspace_id, updated_at);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX messages_conversation_idx
        ON messages(conversation_id, created_at);

      CREATE TABLE patches (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        base_revision_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed', 'applied', 'partial', 'rejected', 'superseded')),
        instruction TEXT NOT NULL,
        summary TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );

      CREATE INDEX patches_document_idx ON patches(document_id, created_at);
      CREATE INDEX patches_conversation_idx ON patches(conversation_id, created_at);

      CREATE TABLE patch_operations (
        id TEXT PRIMARY KEY,
        patch_id TEXT NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        operation_type TEXT NOT NULL
          CHECK (operation_type IN ('replace_block', 'insert_after', 'delete_block')),
        block_id TEXT,
        anchor_block_id TEXT,
        expected_version INTEGER,
        block_type TEXT CHECK (block_type IS NULL OR block_type IN ('heading', 'paragraph', 'callout', 'list_item')),
        before_content TEXT,
        after_content TEXT,
        rationale TEXT NOT NULL,
        sources_json TEXT NOT NULL DEFAULT '[]',
        review_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (review_status IN ('pending', 'accepted', 'rejected')),
        created_at TEXT NOT NULL,
        UNIQUE (patch_id, sequence)
      );

      CREATE INDEX patch_operations_patch_idx
        ON patch_operations(patch_id, sequence);

      CREATE TABLE document_revisions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('seed', 'human', 'agent', 'rollback')),
        patch_id TEXT REFERENCES patches(id) ON DELETE SET NULL,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        UNIQUE (document_id, revision_number)
      );

      CREATE INDEX document_revisions_document_idx
        ON document_revisions(document_id, revision_number DESC);

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        read_set_json TEXT NOT NULL DEFAULT '[]',
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX agent_runs_conversation_idx
        ON agent_runs(conversation_id, started_at);
    `,
  },
  {
    id: "0002_external_agents_and_change_feed",
    sql: `
      CREATE TABLE workspace_api_tokens (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL DEFAULT '["documents:read","documents:write","changes:read"]',
        last_event_cursor INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX workspace_api_tokens_workspace_idx
        ON workspace_api_tokens(workspace_id, created_at DESC);

      ALTER TABLE document_revisions ADD COLUMN base_revision_id TEXT;
      ALTER TABLE document_revisions ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'system';
      ALTER TABLE document_revisions ADD COLUMN actor_user_id TEXT;
      ALTER TABLE document_revisions ADD COLUMN actor_token_id TEXT;
      ALTER TABLE document_revisions ADD COLUMN actor_label TEXT NOT NULL DEFAULT 'Nyxdoc';
      ALTER TABLE document_revisions ADD COLUMN source TEXT NOT NULL DEFAULT 'seed';

      UPDATE document_revisions
      SET actor_type = CASE
            WHEN origin = 'agent' THEN 'agent'
            WHEN origin = 'human' THEN 'human'
            ELSE 'system'
          END,
          actor_user_id = created_by_user_id,
          actor_label = CASE
            WHEN origin = 'agent' THEN '에이전트'
            WHEN origin = 'human' THEN '사용자'
            ELSE 'Nyxdoc'
          END,
          source = CASE
            WHEN origin = 'agent' THEN 'legacy'
            WHEN origin = 'human' THEN 'web'
            WHEN origin = 'rollback' THEN 'rollback'
            ELSE 'seed'
          END;

      CREATE TABLE document_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'archived', 'restored')),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'human', 'agent')),
        actor_user_id TEXT,
        actor_token_id TEXT,
        actor_label TEXT NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX document_events_workspace_cursor_idx
        ON document_events(workspace_id, cursor);
      CREATE INDEX document_events_document_cursor_idx
        ON document_events(document_id, cursor DESC);

      INSERT OR IGNORE INTO document_events
        (id, workspace_id, document_id, revision_id, event_type, actor_type,
         actor_user_id, actor_token_id, actor_label, source, summary, created_at)
      SELECT
        'migration-' || r.id,
        d.workspace_id,
        r.document_id,
        r.id,
        CASE WHEN r.revision_number = 1 THEN 'created' ELSE 'updated' END,
        r.actor_type,
        r.actor_user_id,
        r.actor_token_id,
        r.actor_label,
        r.source,
        r.summary,
        r.created_at
      FROM document_revisions r
      JOIN documents d ON d.id = r.document_id
      ORDER BY r.created_at ASC, r.revision_number ASC;
    `,
  },
  {
    id: "0003_rich_document_blocks",
    sql: `
      ALTER TABLE document_blocks RENAME TO document_blocks_legacy;

      CREATE TABLE document_blocks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        block_type TEXT NOT NULL CHECK (block_type IN (
          'heading', 'heading_2', 'heading_3', 'paragraph', 'callout',
          'list_item', 'numbered_list_item', 'todo', 'quote', 'divider', 'table'
        )),
        content TEXT NOT NULL,
        indent_level INTEGER NOT NULL DEFAULT 0 CHECK (indent_level BETWEEN 0 AND 6),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        sort_order INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      INSERT INTO document_blocks
        (id, document_id, block_type, content, indent_level, metadata_json,
         sort_order, version, created_at, updated_at, deleted_at)
      SELECT id, document_id, block_type, content, 0, '{}',
             sort_order, version, created_at, updated_at, deleted_at
      FROM document_blocks_legacy;

      DROP TABLE document_blocks_legacy;

      CREATE INDEX document_blocks_document_idx
        ON document_blocks(document_id, sort_order);
    `,
  },
  {
    id: "0004_nested_documents",
    sql: `
      ALTER TABLE documents
        ADD COLUMN parent_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;
      ALTER TABLE documents
        ADD COLUMN tree_order INTEGER NOT NULL DEFAULT 0;

      WITH ordered AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at ASC, id ASC) * 100 AS position
        FROM documents
      )
      UPDATE documents
      SET tree_order = (SELECT position FROM ordered WHERE ordered.id = documents.id);

      CREATE INDEX documents_parent_idx
        ON documents(workspace_id, parent_document_id, tree_order);
    `,
  },
  {
    id: "0005_media_assets",
    sql: `
      CREATE TABLE media_assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        storage_key TEXT NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN (
          'image/png', 'image/jpeg', 'image/gif', 'image/webp'
        )),
        byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 15728640),
        original_filename TEXT,
        uploaded_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        uploaded_by_token_id TEXT REFERENCES workspace_api_tokens(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, sha256)
      );

      CREATE INDEX media_assets_workspace_created_idx
        ON media_assets(workspace_id, created_at DESC);
    `,
  },
  {
    id: "0006_document_ast_v2",
    sql: `
      ALTER TABLE documents
        ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1;

      ALTER TABLE document_blocks
        ADD COLUMN content_json TEXT;
    `,
  },
  {
    id: "0007_agent_protocol_v2",
    sql: `
      CREATE TABLE agent_write_requests (
        token_id TEXT NOT NULL REFERENCES workspace_api_tokens(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (token_id, request_id)
      );

      CREATE INDEX agent_write_requests_created_idx
        ON agent_write_requests(created_at);
    `,
  },
  {
    id: "0008_document_references",
    sql: `
      CREATE TABLE document_references (
        source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        target_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        source_block_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_document_id, target_document_id, source_block_id)
      );

      CREATE INDEX document_references_target_idx
        ON document_references(target_document_id, source_document_id);
    `,
  },
  {
    id: "0009_document_metadata",
    sql: `
      ALTER TABLE documents ADD COLUMN document_type TEXT;
      ALTER TABLE documents
        ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'draft'
        CHECK (workflow_status IN ('draft', 'review', 'final'));
      ALTER TABLE documents ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';

      ALTER TABLE document_revisions ADD COLUMN title_snapshot TEXT;
      ALTER TABLE document_revisions ADD COLUMN parent_document_id_snapshot TEXT;
      ALTER TABLE document_revisions ADD COLUMN document_metadata_json TEXT NOT NULL DEFAULT '{}';

      UPDATE document_revisions
      SET title_snapshot = (
            SELECT title FROM documents WHERE documents.id = document_revisions.document_id
          ),
          parent_document_id_snapshot = (
            SELECT parent_document_id FROM documents WHERE documents.id = document_revisions.document_id
          ),
          document_metadata_json = json_object(
            'documentType', (
              SELECT document_type FROM documents WHERE documents.id = document_revisions.document_id
            ),
            'workflowStatus', (
              SELECT workflow_status FROM documents WHERE documents.id = document_revisions.document_id
            ),
            'tags', json((
              SELECT tags_json FROM documents WHERE documents.id = document_revisions.document_id
            ))
          );

      CREATE INDEX documents_metadata_idx
        ON documents(workspace_id, workflow_status, document_type, updated_at DESC);
    `,
  },
  {
    id: "0010_scoped_agent_connections",
    sql: `
      ALTER TABLE workspace_api_tokens
        ADD COLUMN root_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;

      CREATE INDEX workspace_api_tokens_root_idx
        ON workspace_api_tokens(workspace_id, root_document_id, revoked_at);
    `,
  },
  {
    id: "0011_canonical_ast_v2_only",
    safety: "destructive-reset",
    sql: `
      DELETE FROM agent_write_requests;
      DELETE FROM documents;
    `,
  },
  {
    id: "0012_migration_safety_metadata",
    safety: "operational",
    sql: `
      CREATE TABLE _nyxdoc_migration_checksums (
        migration_id TEXT PRIMARY KEY REFERENCES _nyxdoc_migrations(id) ON DELETE CASCADE,
        checksum_sha256 TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE _nyxdoc_migration_runs (
        id TEXT PRIMARY KEY,
        source_revision TEXT NOT NULL,
        planned_ids_json TEXT NOT NULL,
        before_fingerprint_json TEXT NOT NULL,
        after_fingerprint_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded'))
      );
    `,
  },
  {
    id: "0013_workspace_agents_and_rbac",
    safety: "transform",
    sql: `
      ALTER TABLE workspace_members
        ADD COLUMN access_role TEXT
        CHECK (access_role IS NULL OR access_role IN ('owner', 'admin', 'editor', 'viewer'));

      UPDATE workspace_members
      SET access_role = CASE WHEN role = 'owner' THEN 'owner' ELSE 'editor' END
      WHERE access_role IS NULL;

      CREATE TABLE workspace_agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        avatar_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX workspace_agents_workspace_idx
        ON workspace_agents(workspace_id, status, display_name);

      ALTER TABLE workspace_api_tokens
        ADD COLUMN agent_id TEXT REFERENCES workspace_agents(id) ON DELETE CASCADE;

      INSERT INTO workspace_agents
        (id, workspace_id, display_name, avatar_media_id, role, status,
         created_by_user_id, created_at, updated_at)
      SELECT
        'legacy-agent-' || id,
        workspace_id,
        name,
        NULL,
        CASE
          WHEN instr(scopes_json, '"documents:write"') > 0 THEN 'editor'
          ELSE 'viewer'
        END,
        CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'disabled' END,
        created_by_user_id,
        created_at,
        created_at
      FROM workspace_api_tokens;

      UPDATE workspace_api_tokens
      SET agent_id = 'legacy-agent-' || id
      WHERE agent_id IS NULL;

      CREATE INDEX workspace_api_tokens_agent_idx
        ON workspace_api_tokens(agent_id, revoked_at, created_at DESC);

      ALTER TABLE document_revisions ADD COLUMN actor_principal_id TEXT;
      ALTER TABLE document_revisions ADD COLUMN actor_avatar_media_id TEXT;

      UPDATE document_revisions
      SET actor_principal_id = CASE
            WHEN actor_type = 'agent' THEN COALESCE(
              (SELECT agent_id FROM workspace_api_tokens t WHERE t.id = document_revisions.actor_token_id),
              actor_token_id
            )
            WHEN actor_type = 'human' THEN actor_user_id
            ELSE NULL
          END
      WHERE actor_principal_id IS NULL;

      ALTER TABLE document_events ADD COLUMN actor_principal_id TEXT;
      ALTER TABLE document_events ADD COLUMN actor_avatar_media_id TEXT;

      UPDATE document_events
      SET actor_principal_id = CASE
            WHEN actor_type = 'agent' THEN COALESCE(
              (SELECT agent_id FROM workspace_api_tokens t WHERE t.id = document_events.actor_token_id),
              actor_token_id
            )
            WHEN actor_type = 'human' THEN actor_user_id
            ELSE NULL
          END
      WHERE actor_principal_id IS NULL;

      CREATE TABLE workspace_audit_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'human', 'agent')),
        actor_user_id TEXT,
        actor_agent_id TEXT,
        actor_label TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX workspace_audit_events_workspace_cursor_idx
        ON workspace_audit_events(workspace_id, cursor DESC);

      CREATE TABLE workspace_saved_views (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        query_json TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'workspace'
          CHECK (visibility IN ('private', 'workspace')),
        created_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        created_by_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (created_by_user_id IS NOT NULL OR created_by_agent_id IS NOT NULL)
      );

      CREATE INDEX workspace_saved_views_workspace_idx
        ON workspace_saved_views(workspace_id, updated_at DESC);

      CREATE TABLE agent_document_assignments (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        assignment_type TEXT NOT NULL
          CHECK (assignment_type IN ('owner', 'contributor', 'reviewer')),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'completed', 'cancelled')),
        note TEXT,
        assigned_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        assigned_by_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (assigned_by_user_id IS NOT NULL OR assigned_by_agent_id IS NOT NULL)
      );

      CREATE UNIQUE INDEX agent_document_assignments_active_idx
        ON agent_document_assignments(agent_id, document_id, assignment_type)
        WHERE status = 'active';
      CREATE INDEX agent_document_assignments_workspace_idx
        ON agent_document_assignments(workspace_id, status, updated_at DESC);
    `,
  },
  {
    id: "0014_document_trash_lifecycle",
    safety: "transform",
    sql: `
      ALTER TABLE workspaces
        ADD COLUMN trash_retention_days INTEGER NOT NULL DEFAULT 30
        CHECK (trash_retention_days BETWEEN 1 AND 3650);
      ALTER TABLE workspaces
        ADD COLUMN trash_auto_purge INTEGER NOT NULL DEFAULT 1
        CHECK (trash_auto_purge IN (0, 1));

      CREATE TABLE document_trash_batches (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        root_document_id TEXT NOT NULL,
        root_title_snapshot TEXT NOT NULL,
        document_count INTEGER NOT NULL CHECK (document_count > 0),
        trashed_at TEXT NOT NULL,
        purge_after TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
        actor_user_id TEXT,
        actor_agent_id TEXT,
        actor_label TEXT NOT NULL
      );

      CREATE INDEX document_trash_batches_workspace_idx
        ON document_trash_batches(workspace_id, trashed_at DESC);
      CREATE INDEX document_trash_batches_purge_idx
        ON document_trash_batches(purge_after, workspace_id);

      ALTER TABLE documents
        ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
        CHECK (lifecycle_state IN ('active', 'archived', 'trashed'));
      ALTER TABLE documents ADD COLUMN trash_batch_id TEXT;
      ALTER TABLE documents ADD COLUMN trashed_at TEXT;
      ALTER TABLE documents ADD COLUMN purge_after TEXT;
      ALTER TABLE documents ADD COLUMN trashed_by_type TEXT;
      ALTER TABLE documents ADD COLUMN trashed_by_user_id TEXT;
      ALTER TABLE documents ADD COLUMN trashed_by_agent_id TEXT;
      ALTER TABLE documents ADD COLUMN trashed_by_label TEXT;
      ALTER TABLE documents ADD COLUMN original_parent_document_id TEXT;
      ALTER TABLE documents ADD COLUMN original_tree_order INTEGER;

      UPDATE documents
      SET lifecycle_state = CASE WHEN status = 'archived' THEN 'archived' ELSE 'active' END;

      CREATE INDEX documents_lifecycle_idx
        ON documents(workspace_id, lifecycle_state, updated_at DESC);
      CREATE INDEX documents_trash_batch_idx
        ON documents(workspace_id, trash_batch_id, lifecycle_state);
      CREATE INDEX documents_purge_after_idx
        ON documents(workspace_id, purge_after)
        WHERE lifecycle_state = 'trashed';

      CREATE TABLE document_purge_tombstones (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        trash_batch_id TEXT NOT NULL,
        title_snapshot TEXT NOT NULL,
        slug_snapshot TEXT NOT NULL,
        purged_at TEXT NOT NULL,
        purged_by_type TEXT NOT NULL CHECK (purged_by_type IN ('human', 'agent', 'system')),
        purged_by_user_id TEXT,
        purged_by_agent_id TEXT,
        purged_by_label TEXT NOT NULL
      );

      CREATE INDEX document_purge_tombstones_workspace_idx
        ON document_purge_tombstones(workspace_id, purged_at DESC);
    `,
  },
  {
    id: "0015_admin_action_requests",
    safety: "schema",
    sql: `
      CREATE TABLE workspace_admin_action_requests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK (action_type IN (
          'workspace.create',
          'workspace.update',
          'agent.connect',
          'agent.update',
          'credential.rotate',
          'credential.revoke'
        )),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
          'pending', 'executed', 'rejected', 'failed', 'expired'
        )),
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        precondition_json TEXT NOT NULL DEFAULT '{}',
        preview_text TEXT NOT NULL,
        requested_by_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
        requested_by_label TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        reviewed_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        reviewed_by_label TEXT,
        reviewed_at TEXT,
        decision_note TEXT,
        execution_result_json TEXT
      );

      CREATE UNIQUE INDEX workspace_admin_requests_idempotency_idx
        ON workspace_admin_action_requests(workspace_id, request_id);
      CREATE INDEX workspace_admin_requests_pending_idx
        ON workspace_admin_action_requests(workspace_id, status, requested_at DESC);
      CREATE INDEX workspace_admin_requests_expiry_idx
        ON workspace_admin_action_requests(status, expires_at);
    `,
  },
  {
    id: "0016_workspace_boundary_guards",
    safety: "schema",
    sql: `
      CREATE TRIGGER documents_parent_workspace_insert
      BEFORE INSERT ON documents
      WHEN NEW.parent_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents parent
        WHERE parent.id = NEW.parent_document_id AND parent.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'document parent must belong to the same workspace'); END;

      CREATE TRIGGER documents_parent_workspace_update
      BEFORE UPDATE OF workspace_id, parent_document_id ON documents
      WHEN NEW.parent_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents parent
        WHERE parent.id = NEW.parent_document_id AND parent.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'document parent must belong to the same workspace'); END;

      CREATE TRIGGER workspace_agents_avatar_workspace_insert
      BEFORE INSERT ON workspace_agents
      WHEN NEW.avatar_media_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM media_assets media
        WHERE media.id = NEW.avatar_media_id AND media.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'agent avatar must belong to the same workspace'); END;

      CREATE TRIGGER workspace_agents_avatar_workspace_update
      BEFORE UPDATE OF workspace_id, avatar_media_id ON workspace_agents
      WHEN NEW.avatar_media_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM media_assets media
        WHERE media.id = NEW.avatar_media_id AND media.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'agent avatar must belong to the same workspace'); END;

      CREATE TRIGGER workspace_tokens_boundary_insert
      BEFORE INSERT ON workspace_api_tokens
      WHEN (NEW.agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.agent_id AND agent.workspace_id = NEW.workspace_id
      )) OR (NEW.root_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.root_document_id AND document.workspace_id = NEW.workspace_id
      ))
      BEGIN SELECT RAISE(ABORT, 'credential references must belong to the same workspace'); END;

      CREATE TRIGGER workspace_tokens_boundary_update
      BEFORE UPDATE OF workspace_id, agent_id, root_document_id ON workspace_api_tokens
      WHEN (NEW.agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.agent_id AND agent.workspace_id = NEW.workspace_id
      )) OR (NEW.root_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.root_document_id AND document.workspace_id = NEW.workspace_id
      ))
      BEGIN SELECT RAISE(ABORT, 'credential references must belong to the same workspace'); END;

      CREATE TRIGGER media_token_workspace_insert
      BEFORE INSERT ON media_assets
      WHEN NEW.uploaded_by_token_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_api_tokens token
        WHERE token.id = NEW.uploaded_by_token_id AND token.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'media credential must belong to the same workspace'); END;

      CREATE TRIGGER media_token_workspace_update
      BEFORE UPDATE OF workspace_id, uploaded_by_token_id ON media_assets
      WHEN NEW.uploaded_by_token_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_api_tokens token
        WHERE token.id = NEW.uploaded_by_token_id AND token.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'media credential must belong to the same workspace'); END;

      CREATE TRIGGER document_events_workspace_insert
      BEFORE INSERT ON document_events
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'document event must belong to the document workspace'); END;

      CREATE TRIGGER document_events_workspace_update
      BEFORE UPDATE OF workspace_id, document_id ON document_events
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'document event must belong to the document workspace'); END;

      CREATE TRIGGER document_references_workspace_insert
      BEFORE INSERT ON document_references
      WHEN NOT EXISTS (
        SELECT 1 FROM documents source
        JOIN documents target ON target.id = NEW.target_document_id
        WHERE source.id = NEW.source_document_id AND source.workspace_id = target.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'document references cannot cross workspaces'); END;

      CREATE TRIGGER document_references_workspace_update
      BEFORE UPDATE OF source_document_id, target_document_id ON document_references
      WHEN NOT EXISTS (
        SELECT 1 FROM documents source
        JOIN documents target ON target.id = NEW.target_document_id
        WHERE source.id = NEW.source_document_id AND source.workspace_id = target.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'document references cannot cross workspaces'); END;

      CREATE TRIGGER agent_assignments_workspace_insert
      BEFORE INSERT ON agent_document_assignments
      WHEN NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        JOIN documents document ON document.id = NEW.document_id
        WHERE agent.id = NEW.agent_id
          AND agent.workspace_id = NEW.workspace_id
          AND document.workspace_id = NEW.workspace_id
      ) OR (NEW.assigned_by_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents actor
        WHERE actor.id = NEW.assigned_by_agent_id AND actor.workspace_id = NEW.workspace_id
      ))
      BEGIN SELECT RAISE(ABORT, 'assignment references must belong to the same workspace'); END;

      CREATE TRIGGER agent_assignments_workspace_update
      BEFORE UPDATE OF workspace_id, agent_id, document_id, assigned_by_agent_id ON agent_document_assignments
      WHEN NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        JOIN documents document ON document.id = NEW.document_id
        WHERE agent.id = NEW.agent_id
          AND agent.workspace_id = NEW.workspace_id
          AND document.workspace_id = NEW.workspace_id
      ) OR (NEW.assigned_by_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents actor
        WHERE actor.id = NEW.assigned_by_agent_id AND actor.workspace_id = NEW.workspace_id
      ))
      BEGIN SELECT RAISE(ABORT, 'assignment references must belong to the same workspace'); END;

      CREATE TRIGGER saved_views_agent_workspace_insert
      BEFORE INSERT ON workspace_saved_views
      WHEN NEW.created_by_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.created_by_agent_id AND agent.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'saved view agent must belong to the same workspace'); END;

      CREATE TRIGGER saved_views_agent_workspace_update
      BEFORE UPDATE OF workspace_id, created_by_agent_id ON workspace_saved_views
      WHEN NEW.created_by_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.created_by_agent_id AND agent.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'saved view agent must belong to the same workspace'); END;

      CREATE TRIGGER admin_requests_agent_workspace_insert
      BEFORE INSERT ON workspace_admin_action_requests
      WHEN NEW.requested_by_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.requested_by_agent_id AND agent.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'admin request agent must belong to the same workspace'); END;

      CREATE TRIGGER admin_requests_agent_workspace_update
      BEFORE UPDATE OF workspace_id, requested_by_agent_id ON workspace_admin_action_requests
      WHEN NEW.requested_by_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.requested_by_agent_id AND agent.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'admin request agent must belong to the same workspace'); END;
    `,
  },
  {
    id: "0017_crdt_shared_drafts",
    safety: "schema",
    sql: `
      CREATE TABLE document_collaboration_states (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
        yjs_state BLOB NOT NULL,
        base_revision_id TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,
        base_revision_number INTEGER NOT NULL DEFAULT 0 CHECK (base_revision_number >= 0),
        draft_version INTEGER NOT NULL DEFAULT 0 CHECK (draft_version >= 0),
        committed_draft_version INTEGER NOT NULL DEFAULT 0 CHECK (committed_draft_version >= 0),
        seeded_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        committed_at TEXT,
        last_actor_type TEXT CHECK (last_actor_type IS NULL OR last_actor_type IN ('human', 'agent', 'system')),
        last_actor_principal_id TEXT,
        last_actor_label TEXT,
        last_actor_avatar_media_id TEXT
      );

      CREATE UNIQUE INDEX document_collaboration_room_idx
        ON document_collaboration_states(workspace_id, document_id, generation);
      CREATE INDEX document_collaboration_updated_idx
        ON document_collaboration_states(workspace_id, updated_at DESC);

      CREATE TABLE document_draft_contributors (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        contributor_key TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
        actor_principal_id TEXT,
        actor_label TEXT NOT NULL,
        actor_avatar_media_id TEXT,
        first_edit_at TEXT NOT NULL,
        last_edit_at TEXT NOT NULL,
        update_count INTEGER NOT NULL DEFAULT 1 CHECK (update_count > 0),
        PRIMARY KEY (document_id, generation, contributor_key)
      );

      CREATE TABLE document_revision_contributors (
        revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
        contributor_key TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
        actor_principal_id TEXT,
        actor_label TEXT NOT NULL,
        actor_avatar_media_id TEXT,
        first_edit_at TEXT NOT NULL,
        last_edit_at TEXT NOT NULL,
        update_count INTEGER NOT NULL CHECK (update_count > 0),
        PRIMARY KEY (revision_id, contributor_key)
      );

      CREATE TABLE collaboration_idempotency_requests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        actor_principal_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (actor_principal_id, operation, request_id)
      );

      CREATE TRIGGER collaboration_state_workspace_insert
      BEFORE INSERT ON document_collaboration_states
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'collaboration state must belong to the document workspace'); END;

      CREATE TRIGGER collaboration_state_workspace_update
      BEFORE UPDATE OF workspace_id, document_id ON document_collaboration_states
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'collaboration state must belong to the document workspace'); END;

    `,
  },
  {
    id: "0018_collaboration_commit_snapshots",
    safety: "schema",
    sql: `
      ALTER TABLE document_collaboration_states
        ADD COLUMN committed_yjs_state BLOB NOT NULL DEFAULT X'';

      UPDATE document_collaboration_states
      SET committed_yjs_state = yjs_state;
    `,
  },
  {
    id: "0019_global_agents_and_credentials",
    safety: "transform",
    sql: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        avatar_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX agents_owner_idx
        ON agents(owner_user_id, status, display_name);

      INSERT INTO agents
        (id, owner_user_id, display_name, avatar_media_id, status,
         created_by_user_id, created_at, updated_at)
      SELECT id, created_by_user_id, display_name, avatar_media_id, status,
             created_by_user_id, created_at, updated_at
      FROM workspace_agents;

      ALTER TABLE workspace_agents
        ADD COLUMN agent_identity_id TEXT REFERENCES agents(id) ON DELETE CASCADE;
      ALTER TABLE workspace_agents
        ADD COLUMN permission_allow_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE workspace_agents
        ADD COLUMN permission_deny_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE workspace_agents
        ADD COLUMN root_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;

      UPDATE workspace_agents
      SET agent_identity_id = id,
          root_document_id = (
            SELECT token.root_document_id
            FROM workspace_api_tokens token
            WHERE token.agent_id = workspace_agents.id
              AND token.workspace_id = workspace_agents.workspace_id
              AND token.revoked_at IS NULL
            ORDER BY token.created_at DESC
            LIMIT 1
          );

      CREATE UNIQUE INDEX workspace_agents_identity_idx
        ON workspace_agents(workspace_id, agent_identity_id);
      CREATE INDEX workspace_agents_global_identity_idx
        ON workspace_agents(agent_identity_id, workspace_id, status);

      CREATE TABLE agent_credentials (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL,
        default_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        workspace_allowlist_json TEXT NOT NULL DEFAULT '[]',
        ip_allowlist_json TEXT NOT NULL DEFAULT '[]',
        last_used_at TEXT,
        last_used_ip TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX agent_credentials_agent_idx
        ON agent_credentials(agent_id, revoked_at, created_at DESC);
      CREATE INDEX agent_credentials_prefix_idx
        ON agent_credentials(token_prefix);

      INSERT INTO agent_credentials
        (id, agent_id, created_by_user_id, name, token_prefix, token_hash,
         scopes_json, default_workspace_id, workspace_allowlist_json,
         ip_allowlist_json, last_used_at, last_used_ip, expires_at, revoked_at,
         created_at, updated_at)
      SELECT token.id, agent.agent_identity_id, token.created_by_user_id,
             token.name, token.token_prefix, token.token_hash, token.scopes_json,
             token.workspace_id, '[]', '[]', token.last_used_at, NULL,
             token.expires_at, token.revoked_at, token.created_at, token.created_at
      FROM workspace_api_tokens token
      JOIN workspace_agents agent ON agent.id = token.agent_id;

      CREATE TABLE agent_credential_workspace_state (
        credential_id TEXT NOT NULL REFERENCES agent_credentials(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        last_event_cursor INTEGER NOT NULL DEFAULT 0 CHECK (last_event_cursor >= 0),
        last_used_at TEXT,
        last_used_ip TEXT,
        PRIMARY KEY (credential_id, workspace_id)
      );

      INSERT INTO agent_credential_workspace_state
        (credential_id, workspace_id, last_event_cursor, last_used_at, last_used_ip)
      SELECT id, workspace_id, last_event_cursor, last_used_at, NULL
      FROM workspace_api_tokens;

      CREATE TABLE agent_credential_write_requests (
        credential_id TEXT NOT NULL REFERENCES agent_credentials(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (credential_id, request_id)
      );

      CREATE INDEX agent_credential_write_requests_created_idx
        ON agent_credential_write_requests(created_at);

      INSERT INTO agent_credential_write_requests
        (credential_id, request_id, operation, payload_hash,
         document_id, response_json, created_at)
      SELECT token_id, request_id, operation, payload_hash,
             document_id, response_json, created_at
      FROM agent_write_requests;

      ALTER TABLE media_assets
        ADD COLUMN uploaded_by_credential_id TEXT REFERENCES agent_credentials(id) ON DELETE SET NULL;

      UPDATE media_assets
      SET uploaded_by_credential_id = uploaded_by_token_id
      WHERE uploaded_by_token_id IS NOT NULL;

      CREATE INDEX media_assets_agent_credential_idx
        ON media_assets(uploaded_by_credential_id, created_at DESC);

      CREATE TRIGGER workspace_agent_identity_required_insert
      BEFORE INSERT ON workspace_agents
      WHEN NEW.agent_identity_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'workspace agent membership requires a global agent identity'); END;

      CREATE TRIGGER workspace_agent_identity_required_update
      BEFORE UPDATE OF agent_identity_id ON workspace_agents
      WHEN NEW.agent_identity_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'workspace agent membership requires a global agent identity'); END;

      CREATE TRIGGER workspace_agent_root_boundary_insert
      BEFORE INSERT ON workspace_agents
      WHEN NEW.root_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.root_document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'agent document root must belong to the membership workspace'); END;

      CREATE TRIGGER workspace_agent_root_boundary_update
      BEFORE UPDATE OF workspace_id, root_document_id ON workspace_agents
      WHEN NEW.root_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.root_document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'agent document root must belong to the membership workspace'); END;
    `,
  },
  {
    id: "0020_agent_lifecycle",
    safety: "schema",
    sql: `
      ALTER TABLE agents ADD COLUMN deleted_at TEXT;
      ALTER TABLE agents ADD COLUMN purge_after TEXT;
      ALTER TABLE agents ADD COLUMN purged_at TEXT;

      CREATE INDEX agents_owner_lifecycle_idx
        ON agents(owner_user_id, deleted_at, purged_at, status, display_name);
      CREATE INDEX agents_purge_due_idx
        ON agents(purge_after)
        WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
    `,
  },
  {
    id: "0021_workspace_lifecycle",
    safety: "schema",
    sql: `
      ALTER TABLE workspaces
        ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
        CHECK (lifecycle_state IN ('active', 'trashed'));
      ALTER TABLE workspaces ADD COLUMN trashed_at TEXT;
      ALTER TABLE workspaces ADD COLUMN purge_after TEXT;
      ALTER TABLE workspaces ADD COLUMN trashed_by_user_id TEXT;
      ALTER TABLE workspaces ADD COLUMN trashed_by_label TEXT;

      CREATE INDEX workspaces_lifecycle_idx
        ON workspaces(lifecycle_state, purge_after, updated_at DESC);

      CREATE TABLE workspace_purge_tombstones (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        name_snapshot TEXT NOT NULL,
        slug_snapshot TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        document_count INTEGER NOT NULL,
        member_count INTEGER NOT NULL,
        agent_membership_count INTEGER NOT NULL,
        media_count INTEGER NOT NULL,
        backup_generation_id TEXT NOT NULL,
        trashed_at TEXT NOT NULL,
        purged_at TEXT NOT NULL,
        purged_by_user_id TEXT NOT NULL,
        purged_by_label TEXT NOT NULL
      );

      CREATE INDEX workspace_purge_tombstones_purged_idx
        ON workspace_purge_tombstones(purged_at DESC);
    `,
  },
  {
    id: "0022_document_tasks",
    safety: "schema",
    sql: `
      CREATE TABLE document_tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ready'
          CHECK (status IN ('ready', 'in_progress', 'blocked', 'review', 'completed', 'cancelled')),
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        target_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
        assigned_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
        requires_review INTEGER NOT NULL DEFAULT 1 CHECK (requires_review IN (0, 1)),
        blocker TEXT,
        result_summary TEXT,
        result_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
        result_revision_id TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,
        created_by_type TEXT NOT NULL CHECK (created_by_type IN ('human', 'agent')),
        created_by_user_id TEXT,
        created_by_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
        created_by_label TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        CHECK (
          (created_by_type = 'human' AND created_by_user_id IS NOT NULL)
          OR (created_by_type = 'agent' AND created_by_agent_id IS NOT NULL)
        ),
        CHECK (
          (result_document_id IS NULL AND result_revision_id IS NULL)
          OR result_document_id IS NOT NULL
        )
      );

      CREATE INDEX document_tasks_workspace_status_idx
        ON document_tasks(workspace_id, status, priority, updated_at DESC);
      CREATE INDEX document_tasks_agent_status_idx
        ON document_tasks(workspace_id, assigned_agent_id, status, updated_at DESC);
      CREATE INDEX document_tasks_target_idx
        ON document_tasks(workspace_id, target_document_id, status);

      CREATE TABLE document_task_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES document_tasks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'created', 'updated', 'claimed', 'progress', 'blocked',
          'submitted', 'completed', 'reopened', 'cancelled'
        )),
        from_status TEXT CHECK (
          from_status IS NULL OR from_status IN (
            'ready', 'in_progress', 'blocked', 'review', 'completed', 'cancelled'
          )
        ),
        to_status TEXT CHECK (
          to_status IS NULL OR to_status IN (
            'ready', 'in_progress', 'blocked', 'review', 'completed', 'cancelled'
          )
        ),
        message TEXT,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
        actor_user_id TEXT,
        actor_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
        actor_label TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX document_task_events_task_cursor_idx
        ON document_task_events(task_id, cursor DESC);
      CREATE INDEX document_task_events_workspace_cursor_idx
        ON document_task_events(workspace_id, cursor DESC);

      CREATE TRIGGER document_tasks_workspace_insert
      BEFORE INSERT ON document_tasks
      WHEN (NEW.target_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.target_document_id
          AND document.workspace_id = NEW.workspace_id
      )) OR (NEW.result_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.result_document_id
          AND document.workspace_id = NEW.workspace_id
      )) OR (NEW.assigned_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.assigned_agent_id
          AND agent.workspace_id = NEW.workspace_id
      )) OR (NEW.created_by_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.created_by_agent_id
          AND agent.workspace_id = NEW.workspace_id
      )) OR (NEW.result_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM document_revisions revision
        WHERE revision.id = NEW.result_revision_id
          AND revision.document_id = NEW.result_document_id
      ))
      BEGIN SELECT RAISE(ABORT, 'document task references must belong to the same workspace'); END;

      CREATE TRIGGER document_tasks_workspace_update
      BEFORE UPDATE OF workspace_id, target_document_id, result_document_id,
        assigned_agent_id, created_by_agent_id, result_revision_id ON document_tasks
      WHEN (NEW.target_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.target_document_id
          AND document.workspace_id = NEW.workspace_id
      )) OR (NEW.result_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.result_document_id
          AND document.workspace_id = NEW.workspace_id
      )) OR (NEW.assigned_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.assigned_agent_id
          AND agent.workspace_id = NEW.workspace_id
      )) OR (NEW.created_by_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.created_by_agent_id
          AND agent.workspace_id = NEW.workspace_id
      )) OR (NEW.result_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM document_revisions revision
        WHERE revision.id = NEW.result_revision_id
          AND revision.document_id = NEW.result_document_id
      ))
      BEGIN SELECT RAISE(ABORT, 'document task references must belong to the same workspace'); END;

      CREATE TRIGGER document_task_events_workspace_insert
      BEFORE INSERT ON document_task_events
      WHEN NOT EXISTS (
        SELECT 1 FROM document_tasks task
        WHERE task.id = NEW.task_id
          AND task.workspace_id = NEW.workspace_id
      ) OR (NEW.actor_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_agents agent
        WHERE agent.id = NEW.actor_agent_id
          AND agent.workspace_id = NEW.workspace_id
      ))
      BEGIN SELECT RAISE(ABORT, 'document task event must belong to the task workspace'); END;
    `,
  },
  {
    id: "0023_document_public_shares",
    safety: "schema",
    sql: `
      CREATE TABLE document_public_shares (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
        public_token TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_by_label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disabled_at TEXT
      );

      CREATE INDEX document_public_shares_token_idx
        ON document_public_shares(public_token, enabled);

      CREATE TRIGGER document_public_shares_workspace_insert
      BEFORE INSERT ON document_public_shares
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'public share document must belong to the same workspace'); END;

      CREATE TRIGGER document_public_shares_workspace_update
      BEFORE UPDATE OF workspace_id, document_id ON document_public_shares
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'public share document must belong to the same workspace'); END;
    `,
  },
  {
    id: "0024_document_human_grants",
    safety: "schema",
    sql: `
      CREATE TABLE document_human_grants (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_by_label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (document_id, user_id)
      );

      CREATE INDEX document_human_grants_user_workspace_idx
        ON document_human_grants(user_id, workspace_id, updated_at DESC);
      CREATE INDEX document_human_grants_workspace_document_idx
        ON document_human_grants(workspace_id, document_id, role);

      CREATE TABLE document_media_bindings (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (document_id, media_id)
      );

      CREATE INDEX document_media_bindings_media_idx
        ON document_media_bindings(workspace_id, media_id, document_id);

      CREATE TRIGGER document_human_grants_workspace_insert
      BEFORE INSERT ON document_human_grants
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'human grant document must belong to the same workspace'); END;

      CREATE TRIGGER document_human_grants_workspace_update
      BEFORE UPDATE OF workspace_id, document_id ON document_human_grants
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'human grant document must belong to the same workspace'); END;

      CREATE TRIGGER document_media_bindings_workspace_insert
      BEFORE INSERT ON document_media_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      ) OR NOT EXISTS (
        SELECT 1 FROM media_assets media
        WHERE media.id = NEW.media_id
          AND media.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'document media binding must belong to the same workspace'); END;

      CREATE TRIGGER document_media_bindings_workspace_update
      BEFORE UPDATE OF workspace_id, document_id, media_id ON document_media_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      ) OR NOT EXISTS (
        SELECT 1 FROM media_assets media
        WHERE media.id = NEW.media_id
          AND media.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'document media binding must belong to the same workspace'); END;
    `,
  },
  {
    id: "0025_task_attachments",
    safety: "schema",
    sql: `
      CREATE TABLE document_task_attachments (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES document_tasks(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
        field TEXT NOT NULL CHECK (field IN ('description', 'acceptance_criteria')),
        position INTEGER NOT NULL CHECK (position >= 0),
        created_at TEXT NOT NULL,
        UNIQUE (task_id, field, media_id)
      );

      CREATE INDEX document_task_attachments_task_idx
        ON document_task_attachments(task_id, field, position);
      CREATE INDEX document_task_attachments_media_idx
        ON document_task_attachments(workspace_id, media_id, task_id);

      CREATE TRIGGER document_task_attachments_workspace_insert
      BEFORE INSERT ON document_task_attachments
      WHEN NOT EXISTS (
        SELECT 1 FROM document_tasks task
        WHERE task.id = NEW.task_id
          AND task.workspace_id = NEW.workspace_id
      ) OR NOT EXISTS (
        SELECT 1 FROM media_assets media
        WHERE media.id = NEW.media_id
          AND media.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'task attachment must belong to the same workspace'); END;

      CREATE TRIGGER document_task_attachments_workspace_update
      BEFORE UPDATE OF workspace_id, task_id, media_id ON document_task_attachments
      WHEN NOT EXISTS (
        SELECT 1 FROM document_tasks task
        WHERE task.id = NEW.task_id
          AND task.workspace_id = NEW.workspace_id
      ) OR NOT EXISTS (
        SELECT 1 FROM media_assets media
        WHERE media.id = NEW.media_id
          AND media.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'task attachment must belong to the same workspace'); END;
    `,
  },
  {
    id: "0026_site_administration",
    safety: "schema",
    sql: `
      CREATE TABLE site_administrators (
        user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
        granted_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );

      INSERT INTO site_administrators (user_id, granted_by_user_id, created_at)
      SELECT id, id, datetime('now')
      FROM user
      WHERE emailVerified = 1
      ORDER BY createdAt ASC, id ASC
      LIMIT 1;

      CREATE TABLE site_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        public_base_url TEXT NOT NULL,
        email_verification_enabled INTEGER NOT NULL
          CHECK (email_verification_enabled IN (0, 1)),
        email_domain_policy TEXT NOT NULL
          CHECK (email_domain_policy IN ('restricted', 'any')),
        allowed_email_domains_json TEXT NOT NULL DEFAULT '[]',
        smtp_host TEXT,
        smtp_port INTEGER CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
        smtp_secure INTEGER NOT NULL DEFAULT 0 CHECK (smtp_secure IN (0, 1)),
        smtp_user TEXT,
        email_from TEXT,
        updated_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
      );

      CREATE TABLE site_audit_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL,
        actor_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        actor_label TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX site_audit_events_created_idx
        ON site_audit_events(created_at DESC, cursor DESC);
    `,
  },
  {
    id: "0027_site_owner_role",
    safety: "transform",
    sql: `
      ALTER TABLE site_administrators
        ADD COLUMN role TEXT NOT NULL DEFAULT 'administrator'
        CHECK (role IN ('owner', 'administrator'));

      UPDATE site_administrators
      SET role = 'owner'
      WHERE user_id = (
        SELECT user_id
        FROM site_administrators
        ORDER BY created_at ASC, user_id ASC
        LIMIT 1
      );

      CREATE UNIQUE INDEX site_administrators_single_owner_idx
        ON site_administrators(role)
        WHERE role = 'owner';
    `,
  },
  {
    id: "0028_open_source_onboarding_and_i18n",
    safety: "schema",
    sql: `
      ALTER TABLE user
        ADD COLUMN locale TEXT
        CHECK (locale IS NULL OR locale IN ('en', 'ko', 'ja'));

      ALTER TABLE site_settings
        ADD COLUMN registration_mode TEXT NOT NULL DEFAULT 'invite'
        CHECK (registration_mode IN ('invite', 'open'));

      CREATE TABLE site_invites (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_by_label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        used_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        revoked_at TEXT
      );

      CREATE INDEX site_invites_email_idx
        ON site_invites(email, created_at DESC);
      CREATE INDEX site_invites_status_idx
        ON site_invites(used_at, revoked_at, expires_at);
    `,
  },
  {
    id: "0029_preserve_existing_registration_policy",
    safety: "transform",
    sql: `
      UPDATE site_settings
      SET registration_mode = 'open'
      WHERE id = 1;
    `,
  },
  {
    id: "0030_first_owner_setup_lock",
    safety: "schema",
    sql: `
      CREATE TABLE site_setup_claims (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `,
  },
  {
    id: "0031_organizations_teams_and_namespaces",
    safety: "transform",
    sql: `
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        icon TEXT,
        lifecycle_state TEXT NOT NULL DEFAULT 'active'
          CHECK (lifecycle_state IN ('active', 'trashed')),
        trash_retention_days INTEGER NOT NULL DEFAULT 30
          CHECK (trash_retention_days BETWEEN 1 AND 3650),
        trashed_at TEXT,
        purge_after TEXT,
        trashed_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        trashed_by_label TEXT,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX organizations_lifecycle_idx
        ON organizations(lifecycle_state, purge_after, updated_at DESC);

      CREATE TABLE organization_members (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, user_id)
      );

      CREATE INDEX organization_members_user_idx
        ON organization_members(user_id, organization_id);
      CREATE INDEX organization_members_organization_idx
        ON organization_members(organization_id, role, created_at);

      CREATE TABLE organization_invitations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        email TEXT,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_by_label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        accepted_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        revoked_at TEXT
      );

      CREATE INDEX organization_invitations_organization_idx
        ON organization_invitations(organization_id, created_at DESC);
      CREATE INDEX organization_invitations_email_idx
        ON organization_invitations(email, created_at DESC);
      CREATE INDEX organization_invitations_status_idx
        ON organization_invitations(accepted_at, revoked_at, expires_at);

      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, slug)
      );

      CREATE INDEX teams_organization_idx
        ON teams(organization_id, name, created_at);

      CREATE TABLE team_members (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        added_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        UNIQUE (team_id, user_id)
      );

      CREATE INDEX team_members_user_idx
        ON team_members(user_id, organization_id, team_id);

      CREATE TABLE workspace_ownership (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
        owner_user_id TEXT REFERENCES user(id) ON DELETE RESTRICT,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (owner_type = 'personal' AND owner_user_id IS NOT NULL AND organization_id IS NULL)
          OR
          (owner_type = 'organization' AND owner_user_id IS NULL AND organization_id IS NOT NULL)
        )
      );

      INSERT INTO workspace_ownership
        (workspace_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
      SELECT id, 'personal', created_by_user_id, NULL, created_at, updated_at
      FROM workspaces;

      CREATE INDEX workspace_ownership_user_idx
        ON workspace_ownership(owner_user_id, workspace_id)
        WHERE owner_type = 'personal';
      CREATE INDEX workspace_ownership_organization_idx
        ON workspace_ownership(organization_id, workspace_id)
        WHERE owner_type = 'organization';

      CREATE TABLE workspace_team_grants (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        access_role TEXT NOT NULL CHECK (access_role IN ('admin', 'editor', 'viewer')),
        granted_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, team_id)
      );

      CREATE INDEX workspace_team_grants_team_idx
        ON workspace_team_grants(team_id, workspace_id, access_role);
      CREATE INDEX workspace_team_grants_workspace_idx
        ON workspace_team_grants(workspace_id, access_role, team_id);

      CREATE TABLE agent_ownership (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
        owner_user_id TEXT REFERENCES user(id) ON DELETE RESTRICT,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (owner_type = 'personal' AND owner_user_id IS NOT NULL AND organization_id IS NULL)
          OR
          (owner_type = 'organization' AND owner_user_id IS NULL AND organization_id IS NOT NULL)
        )
      );

      INSERT INTO agent_ownership
        (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
      SELECT id, 'personal', owner_user_id, NULL, created_at, updated_at
      FROM agents;

      CREATE INDEX agent_ownership_user_idx
        ON agent_ownership(owner_user_id, agent_id)
        WHERE owner_type = 'personal';
      CREATE INDEX agent_ownership_organization_idx
        ON agent_ownership(organization_id, agent_id)
        WHERE owner_type = 'organization';

      CREATE TABLE organization_agent_approvals (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        approved_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
        approved_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE (organization_id, agent_id)
      );

      CREATE INDEX organization_agent_approvals_agent_idx
        ON organization_agent_approvals(agent_id, organization_id, revoked_at);

      CREATE TABLE organization_audit_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'human')),
        actor_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        actor_label TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX organization_audit_events_organization_idx
        ON organization_audit_events(organization_id, cursor DESC);

      CREATE TRIGGER team_member_organization_insert
      BEFORE INSERT ON team_members
      WHEN NOT EXISTS (
        SELECT 1 FROM teams team
        WHERE team.id = NEW.team_id
          AND team.organization_id = NEW.organization_id
      ) OR NOT EXISTS (
        SELECT 1 FROM organization_members member
        WHERE member.organization_id = NEW.organization_id
          AND member.user_id = NEW.user_id
      )
      BEGIN SELECT RAISE(ABORT, 'team member must belong to the same organization'); END;

      CREATE TRIGGER team_member_organization_update
      BEFORE UPDATE OF organization_id, team_id, user_id ON team_members
      WHEN NOT EXISTS (
        SELECT 1 FROM teams team
        WHERE team.id = NEW.team_id
          AND team.organization_id = NEW.organization_id
      ) OR NOT EXISTS (
        SELECT 1 FROM organization_members member
        WHERE member.organization_id = NEW.organization_id
          AND member.user_id = NEW.user_id
      )
      BEGIN SELECT RAISE(ABORT, 'team member must belong to the same organization'); END;

      CREATE TRIGGER workspace_team_grant_boundary_insert
      BEFORE INSERT ON workspace_team_grants
      WHEN NOT EXISTS (
        SELECT 1 FROM workspace_ownership ownership
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
          AND ownership.organization_id = NEW.organization_id
      ) OR NOT EXISTS (
        SELECT 1 FROM teams team
        WHERE team.id = NEW.team_id
          AND team.organization_id = NEW.organization_id
      )
      BEGIN SELECT RAISE(ABORT, 'team grant must remain inside one organization'); END;

      CREATE TRIGGER workspace_team_grant_boundary_update
      BEFORE UPDATE OF organization_id, workspace_id, team_id ON workspace_team_grants
      WHEN NOT EXISTS (
        SELECT 1 FROM workspace_ownership ownership
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
          AND ownership.organization_id = NEW.organization_id
      ) OR NOT EXISTS (
        SELECT 1 FROM teams team
        WHERE team.id = NEW.team_id
          AND team.organization_id = NEW.organization_id
      )
      BEGIN SELECT RAISE(ABORT, 'team grant must remain inside one organization'); END;
    `,
  },
  {
    id: "0032_organization_boundary_guards",
    safety: "schema",
    sql: `
      CREATE TRIGGER workspace_member_organization_insert
      BEFORE INSERT ON workspace_members
      WHEN EXISTS (
        SELECT 1 FROM workspace_ownership ownership
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
      ) AND NOT EXISTS (
        SELECT 1
        FROM workspace_ownership ownership
        JOIN organization_members member
          ON member.organization_id = ownership.organization_id
         AND member.user_id = NEW.user_id
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
      )
      BEGIN SELECT RAISE(ABORT, 'workspace member must belong to the owning organization'); END;

      CREATE TRIGGER workspace_member_organization_update
      BEFORE UPDATE OF workspace_id, user_id ON workspace_members
      WHEN EXISTS (
        SELECT 1 FROM workspace_ownership ownership
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
      ) AND NOT EXISTS (
        SELECT 1
        FROM workspace_ownership ownership
        JOIN organization_members member
          ON member.organization_id = ownership.organization_id
         AND member.user_id = NEW.user_id
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
      )
      BEGIN SELECT RAISE(ABORT, 'workspace member must belong to the owning organization'); END;

      CREATE TRIGGER workspace_ownership_organization_insert
      BEFORE INSERT ON workspace_ownership
      WHEN NEW.owner_type = 'organization' AND (
        EXISTS (
          SELECT 1 FROM workspace_members workspace_member
          WHERE workspace_member.workspace_id = NEW.workspace_id
            AND NOT EXISTS (
              SELECT 1 FROM organization_members organization_member
              WHERE organization_member.organization_id = NEW.organization_id
                AND organization_member.user_id = workspace_member.user_id
            )
        )
        OR EXISTS (
          SELECT 1 FROM document_human_grants document_grant
          WHERE document_grant.workspace_id = NEW.workspace_id
            AND NOT EXISTS (
              SELECT 1 FROM organization_members organization_member
              WHERE organization_member.organization_id = NEW.organization_id
                AND organization_member.user_id = document_grant.user_id
            )
        )
      )
      BEGIN SELECT RAISE(ABORT, 'organization workspace access must belong to the organization'); END;

      CREATE TRIGGER workspace_ownership_organization_update
      BEFORE UPDATE OF owner_type, organization_id ON workspace_ownership
      WHEN NEW.owner_type = 'organization' AND (
        EXISTS (
          SELECT 1 FROM workspace_members workspace_member
          WHERE workspace_member.workspace_id = NEW.workspace_id
            AND NOT EXISTS (
              SELECT 1 FROM organization_members organization_member
              WHERE organization_member.organization_id = NEW.organization_id
                AND organization_member.user_id = workspace_member.user_id
            )
        )
        OR EXISTS (
          SELECT 1 FROM document_human_grants document_grant
          WHERE document_grant.workspace_id = NEW.workspace_id
            AND NOT EXISTS (
              SELECT 1 FROM organization_members organization_member
              WHERE organization_member.organization_id = NEW.organization_id
                AND organization_member.user_id = document_grant.user_id
            )
        )
      )
      BEGIN SELECT RAISE(ABORT, 'organization workspace access must belong to the organization'); END;

      CREATE TRIGGER document_human_grant_organization_insert
      BEFORE INSERT ON document_human_grants
      WHEN EXISTS (
        SELECT 1 FROM workspace_ownership ownership
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
      ) AND NOT EXISTS (
        SELECT 1
        FROM workspace_ownership ownership
        JOIN organization_members organization_member
          ON organization_member.organization_id = ownership.organization_id
         AND organization_member.user_id = NEW.user_id
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
      )
      BEGIN SELECT RAISE(ABORT, 'document recipient must belong to the owning organization'); END;

      CREATE TRIGGER document_human_grant_organization_update
      BEFORE UPDATE OF workspace_id, user_id ON document_human_grants
      WHEN EXISTS (
        SELECT 1 FROM workspace_ownership ownership
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
      ) AND NOT EXISTS (
        SELECT 1
        FROM workspace_ownership ownership
        JOIN organization_members organization_member
          ON organization_member.organization_id = ownership.organization_id
         AND organization_member.user_id = NEW.user_id
        WHERE ownership.workspace_id = NEW.workspace_id
          AND ownership.owner_type = 'organization'
      )
      BEGIN SELECT RAISE(ABORT, 'document recipient must belong to the owning organization'); END;

      CREATE TRIGGER organization_agent_approval_insert
      BEFORE INSERT ON organization_agent_approvals
      WHEN NOT EXISTS (
        SELECT 1
        FROM agent_ownership ownership
        JOIN organization_members member
          ON member.organization_id = NEW.organization_id
         AND member.user_id = ownership.owner_user_id
        WHERE ownership.agent_id = NEW.agent_id
          AND ownership.owner_type = 'personal'
      )
      BEGIN SELECT RAISE(ABORT, 'only an organization member personal agent can be approved'); END;

      CREATE TRIGGER organization_agent_approval_update
      BEFORE UPDATE OF organization_id, agent_id ON organization_agent_approvals
      WHEN NOT EXISTS (
        SELECT 1
        FROM agent_ownership ownership
        JOIN organization_members member
          ON member.organization_id = NEW.organization_id
         AND member.user_id = ownership.owner_user_id
        WHERE ownership.agent_id = NEW.agent_id
          AND ownership.owner_type = 'personal'
      )
      BEGIN SELECT RAISE(ABORT, 'only an organization member personal agent can be approved'); END;

      CREATE TRIGGER workspace_agent_namespace_insert
      BEFORE INSERT ON workspace_agents
      WHEN NOT EXISTS (
        SELECT 1
        FROM workspace_ownership workspace_owner
        JOIN agent_ownership agent_owner ON agent_owner.agent_id = NEW.agent_identity_id
        WHERE workspace_owner.workspace_id = NEW.workspace_id
          AND (
            (workspace_owner.owner_type = 'personal'
             AND agent_owner.owner_type = 'personal'
             AND workspace_owner.owner_user_id = agent_owner.owner_user_id)
            OR
            (workspace_owner.owner_type = 'organization'
             AND (
               (agent_owner.owner_type = 'organization'
                AND agent_owner.organization_id = workspace_owner.organization_id)
               OR
               (agent_owner.owner_type = 'personal' AND EXISTS (
                 SELECT 1 FROM organization_agent_approvals approval
                 WHERE approval.organization_id = workspace_owner.organization_id
                   AND approval.agent_id = agent_owner.agent_id
                   AND approval.revoked_at IS NULL
               ))
             ))
          )
      )
      BEGIN SELECT RAISE(ABORT, 'agent assignment must remain inside an approved namespace'); END;

      CREATE TRIGGER workspace_agent_namespace_update
      BEFORE UPDATE OF workspace_id, agent_identity_id ON workspace_agents
      WHEN NOT EXISTS (
        SELECT 1
        FROM workspace_ownership workspace_owner
        JOIN agent_ownership agent_owner ON agent_owner.agent_id = NEW.agent_identity_id
        WHERE workspace_owner.workspace_id = NEW.workspace_id
          AND (
            (workspace_owner.owner_type = 'personal'
             AND agent_owner.owner_type = 'personal'
             AND workspace_owner.owner_user_id = agent_owner.owner_user_id)
            OR
            (workspace_owner.owner_type = 'organization'
             AND (
               (agent_owner.owner_type = 'organization'
                AND agent_owner.organization_id = workspace_owner.organization_id)
               OR
               (agent_owner.owner_type = 'personal' AND EXISTS (
                 SELECT 1 FROM organization_agent_approvals approval
                 WHERE approval.organization_id = workspace_owner.organization_id
                   AND approval.agent_id = agent_owner.agent_id
                   AND approval.revoked_at IS NULL
               ))
             ))
          )
      )
      BEGIN SELECT RAISE(ABORT, 'agent assignment must remain inside an approved namespace'); END;
    `,
  },
  {
    id: "0033_agent_media_upload_tickets",
    safety: "schema",
    sql: `
      CREATE TABLE agent_media_upload_tickets (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES agent_credentials(id) ON DELETE CASCADE,
        workspace_agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        original_filename TEXT NOT NULL,
        expected_mime_type TEXT CHECK (
          expected_mime_type IS NULL OR expected_mime_type IN (
            'image/png', 'image/jpeg', 'image/gif', 'image/webp'
          )
        ),
        expected_byte_size INTEGER CHECK (
          expected_byte_size IS NULL
          OR (expected_byte_size > 0 AND expected_byte_size <= 15728640)
        ),
        expected_sha256 TEXT CHECK (
          expected_sha256 IS NULL
          OR (length(expected_sha256) = 64 AND expected_sha256 = lower(expected_sha256))
        ),
        alt_text TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL
      );

      CREATE INDEX agent_media_upload_tickets_expiry_idx
        ON agent_media_upload_tickets(expires_at, consumed_at);
      CREATE INDEX agent_media_upload_tickets_credential_idx
        ON agent_media_upload_tickets(credential_id, created_at DESC);

      CREATE TRIGGER agent_media_upload_ticket_boundary_insert
      BEFORE INSERT ON agent_media_upload_tickets
      WHEN NOT EXISTS (
        SELECT 1
        FROM workspace_agents membership
        JOIN agent_credentials credential
          ON credential.agent_id = membership.agent_identity_id
        WHERE membership.id = NEW.workspace_agent_id
          AND membership.workspace_id = NEW.workspace_id
          AND credential.id = NEW.credential_id
      ) OR (
        NEW.document_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM documents document
          WHERE document.id = NEW.document_id
            AND document.workspace_id = NEW.workspace_id
        )
      )
      BEGIN SELECT RAISE(ABORT, 'media upload ticket must remain inside its agent workspace and document'); END;

      CREATE TRIGGER agent_media_upload_ticket_boundary_update
      BEFORE UPDATE OF credential_id, workspace_agent_id, workspace_id, document_id
      ON agent_media_upload_tickets
      WHEN NOT EXISTS (
        SELECT 1
        FROM workspace_agents membership
        JOIN agent_credentials credential
          ON credential.agent_id = membership.agent_identity_id
        WHERE membership.id = NEW.workspace_agent_id
          AND membership.workspace_id = NEW.workspace_id
          AND credential.id = NEW.credential_id
      ) OR (
        NEW.document_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM documents document
          WHERE document.id = NEW.document_id
            AND document.workspace_id = NEW.workspace_id
        )
      )
      BEGIN SELECT RAISE(ABORT, 'media upload ticket must remain inside its agent workspace and document'); END;
    `,
  },
  {
    id: "0034_editor_caret_incidents",
    safety: "schema",
    sql: `
      CREATE TABLE editor_caret_incidents (
        id TEXT PRIMARY KEY,
        incident_code TEXT NOT NULL UNIQUE,
        client_incident_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'automatic')),
        reason TEXT NOT NULL CHECK (reason IN (
          'manual',
          'editor_remounted',
          'jumped_to_document_start',
          'table_cell_changed',
          'table_selection_escaped',
          'unexpected_block_jump'
        )),
        mount_count INTEGER NOT NULL CHECK (mount_count > 0),
        environment_json TEXT NOT NULL CHECK (
          json_valid(environment_json) AND length(environment_json) <= 4096
        ),
        trace_json TEXT NOT NULL CHECK (
          json_valid(trace_json) AND length(trace_json) <= 131072
        ),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (user_id, client_incident_id)
      );

      CREATE INDEX editor_caret_incidents_document_idx
        ON editor_caret_incidents(workspace_id, document_id, created_at DESC);
      CREATE INDEX editor_caret_incidents_expiry_idx
        ON editor_caret_incidents(expires_at);

      CREATE TRIGGER editor_caret_incident_boundary_insert
      BEFORE INSERT ON editor_caret_incidents
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'caret incident must remain inside its document workspace'); END;

      CREATE TRIGGER editor_caret_incident_boundary_update
      BEFORE UPDATE OF workspace_id, document_id ON editor_caret_incidents
      WHEN NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'caret incident must remain inside its document workspace'); END;
    `,
  },
  {
    id: "0035_mcp_oauth_grants",
    safety: "schema",
    sql: `
      CREATE TABLE mcp_oauth_grants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL REFERENCES agent_credentials(id) ON DELETE CASCADE,
        scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        UNIQUE (user_id, client_id),
        UNIQUE (credential_id)
      );

      CREATE INDEX mcp_oauth_grants_agent_idx
        ON mcp_oauth_grants(agent_id, status, updated_at DESC);
      CREATE INDEX mcp_oauth_grants_client_idx
        ON mcp_oauth_grants(client_id, status, updated_at DESC);
    `,
  },
  {
    id: "0036_app_bug_reports",
    safety: "schema",
    sql: `
      CREATE TABLE app_bug_reports (
        id TEXT PRIMARY KEY,
        report_code TEXT NOT NULL UNIQUE,
        client_report_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
        reporter_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'automatic')),
        category TEXT NOT NULL CHECK (category IN (
          'editor_caret',
          'save_sync',
          'navigation_tree',
          'permissions_sharing',
          'performance',
          'other'
        )),
        category_source TEXT NOT NULL CHECK (category_source IN (
          'suggested',
          'user_override',
          'detector'
        )),
        detector TEXT CHECK (detector IS NULL OR detector IN (
          'editor_remounted',
          'jumped_to_document_start',
          'table_cell_changed',
          'table_selection_escaped',
          'unexpected_block_jump'
        )),
        reason_code TEXT NOT NULL CHECK (reason_code IN (
          'manual_report',
          'editor_remounted',
          'jumped_to_document_start',
          'table_cell_changed',
          'table_selection_escaped',
          'unexpected_block_jump'
        )),
        captured_at TEXT NOT NULL,
        description TEXT CHECK (
          description IS NULL OR length(description) <= 1000
        ),
        app_version TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        fingerprint TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (
          json_valid(payload_json) AND length(payload_json) <= 262144
        ),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (reporter_user_id, workspace_id, client_report_id)
      );

      CREATE INDEX app_bug_reports_workspace_idx
        ON app_bug_reports(workspace_id, created_at DESC);
      CREATE INDEX app_bug_reports_document_idx
        ON app_bug_reports(document_id, created_at DESC);
      CREATE INDEX app_bug_reports_category_idx
        ON app_bug_reports(category, created_at DESC);
      CREATE INDEX app_bug_reports_fingerprint_idx
        ON app_bug_reports(fingerprint, last_seen_at DESC);
      CREATE INDEX app_bug_reports_expiry_idx
        ON app_bug_reports(expires_at);

      CREATE TRIGGER app_bug_report_boundary_insert
      BEFORE INSERT ON app_bug_reports
      WHEN NEW.document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'bug report document must remain inside its workspace'); END;

      CREATE TRIGGER app_bug_report_boundary_update
      BEFORE UPDATE OF workspace_id, document_id ON app_bug_reports
      WHEN NEW.document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'bug report document must remain inside its workspace'); END;
    `,
  },
  {
    id: "0037_user_workspace_navigation_preferences",
    safety: "schema",
    sql: `
      CREATE TABLE user_workspace_navigation_preferences (
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        expanded_document_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (
            json_valid(expanded_document_ids_json)
            AND json_type(expanded_document_ids_json) = 'array'
            AND length(expanded_document_ids_json) <= 131072
          ),
        last_active_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, workspace_id)
      );

      CREATE INDEX user_workspace_navigation_preferences_workspace_idx
        ON user_workspace_navigation_preferences(workspace_id, updated_at DESC);

      CREATE TRIGGER user_workspace_navigation_active_document_insert
      BEFORE INSERT ON user_workspace_navigation_preferences
      WHEN NEW.last_active_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.last_active_document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'navigation active document must remain inside its workspace'); END;

      CREATE TRIGGER user_workspace_navigation_active_document_update
      BEFORE UPDATE OF workspace_id, last_active_document_id
      ON user_workspace_navigation_preferences
      WHEN NEW.last_active_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.last_active_document_id
          AND document.workspace_id = NEW.workspace_id
      )
      BEGIN SELECT RAISE(ABORT, 'navigation active document must remain inside its workspace'); END;
    `,
  },
  {
    id: "0038_navigation_preference_versions",
    safety: "schema",
    sql: `
      ALTER TABLE user_workspace_navigation_preferences
        ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
    `,
  },
  {
    id: "0039_agent_access_grants_and_bindings",
    safety: "transform",
    sql: `
      CREATE TEMP TABLE _nyxdoc_0039_invalid_credential_allowlists (
        credential_id TEXT NOT NULL
      );
      CREATE TEMP TRIGGER _nyxdoc_0039_fail_invalid_credential_allowlist
      BEFORE INSERT ON _nyxdoc_0039_invalid_credential_allowlists
      BEGIN
        SELECT RAISE(
          ABORT,
          '0039 invalid workspace_allowlist_json for active credential ' || NEW.credential_id
        );
      END;
      INSERT INTO _nyxdoc_0039_invalid_credential_allowlists (credential_id)
      SELECT credential.id
      FROM agent_credentials credential
      WHERE credential.revoked_at IS NULL
        AND CASE
          WHEN json_valid(credential.workspace_allowlist_json)
            THEN json_type(credential.workspace_allowlist_json) <> 'array'
          ELSE 1
        END;
      DROP TRIGGER _nyxdoc_0039_fail_invalid_credential_allowlist;
      DROP TABLE _nyxdoc_0039_invalid_credential_allowlists;

      ALTER TABLE workspace_agents
        ADD COLUMN access_profile TEXT NOT NULL DEFAULT 'custom'
        CHECK (access_profile IN ('reader', 'drafter', 'writer', 'custom'));
      ALTER TABLE workspace_agents
        ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'array');
      ALTER TABLE workspace_agents
        ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'workspace'
        CHECK (scope_mode IN ('workspace', 'document_tree'));
      ALTER TABLE workspace_agents
        ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0);
      ALTER TABLE workspace_agents ADD COLUMN revoked_at TEXT;

      UPDATE workspace_agents AS membership
      SET access_profile = CASE
            WHEN json_array_length(membership.permission_allow_json) > 0
              OR json_array_length(membership.permission_deny_json) > 0
              THEN 'custom'
            WHEN membership.role = 'viewer' THEN 'reader'
            -- Legacy editors could restore revisions. The fixed writer profile cannot,
            -- so preserving the effective legacy grant requires a custom profile.
            WHEN membership.role = 'editor' THEN 'custom'
            ELSE 'custom'
          END,
          scope_mode = CASE
            WHEN membership.root_document_id IS NULL THEN 'workspace'
            ELSE 'document_tree'
          END,
          capabilities_json = (
            SELECT COALESCE(json_group_array(permission), '[]')
            FROM (
              SELECT value AS permission
              FROM json_each(CASE membership.role
                WHEN 'viewer' THEN '["workspace.read","agents.read","documents.read","revisions.read","changes.read","saved_views.read","assignments.read","tasks.read","exports.create"]'
                WHEN 'editor' THEN '["workspace.read","agents.read","documents.read","documents.create","documents.update","documents.commit","documents.trash_own","revisions.read","revisions.restore","changes.read","media.upload","saved_views.read","saved_views.manage","assignments.read","tasks.read","tasks.create","tasks.update","exports.create"]'
                ELSE '["workspace.read","agents.read","documents.read","documents.create","documents.update","documents.commit","documents.trash_own","revisions.read","revisions.restore","changes.read","media.upload","saved_views.read","saved_views.manage","assignments.read","tasks.read","tasks.create","tasks.update","exports.create","members.read","credentials.read","documents.trash","documents.restore","assignments.manage","tasks.manage","admin_requests.read","admin_requests.create","audit.read"]'
              END)
              UNION
              SELECT value FROM json_each(membership.permission_allow_json)
              EXCEPT
              SELECT value FROM json_each(membership.permission_deny_json)
              ORDER BY permission
            )
          );

      DROP INDEX workspace_agents_identity_idx;
      CREATE UNIQUE INDEX workspace_agents_active_identity_idx
        ON workspace_agents(workspace_id, agent_identity_id)
        WHERE revoked_at IS NULL;
      CREATE INDEX workspace_agents_grant_lifecycle_idx
        ON workspace_agents(agent_identity_id, workspace_id, status, revoked_at);

      CREATE TABLE agent_credential_grant_bindings (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES agent_credentials(id) ON DELETE CASCADE,
        grant_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE UNIQUE INDEX agent_credential_grant_bindings_active_idx
        ON agent_credential_grant_bindings(credential_id, grant_id)
        WHERE status = 'active' AND revoked_at IS NULL;
      CREATE INDEX agent_credential_grant_bindings_grant_idx
        ON agent_credential_grant_bindings(grant_id, status, credential_id);

      INSERT INTO agent_credential_grant_bindings
        (id, credential_id, grant_id, status, created_by_user_id, created_at, revoked_at)
      SELECT
        'migrated-binding-' || credential.id || '-' || membership.id,
        credential.id,
        membership.id,
        'active',
        credential.created_by_user_id,
        credential.created_at,
        NULL
      FROM agent_credentials credential
      JOIN workspace_agents membership
        ON membership.agent_identity_id = credential.agent_id
       AND membership.status = 'active'
       AND membership.revoked_at IS NULL
      WHERE credential.revoked_at IS NULL
        AND (
          json_array_length(credential.workspace_allowlist_json) = 0
          OR membership.workspace_id IN (
            SELECT value FROM json_each(credential.workspace_allowlist_json)
          )
        );

      CREATE TEMP TABLE _nyxdoc_0039_missing_credential_bindings (
        credential_id TEXT NOT NULL,
        grant_id TEXT NOT NULL
      );
      CREATE TEMP TRIGGER _nyxdoc_0039_fail_missing_credential_binding
      BEFORE INSERT ON _nyxdoc_0039_missing_credential_bindings
      BEGIN
        SELECT RAISE(
          ABORT,
          '0039 missing migrated binding for credential ' || NEW.credential_id
            || ' and grant ' || NEW.grant_id
        );
      END;
      INSERT INTO _nyxdoc_0039_missing_credential_bindings (credential_id, grant_id)
      SELECT credential.id, membership.id
      FROM agent_credentials credential
      JOIN workspace_agents membership
        ON membership.agent_identity_id = credential.agent_id
       AND membership.status = 'active'
       AND membership.revoked_at IS NULL
      WHERE credential.revoked_at IS NULL
        AND (
          json_array_length(credential.workspace_allowlist_json) = 0
          OR membership.workspace_id IN (
            SELECT value FROM json_each(credential.workspace_allowlist_json)
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM agent_credential_grant_bindings binding
          WHERE binding.credential_id = credential.id
            AND binding.grant_id = membership.id
            AND binding.status = 'active'
            AND binding.revoked_at IS NULL
        );
      DROP TRIGGER _nyxdoc_0039_fail_missing_credential_binding;
      DROP TABLE _nyxdoc_0039_missing_credential_bindings;

      CREATE TRIGGER agent_credential_grant_binding_boundary_insert
      BEFORE INSERT ON agent_credential_grant_bindings
      WHEN NOT EXISTS (
        SELECT 1
        FROM agent_credentials credential
        JOIN workspace_agents grant_entry
          ON grant_entry.id = NEW.grant_id
         AND grant_entry.agent_identity_id = credential.agent_id
        WHERE credential.id = NEW.credential_id
      )
      BEGIN SELECT RAISE(ABORT, 'credential binding must belong to the same agent grant'); END;

      CREATE TRIGGER agent_credential_grant_binding_boundary_update
      BEFORE UPDATE OF credential_id, grant_id ON agent_credential_grant_bindings
      WHEN NOT EXISTS (
        SELECT 1
        FROM agent_credentials credential
        JOIN workspace_agents grant_entry
          ON grant_entry.id = NEW.grant_id
         AND grant_entry.agent_identity_id = credential.agent_id
        WHERE credential.id = NEW.credential_id
      )
      BEGIN SELECT RAISE(ABORT, 'credential binding must belong to the same agent grant'); END;
    `,
  },
  {
    id: "0040_media_upload_ticket_binding_guards",
    safety: "schema",
    sql: `
      DROP TRIGGER agent_media_upload_ticket_boundary_insert;
      DROP TRIGGER agent_media_upload_ticket_boundary_update;

      CREATE TRIGGER agent_media_upload_ticket_boundary_insert
      BEFORE INSERT ON agent_media_upload_tickets
      WHEN NOT EXISTS (
        SELECT 1
        FROM workspace_agents membership
        JOIN agent_credentials credential
          ON credential.agent_id = membership.agent_identity_id
         AND credential.id = NEW.credential_id
         AND credential.revoked_at IS NULL
        JOIN agent_credential_grant_bindings binding
          ON binding.credential_id = credential.id
         AND binding.grant_id = membership.id
         AND binding.status = 'active'
         AND binding.revoked_at IS NULL
        WHERE membership.id = NEW.workspace_agent_id
          AND membership.workspace_id = NEW.workspace_id
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
      ) OR (
        NEW.document_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM documents document
          WHERE document.id = NEW.document_id
            AND document.workspace_id = NEW.workspace_id
        )
      )
      BEGIN SELECT RAISE(ABORT, 'media upload ticket requires an active credential grant binding'); END;

      CREATE TRIGGER agent_media_upload_ticket_boundary_update
      BEFORE UPDATE OF credential_id, workspace_agent_id, workspace_id, document_id
      ON agent_media_upload_tickets
      WHEN NOT EXISTS (
        SELECT 1
        FROM workspace_agents membership
        JOIN agent_credentials credential
          ON credential.agent_id = membership.agent_identity_id
         AND credential.id = NEW.credential_id
         AND credential.revoked_at IS NULL
        JOIN agent_credential_grant_bindings binding
          ON binding.credential_id = credential.id
         AND binding.grant_id = membership.id
         AND binding.status = 'active'
         AND binding.revoked_at IS NULL
        WHERE membership.id = NEW.workspace_agent_id
          AND membership.workspace_id = NEW.workspace_id
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
      ) OR (
        NEW.document_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM documents document
          WHERE document.id = NEW.document_id
            AND document.workspace_id = NEW.workspace_id
        )
      )
      BEGIN SELECT RAISE(ABORT, 'media upload ticket requires an active credential grant binding'); END;

      CREATE TRIGGER agent_media_upload_ticket_binding_consume
      BEFORE UPDATE OF consumed_at ON agent_media_upload_tickets
      WHEN NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL AND NOT EXISTS (
        SELECT 1
        FROM workspace_agents membership
        JOIN agent_credentials credential
          ON credential.agent_id = membership.agent_identity_id
         AND credential.id = NEW.credential_id
         AND credential.revoked_at IS NULL
        JOIN agent_credential_grant_bindings binding
          ON binding.credential_id = credential.id
         AND binding.grant_id = membership.id
         AND binding.status = 'active'
         AND binding.revoked_at IS NULL
        WHERE membership.id = NEW.workspace_agent_id
          AND membership.workspace_id = NEW.workspace_id
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
      )
      BEGIN SELECT RAISE(ABORT, 'media upload ticket binding is no longer active'); END;
    `,
  },
  {
    id: "0041_document_tree_grants_fail_closed",
    safety: "schema",
    sql: `
      CREATE TRIGGER workspace_agent_document_tree_root_insert
      BEFORE INSERT ON workspace_agents
      WHEN NEW.scope_mode = 'document_tree'
        AND NEW.root_document_id IS NULL
        AND NEW.status = 'active'
        AND NEW.revoked_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'active document-tree grant requires a root document');
      END;

      CREATE TRIGGER workspace_agent_document_tree_root_update
      BEFORE UPDATE OF scope_mode, root_document_id, status, revoked_at ON workspace_agents
      WHEN NEW.scope_mode = 'document_tree'
        AND NEW.root_document_id IS NULL
        AND NEW.status = 'active'
        AND NEW.revoked_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'active document-tree grant requires a root document');
      END;

      CREATE TRIGGER document_tree_grant_root_delete
      BEFORE DELETE ON documents
      WHEN EXISTS (
        SELECT 1 FROM workspace_agents
        WHERE root_document_id = OLD.id
          AND scope_mode = 'document_tree'
          AND status = 'active'
          AND revoked_at IS NULL
      )
      BEGIN
        UPDATE workspace_agents
        SET status = 'disabled',
            revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            policy_version = policy_version + 1
        WHERE root_document_id = OLD.id
          AND scope_mode = 'document_tree'
          AND status = 'active'
          AND revoked_at IS NULL;
      END;
    `,
  },
];

export type AppMigrationPlan = {
  appliedIds: string[];
  pending: Array<{
    id: string;
    safety: NonNullable<AppMigration["safety"]>;
    checksumSha256: string;
  }>;
};

export type AppMigrationResult = {
  runId: string | null;
  appliedIds: string[];
  beforeFingerprint: DatabaseFingerprint | null;
  afterFingerprint: DatabaseFingerprint | null;
};

function tableExists(database: NyxDatabase, table: string) {
  return Boolean(database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table));
}

function ensureMigrationLedger(database: NyxDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _nyxdoc_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

export function appMigrationChecksum(migration: AppMigration) {
  return createHash("sha256")
    .update("nyxdoc-app-migration/v1\0")
    .update(migration.id)
    .update("\0")
    .update(migration.sql.replaceAll(/\r\n?/g, "\n"))
    .digest("hex");
}

function appliedMigrationIds(database: NyxDatabase) {
  return (database
    .prepare("SELECT id FROM _nyxdoc_migrations ORDER BY id")
    .all() as Array<{ id: string }>).map((row) => row.id);
}

function assertStoredChecksums(database: NyxDatabase, appliedIds: string[]) {
  if (!tableExists(database, "_nyxdoc_migration_checksums")) return;
  const stored = new Map((database
    .prepare("SELECT migration_id, checksum_sha256 FROM _nyxdoc_migration_checksums")
    .all() as Array<{ migration_id: string; checksum_sha256: string }>).map((row) => [
    row.migration_id,
    row.checksum_sha256,
  ]));
  const byId = new Map(APP_MIGRATIONS.map((migration) => [migration.id, migration]));
  for (const id of appliedIds) {
    const migration = byId.get(id)!;
    const checksum = stored.get(id);
    if (!checksum) throw new Error(`Applied migration ${id} has no recorded checksum.`);
    const expected = appMigrationChecksum(migration);
    if (checksum !== expected) {
      throw new Error(`Applied migration ${id} checksum changed (${checksum} != ${expected}).`);
    }
  }
}

export function getAppMigrationPlan(database: NyxDatabase): AppMigrationPlan {
  ensureMigrationLedger(database);
  const appliedIds = appliedMigrationIds(database);
  const known = new Set(APP_MIGRATIONS.map((migration) => migration.id));
  const unknown = appliedIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Database contains migration(s) unknown to this image: ${unknown.join(", ")}.`);
  }
  assertStoredChecksums(database, appliedIds);
  const applied = new Set(appliedIds);
  return {
    appliedIds,
    pending: APP_MIGRATIONS
      .filter((migration) => !applied.has(migration.id))
      .map((migration) => ({
        id: migration.id,
        safety: migration.safety ?? "schema",
        checksumSha256: appMigrationChecksum(migration),
      })),
  };
}

function countRowsIfPresent(database: NyxDatabase, table: string) {
  if (!tableExists(database, table)) return 0;
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
    count: number;
  }).count);
}

function assertMigrationPrecondition(database: NyxDatabase, migration: AppMigration) {
  if (migration.id !== "0011_canonical_ast_v2_only") return;
  const documents = countRowsIfPresent(database, "documents");
  const writeRequests = countRowsIfPresent(database, "agent_write_requests");
  if (documents > 0 || writeRequests > 0) {
    throw new Error(
      "Refusing legacy destructive reset 0011 against non-empty data "
      + `(documents=${documents}, agent_write_requests=${writeRequests}).`,
    );
  }
}

function recordChecksums(database: NyxDatabase, sourceRevision: string, now: string) {
  const applied = new Set(appliedMigrationIds(database));
  const insert = database.prepare(
    `INSERT INTO _nyxdoc_migration_checksums
     (migration_id, checksum_sha256, source_revision, recorded_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(migration_id) DO NOTHING`,
  );
  for (const migration of APP_MIGRATIONS) {
    if (!applied.has(migration.id)) continue;
    insert.run(migration.id, appMigrationChecksum(migration), sourceRevision, now);
  }
}

export function runAppMigrations(
  database: NyxDatabase,
  options: { sourceRevision?: string } = {},
): AppMigrationResult {
  const plan = getAppMigrationPlan(database);
  if (plan.pending.length === 0) {
    return {
      runId: null,
      appliedIds: [],
      beforeFingerprint: null,
      afterFingerprint: null,
    };
  }

  const sourceRevision = (options.sourceRevision?.trim() || "unknown").slice(0, 120);
  const pendingById = new Map(APP_MIGRATIONS.map((migration) => [migration.id, migration]));
  const beforeFingerprint = captureDatabaseFingerprint(database);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let afterFingerprint: DatabaseFingerprint | null = null;

  database.transaction(() => {
    const record = database.prepare(
      "INSERT INTO _nyxdoc_migrations (id, applied_at) VALUES (?, ?)",
    );
    for (const pending of plan.pending) {
      const migration = pendingById.get(pending.id)!;
      assertMigrationPrecondition(database, migration);
      database.exec(migration.sql);
      record.run(migration.id, new Date().toISOString());
    }

    const completedAt = new Date().toISOString();
    if (tableExists(database, "_nyxdoc_migration_checksums")) {
      recordChecksums(database, sourceRevision, completedAt);
    }
    afterFingerprint = captureDatabaseFingerprint(database, beforeFingerprint);
    assertDatabaseFingerprintEqual(beforeFingerprint, afterFingerprint);
    assertDatabaseIntegrity(database);

    if (tableExists(database, "_nyxdoc_migration_runs")) {
      database.prepare(
        `INSERT INTO _nyxdoc_migration_runs
         (id, source_revision, planned_ids_json, before_fingerprint_json,
          after_fingerprint_json, started_at, completed_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded')`,
      ).run(
        runId,
        sourceRevision,
        JSON.stringify(plan.pending.map((migration) => migration.id)),
        JSON.stringify(beforeFingerprint),
        JSON.stringify(afterFingerprint),
        startedAt,
        completedAt,
      );
    }
  }).exclusive();

  return {
    runId,
    appliedIds: plan.pending.map((migration) => migration.id),
    beforeFingerprint,
    afterFingerprint,
  };
}
