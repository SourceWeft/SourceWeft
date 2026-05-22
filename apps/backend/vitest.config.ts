import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["dist/**", "src/**/*.test.ts", "src/**/*.d.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    pool: "forks",
    setupFiles: ["src/test/setup.ts"],
  },
});
