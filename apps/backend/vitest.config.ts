import { configDefaults, defineConfig } from "vitest/config";
import { databaseTestGlob, sharedTestOptions } from "./vitest.shared";

// Unit lane: needs no PostgreSQL. Database-backed suites run through
// vitest.database.config.ts (`pnpm test:database`).
export default defineConfig({
  test: {
    ...sharedTestOptions,
    coverage: {
      exclude: ["dist/**", "src/**/*.test.ts", "src/**/*.d.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, databaseTestGlob],
  },
});
