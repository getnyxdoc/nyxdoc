import type { FullConfig } from "@playwright/test";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export default async function globalTeardown(config: FullConfig) {
  const runtimeRoot = typeof config.metadata.runtimeRoot === "string"
    ? path.resolve(config.metadata.runtimeRoot)
    : null;
  if (!runtimeRoot) return;

  const temporaryRoot = path.resolve(os.tmpdir());
  if (
    path.dirname(runtimeRoot) !== temporaryRoot
    || !path.basename(runtimeRoot).startsWith("nyxdoc-playwright-")
  ) {
    throw new Error(`Refusing to remove an unexpected Playwright runtime directory: ${runtimeRoot}`);
  }
  try {
    await rm(runtimeRoot, { recursive: true, force: true });
  } catch (error) {
    // Playwright stops webServer after global teardown. On Windows that means
    // SQLite can still hold the database file here. Isolation is already
    // guaranteed by the per-run directory, so leave this one temp directory
    // for the OS instead of failing an otherwise valid qualification run.
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (process.platform === "win32" && ["EBUSY", "EPERM"].includes(code)) {
      console.warn(`Playwright runtime cleanup deferred until process exit: ${runtimeRoot}`);
      return;
    }
    throw error;
  }
}
