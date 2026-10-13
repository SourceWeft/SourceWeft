import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("next.config security headers", () => {
  it("sets the baseline security headers on every route and the framing and referrer policy on pages", async () => {
    const headers = await nextConfig.headers!();

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
            value: "camera=(), microphone=(), geolocation=()",
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
});
