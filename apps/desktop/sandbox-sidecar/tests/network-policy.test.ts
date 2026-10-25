import assert from "node:assert/strict";
import { test } from "node:test";
import { deniedReason } from "../src/address-guard.js";
import { createNetworkPolicy } from "../src/network-policy.js";
import type { AskHostRequest, AskHostAnswer } from "../src/network-policy.js";
import type { NetworkMode, WrapNetwork } from "../src/protocol.js";

const OWN = "203.0.113.7";

type Harness = {
  policy: ReturnType<typeof createNetworkPolicy>;
  asks: AskHostRequest[];
  warnings: string[];
  /** Answers the oldest unanswered ask. */
  answer: (answer: AskHostAnswer) => void;
  clock: { now: number };
};

/** A policy whose `askHost` parks until the test answers it, with a manual clock. */
function makeHarness(options: { askTimeoutMs?: number } = {}): Harness {
  const asks: AskHostRequest[] = [];
  const resolvers: Array<(answer: AskHostAnswer) => void> = [];
  const warnings: string[] = [];
  const clock = { now: 1_000 };
  const policy = createNetworkPolicy({
    ownAddresses: () => new Set([OWN]),
    askHost: (request) => {
      asks.push(request);
      return new Promise<AskHostAnswer>((resolve) => resolvers.push(resolve));
    },
    now: () => clock.now,
    warn: (line) => warnings.push(line),
    ...options,
  });
  return {
    policy,
    asks,
    warnings,
    answer: (answer) => {
      const resolve = resolvers.shift();
      assert.ok(resolve, "no ask is waiting for an answer");
      resolve(answer);
    },
    clock,
  };
}

function net(mode: NetworkMode, allow: string[] = [], suggested?: Record<string, string>): WrapNetwork {
  return suggested === undefined ? { mode, allow } : { mode, allow, suggested };
}

const DENY = (reason: string) => ({ allow: false, reason });

test("a guard-denied host is denied in every mode, whatever rules or approvals say", async () => {
  const hosts = ["10.0.0.1", "127.1", "localhost", "169.254.169.254", "[::1]", "2130706433", OWN];
  for (const mode of ["open", "ask", "strict"] as const) {
    for (const host of hosts) {
      const { policy, asks } = makeHarness();
      // Rules naming the private host itself, and a wildcard that would cover a name.
      policy.register("c1", net(mode, [host, `${host}:443`, "*.localhost"]));
      const result = await policy.decide({ host, port: 443 });
      const reason = deniedReason(host, new Set([OWN]));
      assert.ok(reason !== null, `${host} must be guard-denied`);
      assert.deepEqual(result, DENY(`public internet only: ${reason}`), `${mode} ${host}`);
      assert.equal(asks.length, 0, `the guard must run before any ask (${mode} ${host})`);
      const [entry] = policy.drainAudit("c1");
      assert.equal(entry?.source, "guard");
      assert.equal(entry?.decision, "deny");
    }
  }
});

test("an earlier approval for a private host cannot let it through later", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask"));
  // An approved cache entry for the same host name would be the only way to bypass the guard.
  const pending = h.policy.decide({ host: "example.com", port: 443 });
  h.answer({ allow: true });
  assert.equal(await pending, true);
  assert.deepEqual(
    await h.policy.decide({ host: "10.0.0.1", port: 443 }),
    DENY(`public internet only: ${deniedReason("10.0.0.1", new Set([OWN]))}`),
  );
});

test("zero or several active commands deny with no single active command", async () => {
  const h = makeHarness();
  assert.deepEqual(await h.policy.decide({ host: "example.com", port: 443 }), DENY("no single active command"));
  h.policy.register("c1", net("open"));
  assert.equal(await h.policy.decide({ host: "example.com", port: 443 }), true);
  h.policy.register("c2", net("open"));
  assert.deepEqual(await h.policy.decide({ host: "example.com", port: 443 }), DENY("no single active command"));
  // Nothing is attributable while ambiguous, so neither command's audit grows.
  assert.equal(h.policy.drainAudit("c2").length, 0);
  h.policy.unregister("c2");
  assert.equal(await h.policy.decide({ host: "example.org", port: 443 }), true);
  const entries = h.policy.drainAudit("c1");
  assert.deepEqual(entries.map((e) => e.decision), ["allow", "allow"]);
});

test("a missing port is denied", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("open"));
  assert.deepEqual(await h.policy.decide({ host: "example.com", port: undefined }), DENY("missing port"));
});

test("open allows any public host and audits it", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("open"));
  assert.equal(await h.policy.decide({ host: "Example.COM.", port: 443 }), true);
  assert.deepEqual(h.policy.drainAudit("c1"), [
    { t: 1_000, kind: "connection", host: "example.com", port: 443, decision: "allow", source: "open" },
  ]);
});

test("rules match with srt's own matcher after canonicalisation", async () => {
  const h = makeHarness();
  h.policy.register(
    "c1",
    net("strict", ["example.com", "*.github.com", "api.only443.dev:443"]),
  );
  assert.equal(await h.policy.decide({ host: "EXAMPLE.com.", port: 8080 }), true);
  assert.equal(await h.policy.decide({ host: "raw.github.com", port: 443 }), true);
  assert.equal(await h.policy.decide({ host: "api.only443.dev", port: 443 }), true);
  assert.deepEqual(
    await h.policy.decide({ host: "api.only443.dev", port: 80 }),
    DENY("host is not on the allow list (strict network mode)"),
  );
  // `*.github.com` is a strict-subdomain pattern: the apex is not covered.
  assert.deepEqual(
    await h.policy.decide({ host: "github.com", port: 443 }),
    DENY("host is not on the allow list (strict network mode)"),
  );
  const entries = h.policy.drainAudit("c1");
  assert.deepEqual(
    entries.map((e) => [e.host, e.port, e.decision, e.source]),
    [
      ["example.com", 8080, "allow", "rule"],
      ["raw.github.com", 443, "allow", "rule"],
      ["api.only443.dev", 443, "allow", "rule"],
      ["api.only443.dev", 80, "deny", "strict"],
      ["github.com", 443, "deny", "strict"],
    ],
  );
});

test("strict never asks", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("strict"));
  assert.deepEqual(
    await h.policy.decide({ host: "example.com", port: 443 }),
    DENY("host is not on the allow list (strict network mode)"),
  );
  assert.equal(h.asks.length, 0);
});

test("invalid rule entries are dropped, never widened, with one stderr note", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("strict", ["*", "*.com", "not a domain", "ok.example.com"]));
  assert.equal(h.warnings.length, 1, h.warnings.join("\n"));
  assert.match(h.warnings[0] ?? "", /\*/);
  assert.deepEqual(
    await h.policy.decide({ host: "evil.com", port: 443 }),
    DENY("host is not on the allow list (strict network mode)"),
  );
  assert.equal(await h.policy.decide({ host: "ok.example.com", port: 443 }), true);
});

test("ask: a rule match is allowed without asking", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask", ["example.com"]));
  assert.equal(await h.policy.decide({ host: "example.com", port: 443 }), true);
  assert.equal(h.asks.length, 0);
});

test("ask: concurrent connections to one host:port share a single ask", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask", [], { "pypi.org": "py-skill" }));
  const first = h.policy.decide({ host: "pypi.org", port: 443 });
  const second = h.policy.decide({ host: "PyPI.org.", port: 443 });
  const other = h.policy.decide({ host: "pypi.org", port: 80 });
  await Promise.resolve();
  assert.equal(h.asks.length, 2, "one ask for :443, one for :80");
  assert.deepEqual(
    { ...h.asks[0], signal: undefined },
    { commandId: "c1", host: "pypi.org", port: 443, suggestedBy: "py-skill", signal: undefined },
  );
  assert.equal(h.asks[1]?.suggestedBy, "py-skill");
  h.answer({ allow: true });
  h.answer({ allow: false, reason: "no thanks" });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(await other, DENY("no thanks"));
  const entries = h.policy.drainAudit("c1");
  assert.deepEqual(
    entries.map((e) => [e.port, e.decision, e.source]),
    [
      [443, "allow", "approval"],
      [80, "deny", "user"],
    ],
    "consecutive duplicates collapse",
  );
});

test("ask: an approval is cached for the command; a denial is not", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask"));
  const approved = h.policy.decide({ host: "example.com", port: 443 });
  h.answer({ allow: true });
  assert.equal(await approved, true);
  assert.equal(await h.policy.decide({ host: "example.com", port: 443 }), true);
  assert.equal(h.asks.length, 1);

  const denied = h.policy.decide({ host: "other.example", port: 443 });
  h.answer({ allow: false });
  assert.deepEqual(await denied, DENY("denied by the user"));
  const again = h.policy.decide({ host: "other.example", port: 443 });
  h.answer({ allow: true });
  assert.equal(await again, true);
  assert.equal(h.asks.length, 3, "the approved host was cached, the denied one asked again");
});

test("ask: an approval does not carry over to another command", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask"));
  const approved = h.policy.decide({ host: "example.com", port: 443 });
  h.answer({ allow: true });
  await approved;
  h.policy.unregister("c1");
  h.policy.register("c2", net("ask"));
  const next = h.policy.decide({ host: "example.com", port: 443 });
  await Promise.resolve();
  assert.equal(h.asks.length, 2);
  assert.equal(h.asks[1]?.commandId, "c2");
  h.answer({ allow: true });
  assert.equal(await next, true);
});

test("ask: no answer within the timeout denies with approval timed out and aborts the ask", async () => {
  const h = makeHarness({ askTimeoutMs: 20 });
  h.policy.register("c1", net("ask"));
  const result = await h.policy.decide({ host: "example.com", port: 443 });
  assert.deepEqual(result, DENY("approval timed out"));
  assert.equal(h.asks[0]?.signal.aborted, true);
  const [entry] = h.policy.drainAudit("c1");
  assert.equal(entry?.source, "timeout");
  assert.equal(entry?.decision, "deny");
  // A reply that arrives after the deadline changes nothing.
  h.answer({ allow: true });
  assert.deepEqual(await h.policy.decide({ host: "example.com", port: 443 }), DENY("approval timed out"));
});

test("ask: unregistering settles a pending ask with a denial", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask"));
  const pending = h.policy.decide({ host: "example.com", port: 443 });
  await Promise.resolve();
  h.policy.unregister("c1");
  assert.deepEqual(await pending, DENY("command finished"));
  assert.equal(h.asks[0]?.signal.aborted, true);
  assert.deepEqual(h.policy.drainAudit("c1"), []);
});

test("ask: an askHost failure denies with the command still running", async () => {
  const policy = createNetworkPolicy({
    ownAddresses: () => new Set(),
    askHost: () => Promise.reject(new Error("socket closed")),
    now: () => 1,
    warn: () => {},
  });
  policy.register("c1", net("ask"));
  assert.deepEqual(await policy.decide({ host: "example.com", port: 443 }), DENY("approval unavailable"));
});

test("audit entries never carry a query string or fragment, and paths are bounded", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("open"));
  await h.policy.decide({ host: "example.com", port: 80 });
  const first = h.policy.beginHttp({ host: "Example.com", port: 80, method: "GET", path: "/a/b?token=secret#frag" });
  const second = h.policy.beginHttp({ host: "example.com", port: 80, method: "GET", path: `/${"x".repeat(500)}` });
  assert.ok(first && second);
  first(200);
  second(404);
  const entries = h.policy.drainAudit("c1");
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[1], {
    t: 1_000,
    kind: "http",
    host: "example.com",
    port: 80,
    decision: "allow",
    source: "open",
    method: "GET",
    path: "/a/b",
    status: 200,
  });
  assert.equal(entries[2]?.path?.length, 200);
  assert.ok(!JSON.stringify(entries).includes("secret"));
});

test("an http entry names the source of the connection decision it rode on", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask", ["example.com"]));
  await h.policy.decide({ host: "example.com", port: 80 });
  h.policy.beginHttp({ host: "example.com", port: 80, method: "GET", path: "/" })?.(200);
  assert.equal(h.policy.drainAudit("c1")[1]?.source, "rule");
});

test("an http entry for a command that finished first is dropped", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("open"));
  const done = h.policy.beginHttp({ host: "example.com", port: 80, method: "GET", path: "/" });
  h.policy.unregister("c1");
  done?.(200);
  assert.deepEqual(h.policy.drainAudit("c1"), []);
});

test("audit keeps at most 200 entries per command and drains", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("open"));
  for (let i = 0; i < 250; i += 1) await h.policy.decide({ host: `h${i}.example.com`, port: 443 });
  assert.equal(h.policy.drainAudit("c1").length, 200);
  assert.equal(h.policy.drainAudit("c1").length, 0);
  assert.deepEqual(h.policy.drainAudit("unknown"), []);
});

test("beginHttp cannot attribute without a single active command", () => {
  const h = makeHarness();
  const request = { host: "example.com", port: 80, method: "GET", path: "/" };
  assert.equal(h.policy.beginHttp(request), null);
  h.policy.register("c1", net("open"));
  h.policy.register("c2", net("open"));
  assert.equal(h.policy.beginHttp(request), null);
});

test("the probe command id is never counted as active", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("open"));
  h.policy.register("probe", net("strict"));
  assert.equal(await h.policy.decide({ host: "example.com", port: 443 }), true);
});
