import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Points next-intl at our request config (which reads the proxy-set locale header).
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const monorepoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function isPrivateIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [first, second] = octets as [number, number, number, number];
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function getAllowedDevOrigins() {
  const origins = new Set(["localhost", "127.0.0.1", "[::1]"]);

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && isPrivateIpv4(address.address)) {
        origins.add(address.address);
        continue;
      }

      if (address.family === "IPv6" && /^(?:fc|fd)/i.test(address.address)) {
        origins.add(`[${address.address.split("%")[0]}]`);
      }
    }
  }

  return [...origins];
}

const nextConfig: NextConfig = {
  // Separate build output lets an isolated E2E server share this checkout.
  distDir: process.env.SOURCEWEFT_NEXT_DIST_DIR ?? ".next",
  allowedDevOrigins:
    process.env.NODE_ENV === "development" ? getAllowedDevOrigins() : undefined,
  output: "standalone",
  // The standalone runner only receives traced files; the changelog reads this
  // directory, and a dynamic path is not traceable.
  outputFileTracingIncludes: {
    "/changelog": ["./content/changelog/**"],
  },
  async redirects() {
    return [
      // Public shares moved from `/s/:token` to the canonical `/artifact/:token`
      // (opaque id, no slug). A routing-layer 308 keeps old links and any
      // already-indexed pages working without a client-side meta refresh.
      { source: "/s/:token", destination: "/artifact/:token", permanent: true },
    ];
  },
  turbopack: {
    // Avoid inferring workspace root from a lockfile outside this repo (e.g. ~/package-lock.json).
    root: monorepoRoot,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default withNextIntl(nextConfig);
