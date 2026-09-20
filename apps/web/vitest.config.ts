import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./*" so tests can import files (or,
    // transitively, files that import files) that use the alias the way
    // Next's own bundler already does — without this, vitest simply can't
    // resolve them.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Browser acceptance uses Playwright and real services, not Vitest.
    exclude: [...configDefaults.exclude, "e2e/**"],
    coverage: {
      exclude: [".next/**", "next-env.d.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    environment: "node",
    // Share the machine with the backend and package suites under Turbo instead
    // of each suite independently claiming all available CPUs.
    maxWorkers: 2,
    include: ["**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
  },
});
