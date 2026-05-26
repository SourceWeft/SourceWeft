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
  noExternal: [
    /^@sourceweft\/contracts(\/.*)?$/,
    /^@sourceweft\/credits-core(\/.*)?$/,
    /^@sourceweft\/market-contracts(\/.*)?$/,
    /^@sourceweft\/market-sdk(\/.*)?$/,
    /^@sourceweft\/model-gateway(\/.*)?$/,
  ],
  outDir: "dist",
  platform: "node",
  shims: false,
  sourcemap: true,
  splitting: false,
  target: "node20",
  treeshake: true,
});
