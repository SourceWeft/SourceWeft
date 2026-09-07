import { defineConfig } from "tsup";

export default defineConfig({
  bundle: true,
  clean: true,
  dts: false,
  entry: {
    api: "src/api/main.ts",
    scheduler: "src/scheduler/main.ts",
    worker: "src/worker/main.ts",
  },
  format: ["esm"],
  minify: false,
  // Workspace packages export TypeScript source. Bundle their static imports
  // (including the builtin capability map) for the plain Node dist entrypoints.
  // The backend's declared third-party runtime dependencies stay external so
  // Node loads SDKs and their package-relative/native assets in place.
  noExternal: [/^@sourceweft\//],
  outDir: "dist",
  platform: "node",
  shims: false,
  sourcemap: true,
  splitting: false,
  target: "node20",
  treeshake: true,
});
