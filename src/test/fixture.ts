import { randomUUID } from "node:crypto";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import { runAppMigrations } from "@/lib/db/migrations";
import { ensurePersonalWorkspace } from "@/lib/workspaces/bootstrap";

export function createTestDatabase() {
  const database = openDatabase(":memory:");
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

export function createTestUser(
  database: NyxDatabase,
  input: { name?: string; email?: string; createdAt?: number } = {},
) {
  const id = randomUUID();
  const user = {
    id,
    name: input.name ?? "Codex Tester",
    email: input.email ?? `tester-${id.slice(0, 8)}@example.com`,
  };
  const createdAt = input.createdAt ?? Date.now();
  database
    .prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
    .run(user.id, user.name, user.email, createdAt, createdAt);
  const workspace = ensurePersonalWorkspace(database, user);
  return { user, workspace };
}
