import assert from "node:assert/strict";
import test from "node:test";
import { WordPressError, type WordPressErrorCode } from "../src/errors";
import { discoverRestRoot, routeUrl, type RestRoot } from "../src/rest-root";
import {
  createFakeWordPress,
  type FakeWordPress,
  type FakeWordPressOptions,
} from "./helpers/fake-wordpress";

type Discovered = { fake: FakeWordPress; root: RestRoot };

async function discover(
  options: FakeWordPressOptions,
  allowWpcom = false,
): Promise<Discovered> {
  const fake = createFakeWordPress(options);
  const root = await discoverRestRoot({
    fetch: fake.fetch,
    siteBase: options.siteBase.replace(/\/$/, ""),
    allowWpcom,
    now: () => 1_000_000,
    sleep: async () => undefined,
  });
  return { fake, root };
}

async function codeOf(
  options: FakeWordPressOptions,
  allowWpcom = false,
): Promise<{ code: WordPressErrorCode; fake: FakeWordPress }> {
  const fake = createFakeWordPress(options);
  try {
    await discoverRestRoot({
      fetch: fake.fetch,
      siteBase: options.siteBase.replace(/\/$/, ""),
      allowWpcom,
      now: () => 1_000_000,
      sleep: async () => undefined,
    });
  } catch (error) {
    assert.ok(error instanceof WordPressError, String(error));
    return { code: error.code, fake };
  }
  assert.fail("expected a WordPressError");
}

const SITE = "https://site.example";

test("discovers the pretty root from the Link header", async () => {
  const { root, fake } = await discover({
    siteBase: SITE,
    discovery: "header",
  });
  assert.deepEqual(root, { kind: "pretty", base: `${SITE}/wp-json` });
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.url, `${SITE}/`);
  assert.equal(fake.requests[0]!.redirect, "manual");
});

test("discovers the pretty root from the HTML <link> tag when no header", async () => {
  const { root } = await discover({ siteBase: SITE, discovery: "tag" });
  assert.deepEqual(root, { kind: "pretty", base: `${SITE}/wp-json` });
});

test("a tag beyond 256 KiB is not read; a tag within it is", async () => {
  const link = `<link rel="https://api.w.org/" href="${SITE}/wp-json/">`;
  const beyond = createFakeWordPress({ siteBase: SITE, discovery: "none" });
  beyond.failNext({
    status: 200,
    headers: { "content-type": "text/html" },
    body: `<html><head><!--${"x".repeat(300_000)}-->${link}</head></html>`,
  });
  await assert.rejects(
    discoverRestRoot({
      fetch: beyond.fetch,
      siteBase: SITE,
      allowWpcom: false,
      now: () => 0,
      sleep: async () => undefined,
    }),
    (e: unknown) =>
      e instanceof WordPressError && e.code === "NOT_A_WORDPRESS_SITE",
  );

  const within = createFakeWordPress({ siteBase: SITE, discovery: "none" });
  within.failNext({
    status: 200,
    headers: { "content-type": "text/html" },
    body: `<html><head><!--${"x".repeat(100_000)}-->${link}</head></html>`,
  });
  const root = await discoverRestRoot({
    fetch: within.fetch,
    siteBase: SITE,
    allowWpcom: false,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.deepEqual(root, { kind: "pretty", base: `${SITE}/wp-json` });
});

test("the Link header wins over the HTML tag", async () => {
  const fake = createFakeWordPress({ siteBase: SITE, discovery: "none" });
  fake.failNext({
    status: 200,
    headers: {
      "content-type": "text/html",
      Link: `<${SITE}/wp-json/>; rel="https://api.w.org/"`,
    },
    body: `<html><head><link rel="https://api.w.org/" href="${SITE}/?rest_route=/"></head></html>`,
  });
  const root = await discoverRestRoot({
    fetch: fake.fetch,
    siteBase: SITE,
    allowWpcom: false,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.deepEqual(root, { kind: "pretty", base: `${SITE}/wp-json` });
});

test("a Link rel with several space-separated types is matched", async () => {
  const fake = createFakeWordPress({ siteBase: SITE, discovery: "none" });
  fake.failNext({
    status: 200,
    headers: {
      "content-type": "text/html",
      Link: `<${SITE}/wp-json/>; rel="alternate https://api.w.org/"`,
    },
    body: "<html></html>",
  });
  const root = await discoverRestRoot({
    fetch: fake.fetch,
    siteBase: SITE,
    allowWpcom: false,
    now: () => 0,
    sleep: async () => undefined,
  });
  assert.deepEqual(root, { kind: "pretty", base: `${SITE}/wp-json` });
});

test("no api.w.org link anywhere is NOT_A_WORDPRESS_SITE", async () => {
  const { code } = await codeOf({ siteBase: SITE, discovery: "none" });
  assert.equal(code, "NOT_A_WORDPRESS_SITE");
});

test("accepts a plain root", async () => {
  const { root } = await discover({ siteBase: SITE, root: "plain" });
  assert.deepEqual(root, { kind: "plain", index: `${SITE}/?rest_route=/` });
});

test("accepts a subfolder pretty root", async () => {
  const base = `${SITE}/blog`;
  const { root } = await discover({ siteBase: base, root: "pretty" });
  assert.deepEqual(root, { kind: "pretty", base: `${base}/wp-json` });
});

test("accepts the hosted wordpress.com route only when allowed", async () => {
  const { root } = await discover({ siteBase: SITE, root: "wpcom" }, true);
  assert.deepEqual(root, {
    kind: "wpcom",
    base: "https://public-api.wordpress.com/wp/v2/sites/site.example",
    host: "site.example",
  });
});

test("the hosted route is refused when allowWpcom is false", async () => {
  const { code, fake } = await codeOf({ siteBase: SITE, root: "wpcom" }, false);
  assert.equal(code, "BLOCKED_ENDPOINT");
  assert.ok(
    fake.requests.every((r) => r.host !== "public-api.wordpress.com"),
    "no request reaches the hosted API",
  );
});

test("the hosted route for a different host is refused", async () => {
  const { code } = await codeOf(
    {
      siteBase: SITE,
      advertisedRoot:
        "https://public-api.wordpress.com/wp-json/?rest_route=/sites/other.example",
    },
    true,
  );
  assert.equal(code, "BLOCKED_ENDPOINT");
});

const REFUSED_ROOTS: [string, string][] = [
  ["another origin", "https://evil.example/wp-json/"],
  ["a look-alike host", "https://site.example.evil.test/wp-json/"],
  ["another port", "https://site.example:8443/wp-json/"],
  ["http", "http://site.example/wp-json/"],
  ["userinfo", "https://u:p@site.example/wp-json/"],
  ["javascript", "javascript:alert(1)"],
  ["a foreign plain root", "https://evil.example/?rest_route=/"],
  ["a wrong same-origin path", "https://site.example/not-wp-json/"],
];

for (const [label, advertisedRoot] of REFUSED_ROOTS) {
  test(`refuses ${label} and never requests it`, async () => {
    const { code, fake } = await codeOf({ siteBase: SITE, advertisedRoot });
    assert.equal(code, "BLOCKED_ENDPOINT", label);
    assert.equal(fake.requests.length, 1, "only the home page is fetched");
    assert.equal(fake.requests[0]!.url, `${SITE}/`);
  });
}

test("a home-page redirect is BLOCKED_ENDPOINT and never followed", async () => {
  const fake = createFakeWordPress({ siteBase: SITE });
  fake.failNext({
    status: 301,
    headers: { location: "https://evil.example/" },
  });
  await assert.rejects(
    discoverRestRoot({
      fetch: fake.fetch,
      siteBase: SITE,
      allowWpcom: false,
      now: () => 0,
      sleep: async () => undefined,
    }),
    (e: unknown) =>
      e instanceof WordPressError && e.code === "BLOCKED_ENDPOINT",
  );
  assert.equal(fake.requests.length, 1);
  assert.ok(fake.requests.every((r) => r.host !== "evil.example"));
});

test("a network failure fetching the home page is SITE_UNREACHABLE", async () => {
  const fake = createFakeWordPress({ siteBase: SITE });
  fake.failNext({ networkError: true }, 10);
  await assert.rejects(
    discoverRestRoot({
      fetch: fake.fetch,
      siteBase: SITE,
      allowWpcom: false,
      now: () => 0,
      sleep: async () => undefined,
    }),
    (e: unknown) =>
      e instanceof WordPressError && e.code === "SITE_UNREACHABLE",
  );
});

test("routeUrl builds a pretty route with params in order", () => {
  const root: RestRoot = { kind: "pretty", base: `${SITE}/wp-json` };
  assert.equal(
    routeUrl(root, "/wp/v2/posts", { per_page: 100, page: 2 }),
    `${SITE}/wp-json/wp/v2/posts?per_page=100&page=2`,
  );
  assert.equal(
    routeUrl(root, "/wp/v2/posts/5"),
    `${SITE}/wp-json/wp/v2/posts/5`,
  );
});

test("routeUrl puts a plain route into rest_route, params after it", () => {
  const root: RestRoot = { kind: "plain", index: `${SITE}/?rest_route=/` };
  assert.equal(
    routeUrl(root, "/wp/v2/posts", { per_page: 100 }),
    `${SITE}/?rest_route=/wp/v2/posts&per_page=100`,
  );
  assert.equal(
    routeUrl(root, "/wp/v2/pages/7"),
    `${SITE}/?rest_route=/wp/v2/pages/7`,
  );
});

test("routeUrl drops the /wp/v2 prefix for a hosted root", () => {
  const root: RestRoot = {
    kind: "wpcom",
    base: "https://public-api.wordpress.com/wp/v2/sites/site.example",
    host: "site.example",
  };
  assert.equal(
    routeUrl(root, "/wp/v2/posts", { per_page: 100 }),
    "https://public-api.wordpress.com/wp/v2/sites/site.example/posts?per_page=100",
  );
  assert.equal(
    routeUrl(root, "/wp/v2/categories"),
    "https://public-api.wordpress.com/wp/v2/sites/site.example/categories",
  );
});

test("routeUrl rejects a route outside /wp/v2", () => {
  const root: RestRoot = { kind: "pretty", base: `${SITE}/wp-json` };
  for (const route of [
    "/wp/v1/posts",
    "posts",
    "/wp/v2/",
    "/wp/v2/posts/../x",
  ]) {
    assert.throws(
      () => routeUrl(root, route),
      (e: unknown) =>
        e instanceof WordPressError && e.code === "CONFIG_INVALID",
      route,
    );
  }
});
