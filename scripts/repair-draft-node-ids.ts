import { loadEnvConfig } from "@next/env";
import { yTextToSlateElement } from "@slate-yjs/core";
import * as Y from "yjs";

loadEnvConfig(process.cwd());

type CollaborationStateRow = {
  document_id: string;
  workspace_id: string;
  generation: number;
  yjs_state: Buffer;
  committed_yjs_state: Buffer;
};

function withoutNodeIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNodeIds);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "id")
      .map(([key, child]) => [key, withoutNodeIds(child)]),
  );
}

async function main() {
  const apply = process.argv.includes("--apply");
  const [config, backup, databaseModule, drafts] = await Promise.all([
    import("../src/lib/config"),
    import("../src/lib/db/backup"),
    import("../src/lib/db/client"),
    import("../src/lib/collaboration/drafts"),
  ]);
  config.assertRuntimeConfiguration();
  const databasePath = config.getDatabasePath();

  function scan() {
    const database = databaseModule.openDatabase(databasePath);
    try {
      const rows = database.prepare(
        `SELECT document_id, workspace_id, generation, yjs_state, committed_yjs_state
         FROM document_collaboration_states
         ORDER BY workspace_id, document_id`,
      ).all() as CollaborationStateRow[];

      return rows.flatMap((row) => {
        const fields = ["yjs_state", "committed_yjs_state"] as const;
        const repaired = fields.map((field) => {
          const ydoc = drafts.collaborationYDocFromState(new Uint8Array(row[field]));
          const shared = ydoc.get("content", Y.XmlText);
          const before = yTextToSlateElement(shared);
          const metadataBefore = ydoc.getMap("metadata").toJSON();
          const repairs = drafts.repairCollaborationYDocNodeIds(ydoc);
          if (repairs.length === 0) return null;

          const after = yTextToSlateElement(shared);
          const metadataAfter = ydoc.getMap("metadata").toJSON();
          if (
            JSON.stringify(withoutNodeIds(before)) !== JSON.stringify(withoutNodeIds(after))
            || JSON.stringify(metadataBefore) !== JSON.stringify(metadataAfter)
          ) {
            throw new Error(`Node ID repair changed document content: ${row.document_id} ${field}`);
          }
          if (drafts.repairCollaborationYDocNodeIds(ydoc).length > 0) {
            throw new Error(`Node ID repair was not idempotent: ${row.document_id} ${field}`);
          }
          return {
            field,
            repairCount: repairs.length,
            missingCount: repairs.filter((repair) => repair.reason === "missing").length,
            duplicateCount: repairs.filter((repair) => repair.reason === "duplicate").length,
            repairedState: Buffer.from(Y.encodeStateAsUpdate(ydoc)),
          };
        }).filter((value) => value !== null);

        if (repaired.length === 0) return [];
        return [{ row, repaired }];
      });
    } finally {
      database.close();
    }
  }

  const candidates = scan();
  let backupGenerationId: string | null = null;
  if (apply && candidates.length > 0) {
    const generation = await backup.createBackupGeneration({
      databasePath,
      mediaRoot: config.getMediaRoot(),
      backupRoot: config.getBackupRoot(),
      sourceRevision: process.env.NYXDOC_SOURCE_REVISION?.trim() || "draft-node-id-repair",
    });
    const verified = await backup.verifyBackupGeneration(generation.generationPath);
    backupGenerationId = verified.manifest.generationId;

    const database = databaseModule.openDatabase(databasePath);
    try {
      database.transaction(() => {
        for (const candidate of candidates) {
          const current = candidate.repaired.find((item) => item.field === "yjs_state");
          const committed = candidate.repaired.find((item) => item.field === "committed_yjs_state");
          const result = database.prepare(
            `UPDATE document_collaboration_states
             SET yjs_state = ?, committed_yjs_state = ?,
                 draft_version = draft_version + ?, updated_at = ?
             WHERE workspace_id = ? AND document_id = ? AND generation = ?
               AND yjs_state = ? AND committed_yjs_state = ?`,
          ).run(
            current?.repairedState ?? candidate.row.yjs_state,
            committed?.repairedState ?? candidate.row.committed_yjs_state,
            current ? 1 : 0,
            new Date().toISOString(),
            candidate.row.workspace_id,
            candidate.row.document_id,
            candidate.row.generation,
            candidate.row.yjs_state,
            candidate.row.committed_yjs_state,
          );
          if (result.changes !== 1) {
            throw new Error(`Draft changed during repair; no data was written: ${candidate.row.document_id}`);
          }
        }
      })();
    } finally {
      database.close();
    }

    const remaining = scan();
    if (remaining.length > 0) {
      throw new Error(`Missing or duplicate node IDs remain in ${remaining.length} collaboration states.`);
    }
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    affectedDocuments: candidates.length,
    affectedStates: candidates.reduce((total, candidate) => total + candidate.repaired.length, 0),
    repairedNodeIds: candidates.reduce(
      (total, candidate) => total + candidate.repaired.reduce((count, item) => count + item.repairCount, 0),
      0,
    ),
    missingNodeIds: candidates.reduce(
      (total, candidate) => total + candidate.repaired.reduce((count, item) => count + item.missingCount, 0),
      0,
    ),
    duplicateNodeIds: candidates.reduce(
      (total, candidate) => total + candidate.repaired.reduce((count, item) => count + item.duplicateCount, 0),
      0,
    ),
    documents: candidates.map((candidate) => ({
      workspaceId: candidate.row.workspace_id,
      documentId: candidate.row.document_id,
      generation: candidate.row.generation,
      fields: candidate.repaired.map((item) => ({
        field: item.field,
        repairedNodeIds: item.repairCount,
        missingNodeIds: item.missingCount,
        duplicateNodeIds: item.duplicateCount,
      })),
    })),
    backupGenerationId,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error("Nyxdoc draft node ID repair failed.", error);
  process.exitCode = 1;
});
