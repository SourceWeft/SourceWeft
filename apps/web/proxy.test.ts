import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { test } from "vitest";

import { SW_LOCALE_HEADER } from "./lib/i18n/constants";
import { config, proxy } from "./proxy";

function req(
  path: string,
  init?: { cookie?: string; headers?: Record<string, string> },
) {
  const headers = new Headers(init?.headers);
  if (init?.cookie) {
    headers.set("cookie", init.cookie);
  }
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

// Regression for a site-breaking bug found 2026-09-20: Next re-runs the proxy
// against a `NextResponse.rewrite()` target internally (a single external `/`
// request produced two proxy invocations, the second one on the rewritten
// `/en`). Without a re-entry guard, that second pass hit the "default locale
// prefix in the URL → 308 to the bare path" branch, and the response for the
// *original* `/` request became a 308 to `/` itself — every client that
// followed it looped forever (curl hit its 50-redirect cap; browsers gave
// ERR_TOO_MANY_REDIRECTS). This made the marketing homepage unreachable.
test("does not redirect when the proxy is re-invoked on its own rewrite target", () => {
  // Simulates the re-entrant call: the incoming request already carries the
  // header only this file ever sets, exactly as it would after `rewrite()`.
  const reentrant = req("/en", { headers: { [SW_LOCALE_HEADER]: "en" } });
  const res = proxy(reentrant);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
});

test("bare / rewrites onto the default locale segment without redirecting", () => {
  const res = proxy(req("/"));
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("x-middleware-rewrite"),
    "http://localhost:3000/en",
  );
  assert.equal(res.headers.get("location"), null);
});

test("/en canonicalizes to the bare path with a single 308", () => {
  const res = proxy(req("/en"));
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "http://localhost:3000/");
});

test("/en/about canonicalizes to /about with a single 308", () => {
  const res = proxy(req("/en/about"));
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "http://localhost:3000/about");
});

test("a non-default locale cookie redirects the bare path to the prefixed URL", () => {
  const res = proxy(req("/", { cookie: "sw_locale=zh-CN" }));
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), "http://localhost:3000/zh-CN");
});

test("an explicit non-default locale in the URL passes through with the locale header set", () => {
  const res = proxy(req("/zh-TW"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-middleware-next"), "1");
  assert.equal(res.headers.get("location"), null);
});

test("app-tree routes are never prefixed or redirected, only header-tagged", () => {
  const res = proxy(req("/dashboard"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-middleware-next"), "1");
  assert.equal(res.headers.get("location"), null);
  assert.equal(res.headers.get("x-middleware-rewrite"), null);
});

test("/skills is localized: the bare path rewrites onto /en and /en/skills canonicalizes", () => {
  const bare = proxy(req("/skills/pdf-forms"));
  assert.equal(bare.status, 200);
  assert.equal(
    bare.headers.get("x-middleware-rewrite"),
    "http://localhost:3000/en/skills/pdf-forms",
  );
  const prefixed = proxy(req("/en/skills"));
  assert.equal(prefixed.status, 308);
  assert.equal(
    prefixed.headers.get("location"),
    "http://localhost:3000/skills",
  );
});

// /skills/SKILL.md stays at app/skills/SKILL.md/route.ts (not under [locale]):
// the catalog-detail exception must not rewrite this real file endpoint.
test("the agent entry point /skills/SKILL.md is outside the proxy matcher", () => {
  assert.equal(matches("/skills"), true);
  assert.equal(matches("/skills/SKILL.md"), false);
});

function matches(url: string) {
  return unstable_doesMiddlewareMatch({ config, nextConfig: {}, url });
}

for (const path of [
  "/mcp/io.github.heintonny%2Fkeycloak-mcp.test",
  "/mcp/io.github.mastyf-ai%2Fmastyf.ai",
  "/skills/agent.v2",
]) {
  test(`dotted catalog detail uses locale routing: ${path}`, () => {
    assert.equal(matches(path), true);
    const bare = proxy(req(path));
    assert.equal(
      bare.headers.get("x-middleware-rewrite"),
      `http://localhost:3000/en${path}`,
    );
    assert.equal(matches(`/en${path}`), true);
    assert.equal(
      proxy(req(`/en${path}`)).headers.get("location"),
      `http://localhost:3000${path}`,
    );
    for (const locale of ["zh-CN", "zh-TW"]) {
      assert.equal(matches(`/${locale}${path}`), true);
      const localized = proxy(req(`/${locale}${path}`));
      assert.equal(localized.headers.get("location"), null);
      assert.equal(
        localized.headers.get("x-middleware-request-x-sw-locale"),
        locale,
      );
    }
  });
}

test("file endpoints and static assets stay outside the proxy", () => {
  for (const path of [
    "/skills/SKILL.md",
    "/skills/agent.v2/install.md",
    "/en/skills/agent.v2/install.md",
    "/zh-CN/skills/agent.v2/install.md",
    "/favicon.ico",
    "/icons/mcp.svg",
    "/_next/static/chunk.js",
    "/file-viewer/viewer.js",
    "/api/mcp/agent.test",
    "/sitemap-mcp-4.xml",
  ])
    assert.equal(matches(path), false, path);
});

test("/download is localized: the bare path rewrites onto /en and /en/download canonicalizes", () => {
  const bare = proxy(req("/download"));
  assert.equal(bare.status, 200);
  assert.equal(
    bare.headers.get("x-middleware-rewrite"),
    "http://localhost:3000/en/download",
  );
  const prefixed = proxy(req("/en/download"));
  assert.equal(prefixed.status, 308);
  assert.equal(
    prefixed.headers.get("location"),
    "http://localhost:3000/download",
  );
});
