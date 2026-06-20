import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  test: {
    coverage: {
      exclude: [".next/**", "next-env.d.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
  },
});
