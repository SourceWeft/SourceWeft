import { defineConfig } from "tsup";

export default defineConfig({
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as sourceweftCreateRequire } from 'node:module';\nconst require = sourceweftCreateRequire(import.meta.url);",
  },
  clean: true,
  entry: ["src/main.ts"],
  format: ["esm"],
  // Workspace packages are private, so the published CLI carries them inline.
  noExternal: [/^@sourceweft\//u],
  outDir: "dist",
  platform: "node",
  sourcemap: false,
  splitting: false,
  target: "node20",
  treeshake: true,
});
