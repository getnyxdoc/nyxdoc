import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3100";
const externalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1";
const runtimeRoot = externalServer
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), "nyxdoc-playwright-"));

export default defineConfig({
  testDir: "./e2e",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || "output/playwright/results",
  globalTeardown: runtimeRoot ? "./e2e/global-teardown.ts" : undefined,
  metadata: runtimeRoot ? { runtimeRoot } : {},
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  projects: process.platform === "win32"
    ? [
        { name: "chrome", use: { channel: "chrome" } },
        { name: "edge", use: { channel: "msedge" } },
      ]
    : [{ name: "chromium" }],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    locale: "ko-KR",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: externalServer
    ? undefined
    : {
        command: "npm run dev",
        url: `${baseURL}/api/health`,
        env: {
          NYXDOC_DB_PATH: path.join(runtimeRoot!, "nyxdoc.db"),
          NYXDOC_MEDIA_ROOT: path.join(runtimeRoot!, "media"),
          NYXDOC_BACKUP_ROOT: path.join(runtimeRoot!, "backups"),
        },
        reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
        timeout: 120_000,
      },
});
