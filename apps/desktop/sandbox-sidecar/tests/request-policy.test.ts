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
  rig.requests.registerCommand("c1", [secret()]);
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const decision = await send(rig, method, "https://api.example.com/v1/items");
    assert.equal(decision.action, "allow", method);
  }
  assert.equal(rig.asks.length, 0);
});

test("read-only secret host: a write raises one request ask and waits for the answer", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "PURGE"]) {
    const rig = makeRig();
    rig.requests.registerCommand("c1", [secret()]);
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
    // Cached for the command and host: no second ask for any later write.
    const next = await send(rig, "DELETE", "https://api.example.com/other");
    assert.equal(next.action, "allow");
    assert.equal(rig.asks.length, 1);
  }
});

test("read-only secret host: a denied write is a 403 with the reason, audited, and not asked again", async () => {
  const rig = makeRig();
  rig.requests.registerCommand("c1", [secret()]);
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
  const again = await send(rig, "POST", "https://api.example.com/x");
  assert.deepEqual(again, { action: "deny", status: 403, reason: "denied by user" });
  assert.equal(rig.asks.length, 1);
  // Reads to the same host are still fine.
  assert.equal((await send(rig, "GET", "https://api.example.com/x")).action, "allow");
});

test("read-only secret host: an unanswered write is a 403 approval timed out", async () => {
  const rig = makeRig({ askTimeoutMs: 15 });
  rig.requests.registerCommand("c1", [secret()]);
  const decision = await send(rig, "PUT", "https://api.example.com/x");
  assert.deepEqual(decision, { action: "deny", status: 403, reason: "approval timed out" });
  assert.equal(rig.network.drainAudit("c1").find((e) => e.kind === "http")?.source, "timeout");
});

test("only the hosts of read-only secrets are gated", async () => {
  const rig = makeRig();
  rig.requests.registerCommand("c1", [
    secret(),
    secret({ envVar: "OTHER", hosts: ["writes.example.org"], readOnly: false }),
    secret({ envVar: "WILD", hosts: ["*.wild.example.net"], readOnly: true }),
  ]);
  // A host of a read-write secret, and an unrelated host, may be written to freely.
  assert.equal((await send(rig, "POST", "https://writes.example.org/x")).action, "allow");
  assert.equal((await send(rig, "POST", "https://unrelated.example.io/x")).action, "allow");
  assert.equal(rig.asks.length, 0);
  // A wildcard host is matched with srt's own matcher; the apex is not covered by `*.`.
  const wild = send(rig, "POST", "https://a.wild.example.net/x");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rig.asks.length, 1);
  rig.answer({ allow: true });
  await wild;
  assert.equal((await send(rig, "POST", "https://wild.example.net/x")).action, "allow");
});

test("gating follows the command: unregistering drops it, and another command is not gated", async () => {
  const rig = makeRig();
  rig.requests.registerCommand("c1", [secret()]);
  rig.requests.unregisterCommand("c1");
  assert.equal((await send(rig, "PUT", "https://api.example.com/x")).action, "allow");
  assert.equal(rig.asks.length, 0);
  rig.requests.registerCommand("other", [secret()]);
  assert.equal((await send(rig, "PUT", "https://api.example.com/x")).action, "allow", "c1 is the active one");
});

test("a failing approval denies the write (fail closed)", async () => {
  const network = createNetworkPolicy({
    ownAddresses: () => new Set(),
    askHost: () => Promise.reject(new Error("socket closed")),
    warn: () => {},
  });
  network.register("c1", { mode: "open", allow: [] });
  const requests = createRequestPolicy(network);
  requests.registerCommand("c1", [secret()]);
  await network.decide({ host: "api.example.com", port: 443 });
  const decision = await requests.filterRequest(new Request("https://api.example.com/x", { method: "PUT" }), info("api.example.com"));
  assert.deepEqual(decision, { action: "deny", status: 403, reason: "approval unavailable" });
});

test("the real secret value appears in nothing the request policy produces", async () => {
  const rig = makeRig();
  rig.requests.registerCommand("c1", [secret()]);
  const seen: unknown[] = [];
  const pending = send(rig, "PUT", "https://api.example.com/v1/x");
  await new Promise((resolve) => setImmediate(resolve));
  seen.push(rig.asks.map(({ signal: _signal, ...rest }) => rest));
  rig.answer({ allow: true });
  seen.push(await pending);
  seen.push(rig.network.drainAudit("c1"));
  assert.ok(!JSON.stringify(seen).includes(REAL));
});
