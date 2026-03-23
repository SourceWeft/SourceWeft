import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  turbopack: {
    // Avoid inferring workspace root from a lockfile outside this repo (e.g. ~/package-lock.json).
    root: monorepoRoot,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
