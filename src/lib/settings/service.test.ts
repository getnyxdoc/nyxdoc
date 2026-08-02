import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NyxDatabase } from "@/lib/db/client";
import {
  SettingsServiceError,
  updateWorkspaceName,
} from "@/lib/settings/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("settings service", () => {
  it("lets the owner rename the workspace", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);

    const updated = updateWorkspaceName(
      database,
      workspace.id,
      user.id,
      "새 워크스페이스",
    );

    expect(updated).toMatchObject({ id: workspace.id, name: "새 워크스페이스" });
    expect(database.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspace.id))
      .toEqual({ name: "새 워크스페이스" });
  });

  it("does not let a non-owner rename the workspace", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database);
    const member = createTestUser(database);
    database
      .prepare(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'member', ?)`,
      )
      .run(randomUUID(), owner.workspace.id, member.user.id, new Date().toISOString());

    expect(() => updateWorkspaceName(
      database,
      owner.workspace.id,
      member.user.id,
      "권한 없는 변경",
    )).toThrowError(expect.objectContaining<Partial<SettingsServiceError>>({ code: "FORBIDDEN" }));
  });
});
