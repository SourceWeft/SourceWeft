import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The compiler tests run real @babel/standalone compilation of scene
    // modules; well under 5s alone, but past it on a contended CI runner.
    // Same reasoning as apps/backend/vitest.config.ts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
