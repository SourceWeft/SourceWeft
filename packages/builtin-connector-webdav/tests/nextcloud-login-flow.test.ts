import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { createWebdavAdapter } from "../src/adapter";
import { webdavFlavor } from "../src/flavor";
import { nextcloudFlavor } from "../src/nextcloud/flavor";
import { createNextcloudCredentialFlow } from "../src/nextcloud/login-flow";
import {
  builtinWebDavConnectorCapabilityManifest,
  nextcloudConnectorContribution,
  toBackendNextcloudManifest,
} from "../src";
import { fakeHarness } from "./fake-dav";

// Secrets are given recognisable markers so a leak into an error, its stack, or
// a logger call is unmistakable.
const SERVER = "https://cloud.example.com";
const POLL_TOKEN = "poll-token-SECRET-xyzzy";
const APP_PASSWORD = "app-pw-SECRET-plugh";
const LOGIN_NAME = "alice@login-SECRET";
const BODY_SENTINEL = "SERVER-BODY-SENTINEL-leak";

/** The host's endpoint-policy refusal (a blocked address or a cross-origin
 * redirect): the scope's fetch throws this; the adapter duck-types the code. */
class EndpointNotAllowedError extends Error {
  readonly code = "ENDPOINT_NOT_ALLOWED";
  constructor() {
    super("endpoint not allowed");
    this.name = "EndpointNotAllowedError";
  }
}

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

type FakeConfig = {
  server?: string;
  login?: string;
  pollEndpoint?: string;
  pollToken?: string;
  pendingPolls?: number;
  authorized?: { server?: string; loginName?: string; appPassword?: string };
  userId?: string;
  start?: { status?: number; body?: string; throw?: "blocked" | "network" };
  ocs?: { status?: number; body?: string };
  del?: { status?: number; throw?: "blocked" | "network" };
};

function recordHeaders(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/**
 * An in-memory fake Nextcloud server behind a fake `fetch`: Login Flow v2
 * `start`/`poll`, the OCS `cloud/user` lookup and the OCS `apppassword` delete.
 * Every request is recorded (url, method, headers, body) so a test can prove
 * where credentials went and what was sent. Error injections cover a missing
 * endpoint, a 5xx, a blocked address, a network error and a malformed body.
 */
function buildFakeNextcloud(config: FakeConfig = {}): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const server = config.server ?? SERVER;
  const login = config.login ?? `${server}/index.php/login/v2/flow/opaque`;
  const pollEndpoint =
    config.pollEndpoint ?? `${server}/index.php/login/v2/poll`;
  const pollToken = config.pollToken ?? POLL_TOKEN;
  const authorized = {
    server: config.authorized?.server ?? server,
    loginName: config.authorized?.loginName ?? LOGIN_NAME,
    appPassword: config.authorized?.appPassword ?? APP_PASSWORD,
  };
  const userId = config.userId ?? "alice";
  const pendingPolls = config.pendingPolls ?? 0;
  const pollPath = new URL(pollEndpoint).pathname;
  const calls: RecordedCall[] = [];
  let pollSeen = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method, headers: recordHeaders(init), body });
    const path = new URL(url).pathname;

    if (method === "POST" && path.endsWith("/index.php/login/v2")) {
      if (config.start?.throw === "blocked")
        throw new EndpointNotAllowedError();
      if (config.start?.throw === "network")
        throw new TypeError("fetch failed");
      const responseBody =
        config.start?.body ??
        JSON.stringify({
          poll: { token: pollToken, endpoint: pollEndpoint },
          login,
        });
      return new Response(responseBody, {
        status: config.start?.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "POST" && path === pollPath) {
      pollSeen += 1;
      if (pollSeen <= pendingPolls) {
        return new Response("not yet", { status: 404 });
      }
      return new Response(JSON.stringify(authorized), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "GET" && path.endsWith("/ocs/v1.php/cloud/user")) {
      const responseBody =
        config.ocs?.body ?? JSON.stringify({ ocs: { data: { id: userId } } });
      return new Response(responseBody, {
        status: config.ocs?.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "DELETE" && path.endsWith("/ocs/v2.php/core/apppassword")) {
      if (config.del?.throw === "blocked") throw new EndpointNotAllowedError();
      if (config.del?.throw === "network") throw new TypeError("fetch failed");
      return new Response("", { status: config.del?.status ?? 200 });
    }

    return new Response("unexpected", { status: 418 });
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}

function flowFor(
  config: FakeConfig = {},
  seams: { maxResponseBytes?: number; requestTimeoutMs?: number } = {},
) {
  const fake = buildFakeNextcloud(config);
  const harness = fakeHarness(fake.fetch);
  const flow = createNextcloudCredentialFlow({
    credentialedFetch: harness.credentialedFetch,
    maxResponseBytes: seams.maxResponseBytes,
    requestTimeoutMs: seams.requestTimeoutMs,
  });
  return { flow, harness, calls: fake.calls };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection but the promise resolved");
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
): Promise<Error> {
  const error = await captureError(promise);
  assert.equal((error as { code?: unknown }).code, code);
  return error as Error;
}

function serializeError(error: unknown): string {
  const err = (error ?? {}) as Error & Record<string, unknown>;
  return [
    err.name,
    err.message,
    String((err as { code?: unknown }).code),
    err.stack,
    JSON.stringify(err, Object.getOwnPropertyNames(err)),
  ].join("\n");
}

// --- start ------------------------------------------------------------------

test("start posts to login/v2 with the SourceWeft user agent and an empty body", async () => {
  const { flow, calls } = flowFor();
  const started = await flow.start({ serverUrl: SERVER, config: {} });
  assert.equal(started.loginUrl, `${SERVER}/index.php/login/v2/flow/opaque`);
  assert.deepEqual(started.pending, {
    pollEndpoint: `${SERVER}/index.php/login/v2/poll`,
    pollToken: POLL_TOKEN,
    server: SERVER,
  });
  const startCall = calls.find((c) => c.method === "POST");
  assert.ok(startCall);
  assert.equal(new URL(startCall.url).pathname, "/index.php/login/v2");
  assert.equal(startCall.headers["user-agent"], "SourceWeft");
  assert.equal(startCall.body, "");
});

test("start opens and closes exactly one fetch scope", async () => {
  const { flow, harness } = flowFor();
  await flow.start({ serverUrl: SERVER, config: {} });
  assert.equal(harness.state.scopes, 1);
  assert.equal(harness.state.closes, 1);
});

test("start rejects a server url with userinfo, query, fragment or a non-http scheme", async () => {
  for (const bad of [
    "https://user:pass@cloud.example.com",
    "https://cloud.example.com/?a=1",
    "https://cloud.example.com/#frag",
    "ftp://cloud.example.com",
    "not a url",
    "",
  ]) {
    const { flow } = flowFor();
    await rejectsWithCode(
      flow.start({ serverUrl: bad, config: {} }),
      "NEXTCLOUD_LOGIN_FLOW_INVALID",
    );
  }
});

test("start rejects a login url on another origin", async () => {
  const { flow } = flowFor({ login: "https://evil.example.com/flow" });
  await rejectsWithCode(
    flow.start({ serverUrl: SERVER, config: {} }),
    "NEXTCLOUD_LOGIN_FLOW_INVALID",
  );
});

test("start rejects a poll endpoint on another origin", async () => {
  const { flow } = flowFor({ pollEndpoint: "https://evil.example.com/poll" });
  await rejectsWithCode(
    flow.start({ serverUrl: SERVER, config: {} }),
    "NEXTCLOUD_LOGIN_FLOW_INVALID",
  );
});

test("a missing login/v2 endpoint (404/405) is unsupported", async () => {
  for (const status of [404, 405]) {
    const { flow } = flowFor({ start: { status } });
    await rejectsWithCode(
      flow.start({ serverUrl: SERVER, config: {} }),
      "NEXTCLOUD_LOGIN_FLOW_UNSUPPORTED",
    );
  }
});

test("a 5xx or a network error on start is unreachable", async () => {
  const five = flowFor({ start: { status: 503 } });
  await rejectsWithCode(
    five.flow.start({ serverUrl: SERVER, config: {} }),
    "NEXTCLOUD_UNREACHABLE",
  );
  const net = flowFor({ start: { throw: "network" } });
  await rejectsWithCode(
    net.flow.start({ serverUrl: SERVER, config: {} }),
    "NEXTCLOUD_UNREACHABLE",
  );
});

test("an endpoint-policy refusal on start is a blocked endpoint", async () => {
  const { flow } = flowFor({ start: { throw: "blocked" } });
  const error = await rejectsWithCode(
    flow.start({ serverUrl: SERVER, config: {} }),
    "NEXTCLOUD_BLOCKED_ENDPOINT",
  );
  assert.equal((error as { statusCode?: number }).statusCode, 422);
});

test("a non-JSON login/v2 body is invalid", async () => {
  const { flow } = flowFor({ start: { body: "<html>not json</html>" } });
  await rejectsWithCode(
    flow.start({ serverUrl: SERVER, config: {} }),
    "NEXTCLOUD_LOGIN_FLOW_INVALID",
  );
});

test("an oversize response body is invalid", async () => {
  const { flow } = flowFor({}, { maxResponseBytes: 8 });
  await rejectsWithCode(
    flow.start({ serverUrl: SERVER, config: {} }),
    "NEXTCLOUD_LOGIN_FLOW_INVALID",
  );
});

// --- poll -------------------------------------------------------------------

test("poll authorizes after two pending polls and resolves an encoded files user id", async () => {
  const { flow, harness } = flowFor({
    pendingPolls: 2,
    userId: "alicé",
  });
  const started = await flow.start({ serverUrl: SERVER, config: {} });
  const first = await flow.poll({ pending: started.pending });
  assert.equal(first.status, "pending");
  const second = await flow.poll({ pending: started.pending });
  assert.equal(second.status, "pending");
  const third = await flow.poll({ pending: started.pending });
  assert.equal(third.status, "authorized");
  if (third.status !== "authorized") return;
  // The WebDAV Basic-auth username is the LOGIN NAME, not the files user id.
  assert.deepEqual(third.credential, {
    username: LOGIN_NAME,
    secret: APP_PASSWORD,
  });
  assert.deepEqual(third.config, {
    server: SERVER,
    endpoint: `${SERVER}/remote.php/dav/files/alic%C3%A9/`,
    userId: "alicé",
  });
  // One scope per call, all closed: 1 start + 3 polls.
  assert.equal(harness.state.scopes, 4);
  assert.equal(harness.state.closes, 4);
});

test("a sub-folder install keeps the base path and strips a trailing slash", async () => {
  const server = "https://host.example/nextcloud";
  const { flow, calls } = flowFor({ server });
  const started = await flow.start({ serverUrl: `${server}/`, config: {} });
  assert.equal(started.pending.server, server);
  const startCall = calls.find((c) => c.method === "POST");
  assert.ok(startCall);
  assert.equal(
    new URL(startCall.url).pathname,
    "/nextcloud/index.php/login/v2",
  );
  const result = await flow.poll({ pending: started.pending });
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") return;
  assert.equal(result.config.server, server);
  assert.equal(result.config.endpoint, `${server}/remote.php/dav/files/alice/`);
});

test("poll rejects an authorized server on another origin", async () => {
  const { flow } = flowFor({
    authorized: { server: "https://evil.example.com" },
  });
  const started = await flow.start({ serverUrl: SERVER, config: {} });
  await rejectsWithCode(
    flow.poll({ pending: started.pending }),
    "NEXTCLOUD_LOGIN_FLOW_INVALID",
  );
});

test("poll fails invalid when the OCS user id is missing or malformed", async () => {
  for (const body of [
    JSON.stringify({ ocs: { data: { id: "" } } }),
    JSON.stringify({ ocs: { data: {} } }),
    JSON.stringify({ ocs: { data: { id: "a/b" } } }),
    "not json",
  ]) {
    const { flow } = flowFor({ ocs: { body } });
    const started = await flow.start({ serverUrl: SERVER, config: {} });
    await rejectsWithCode(
      flow.poll({ pending: started.pending }),
      "NEXTCLOUD_LOGIN_FLOW_INVALID",
    );
  }
});

test("poll is unreachable when the OCS endpoint returns 5xx", async () => {
  const { flow } = flowFor({ ocs: { status: 502 } });
  const started = await flow.start({ serverUrl: SERVER, config: {} });
  await rejectsWithCode(
    flow.poll({ pending: started.pending }),
    "NEXTCLOUD_UNREACHABLE",
  );
});

test("poll sends the token form body and sends credentials only to the server origin", async () => {
  const { flow, calls } = flowFor();
  const started = await flow.start({ serverUrl: SERVER, config: {} });
  const result = await flow.poll({ pending: started.pending });
  assert.equal(result.status, "authorized");
  const serverOrigin = new URL(SERVER).origin;
  // No request that carries a credential leaves the server's own origin.
  for (const call of calls) {
    if (call.headers["authorization"] !== undefined) {
      assert.equal(new URL(call.url).origin, serverOrigin);
    }
  }
  // The poll POST carries the token (urlencoded) and no credential.
  const pollCall = calls.find(
    (c) => c.method === "POST" && c.url.includes("/login/v2/poll"),
  );
  assert.ok(pollCall);
  assert.equal(pollCall.headers["authorization"], undefined);
  assert.equal(
    pollCall.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(pollCall.body, `token=${POLL_TOKEN}`);
  // The OCS lookup carries Basic auth to the server origin.
  const ocsCall = calls.find(
    (c) => c.method === "GET" && c.url.includes("/ocs/v1.php/cloud/user"),
  );
  assert.ok(ocsCall);
  assert.ok(ocsCall.headers["authorization"]?.startsWith("Basic "));
  assert.equal(ocsCall.headers["ocs-apirequest"], "true");
});

// --- discard ----------------------------------------------------------------

test("discard sends a DELETE with Basic auth and the OCS header, and swallows failures", async () => {
  const ok = flowFor();
  await ok.flow.discard!({
    config: { server: SERVER },
    credential: { username: LOGIN_NAME, secret: APP_PASSWORD },
  });
  const del = ok.calls.find((c) => c.method === "DELETE");
  assert.ok(del);
  assert.ok(del.url.endsWith("/ocs/v2.php/core/apppassword"));
  assert.equal(new URL(del.url).origin, new URL(SERVER).origin);
  assert.ok(del.headers["authorization"]?.startsWith("Basic "));
  assert.equal(del.headers["ocs-apirequest"], "true");

  const failing = flowFor({ del: { status: 500 } });
  await assert.doesNotReject(
    failing.flow.discard!({
      config: { server: SERVER },
      credential: { username: LOGIN_NAME, secret: APP_PASSWORD },
    }),
  );
  const throwing = flowFor({ del: { throw: "network" } });
  await assert.doesNotReject(
    throwing.flow.discard!({
      config: { server: SERVER },
      credential: { username: LOGIN_NAME, secret: APP_PASSWORD },
    }),
  );
});

// --- secret hygiene ---------------------------------------------------------

test("no thrown error, its serialization or a logger call carries a secret", async () => {
  const errors: unknown[] = [];
  // OCS returns a bad id: the login name and app password are in scope and the
  // poll token is in `pending` — none may reach the error.
  {
    const { flow } = flowFor({
      ocs: { body: JSON.stringify({ ocs: { data: { id: "" } } }) },
    });
    const started = await flow.start({ serverUrl: SERVER, config: {} });
    errors.push(await captureError(flow.poll({ pending: started.pending })));
  }
  // A non-JSON start body carrying a sentinel must not reach the error.
  {
    const { flow } = flowFor({ start: { body: `${BODY_SENTINEL} <<<` } });
    errors.push(
      await captureError(flow.start({ serverUrl: SERVER, config: {} })),
    );
  }
  {
    const { flow } = flowFor({ start: { status: 500 } });
    errors.push(
      await captureError(flow.start({ serverUrl: SERVER, config: {} })),
    );
  }
  for (const error of errors) {
    const serialized = serializeError(error);
    for (const secret of [
      POLL_TOKEN,
      APP_PASSWORD,
      LOGIN_NAME,
      BODY_SENTINEL,
    ]) {
      assert.ok(!serialized.includes(secret), `error leaked "${secret}"`);
    }
  }

  // The adapter-wired flow never calls the logger across a full run.
  const fake = buildFakeNextcloud({ pendingPolls: 1 });
  const harness = fakeHarness(fake.fetch);
  const adapter = createWebdavAdapter({
    credentialedFetch: harness.credentialedFetch,
    logger: harness.logger,
    flavor: nextcloudFlavor,
  });
  const flow = adapter.credentialFlow!;
  const started = await flow.start({ serverUrl: SERVER, config: {} });
  await flow.poll({ pending: started.pending });
  await flow.poll({ pending: started.pending });
  await flow.discard!({
    config: { server: SERVER },
    credential: { username: LOGIN_NAME, secret: APP_PASSWORD },
  });
  assert.deepEqual(harness.warnings, []);
});

// --- wiring and manifest ----------------------------------------------------

test("the nextcloud adapter exposes credentialFlow and the webdav adapter does not", () => {
  const harness = fakeHarness(
    (async () => new Response("", { status: 200 })) as typeof fetch,
  );
  const nc = createWebdavAdapter({
    credentialedFetch: harness.credentialedFetch,
    flavor: nextcloudFlavor,
  });
  const dav = createWebdavAdapter({
    credentialedFetch: harness.credentialedFetch,
    flavor: webdavFlavor,
  });
  assert.equal(typeof nc.credentialFlow?.start, "function");
  assert.equal(typeof nc.credentialFlow?.poll, "function");
  assert.equal(typeof nc.credentialFlow?.discard, "function");
  assert.equal(dav.credentialFlow, undefined);
  // The adapter hook and the manifest flag agree (the registry rule is
  // bidirectional): the login-flow flag is present exactly when the hook is.
  assert.equal((nc.getManifest().auth as { flow?: string }).flow, "login_flow");
  assert.equal((dav.getManifest().auth as { flow?: string }).flow, undefined);
});

test("the nextcloud manifest and capability JSON declare the login_flow auth", async () => {
  assert.equal(nextcloudConnectorContribution.auth.flow, "login_flow");
  assert.deepEqual(toBackendNextcloudManifest().auth, {
    kind: "credential",
    scheme: "basic",
    flow: "login_flow",
  });
  const { raw } = await loadCapabilityManifestFixture(
    new URL("../", import.meta.url),
  );
  assert.deepEqual(raw, builtinWebDavConnectorCapabilityManifest);
  const nc = (
    raw as { connectors: Array<{ id: string; auth: unknown }> }
  ).connectors.find((c) => c.id === "nextcloud");
  assert.deepEqual(nc?.auth, {
    kind: "credential",
    scheme: "basic",
    flow: "login_flow",
  });
});
