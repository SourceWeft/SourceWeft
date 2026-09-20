import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { test } from "vitest";

import { SW_LOCALE_HEADER } from "./lib/i18n/constants";
import { proxy } from "./proxy";

function req(path: string, init?: { cookie?: string; headers?: Record<string, string> }) {
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
  assert.equal(res.headers.get("x-middleware-rewrite"), "http://localhost:3000/en");
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
