import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3100";

export default defineConfig({
  testDir: "./e2e",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || "output/playwright/results",
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
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1"
    ? undefined
    : {
        command: "npm run dev",
        url: `${baseURL}/api/health`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
