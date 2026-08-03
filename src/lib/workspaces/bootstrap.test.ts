import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { createTestDatabase } from "@/test/fixture";
import { ensurePersonalWorkspace } from "@/lib/workspaces/bootstrap";
import type { AppLocale } from "@/lib/i18n/locales";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("personal workspace bootstrap", () => {
  it.each([
    ["en", "Ada's workspace", "Getting started"],
    ["ko", "Ada의 워크스페이스", "시작하기"],
    ["ja", "Adaのワークスペース", "はじめに"],
  ] as const)("creates one localized starter document for %s", (locale, workspaceName, title) => {
    const database = createTestDatabase();
    databases.push(database);
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
    ).run("localized-user", "Ada", "ada@example.com", Date.now(), Date.now());

    const workspace = ensurePersonalWorkspace(database, {
      id: "localized-user",
      name: "Ada",
      email: "ada@example.com",
    }, locale satisfies AppLocale);

    expect(workspace.name).toBe(workspaceName);
    expect(database.prepare(
      "SELECT title FROM documents WHERE workspace_id = ?",
    ).all(workspace.id)).toEqual([{ title }]);
    expect(database.prepare(
      `SELECT revision.title_snapshot, revision.parent_document_id_snapshot,
              revision.document_metadata_json, revision.actor_type,
              revision.actor_principal_id, revision.source
       FROM document_revisions revision
       JOIN documents document ON document.current_revision_id = revision.id
       WHERE document.workspace_id = ?`,
    ).get(workspace.id)).toEqual({
      title_snapshot: title,
      parent_document_id_snapshot: null,
      document_metadata_json: JSON.stringify({
        documentType: null,
        workflowStatus: "draft",
        tags: [],
      }),
      actor_type: "system",
      actor_principal_id: "localized-user",
      source: "seed",
    });
  });
});
