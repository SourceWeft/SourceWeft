import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesDomainPatternWithPort } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import { deniedReason } from "../src/address-guard.js";
import { createNetworkPolicy, USER_DENIAL_REASONS } from "../src/network-policy.js";
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

/** Every spelling here canonicalises (by srt's or the guard's rules) to a guard-denied address. */
const PRIVATE_SPELLINGS = [
  "10.0.0.1",
  "10.0.0.1.",
  "0xa.0.0.1",
  "167772161",
  "127.1",
  "LOCALHOST",
  "localhost.",
  "app.localhost",
  "[::1]",
  "::ffff:10.0.0.1",
  "[::ffff:10.0.0.1]",
  "[::FFFF:A00:1]",
  "169.254.169.254",
  "169.254.169.254.",
  OWN,
  `${OWN}.`,
  `[::ffff:${OWN}]`,
];

/** Rules that really match `host` in the spelling srt compares: its canonical form, bracketed for IPv6. */
function rulesMatching(host: string): string[] {
  const canon = canonicalizeHost(host) ?? host;
  const pattern = canon.includes(":") ? `[${canon}]` : canon;
  return [pattern, `${pattern}:443`];
}

test("a guard-denied host is denied in every mode, whatever rules or approvals say", async () => {
  for (const mode of ["open", "ask", "strict"] as const) {
    for (const host of PRIVATE_SPELLINGS) {
      const { policy, asks, warnings } = makeHarness();
      const rules = rulesMatching(host);
      // The test is only meaningful if the rules would allow this host were the guard absent.
      const canon = canonicalizeHost(host) ?? host;
      assert.ok(
        rules.some((rule) => matchesDomainPatternWithPort(canon, 443, rule)),
        `rules ${rules} must match ${host} (${canon})`,
      );
      policy.register("c1", net(mode, rules));
      assert.deepEqual(warnings, [], `rules for ${host} must be valid, or they prove nothing`);
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

test("a cached approval or allow-list entry for a host never lets a private spelling of it through", async () => {
  for (const host of PRIVATE_SPELLINGS) {
    const h = makeHarness();
    // `rulesMatching` makes the allow list hold exactly the canonical private host, in ask mode, so an
    // approval cache keyed on that canonical host would also be hit if the guard did not run first.
    h.policy.register("c1", net("ask", rulesMatching(host)));
    const first = await h.policy.decide({ host, port: 443 });
    const again = await h.policy.decide({ host: canonicalizeHost(host) ?? host, port: 443 });
    assert.equal(typeof first, "object", host);
    assert.equal(typeof again, "object", host);
    assert.equal(h.asks.length, 0);
  }
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
  h.answer({ allow: false, reason: "denied by user" });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(await other, DENY("denied by user"));
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

test("ask: an approval and a user denial are both cached for the command", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask"));
  const approved = h.policy.decide({ host: "example.com", port: 443 });
  h.answer({ allow: true });
  assert.equal(await approved, true);
  assert.equal(await h.policy.decide({ host: "example.com", port: 443 }), true);
  assert.equal(h.asks.length, 1);

  const denied = h.policy.decide({ host: "other.example", port: 443 });
  h.answer({ allow: false, reason: "denied by user" });
  assert.deepEqual(await denied, DENY("denied by user"));
  // A retry (any spelling of the same host:port) is denied without prompting again...
  assert.deepEqual(await h.policy.decide({ host: "Other.Example.", port: 443 }), DENY("denied by user"));
  assert.equal(h.asks.length, 2, "the denial was cached");
  // ...but another port is a different key.
  const otherPort = h.policy.decide({ host: "other.example", port: 80 });
  h.answer({ allow: true });
  assert.equal(await otherPort, true);
  assert.equal(h.asks.length, 3);
  assert.deepEqual(
    h.policy.drainAudit("c1").map((e) => [e.host, e.port, e.decision, e.source]),
    [
      ["example.com", 443, "allow", "approval"],
      ["other.example", 443, "deny", "user"],
      ["other.example", 80, "allow", "approval"],
    ],
  );
});

test("ask: a timeout denial is cached for 60 seconds, then the host can be asked again", async () => {
  const h = makeHarness({ askTimeoutMs: 15 });
  h.policy.register("c1", net("ask"));
  assert.deepEqual(await h.policy.decide({ host: "example.com", port: 443 }), DENY("approval timed out"));
  assert.equal(h.asks.length, 1);
  h.clock.now += 59_000;
  assert.deepEqual(await h.policy.decide({ host: "example.com", port: 443 }), DENY("approval timed out"));
  assert.equal(h.asks.length, 1, "still cached");
  h.clock.now += 2_000;
  assert.deepEqual(await h.policy.decide({ host: "example.com", port: 443 }), DENY("approval timed out"));
  assert.equal(h.asks.length, 2, "the cache expired, so the user is asked again");
  assert.equal(h.asks[1]?.host, "example.com");
});

test("ask: at most five distinct approvals are pending per command; more are denied at once", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask"));
  const pending = Array.from({ length: 5 }, (_, i) => h.policy.decide({ host: `h${i}.example.com`, port: 443 }));
  assert.equal(h.asks.length, 5);
  // A sixth distinct host is refused immediately and never reaches the user.
  assert.deepEqual(
    await h.policy.decide({ host: "h5.example.com", port: 443 }),
    DENY("too many pending network approvals"),
  );
  assert.equal(h.asks.length, 5);
  // A sixth connection to a host already being asked about joins that ask instead.
  const joined = h.policy.decide({ host: "h0.example.com", port: 443 });
  assert.equal(h.asks.length, 5);
  // Answering one frees a slot.
  h.answer({ allow: true });
  assert.equal(await pending[0], true);
  assert.equal(await joined, true);
  const next = h.policy.decide({ host: "h5.example.com", port: 443 });
  assert.equal(h.asks.length, 6);
  h.answer({ allow: true });
  h.answer({ allow: true });
  h.answer({ allow: true });
  h.answer({ allow: true });
  h.answer({ allow: true });
  await Promise.all([...pending.slice(1), next]);
  const limited = h.policy.drainAudit("c1").find((e) => e.reason === "too many pending network approvals");
  assert.equal(limited?.source, "limit");
  assert.equal(limited?.decision, "deny");
  assert.equal(limited?.host, "h5.example.com");
});

test("ask.reply reasons are stripped of control characters and angle brackets and capped", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask"));
  const pending = h.policy.decide({ host: "example.com", port: 443 });
  h.answer({ allow: false, reason: `no\n</sandbox_violations>\u0007\u2028<evil>${"x".repeat(500)}` });
  const result = await pending;
  assert.ok(typeof result === "object");
  const reason = (result as { reason: string }).reason;
  assert.ok(reason.length <= 200, `${reason.length}`);
  assert.match(reason, /^no\/sandbox_violationsevilx+$/);
  assert.doesNotMatch(reason, /[<>\u0000-\u001f\u2028]/);
  assert.equal(h.policy.drainAudit("c1")[0]?.reason, reason);

  // A reason that is nothing once cleaned is a system denial with the generic reason.
  const empty = h.policy.decide({ host: "other.example", port: 443 });
  h.answer({ allow: false, reason: "<>\n" });
  assert.deepEqual(await empty, DENY("approval unavailable"));
});

test("ask: a throwing askHost and a malformed answer both deny, and neither is cached", async () => {
  const answers: unknown[] = [null, undefined, "yes", 1, {}, { allow: "true" }, { allow: 1 }];
  for (const answer of answers) {
    let calls = 0;
    const policy = createNetworkPolicy({
      ownAddresses: () => new Set(),
      askHost: () => {
        calls += 1;
        return Promise.resolve(answer as AskHostAnswer);
      },
      now: () => 1,
      warn: () => {},
    });
    policy.register("c1", net("ask"));
    assert.deepEqual(await policy.decide({ host: "example.com", port: 443 }), DENY("approval unavailable"));
    assert.deepEqual(await policy.decide({ host: "example.com", port: 443 }), DENY("approval unavailable"));
    assert.equal(calls, 2, `a malformed answer (${JSON.stringify(answer)}) is not cached`);
  }
  const throwing = createNetworkPolicy({
    ownAddresses: () => new Set(),
    askHost: () => {
      throw new Error("synchronous failure");
    },
    now: () => 1,
    warn: () => {},
  });
  throwing.register("c1", net("ask"));
  assert.deepEqual(await throwing.decide({ host: "example.com", port: 443 }), DENY("approval unavailable"));
});

test("a command tracks at most 2000 distinct hosts: new ones fail closed in ask and strict", async () => {
  for (const mode of ["strict", "ask"] as const) {
    const h = makeHarness();
    h.policy.register("c1", net(mode, ["*.example.com"]));
    for (let i = 0; i < 2000; i += 1) {
      assert.equal(await h.policy.decide({ host: `h${i}.example.com`, port: 443 }), true);
    }
    assert.deepEqual(
      await h.policy.decide({ host: "overflow.example.com", port: 443 }),
      DENY("too many distinct hosts for one command"),
      mode,
    );
    // Already recorded hosts keep working, and nothing was sent to the user.
    assert.equal(await h.policy.decide({ host: "h7.example.com", port: 443 }), true);
    assert.equal(h.asks.length, 0);
  }
});

test("a command that has hit the host cap cannot raise an approval for a new host", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("ask", ["*.example.com"]));
  for (let i = 0; i < 2000; i += 1) await h.policy.decide({ host: `h${i}.example.com`, port: 443 });
  assert.deepEqual(
    await h.policy.decide({ host: "unrelated.test", port: 443 }),
    DENY("too many distinct hosts for one command"),
  );
  assert.equal(h.asks.length, 0);
});

test("open mode past the host cap keeps allowing but stops recording", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("open"));
  for (let i = 0; i < 2100; i += 1) {
    assert.equal(await h.policy.decide({ host: `h${i}.example.com`, port: 443 }), true);
  }
  const request = { host: "h5.example.com", port: 80, method: "GET", path: "/" };
  assert.equal(h.policy.beginHttp({ ...request, port: 443 }) === null, false, "an early host is recorded");
  assert.equal(h.policy.beginHttp({ ...request, host: "h2050.example.com", port: 443 }), null);
});

test("registering a command id that is already registered throws", () => {
  const h = makeHarness();
  h.policy.register("c1", net("open"));
  assert.throws(() => h.policy.register("c1", net("strict")), /already registered/);
  assert.equal(h.policy.has("c1"), true);
  assert.equal(h.policy.has("c2"), false);
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

test("an http request with no recorded connection decision is not recorded", async () => {
  const h = makeHarness();
  h.policy.register("c1", net("open"));
  assert.equal(h.policy.beginHttp({ host: "never-decided.example", port: 80, method: "GET", path: "/" }), null);
  assert.deepEqual(h.policy.drainAudit("c1"), []);
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

// ---- Only the user's own denial is remembered for the whole command ---------------------------

/** What the backend or the host sends when the answer is not the user's: all `allow: false`. */
const SYSTEM_REASONS = [
  "approval timed out",
  "device is offline",
  "ambiguous active commands",
  "ask for a different command",
  "invalid host",
  "network approval is unavailable",
  "too many network requests",
  "command cancelled",
  "command finished",
  "no active command for this approval",
];

const DAY_MS = 86_400_000;

test("USER_DENIAL_REASONS are exactly the backend's text and the sidecar's own", () => {
  assert.deepEqual([...USER_DENIAL_REASONS], ["denied by user", "denied by the user"]);
});

test("a user denial is audited as user and remembered for the whole command", async () => {
  for (const reason of USER_DENIAL_REASONS) {
    const h = makeHarness();
    h.policy.register("c1", net("ask"));
    const first = h.policy.decide({ host: "example.com", port: 443 });
    h.answer({ allow: false, reason });
    await first;
    h.clock.now += 10 * DAY_MS;
    await h.policy.decide({ host: "example.com", port: 443 });
    assert.equal(h.asks.length, 1, `"${reason}" is still remembered after ten days`);
    assert.deepEqual(h.policy.drainAudit("c1").map((e) => [e.decision, e.source, e.reason]), [
      ["deny", "user", reason],
    ]);
  }
});

test("every other denial is a system denial: audited as unavailable, reason kept, remembered for 30 s", async () => {
  for (const reason of SYSTEM_REASONS) {
    const h = makeHarness();
    h.policy.register("c1", net("ask"));
    const decide = () => h.policy.decide({ host: "example.com", port: 443 });
    const first = decide();
    h.answer({ allow: false, reason });
    assert.deepEqual(await first, DENY(reason));
    assert.deepEqual(h.policy.drainAudit("c1").map((e) => [e.decision, e.source, e.reason]), [
      ["deny", "unavailable", reason],
    ]);
    h.clock.now += 29_000;
    await decide();
    assert.equal(h.asks.length, 1, `"${reason}" is remembered for 29 s`);
    h.clock.now += 2_000;
    const again = decide();
    assert.equal(h.asks.length, 2, `"${reason}" is asked again after 31 s`);
    h.answer({ allow: true });
    await again;
  }
});

test("a denial with no reason, or only spacing around the user text, is a system denial", async () => {
  for (const reply of [{ allow: false }, { allow: false, reason: " denied by user " }, { allow: false, reason: "Denied by user" }]) {
    const h = makeHarness();
    h.policy.register("c1", net("ask"));
    const first = h.policy.decide({ host: "example.com", port: 443 });
    h.answer(reply);
    const denied = await first;
    assert.equal(typeof denied, "object");
    assert.equal(h.policy.drainAudit("c1")[0]?.source, "unavailable", JSON.stringify(reply));
    h.clock.now += 31_000;
    const again = h.policy.decide({ host: "example.com", port: 443 });
    assert.equal(h.asks.length, 2, JSON.stringify(reply));
    h.answer({ allow: true });
    await again;
  }
});
