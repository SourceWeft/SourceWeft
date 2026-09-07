import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
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
