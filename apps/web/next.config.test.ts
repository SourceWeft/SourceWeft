import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { FILE_VIEWER_ASSET_VERSION } from "../../packages/preview/src/asset-base.mjs";
import { BUILD_SHA } from "./lib/app-version";
import nextConfig from "./next.config";

describe("next.config security headers", () => {
  it("sets the baseline security headers on every route and the framing and referrer policy on pages", async () => {
    const headers = (await nextConfig.headers!()).filter(
      ({ headers: rule }) =>
        !rule.some(
          ({ key }) => key === "Cache-Control" || key === "x-sourceweft-build",
        ),
    );

    expect(headers).toEqual([
      {
        source: "/(.*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
        ],
      },
      {
        // Route handlers under /api set their own, stricter values (a
        // `sandbox` CSP, `no-referrer` for tokened URLs), and Next drops a
        // handler's header when the config already set the same key.
        source: "/((?!api/).*)",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The app frames itself (sub-agent panel, mobile route sheet), and
          // nothing else may: `'self'` keeps those while blocking clickjacking.
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
    ]);
  });

  it("caches the versioned file viewer assets forever and the unversioned public files briefly", async () => {
    const headers = await nextConfig.headers!();
    const cacheControl = (source: string) =>
      headers
        .find((rule) => rule.source === source)
        ?.headers.find(({ key }) => key === "Cache-Control")?.value;

    expect(
      cacheControl(`/file-viewer/${FILE_VIEWER_ASSET_VERSION}/:path*`),
    ).toBe("public, max-age=31536000, immutable");
    for (const source of ["/icons/:path*", "/icon-512.png", "/logo.svg"]) {
      expect(cacheControl(source)).toBe(
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      );
    }
    // Next sets its own values for these; a rule here would be dropped or wrong.
    expect(
      headers.filter(({ source }) => /^\/(_next|api)\//.test(source)),
    ).toEqual([]);
  });

  it("names the build on the pages the iOS app's service worker keeps", async () => {
    const named = (await nextConfig.headers!()).filter(({ headers: rule }) =>
      rule.some(({ key }) => key === "x-sourceweft-build"),
    );
    // The worker compares this header on exactly the pages it caches.
    const worker = readFileSync(resolve(__dirname, "public/sw.js"), "utf8");
    const kept = /const SHELL_PATHS = new Set\(\[([^\]]+)\]\)/.exec(
      worker,
    )?.[1];
    expect(named.map(({ source }) => source).sort()).toEqual(
      [...(kept ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort(),
    );
    expect(worker).toContain('const BUILD_HEADER = "x-sourceweft-build";');
    for (const rule of named) {
      expect(rule.headers).toEqual([
        { key: "x-sourceweft-build", value: BUILD_SHA },
      ]);
    }
  });
});
