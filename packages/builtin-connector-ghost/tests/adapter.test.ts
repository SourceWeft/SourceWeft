import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorItemSkipError,
  type ConnectorActionInput,
  type ConnectorAdapter,
  type ConnectorDiscoverInput,
  type ConnectorDiscoveryPage,
  type ConnectorExtractInput,
  type ConnectorItem,
} from "@sourceweft/contracts";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { createGhostAdapter, type GhostAdapterLimits } from "../src/adapter";
import { GhostAdapterError, mapGhostError } from "../src/adapter-error";
import { GHOST_ERROR_MESSAGES, GhostError } from "../src/errors";
import { ghostCredentialIdentity } from "../src/identity";
import {
  createFakeGhost,
  DEFAULT_KEY,
  hexId,
  sampleState,
  type FakeGhost,
  type FakeGhostOptions,
} from "./helpers/fake-ghost";
import { hostLikeScope } from "./helpers/host-scope";

const SITE = "https://site.example";
const KEY = DEFAULT_KEY;
const WRONG_KEY = "ffffffffffffffffffffffffff";

const token = (secret = KEY) => JSON.stringify({ username: "ghost", secret });
const config = (items: unknown[] = []): Record<string, unknown> => ({
  siteUrl: SITE,
  items,
});

type Logged = { message: string; meta: Record<string, unknown> | undefined };

type Harness = {
  adapter: ConnectorAdapter;
  fake: FakeGhost;
  scopes: { opened: number; closed: number };
  logs: Logged[];
};

function harness(
  options: {
    fake?: Partial<FakeGhostOptions>;
    state?: ReturnType<typeof sampleState>;
    limits?: GhostAdapterLimits;
    wrapScope?: (fake: FakeGhost) => ConnectorPublicFetchScope;
  } = {},
): Harness {
  const fake = createFakeGhost({
    siteBase: SITE,
    key: KEY,
    ...(options.state ?? sampleState()),
    ...options.fake,
  });
  const scopes = { opened: 0, closed: 0 };
  const logs: Logged[] = [];
  const adapter = createGhostAdapter({
    credentialedFetch: () => {
      scopes.opened += 1;
      const inner =
        options.wrapScope?.(fake) ??
        ({ fetch: fake.fetch, close: async () => undefined } as const);
      return {
        fetch: inner.fetch,
        close: async () => {
          scopes.closed += 1;
          await inner.close();
        },
      };
    },
    logger: {
      warn: (message, meta) => logs.push({ message, meta }),
    },
    limits: { minRequestGapMs: 0, maxRetryDelayMs: 0, ...options.limits },
  });
  return { adapter, fake, scopes, logs };
}

const base = {
  teamId: "t",
  workspaceId: "w",
  connectorId: "c",
  connectorType: "ghost",
} as const;

const discoverInput = (
  items: unknown[] = [],
  accessToken = token(),
  cfg: Record<string, unknown> = config(items),
): ConnectorDiscoverInput => ({ ...base, config: cfg, accessToken });

const actionInput = (
  actionType: string,
  request: Record<string, unknown>,
  accessToken = token(),
  cfg: Record<string, unknown> = config(),
): ConnectorActionInput => ({
  ...base,
  actionType,
  request,
  config: cfg,
  accessToken,
  idempotencyKey: "k",
});

async function collect(
  adapter: ConnectorAdapter,
  input: ConnectorDiscoverInput,
): Promise<ConnectorItem[]> {
  const out: ConnectorItem[] = [];
  for await (const item of adapter.discover(input)) out.push(item);
  return out;
}

async function collectPages(
  adapter: ConnectorAdapter,
  input: ConnectorDiscoverInput,
): Promise<ConnectorDiscoveryPage[]> {
  const out: ConnectorDiscoveryPage[] = [];
  for await (const page of adapter.discoverPages!(input)) out.push(page);
  return out;
}

async function adapterError(
  promise: Promise<unknown>,
): Promise<GhostAdapterError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GhostAdapterError, String(error));
    return error;
  }
  assert.fail("expected a GhostAdapterError");
}

function assertNoKey(value: unknown): void {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, jsonReplacer);
  assert.ok(!text.includes(KEY), "the key must not appear");
  assert.ok(!text.includes(WRONG_KEY), "the stored key must not appear");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error
    ? { ...value, name: value.name, message: value.message }
    : value;
}

// ------------------------------------------------------------ identity

test("the adapter identifies itself and has no OAuth or webhook surface", () => {
  const { adapter } = harness();
  assert.equal(adapter.capabilityId, "sourceweft/ghost");
  const manifest = adapter.getManifest();
  assert.equal(manifest.type, "ghost");
  assert.deepEqual(manifest.auth, { kind: "credential", scheme: "api_key" });
  assert.equal(typeof adapter.credentialIdentity, "function");
  for (const absent of [
    "exchangeOAuthCode",
    "refreshOAuthToken",
    "credentialFlow",
    "startAuthorization",
    "finishAuthorization",
    "revokeAuthorization",
    "verifyWebhook",
    "parseWebhookEvent",
    "mapWebhookEventToSyncTargets",
  ] as const) {
    assert.equal(absent in adapter, false, absent);
  }
});

test("the credential identity follows the site and survives a key rotation", () => {
  const { adapter } = harness();
  const identity = adapter.credentialIdentity!;
  const credential = { username: "ghost", secret: KEY };
  const a = identity(config(), credential);
  assert.equal(a, ghostCredentialIdentity(config(), credential));
  assert.equal(identity(config(), { username: "x", secret: WRONG_KEY }), a);
  assert.notEqual(
    identity({ siteUrl: "https://other.example", items: [] }, credential),
    a,
  );
});

test("an unusable site address in the identity is a 400 adapter error", () => {
  const { adapter } = harness();
  assert.throws(
    () =>
      adapter.credentialIdentity!(
        { siteUrl: "https://localhost" },
        { username: "ghost", secret: KEY },
      ),
    (error: unknown) => {
      assert.ok(error instanceof GhostAdapterError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "GHOST_SITE_URL_INVALID");
      return true;
    },
  );
});

// ----------------------------------------------------------- readiness

test("readiness is ready for a Ghost site and a good key, with an empty selection", async () => {
  const { adapter, fake, scopes } = harness();
  const result = await adapter.checkSyncReadiness!(discoverInput());
  assert.deepEqual(result, { ready: true });
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.path, "/ghost/api/content/settings/");
  assert.deepEqual(scopes, { opened: 1, closed: 1 });
});

test("readiness is ready with a selection and reads nothing but the settings", async () => {
  const { adapter, fake } = harness();
  const result = await adapter.checkSyncReadiness!(
    discoverInput([
      { id: "type:post", kind: "type" },
      { id: `tag:${hexId(0x101)}`, kind: "tag" },
    ]),
  );
  assert.equal(result.ready, true);
  assert.equal(fake.requests.length, 1);
});

test("a wrong key is not ready and asks to reconnect", async () => {
  const { adapter, logs } = harness();
  const result = await adapter.checkSyncReadiness!(
    discoverInput([], token(WRONG_KEY)),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "reauth_required");
  assert.equal(result.message, GHOST_ERROR_MESSAGES.BAD_CREDENTIALS);
  assertNoKey(result);
  assertNoKey(logs);
});

test("a malformed stored credential is a reconnect condition before any request", async () => {
  const { adapter, fake, scopes } = harness();
  for (const accessToken of ["nope", "{}", JSON.stringify({ secret: "" })]) {
    const result = await adapter.checkSyncReadiness!(
      discoverInput([], accessToken),
    );
    assert.equal(result.reason, "reauth_required");
  }
  assert.equal(fake.requests.length, 0);
  assert.equal(scopes.opened, 0);
});

test("a site that is not Ghost is not ready (HTML 200 and 404)", async () => {
  for (const notGhost of ["html", "not-found"] as const) {
    const { adapter } = harness({ fake: { notGhost } });
    const result = await adapter.checkSyncReadiness!(discoverInput());
    assert.equal(result.ready, false, notGhost);
    assert.equal(result.reason, "not_a_ghost_site", notGhost);
    assert.equal(result.message, GHOST_ERROR_MESSAGES.NOT_A_GHOST_SITE);
  }
});

test("a redirect is not ready (blocked endpoint) and is not followed", async () => {
  const { adapter, fake } = harness();
  fake.redirectNext(`https://evil.example/?key=${KEY}`, 5, 302);
  const result = await adapter.checkSyncReadiness!(discoverInput());
  assert.equal(result.ready, false);
  assert.equal(result.reason, "blocked_endpoint");
  assert.equal(fake.requests.length, 1);
  assert.ok(fake.requests.every((r) => r.host === "site.example"));
  assertNoKey(result);
});

test("readiness names rate limiting, an unreachable site and a bad answer", async () => {
  {
    const h = harness();
    h.fake.rateLimitNext(0, 10);
    const r = await h.adapter.checkSyncReadiness!(discoverInput());
    assert.equal(r.reason, "rate_limited");
  }
  {
    const h = harness();
    h.fake.failNext({ networkError: true }, 10);
    const r = await h.adapter.checkSyncReadiness!(discoverInput());
    assert.equal(r.reason, "unreachable");
  }
  {
    const h = harness();
    h.fake.failNext({ status: 418 });
    const r = await h.adapter.checkSyncReadiness!(discoverInput());
    assert.equal(r.reason, "unreachable");
  }
});

test("readiness reports an invalid configuration without opening a scope", async () => {
  const { adapter, scopes, fake } = harness();
  for (const cfg of [
    { siteUrl: "http://site.example", items: [] },
    { siteUrl: "https://localhost", items: [] },
    { items: [] },
    { siteUrl: SITE, items: "all" },
    { siteUrl: SITE, items: [null] },
    // The kind must be the id's own prefix.
    { siteUrl: SITE, items: [{ id: `tag:${hexId(1)}`, kind: "post" }] },
    { siteUrl: SITE, items: [{ id: "type:post", kind: "tag" }] },
    { siteUrl: SITE, items: [{ id: "tag:123", kind: "tag" }] },
    { siteUrl: SITE, items: [{ id: "type:tag", kind: "type" }] },
    { siteUrl: SITE, items: [{ id: "type:post", kind: "other" }] },
    {
      siteUrl: SITE,
      items: [
        { id: "type:post", kind: "type" },
        { id: "type:post", kind: "type" },
      ],
    },
    {
      siteUrl: SITE,
      items: Array.from({ length: 501 }, (_, i) => ({
        id: `post:${hexId(i + 1)}`,
        kind: "post",
      })),
    },
  ]) {
    const result = await adapter.checkSyncReadiness!(
      discoverInput([], token(), cfg),
    );
    assert.equal(result.ready, false, JSON.stringify(cfg).slice(0, 80));
    assert.equal(result.reason, "config_invalid");
    assert.ok(!(result.message ?? "").includes("site.example"));
  }
  assert.equal(scopes.opened, 0);
  assert.equal(fake.requests.length, 0);
});

test("readiness closes its scope after a failure too", async () => {
  const { adapter, scopes } = harness({ fake: { notGhost: "html" } });
  await adapter.checkSyncReadiness!(discoverInput());
  assert.deepEqual(scopes, { opened: 1, closed: 1 });
});

// ---------------------------------------------------- discover / extract

test("discover yields the readable posts and pages and logs the skipped count", async () => {
  const { adapter, logs, scopes } = harness();
  const items = await collect(adapter, discoverInput());
  assert.deepEqual(
    items.map((i) => i.externalId),
    [
      `ghost:page:${hexId(3)}`,
      `ghost:post:${hexId(1)}`,
      `ghost:post:${hexId(2)}`,
    ],
  );
  assert.equal(items[0]!.mimeType, "text/markdown");
  assert.deepEqual(scopes, { opened: 1, closed: 1 });
  // The members-only post is counted in a fixed-format warning.
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.message, "ghost_scan_warning");
  assert.match(String(logs[0]!.meta?.warning), /skipped.*: 1$/);
  assertNoKey(logs);
});

test("discoverPages yields exactly one authoritative page without warnings", async () => {
  const { adapter } = harness();
  const pages = await collectPages(adapter, discoverInput());
  assert.equal(pages.length, 1);
  const page = pages[0]!;
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
  assert.equal(page.checkpoint, null);
  assert.equal(page.items.length, 3);
  assert.equal("warnings" in page, false);
  assert.deepEqual(Object.keys(page).sort(), [
    "checkpoint",
    "complete",
    "items",
    "reconcileMissing",
  ]);
});

test("an incomplete scan is logged, yields an empty non-reconciling page and succeeds", async () => {
  const { adapter, logs } = harness({ limits: { MAX_ITEMS: 1 } });
  const pages = await collectPages(adapter, discoverInput());
  assert.equal(pages[0]!.reconcileMissing, false);
  assert.deepEqual(pages[0]!.items, []);
  assert.equal(logs.length, 1);
  assert.match(String(logs[0]!.meta?.warning), /Narrow your selection/);
});

test("discover honours the selection (a tag)", async () => {
  const { adapter } = harness();
  const items = await collect(
    adapter,
    discoverInput([{ id: `tag:${hexId(0x102)}`, kind: "tag" }]),
  );
  assert.deepEqual(
    items.map((i) => i.externalId),
    [`ghost:post:${hexId(2)}`],
  );
});

test("extract round-trips an item with the scan's hash", async () => {
  const { adapter } = harness();
  const [item] = await collect(adapter, discoverInput());
  const input: ConnectorExtractInput = { ...discoverInput(), item: item! };
  const out = (await adapter.extract(input)) as {
    item: ConnectorItem;
    contentText: string;
  };
  assert.equal(out.item.externalId, item!.externalId);
  assert.equal(out.item.contentHash, item!.contentHash);
  assert.match(out.contentText, /^# /);
});

test("extract skips a members-only or missing item as unreadable and closes the scope", async () => {
  const { adapter, scopes } = harness();
  const [item] = await collect(adapter, discoverInput());
  for (const id of [`ghost:post:${hexId(4)}`, `ghost:post:${hexId(0x777)}`]) {
    await assert.rejects(
      adapter.extract({
        ...discoverInput(),
        item: { ...item!, externalId: id },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorItemSkipError);
        assert.equal(error.reason, "unreadable");
        return true;
      },
    );
  }
  assert.equal(scopes.opened, scopes.closed);
});

test("an extract failure crosses the boundary as a fixed adapter error", async () => {
  const { adapter } = harness();
  const [item] = await collect(adapter, discoverInput());
  const error = await adapterError(
    adapter.extract({
      ...discoverInput([], token(WRONG_KEY)),
      item: item!,
    }),
  );
  assert.equal(error.statusCode, 422);
  assert.equal(error.code, "GHOST_REAUTH_REQUIRED");
  assert.ok(error.code.endsWith("_REAUTH_REQUIRED"));
  assert.equal(error.cause, undefined);
  assertNoKey(error);
});

// -------------------------------------------------------- error mapping

test("every Ghost error crosses as a prefixed fixed adapter error; a bad key is a reauth", () => {
  const codes = Object.keys(GHOST_ERROR_MESSAGES) as Array<
    keyof typeof GHOST_ERROR_MESSAGES
  >;
  for (const code of codes) {
    const source = new GhostError(code);
    try {
      mapGhostError(source);
      assert.fail("must throw");
    } catch (error) {
      assert.ok(error instanceof GhostAdapterError);
      assert.equal(error.cause, undefined);
      if (code === "BAD_CREDENTIALS") {
        assert.equal(error.statusCode, 422);
        assert.equal(error.code, "GHOST_REAUTH_REQUIRED");
        assert.equal(error.message, GHOST_ERROR_MESSAGES.BAD_CREDENTIALS);
      } else {
        assert.equal(error.statusCode, source.status);
        assert.equal(error.code, `GHOST_${code}`);
        assert.equal(error.message, source.message);
      }
    }
  }
  const other = new Error("boom");
  assert.throws(
    () => mapGhostError(other),
    (error: unknown) => error === other,
  );
});

test("discovery maps a Ghost failure and closes the scope", async () => {
  // A list route that answers 404 is a bad answer, not an empty list (readiness
  // is where a missing Content API is told apart).
  const expected = {
    html: "GHOST_NOT_A_GHOST_SITE",
    "not-found": "GHOST_BAD_RESPONSE",
  } as const;
  for (const notGhost of ["html", "not-found"] as const) {
    const { adapter, scopes } = harness({ fake: { notGhost } });
    const error = await adapterError(collect(adapter, discoverInput()));
    assert.equal(error.code, expected[notGhost]);
    assert.equal(error.statusCode, notGhost === "html" ? 422 : 502);
    assert.deepEqual(scopes, { opened: 1, closed: 1 });
  }
  const { adapter, scopes } = harness();
  const error = await adapterError(
    collectPages(adapter, discoverInput([], token(WRONG_KEY))),
  );
  assert.equal(error.code, "GHOST_REAUTH_REQUIRED");
  assert.deepEqual(scopes, { opened: 1, closed: 1 });
});

test("a consumer that stops early still closes the scope", async () => {
  const { adapter, scopes } = harness();
  for await (const _item of adapter.discover(discoverInput())) break;
  assert.deepEqual(scopes, { opened: 1, closed: 1 });
  for await (const _page of adapter.discoverPages!(discoverInput())) break;
  assert.deepEqual(scopes, { opened: 2, closed: 2 });
});

test("an invalid configuration is a 400 adapter error and opens no scope", async () => {
  const { adapter, scopes, fake } = harness();
  const cfg = {
    siteUrl: SITE,
    items: [{ id: `tag:${hexId(1)}`, kind: "post" }],
  };
  const e1 = await adapterError(
    collect(adapter, discoverInput([], token(), cfg)),
  );
  assert.equal(e1.code, "GHOST_CONFIG_INVALID");
  assert.equal(e1.statusCode, 400);
  const [item] = await collect(adapter, discoverInput());
  const e2 = await adapterError(
    adapter.extract({ ...discoverInput([], token(), cfg), item: item! }),
  );
  assert.equal(e2.code, "GHOST_CONFIG_INVALID");
  const e3 = await adapterError(
    adapter.executeAction(actionInput("ghost.browse", {}, token(), cfg)),
  );
  assert.equal(e3.code, "GHOST_CONFIG_INVALID");
  const badSite = await adapterError(
    collect(
      adapter,
      discoverInput([], token(), { siteUrl: "http://site.example", items: [] }),
    ),
  );
  assert.equal(badSite.code, "GHOST_SITE_URL_INVALID");
  assert.equal(badSite.statusCode, 400);
  // Only the one good discovery above opened a scope.
  assert.equal(scopes.opened, 1);
  assert.equal(scopes.closed, 1);
  assert.ok(fake.requests.every((r) => r.path.startsWith("/ghost/api/")));
});

// ------------------------------------------------------------- actions

test("browse, search and describe run through executeAction", async () => {
  const { adapter, scopes } = harness();
  const browse = await adapter.executeAction(actionInput("ghost.browse", {}));
  const entries = (browse.result as { entries: Array<{ id: string }> }).entries;
  assert.equal(entries[0]!.id, "type:post");
  assert.equal(entries.length, 4);

  const search = await adapter.executeAction(
    actionInput("ghost.search", { query: "Fir" }),
  );
  assert.deepEqual(
    (search.result as { entries: Array<{ id: string }> }).entries.map(
      (e) => e.id,
    ),
    [`post:${hexId(1)}`],
  );

  const describe = await adapter.executeAction(
    actionInput("ghost.describe", {
      ids: ["type:page", `tag:${hexId(0x101)}`, `post:${hexId(0x888)}`],
    }),
  );
  assert.deepEqual(
    (
      describe.result as { items: Array<{ id: string; name: string | null }> }
    ).items.map((i) => [i.id, i.name]),
    [
      ["type:page", "All pages"],
      [`tag:${hexId(0x101)}`, "News"],
    ],
  );
  assert.deepEqual(scopes, { opened: 3, closed: 3 });
});

test("an unsupported action and a bad request are fixed 400 errors", async () => {
  const { adapter } = harness();
  const unsupported = await adapterError(
    adapter.executeAction(actionInput("ghost.publish", {})),
  );
  assert.equal(unsupported.statusCode, 400);
  assert.equal(unsupported.code, "GHOST_UNSUPPORTED_ACTION");
  const bad = await adapterError(
    adapter.executeAction(actionInput("ghost.search", { query: "" })),
  );
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.code, "GHOST_INVALID_REQUEST");
});

test("an action failure is mapped, and the scope is closed after a thrown error", async () => {
  const { adapter, scopes } = harness();
  const error = await adapterError(
    adapter.executeAction(actionInput("ghost.browse", {}, token(WRONG_KEY))),
  );
  assert.equal(error.code, "GHOST_REAUTH_REQUIRED");
  assert.deepEqual(scopes, { opened: 1, closed: 1 });
  await adapterError(
    adapter.executeAction(actionInput("ghost.describe", { ids: [] })),
  );
  assert.deepEqual(scopes, { opened: 2, closed: 2 });
});

test("a selection action and readiness stop at the action deadline", async () => {
  const limits: GhostAdapterLimits = { ACTION_DEADLINE_MS: 25 };
  const a = harness({ limits });
  a.fake.failNext({ hang: true }, 10);
  const error = await adapterError(
    a.adapter.executeAction(actionInput("ghost.browse", {})),
  );
  assert.equal(error.code, "GHOST_SITE_UNREACHABLE");
  assert.deepEqual(a.scopes, { opened: 1, closed: 1 });

  const b = harness({ limits });
  b.fake.failNext({ hang: true }, 10);
  const result = await b.adapter.checkSyncReadiness!(discoverInput());
  assert.equal(result.ready, false);
  assert.equal(result.reason, "unreachable");
  assert.deepEqual(b.scopes, { opened: 1, closed: 1 });
});

// --------------------------------------------------------- the network

test("every request is a manual-redirect GET to the site's own origin, with the key last", async () => {
  const { adapter, fake } = harness();
  await adapter.checkSyncReadiness!(discoverInput());
  await collect(adapter, discoverInput());
  const [item] = await collect(adapter, discoverInput());
  await adapter.extract({ ...discoverInput(), item: item! });
  await adapter.executeAction(actionInput("ghost.browse", {}));
  assert.ok(fake.requests.length > 5);
  for (const request of fake.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.host, "site.example");
    assert.equal(request.redirect, "manual");
    // The operation's own signal reaches the client, so an abort cancels the
    // request in flight.
    assert.ok(request.initKeys.includes("signal"), "signal");
    assert.ok(request.path.startsWith("/ghost/api/content/"));
    assert.ok(request.path.endsWith("/"));
    assert.equal(request.query.key, KEY);
    assert.ok(request.url.endsWith(`key=${KEY}`));
    assert.equal(request.headers.authorization, undefined);
    assert.deepEqual(request.queryAll.key, [KEY]);
  }
});

test("the key reaches no result, error or log line", async () => {
  const h = harness();
  const everything: unknown[] = [];
  everything.push(await h.adapter.checkSyncReadiness!(discoverInput()));
  everything.push(await collectPages(h.adapter, discoverInput()));
  const [item] = await collect(h.adapter, discoverInput());
  everything.push(await h.adapter.extract({ ...discoverInput(), item: item! }));
  everything.push(
    await h.adapter.executeAction(actionInput("ghost.search", { query: "a" })),
  );
  everything.push(
    await adapterError(
      h.adapter.executeAction(
        actionInput("ghost.browse", {}, token(WRONG_KEY)),
      ),
    ),
  );
  everything.push(h.logs);
  assertNoKey(everything);
});

// ----------------------------------------- host-shaped scope: redirects

test("a cross-origin redirect through a host-shaped scope is BLOCKED_ENDPOINT, once, and the key goes nowhere else", async () => {
  const h = harness({
    wrapScope: (fake) => hostLikeScope(fake.fetch),
  });
  h.fake.redirectNext(`https://evil.example/steal?key=${KEY}`, 20, 301);

  const readiness = await h.adapter.checkSyncReadiness!(discoverInput());
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "blocked_endpoint");
  assert.equal(readiness.message, GHOST_ERROR_MESSAGES.BLOCKED_ENDPOINT);
  // Not retried: the policy refusal is final.
  assert.equal(h.fake.requests.length, 1);

  const error = await adapterError(collect(h.adapter, discoverInput()));
  assert.equal(error.code, "GHOST_BLOCKED_ENDPOINT");
  assert.equal(error.statusCode, 422);
  assert.equal(error.cause, undefined);
  assertNoKey(error);
  assert.equal(h.fake.requests.length, 2);

  const action = await adapterError(
    h.adapter.executeAction(actionInput("ghost.browse", {})),
  );
  assert.equal(action.code, "GHOST_BLOCKED_ENDPOINT");

  // The target was never contacted, with or without the key.
  assert.ok(h.fake.requests.every((r) => r.host === "site.example"));
  assert.equal(h.scopes.opened, h.scopes.closed);
  assertNoKey(h.logs);
});

test("a same-origin redirect through a host-shaped scope is also BLOCKED_ENDPOINT", async () => {
  const h = harness({
    wrapScope: (fake) => hostLikeScope(fake.fetch),
  });
  h.fake.redirectNext(`${SITE}/elsewhere/?key=${KEY}`, 5, 302);
  const readiness = await h.adapter.checkSyncReadiness!(discoverInput());
  assert.equal(readiness.reason, "blocked_endpoint");
  assert.equal(h.fake.requests.length, 1);
});

test("a host-shaped scope that denies a plain-http redirect target maps it the same way", async () => {
  const h = harness({
    wrapScope: (fake) => hostLikeScope(fake.fetch),
  });
  h.fake.redirectNext(`http://site.example/x/?key=${KEY}`, 5, 307);
  const readiness = await h.adapter.checkSyncReadiness!(discoverInput());
  assert.equal(readiness.reason, "blocked_endpoint");
});
