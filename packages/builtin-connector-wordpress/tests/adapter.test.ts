import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorItemSkipError,
  type ConnectorDiscoveryPage,
} from "@sourceweft/contracts";
import { createWordPressAdapter, WordPressAdapterError } from "../src/adapter";
import {
  actionInput,
  baseInput,
  CREDENTIAL,
  credentialToken,
  fakePost,
  harness,
  sel,
  SITE_URL,
  wpConfig,
} from "./helpers/adapter-fixtures";
import type {
  FakeCategory,
  FakeWordPressOptions,
} from "./helpers/fake-wordpress";

const CATEGORIES: FakeCategory[] = [
  { id: 10, name: "News", parent: 0 },
  { id: 11, name: "World", parent: 10 },
  { id: 12, name: "Sports", parent: 0 },
];

const siteFake = (over: Partial<FakeWordPressOptions> = {}) => ({
  categories: CATEGORIES,
  tags: [{ id: 20, name: "update" }],
  users: [{ id: 5, name: "Alice" }],
  posts: [
    fakePost(1),
    fakePost(2, { categories: [11] }),
    { id: 3, type: "page" as const, title: "About" },
  ],
  ...over,
});

// ---- identity ------------------------------------------------------------

test("the public adapter identifies itself and exposes no credential surface", () => {
  const { adapter } = harness({ flavor: "public", fake: siteFake() });
  assert.equal(adapter.capabilityId, "sourceweft/wordpress");
  assert.equal(adapter.getManifest().type, "wordpress");
  assert.deepEqual(adapter.getManifest().auth, { kind: "none" });
  assert.equal("credentialIdentity" in adapter, false);
  for (const absent of [
    "exchangeOAuthCode",
    "refreshOAuthToken",
    "credentialFlow",
    "verifyWebhook",
  ] as const) {
    assert.equal(absent in adapter, false, absent);
  }
});

test("the login adapter is a credential connector with a credential identity", () => {
  const { adapter } = harness({ flavor: "login", fake: siteFake() });
  assert.equal(adapter.capabilityId, "sourceweft/wordpress");
  assert.equal(adapter.getManifest().type, "wordpress_login");
  assert.deepEqual(adapter.getManifest().auth, {
    kind: "credential",
    scheme: "basic",
  });
  assert.equal(typeof adapter.credentialIdentity, "function");
});

// ---- readiness -----------------------------------------------------------

test("readiness: a reachable public site with a selection is ready", async () => {
  const h = harness({ flavor: "public", fake: siteFake() });
  const result = await h.adapter.checkSyncReadiness!(
    baseInput(wpConfig(sel("type:post"))),
  );
  assert.equal(result.ready, true);
  assert.equal(h.opened(), 1);
  assert.equal(h.closed(), 1);
});

test("readiness: an empty selection is ready (it means everything)", async () => {
  for (const flavor of ["public", "login"] as const) {
    const h = harness({
      flavor,
      fake: siteFake({ credential: CREDENTIAL }),
    });
    const result = await h.adapter.checkSyncReadiness!(
      baseInput(wpConfig([]), flavor === "login" ? credentialToken() : ""),
    );
    assert.equal(result.ready, true, flavor);
    assert.equal(h.closed(), h.opened());
  }
});

test("readiness: a public site that walls its REST is login_required", async () => {
  const h = harness({
    flavor: "public",
    fake: siteFake({ loginRequired: true }),
  });
  const result = await h.adapter.checkSyncReadiness!(baseInput(wpConfig([])));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "login_required");
  assert.equal(typeof result.message, "string");
  assert.ok(!result.message!.includes("site.example"));
});

test("readiness: REST disabled, not a WordPress site, and a redirect each map", async () => {
  const disabled = harness({
    flavor: "public",
    fake: siteFake({ restDisabled: true }),
  });
  assert.equal(
    (await disabled.adapter.checkSyncReadiness!(baseInput(wpConfig([]))))
      .reason,
    "rest_disabled",
  );

  const notWp = harness({
    flavor: "public",
    fake: siteFake({ discovery: "none" }),
  });
  assert.equal(
    (await notWp.adapter.checkSyncReadiness!(baseInput(wpConfig([])))).reason,
    "not_a_wordpress_site",
  );

  const redirect = harness({ flavor: "public", fake: siteFake() });
  redirect.fake.failNext(
    { status: 301, headers: { location: "https://elsewhere.example/" } },
    1,
  );
  assert.equal(
    (await redirect.adapter.checkSyncReadiness!(baseInput(wpConfig([]))))
      .reason,
    "blocked_endpoint",
  );
});

test("readiness: an invalid config is config_invalid with no request", async () => {
  const h = harness({ flavor: "public", fake: siteFake() });
  for (const config of [
    { items: sel("type:post") }, // no siteUrl
    { siteUrl: "http://site.example", items: sel("type:post") }, // not https
    wpConfig([{ id: "post:1", kind: "category" }]), // kind/prefix mismatch
    wpConfig([
      { id: "post:1", kind: "post" },
      { id: "post:1", kind: "post" },
    ]), // dup
  ]) {
    const result = await h.adapter.checkSyncReadiness!(baseInput(config));
    assert.equal(result.ready, false);
    assert.equal(result.reason, "config_invalid");
  }
  assert.equal(h.fake.requests.length, 0);
  assert.equal(h.closed(), h.opened());
});

test("readiness: login with the wrong application password is reauth_required", async () => {
  const h = harness({
    flavor: "login",
    fake: siteFake({ credential: CREDENTIAL }),
  });
  // The site rejects the password: a 401 incorrect_password on users/me.
  h.fake.failNext(
    { status: 401, body: JSON.stringify({ code: "incorrect_password" }) },
    1,
    (r) =>
      r.path.endsWith("/users/me") || r.query.rest_route === "/wp/v2/users/me",
  );
  const result = await h.adapter.checkSyncReadiness!(
    baseInput(wpConfig([]), credentialToken()),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "reauth_required");
  assert.ok(!result.message!.includes(CREDENTIAL.secret));
});

test("readiness: a credentialed 401 with no injected code is reauth_required (host strips Authorization)", async () => {
  // The fake has no matching credential, so users/me answers its realistic
  // default 401 rest_not_logged_in — exactly what a host stripping the
  // Authorization header, or a revoked password, produces. A correct password
  // that never reaches WordPress must still read as reauth_required, not
  // login_required.
  const h = harness({ flavor: "login", fake: siteFake() });
  const result = await h.adapter.checkSyncReadiness!(
    baseInput(wpConfig([]), credentialToken()),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "reauth_required");
  assert.equal(h.closed(), h.opened());
});

test("readiness: a malformed stored credential is reauth_required before any request", async () => {
  const h = harness({
    flavor: "login",
    fake: siteFake({ credential: CREDENTIAL }),
  });
  const result = await h.adapter.checkSyncReadiness!(
    baseInput(wpConfig([]), "not-json"),
  );
  assert.equal(result.reason, "reauth_required");
  assert.equal(h.fake.requests.length, 0);
  assert.equal(h.closed(), h.opened());
});

test("readiness: login with includeUnpublished needs a capable account", async () => {
  const weak = harness({
    flavor: "login",
    fake: siteFake({
      credential: CREDENTIAL,
      me: { id: 5, name: "Alice", capabilities: {} },
    }),
  });
  const denied = await weak.adapter.checkSyncReadiness!(
    baseInput(wpConfig([], { includeUnpublished: true }), credentialToken()),
  );
  assert.equal(denied.ready, false);
  assert.equal(denied.reason, "insufficient_permission");

  const strong = harness({
    flavor: "login",
    fake: siteFake({
      credential: CREDENTIAL,
      me: { id: 5, name: "Alice", capabilities: { edit_posts: true } },
    }),
  });
  const ok = await strong.adapter.checkSyncReadiness!(
    baseInput(wpConfig([], { includeUnpublished: true }), credentialToken()),
  );
  assert.equal(ok.ready, true);
});

// ---- discovery and extraction -------------------------------------------

async function collect(
  gen: AsyncIterable<ConnectorDiscoveryPage>,
): Promise<ConnectorDiscoveryPage[]> {
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of gen) pages.push(page);
  return pages;
}

test("discoverPages scans the whole site for an empty selection", async () => {
  const h = harness({ flavor: "public", fake: siteFake() });
  const pages = await collect(
    h.adapter.discoverPages!(baseInput(wpConfig([]))),
  );
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.complete, true);
  assert.equal(pages[0]!.reconcileMissing, true);
  // posts 1, 2 and page 3.
  assert.deepEqual(pages[0]!.items.map((i) => i.externalId).sort(), [
    "wordpress:page:3",
    "wordpress:post:1",
    "wordpress:post:2",
  ]);
  assert.equal(h.closed(), h.opened());
});

test("discover yields the items and extract round-trips one by external id", async () => {
  const h = harness({ flavor: "public", fake: siteFake() });
  const items = [];
  for await (const item of h.adapter.discover(
    baseInput(wpConfig(sel("post:1"))),
  )) {
    items.push(item);
  }
  assert.equal(items.length, 1);
  const extracted = await h.adapter.extract({
    ...baseInput(wpConfig(sel("post:1"))),
    item: items[0]!,
  });
  assert.ok("contentText" in extracted);
  assert.equal(extracted.item.contentHash, items[0]!.contentHash);
  assert.match(extracted.contentText, /Body 1/);
  assert.equal(h.closed(), h.opened());
});

test("extract skips an item that has vanished", async () => {
  const h = harness({ flavor: "public", fake: siteFake() });
  await assert.rejects(
    () =>
      h.adapter.extract({
        ...baseInput(wpConfig(sel("post:999"))),
        item: {
          externalId: "wordpress:post:999",
          externalUri: null,
          title: "gone",
          mimeType: "text/markdown",
          sizeBytes: null,
          externalUpdatedAt: null,
          contentHash: "h",
          metadata: {},
        },
      }),
    (error: unknown) => error instanceof ConnectorItemSkipError,
  );
  assert.equal(h.closed(), h.opened());
});

test("a discovery failure crosses the boundary as a fixed-message adapter error", async () => {
  const h = harness({
    flavor: "public",
    fake: siteFake({ loginRequired: true }),
  });
  let error: unknown;
  try {
    await collect(
      h.adapter.discoverPages!(baseInput(wpConfig(sel("type:post")))),
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof WordPressAdapterError);
  assert.equal(error.code, "WORDPRESS_LOGIN_REQUIRED");
  assert.equal(error.statusCode, 422);
  assert.ok(!error.message.includes("site.example"));
  assert.equal(error.cause, undefined);
  assert.equal(h.closed(), h.opened());
});

test("a kind/prefix mismatch is rejected before any request", async () => {
  const h = harness({ flavor: "public", fake: siteFake() });
  let error: unknown;
  try {
    for await (const _page of h.adapter.discoverPages!(
      baseInput(wpConfig([{ id: "category:3", kind: "post" }])),
    )) {
      void _page;
    }
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof WordPressAdapterError);
  assert.equal(error.code, "WORDPRESS_CONFIG_INVALID");
  assert.equal(error.statusCode, 400);
  assert.equal(h.fake.requests.length, 0);
  assert.equal(h.closed(), h.opened());
});

// ---- mid-run credential rejection is the reconnect condition --------------

test("a password rejected during discover surfaces WORDPRESS_REAUTH_REQUIRED", async () => {
  const h = harness({
    flavor: "login",
    fake: siteFake({ credential: CREDENTIAL }),
  });
  // The site rejects the password on the first REST read of the scan.
  h.fake.failNext(
    { status: 401, body: JSON.stringify({ code: "incorrect_password" }) },
    1,
    (r) =>
      r.path.includes("/wp/v2/") ||
      (r.query.rest_route ?? "").startsWith("/wp/v2/"),
  );
  let error: unknown;
  try {
    await collect(
      h.adapter.discoverPages!(baseInput(wpConfig([]), credentialToken())),
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof WordPressAdapterError);
  assert.equal(error.code, "WORDPRESS_REAUTH_REQUIRED");
  assert.equal(error.statusCode, 422);
  assert.ok(typeof error.message === "string" && error.message.length > 0);
  assert.ok(!error.message.includes(CREDENTIAL.secret));
  assert.ok(!error.message.includes("site.example"));
  assert.equal(h.closed(), h.opened());
});

test("a password rejected during extract surfaces WORDPRESS_REAUTH_REQUIRED", async () => {
  const h = harness({
    flavor: "login",
    fake: siteFake({ credential: CREDENTIAL }),
  });
  h.fake.failNext(
    { status: 401, body: JSON.stringify({ code: "incorrect_password" }) },
    1,
    (r) =>
      r.path.endsWith("/wp/v2/posts/1") ||
      (r.query.rest_route ?? "") === "/wp/v2/posts/1",
  );
  await assert.rejects(
    () =>
      h.adapter.extract({
        ...baseInput(wpConfig(sel("post:1")), credentialToken()),
        item: {
          externalId: "wordpress:post:1",
          externalUri: null,
          title: "Post 1",
          mimeType: "text/markdown",
          sizeBytes: null,
          externalUpdatedAt: null,
          contentHash: "h",
          metadata: {},
        },
      }),
    (error: unknown) =>
      error instanceof WordPressAdapterError &&
      error.code === "WORDPRESS_REAUTH_REQUIRED" &&
      error.statusCode === 422,
  );
  assert.equal(h.closed(), h.opened());
});

test("a credentialed site that 401s every read (no injection) surfaces WORDPRESS_REAUTH_REQUIRED on discover", async () => {
  // The whole REST surface answers 401 rest_not_logged_in to the credentialed
  // connector. Unlike the public path (WORDPRESS_LOGIN_REQUIRED), a login
  // connector reads this as a rejected credential and the orchestrator is told
  // to reconnect rather than retry.
  const h = harness({
    flavor: "login",
    fake: siteFake({ credential: CREDENTIAL, loginRequired: true }),
  });
  let error: unknown;
  try {
    await collect(
      h.adapter.discoverPages!(baseInput(wpConfig([]), credentialToken())),
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof WordPressAdapterError);
  assert.equal(error.code, "WORDPRESS_REAUTH_REQUIRED");
  assert.equal(error.statusCode, 422);
  assert.equal(h.closed(), h.opened());
});

test("a credentialed single read that 401s (no injection) surfaces WORDPRESS_REAUTH_REQUIRED on extract", async () => {
  const h = harness({
    flavor: "login",
    fake: siteFake({ credential: CREDENTIAL, loginRequired: true }),
  });
  await assert.rejects(
    () =>
      h.adapter.extract({
        ...baseInput(wpConfig(sel("post:1")), credentialToken()),
        item: {
          externalId: "wordpress:post:1",
          externalUri: null,
          title: "Post 1",
          mimeType: "text/markdown",
          sizeBytes: null,
          externalUpdatedAt: null,
          contentHash: "h",
          metadata: {},
        },
      }),
    (error: unknown) =>
      error instanceof WordPressAdapterError &&
      error.code === "WORDPRESS_REAUTH_REQUIRED" &&
      error.statusCode === 422,
  );
  assert.equal(h.closed(), h.opened());
});

// ---- config: the public flavor never asks for unpublished content ---------

test("the public flavor never sends a status parameter", async () => {
  const h = harness({ flavor: "public", fake: siteFake() });
  await collect(h.adapter.discoverPages!(baseInput(wpConfig([]))));
  assert.ok(
    h.fake.requests.every((r) => r.query.status === undefined),
    "no status filter is ever sent by the public connector",
  );
});

// ---- actions and scope discipline ----------------------------------------

test("an unsupported action is a fixed 400 and opens no scope", async () => {
  const h = harness({ flavor: "public", fake: siteFake() });
  await assert.rejects(
    () =>
      h.adapter.executeAction(actionInput("wordpress.unknown", {}, wpConfig())),
    (error: unknown) =>
      error instanceof WordPressAdapterError &&
      error.statusCode === 400 &&
      error.code === "WORDPRESS_UNSUPPORTED_ACTION",
  );
  assert.equal(h.opened(), 0);
});

test("the login adapter's action ids are prefixed wordpress_login", async () => {
  const h = harness({
    flavor: "login",
    fake: siteFake({ credential: CREDENTIAL }),
  });
  const result = await h.adapter.executeAction(
    actionInput("wordpress_login.browse", {}, wpConfig(), credentialToken()),
  );
  assert.ok(Array.isArray((result.result as { entries: unknown[] }).entries));
  // The public prefix is not accepted by the login adapter.
  await assert.rejects(
    () =>
      h.adapter.executeAction(
        actionInput("wordpress.browse", {}, wpConfig(), credentialToken()),
      ),
    (error: unknown) =>
      error instanceof WordPressAdapterError &&
      error.code === "WORDPRESS_UNSUPPORTED_ACTION",
  );
});

test("each operation opens exactly one fresh scope and closes it", async () => {
  const h = harness({
    flavor: "public",
    fake: siteFake(),
    limits: { maxRequests: 10 },
  });
  // A shared client would run its per-instance request budget dry.
  for (let i = 0; i < 6; i += 1) {
    const result = await h.adapter.checkSyncReadiness!(
      baseInput(wpConfig(sel("type:post"))),
    );
    assert.equal(result.ready, true);
  }
  assert.equal(h.opened(), 6);
  assert.equal(h.closed(), 6);
});

test("a selection action honours the action deadline and still closes its scope", async () => {
  const h = harness({
    flavor: "public",
    fake: siteFake(),
    limits: { ACTION_DEADLINE_MS: 5 },
  });
  h.fake.failNext({ hang: true }, 1);
  await assert.rejects(
    () =>
      h.adapter.executeAction(actionInput("wordpress.browse", {}, wpConfig())),
    (error: unknown) =>
      error instanceof WordPressAdapterError &&
      error.code === "WORDPRESS_SITE_UNREACHABLE",
  );
  assert.equal(h.opened(), 1);
  assert.equal(h.closed(), 1);
});

test("the application password never appears in a result, an error or a log", async () => {
  const h = harness({
    flavor: "login",
    fake: siteFake({ credential: CREDENTIAL }),
  });
  const token = credentialToken();
  const seen: string[] = [];
  const pages = await collect(
    h.adapter.discoverPages!(baseInput(wpConfig([]), token)),
  );
  seen.push(JSON.stringify(pages));
  const browse = await h.adapter.executeAction(
    actionInput("wordpress_login.browse", {}, wpConfig(), token),
  );
  seen.push(JSON.stringify(browse));
  // A failing operation's error message too.
  const bad = harness({
    flavor: "login",
    fake: siteFake({ loginRequired: true }),
  });
  try {
    await collect(
      bad.adapter.discoverPages!(baseInput(wpConfig(sel("type:post")), token)),
    );
  } catch (error) {
    seen.push(error instanceof Error ? error.message : String(error));
  }
  seen.push(JSON.stringify(h.warnings), JSON.stringify(bad.warnings));
  for (const text of seen) {
    assert.ok(!text.includes(CREDENTIAL.secret), text);
  }
});
