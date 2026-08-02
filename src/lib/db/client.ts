import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getDatabasePath } from "@/lib/config";

export type NyxDatabase = Database.Database;

function registerDatabaseFunctions(database: NyxDatabase) {
  database.function("nyxdoc_search_text", { deterministic: true }, (value: unknown) =>
    typeof value === "string" ? value.normalize("NFC").toLocaleLowerCase() : "");
}

export function openDatabase(databasePath = getDatabasePath()): NyxDatabase {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  registerDatabaseFunctions(database);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = NORMAL");
  if (databasePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
  }
  return database;
}

const globalDatabase = globalThis as typeof globalThis & {
  __nyxdocDatabase?: NyxDatabase;
};

export const sqlite = globalDatabase.__nyxdocDatabase ?? openDatabase();

if (process.env.NODE_ENV !== "production") {
  registerDatabaseFunctions(sqlite);
  globalDatabase.__nyxdocDatabase = sqlite;
}
