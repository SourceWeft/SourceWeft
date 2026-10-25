import assert from "node:assert/strict";
import { test } from "node:test";
import { createNetworkPolicy } from "../src/network-policy.js";
import type { AskHostAnswer, AskHostRequest } from "../src/network-policy.js";
import type { WrapSecret } from "../src/protocol.js";
import { createRequestPolicy } from "../src/request-policy.js";

const REAL = "tok_REAL_0123456789";

const secret = (overrides: Partial<WrapSecret> = {}): WrapSecret => ({
  envVar: "API_TOKEN",
  value: REAL,
  hosts: ["api.example.com"],
  readOnly: true,
  ...overrides,
});

type Rig = ReturnType<typeof makeRig>;

/** The placeholder the sidecar would have minted for `envVar` (a fixed one, so tests can find it). */
const sentinelFor = (envVar: string): string =>
  `fake_value_${envVar.toLowerCase()}-0000-4000-8000-000000000000`;
const placeholders = (secrets: readonly WrapSecret[]): Record<string, string> =>
  Object.fromEntries(secrets.map((entry) => [entry.envVar, sentinelFor(entry.envVar)]));

function registerWith(rig: Rig, commandId: string, secrets: readonly WrapSecret[]): Record<string, string> {
  const env = placeholders(secrets);
  rig.requests.registerCommand(commandId, secrets, env);
  return env;
}

/** A request policy over a real network policy; `askHost` parks until the test answers it. */
function makeRig(options: { askTimeoutMs?: number } = {}) {
  const asks: AskHostRequest[] = [];
  const resolvers: Array<(answer: AskHostAnswer) => void> = [];
  const network = createNetworkPolicy({
    ownAddresses: () => new Set(),
    askHost: (request) => {
      asks.push(request);
      return new Promise<AskHostAnswer>((resolve) => resolvers.push(resolve));
    },
    now: () => 5_000,
    warn: () => {},
    ...options,
  });
  const requests = createRequestPolicy(network);
  network.register("c1", { mode: "open", allow: [] });
  return {
    network,
    requests,
    asks,
    answer: (answer: AskHostAnswer) => {
      const resolve = resolvers.shift();
      assert.ok(resolve, "no ask is waiting");
      resolve(answer);
    },
  };
}

const info = (host: string, port = 443, requestTarget = "/") => ({
  scheme: "https" as const,
  target: { host, port },
  requestTarget,
});

/** Runs the hook for `method url` the way srt's proxy does, after the connection was allowed. */
async function send(rig: Rig, method: string, url: string, over = {}) {
  const parsed = new URL(url);
  const port = parsed.port === "" ? 443 : Number(parsed.port);
  await rig.network.decide({ host: parsed.hostname, port });
  const pending = rig.requests.filterRequest(new Request(url, { method }), {
    ...info(parsed.hostname, port, parsed.pathname + parsed.search),
    ...over,
  });
  return pending;
}

test("every terminated request is allowed and audited with method, host, path and status", async () => {
  const rig = makeRig();
  const decision = await send(rig, "POST", "https://api.example.com/v1/items?token=abc#frag");
  assert.equal(decision.action, "allow");
  decision.onResponse?.(201, {});
  const [connection, request] = rig.network.drainAudit("c1");
  assert.equal(connection?.kind, "connection");
  assert.deepEqual(request, {
    t: 5_000,
    kind: "http",
    host: "api.example.com",
    port: 443,
    decision: "allow",
    source: "open",
    method: "POST",
    path: "/v1/items",
    status: 201,
  });
  assert.equal(rig.asks.length, 0, "no secret is bound, so nothing is asked");
});

test("without proxy info the target comes from the URL", async () => {
  const rig = makeRig();
  await rig.network.decide({ host: "example.com", port: 80 });
  const decision = await rig.requests.filterRequest(new Request("http://example.com/a"));
  decision.onResponse?.(200, {});
  const [, entry] = rig.network.drainAudit("c1");
  assert.deepEqual([entry?.host, entry?.port, entry?.path], ["example.com", 80, "/a"]);
});

test("a request that cannot be attributed is allowed and recorded nowhere", async () => {
  const rig = makeRig();
  rig.network.unregister("c1");
  const decision = await rig.requests.filterRequest(new Request("https://api.example.com/x", { method: "PUT" }));
  assert.deepEqual(decision, { action: "allow" });
});

test("a recording failure never denies a request", async () => {
  const network = createNetworkPolicy({ ownAddresses: () => new Set(), askHost: async () => ({ allow: true }), warn: () => {} });
  const throwing = { ...network, beginHttp: () => { throw new Error("boom"); } };
  const decision = await createRequestPolicy(throwing).filterRequest(new Request("https://example.com/"));
  assert.equal(decision.action, "allow");
});

test("read-only secret host: safe methods pass without an ask", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [secret()]);
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const decision = await send(rig, method, "https://api.example.com/v1/items");
    assert.equal(decision.action, "allow", method);
  }
  assert.equal(rig.asks.length, 0);
});

test("read-only secret host: a write raises one request ask and waits for the answer", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "PURGE"]) {
    const rig = makeRig();
    registerWith(rig, "c1", [secret()]);
    const pending = send(rig, method, `https://api.example.com/v1/items/7?token=abc`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rig.asks.length, 1, method);
    const { signal, ...ask } = rig.asks[0] as AskHostRequest;
    assert.ok(signal);
    assert.deepEqual(ask, {
      commandId: "c1",
      kind: "request",
      host: "api.example.com",
      port: 443,
      method,
      path: "/v1/items/7",
    });
    rig.answer({ allow: true });
    const decision = await pending;
    assert.equal(decision.action, "allow");
    decision.onResponse?.(200, {});
    // Cached for exactly this method, host and path (the query does not count): sending it
    // again asks nothing, but a different method or path is a new question.
    const again = await send(rig, method, "https://api.example.com/v1/items/7?token=other");
    assert.equal(again.action, "allow");
    assert.equal(rig.asks.length, 1);
    const other = send(rig, method, "https://api.example.com/v1/items/8");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rig.asks.length, 2);
    rig.answer({ allow: true });
    await other;
  }
});

test("read-only secret host: a denied write is a 403 with the reason, audited, and not asked again", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [secret()]);
  const pending = send(rig, "PUT", "https://api.example.com/v1/items/7");
  await new Promise((resolve) => setImmediate(resolve));
  rig.answer({ allow: false, reason: "denied by user" });
  const decision = await pending;
  assert.deepEqual(decision, { action: "deny", status: 403, reason: "denied by user" });
  assert.deepEqual(
    rig.network.drainAudit("c1").filter((e) => e.kind === "http"),
    [
      {
        t: 5_000,
        kind: "http",
        host: "api.example.com",
        port: 443,
        decision: "deny",
        source: "user",
        reason: "denied by user",
        method: "PUT",
        path: "/v1/items/7",
        status: 403,
      },
    ],
  );
  const again = await send(rig, "PUT", "https://api.example.com/v1/items/7?x=1");
  assert.deepEqual(again, { action: "deny", status: 403, reason: "denied by user" });
  assert.equal(rig.asks.length, 1, "the same method, host and path is not asked again");
  // Reads to the same host are still fine.
  assert.equal((await send(rig, "GET", "https://api.example.com/x")).action, "allow");
});

test("read-only secret host: an unanswered write is a 403 approval timed out", async () => {
  const rig = makeRig({ askTimeoutMs: 15 });
  registerWith(rig, "c1", [secret()]);
  const decision = await send(rig, "PUT", "https://api.example.com/x");
  assert.deepEqual(decision, { action: "deny", status: 403, reason: "approval timed out" });
  assert.equal(rig.network.drainAudit("c1").find((e) => e.kind === "http")?.source, "timeout");
});

test("only the hosts of read-only secrets are gated", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [
    secret(),
    secret({ envVar: "OTHER", hosts: ["writes.example.org"], readOnly: false }),
  ]);
  // A host of a read-write secret, and an unrelated host, may be written to freely.
  assert.equal((await send(rig, "POST", "https://writes.example.org/x")).action, "allow");
  assert.equal((await send(rig, "POST", "https://unrelated.example.io/x")).action, "allow");
  // A sibling or parent name of a bound host is not the bound host.
  assert.equal((await send(rig, "POST", "https://x.api.example.com/x")).action, "allow");
  assert.equal((await send(rig, "POST", "https://example.com/x")).action, "allow");
  assert.equal(rig.asks.length, 0);
});

test("unregistering a command drops its gating", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [secret()]);
  rig.requests.unregisterCommand("c1");
  assert.equal((await send(rig, "PUT", "https://api.example.com/x")).action, "allow");
  assert.equal(rig.asks.length, 0);
});

test("with two active commands a write to a read-only secret's host cannot be attributed and is denied", async () => {
  const rig = makeRig();
  rig.network.register("c2", { mode: "open", allow: [] });
  registerWith(rig, "c1", [secret()]);
  // Whichever command sent it, the host has a read-only secret and the sender is unknown.
  const decision = await rig.requests.filterRequest(new Request("https://api.example.com/x", { method: "PUT" }), info("api.example.com"));
  assert.deepEqual(decision, { action: "deny", status: 403, reason: "no single active command" });
  assert.equal(rig.asks.length, 0, "nothing is asked of the user about an unattributable request");
  // Safe methods, and hosts without a read-only secret, are unaffected.
  assert.equal((await rig.requests.filterRequest(new Request("https://api.example.com/x"), info("api.example.com"))).action, "allow");
  assert.equal(
    (await rig.requests.filterRequest(new Request("https://elsewhere.example.org/x", { method: "PUT" }), info("elsewhere.example.org"))).action,
    "allow",
  );
});

test("the gate does not depend on which command is active: a secret of any registered command counts", async () => {
  const rig = makeRig();
  rig.network.unregister("c1");
  rig.network.register("c2", { mode: "open", allow: [] });
  // Only c2 is active, but the read-only secret was registered under c1.
  registerWith(rig, "c1", [secret()]);
  const pending = rig.requests.filterRequest(new Request("https://api.example.com/x", { method: "PUT" }), info("api.example.com"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rig.asks.length, 1, "the write is still put to the user");
  assert.equal(rig.asks[0]?.commandId, "c2");
  rig.answer({ allow: false, reason: "denied by user" });
  assert.equal((await pending).action, "deny");
});

test("a failing approval denies the write (fail closed)", async () => {
  const network = createNetworkPolicy({
    ownAddresses: () => new Set(),
    askHost: () => Promise.reject(new Error("socket closed")),
    warn: () => {},
  });
  network.register("c1", { mode: "open", allow: [] });
  const requests = createRequestPolicy(network);
  requests.registerCommand("c1", [secret()], placeholders([secret()]));
  await network.decide({ host: "api.example.com", port: 443 });
  const decision = await requests.filterRequest(new Request("https://api.example.com/x", { method: "PUT" }), info("api.example.com"));
  assert.deepEqual(decision, { action: "deny", status: 403, reason: "approval unavailable" });
});

test("the real secret value appears in nothing the request policy produces", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [secret()]);
  const seen: unknown[] = [];
  const pending = send(rig, "PUT", "https://api.example.com/v1/x");
  await new Promise((resolve) => setImmediate(resolve));
  seen.push(rig.asks.map(({ signal: _signal, ...rest }) => rest));
  rig.answer({ allow: true });
  seen.push(await pending);
  seen.push(rig.network.drainAudit("c1"));
  assert.ok(!JSON.stringify(seen).includes(REAL));
});

// ---- Placeholders in request bodies ------------------------------------------------------------

const TOKEN = secret({ readOnly: false });
const sentinelOf = (entry: WrapSecret = TOKEN): string => sentinelFor(entry.envVar);

/** Sends `body` to api.example.com the way the proxy hands a request over (connection already allowed). */
async function sendBody(
  rig: Rig,
  method: string,
  path: string,
  body: BodyInit | null,
  over: Record<string, unknown> = {},
) {
  await rig.network.decide({ host: "api.example.com", port: 443 });
  return rig.requests.filterRequest(
    new Request(`https://api.example.com${path}`, { method, ...(body === null ? {} : { body }) }),
    { ...info("api.example.com", 443, path), ...over },
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a body carrying a placeholder is put to the user, whatever the method and even for a read-write secret", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const rig = makeRig();
    registerWith(rig, "c1", [TOKEN]);
    const pending = sendBody(rig, method, "/gists", JSON.stringify({ files: { a: { content: sentinelOf() } } }));
    await settle();
    assert.equal(rig.asks.length, 1, method);
    const { signal, ...ask } = rig.asks[0] as AskHostRequest;
    assert.ok(signal);
    assert.deepEqual(ask, {
      commandId: "c1",
      kind: "request",
      host: "api.example.com",
      port: 443,
      method,
      path: "/gists",
      secretInBody: true,
    });
    rig.answer({ allow: true });
    assert.equal((await pending).action, "allow");
  }
});

test("a body without a placeholder, or a placeholder only in a header, is not asked about for a read-write secret", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [TOKEN]);
  assert.equal((await sendBody(rig, "POST", "/x", JSON.stringify({ hello: "world" }))).action, "allow");
  await rig.network.decide({ host: "api.example.com", port: 443 });
  const withHeader = await rig.requests.filterRequest(
    new Request("https://api.example.com/x", {
      method: "POST",
      headers: { authorization: `Bearer ${sentinelOf()}` },
      body: "plain",
    }),
    info("api.example.com", 443, "/x"),
  );
  assert.equal(withHeader.action, "allow", "a placeholder in a header is what the secret is for");
  assert.equal(rig.asks.length, 0);
});

test("a placeholder split across chunks is still found", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [TOKEN]);
  const sentinel = sentinelOf();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`{"k":"${sentinel.slice(0, 9)}`));
      controller.enqueue(encoder.encode(`${sentinel.slice(9, 20)}`));
      controller.enqueue(encoder.encode(`${sentinel.slice(20)}"}`));
      controller.close();
    },
  });
  await rig.network.decide({ host: "api.example.com", port: 443 });
  const pending = rig.requests.filterRequest(
    new Request("https://api.example.com/x", { method: "POST", body, duplex: "half" } as RequestInit),
    info("api.example.com", 443, "/x"),
  );
  await settle();
  assert.equal(rig.asks.length, 1);
  rig.answer({ allow: false, reason: "denied by user" });
  assert.equal((await pending).action, "deny");
});

test("a placeholder bound to a different host is not a problem in a body sent here", async () => {
  const rig = makeRig();
  const other = secret({ envVar: "NPM_TOKEN", hosts: ["registry.example.org"] });
  registerWith(rig, "c1", [TOKEN, other]);
  assert.equal((await sendBody(rig, "POST", "/x", `token=${sentinelOf(other)}`)).action, "allow");
  assert.equal(rig.asks.length, 0, "it would not be substituted at api.example.com");
});

test("a body over 1 MiB, or one that cannot be read, is treated as carrying a placeholder", async () => {
  for (const kind of ["large", "broken"] as const) {
    const rig = makeRig();
    registerWith(rig, "c1", [TOKEN]);
    let body: BodyInit;
    if (kind === "large") body = new Uint8Array(1024 * 1024 + 1);
    else {
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("client went away"));
        },
      });
    }
    await rig.network.decide({ host: "api.example.com", port: 443 });
    const pending = rig.requests.filterRequest(
      new Request("https://api.example.com/x", { method: "POST", body, duplex: "half" } as RequestInit),
      info("api.example.com", 443, "/x"),
    );
    await settle();
    assert.equal(rig.asks.length, 1, kind);
    rig.answer({ allow: true });
    await pending;
  }
  // The largest body that is still scanned is exactly 1 MiB.
  const rig = makeRig();
  registerWith(rig, "c1", [TOKEN]);
  assert.equal((await sendBody(rig, "POST", "/x", new Uint8Array(1024 * 1024))).action, "allow");
  assert.equal(rig.asks.length, 0);
});

test("a GET with a body the proxy could not show is treated as carrying a placeholder", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [TOKEN]);
  const pending = sendBody(rig, "GET", "/search", null, { unshownBody: async () => true });
  await settle();
  assert.equal(rig.asks.length, 1);
  assert.equal(rig.asks[0]?.secretInBody, true);
  rig.answer({ allow: true });
  await pending;
  // An empty GET body (or none declared) is nothing to ask about.
  const quiet = makeRig();
  registerWith(quiet, "c1", [TOKEN]);
  assert.equal((await sendBody(quiet, "GET", "/search", null, { unshownBody: async () => false })).action, "allow");
  assert.equal((await sendBody(quiet, "GET", "/search", null)).action, "allow");
  assert.equal(quiet.asks.length, 0);
});

test("a denied body is a 403 saying the body holds a stored secret, and is audited", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [TOKEN]);
  const pending = sendBody(rig, "POST", "/gists", `x=${sentinelOf()}`);
  await settle();
  rig.answer({ allow: false, reason: "denied by user" });
  const decision = await pending;
  assert.deepEqual(decision, {
    action: "deny",
    status: 403,
    reason: "request body contains a stored secret: denied by user",
  });
  const entry = rig.network.drainAudit("c1").find((e) => e.kind === "http");
  assert.deepEqual([entry?.decision, entry?.source, entry?.status, entry?.method, entry?.path], [
    "deny",
    "user",
    403,
    "POST",
    "/gists",
  ]);
  assert.match(entry?.reason ?? "", /request body contains a stored secret/);
});

test("a body approval covers exactly that method, host and path; a write approval does not cover a body", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [TOKEN]);
  const body = `x=${sentinelOf()}`;
  const first = sendBody(rig, "POST", "/issues/1/comments?draft=1", body);
  await settle();
  rig.answer({ allow: true });
  assert.equal((await first).action, "allow");
  // Same method and path (query aside): remembered.
  assert.equal((await sendBody(rig, "POST", "/issues/1/comments", body)).action, "allow");
  assert.equal(rig.asks.length, 1);
  // A different path, or a different method, is a new question.
  for (const [method, path] of [["POST", "/gists"], ["PUT", "/issues/1/comments"]] as const) {
    const next = sendBody(rig, method, path, body);
    await settle();
    rig.answer({ allow: false, reason: "denied by user" });
    assert.equal((await next).action, "deny", `${method} ${path}`);
  }
  assert.equal(rig.asks.length, 3);
});

test("a body that carries a placeholder asks once, not once for the body and once for the write gate", async () => {
  const rig = makeRig();
  const guarded = secret({ readOnly: true });
  registerWith(rig, "c1", [guarded]);
  const pending = sendBody(rig, "POST", "/x", `x=${sentinelOf(guarded)}`);
  await settle();
  assert.equal(rig.asks.length, 1);
  assert.equal(rig.asks[0]?.secretInBody, true);
  rig.answer({ allow: true });
  assert.equal((await pending).action, "allow");
  // A read-only secret's host without a placeholder in the body is still the ordinary write gate.
  const write = sendBody(rig, "POST", "/y", "no placeholder here");
  await settle();
  assert.equal(rig.asks.length, 2);
  assert.equal(rig.asks[1]?.secretInBody, undefined);
  rig.answer({ allow: true });
  await write;
});

test("an unattributable request with a placeholder in its body to a bound host is denied", async () => {
  const rig = makeRig();
  rig.network.register("c2", { mode: "open", allow: [] });
  registerWith(rig, "c1", [TOKEN]);
  const decision = await rig.requests.filterRequest(
    new Request("https://api.example.com/x", { method: "POST", body: `x=${sentinelOf()}` }),
    info("api.example.com", 443, "/x"),
  );
  assert.deepEqual(decision, { action: "deny", status: 403, reason: "no single active command" });
  assert.equal(rig.asks.length, 0);
});

test("the placeholders themselves never reach the ask or the audit more than as a flag", async () => {
  const rig = makeRig();
  registerWith(rig, "c1", [TOKEN]);
  const pending = sendBody(rig, "POST", "/x", `x=${sentinelOf()}`);
  await settle();
  rig.answer({ allow: true });
  await pending;
  const seen = JSON.stringify([rig.asks.map(({ signal: _s, ...rest }) => rest), rig.network.drainAudit("c1")]);
  assert.ok(!seen.includes(sentinelOf()));
  assert.ok(!seen.includes(REAL));
});
