import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  // This suite requires the isolated Compose runner and its dedicated config.
  testIgnore: "**/selfhost.spec.ts",
  timeout: 180_000,
  workers: 1,
  retries: 0,
  outputDir: "../../output/playwright/skills-results",
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: "../../output/playwright/skills-report", open: "never" },
    ],
  ],
  use: {
    actionTimeout: 20000,
    navigationTimeout: 60000,
    baseURL: process.env.SKILL_E2E_WEB_URL ?? "http://localhost:3310",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
