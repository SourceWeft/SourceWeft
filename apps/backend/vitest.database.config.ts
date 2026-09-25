import { defineConfig } from "vitest/config";
import { databaseTestGlob, sharedTestOptions } from "./vitest.shared";

// Database lane: every *.database.test.ts clones the one migrated template
// that src/test/global-setup.ts builds per run. Requires DATABASE_URL and
// CREATE DATABASE permission; fails fast without them.
export default defineConfig({
  test: {
    ...sharedTestOptions,
    include: [databaseTestGlob],
    globalSetup: ["src/test/global-setup.ts"],
  },
});
