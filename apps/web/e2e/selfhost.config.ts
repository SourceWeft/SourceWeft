import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "selfhost.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: "list",
  outputDir: "../../../output/selfhost-playwright",
  use: {
    baseURL: process.env.SELFHOST_BASE_URL,
    browserName: "chromium",
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
