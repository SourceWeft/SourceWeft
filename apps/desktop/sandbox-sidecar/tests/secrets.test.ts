import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesDomainPattern } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { SentinelRegistry } from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-sentinel.js";
import { parseSecrets, registerSecrets, SecretsError } from "../src/secrets.js";
import type { WrapSecret } from "../src/protocol.js";

const REAL = "ghp_REAL-secret-value-0123456789";

const secret = (overrides: Partial<WrapSecret> = {}): WrapSecret => ({
  envVar: "GITHUB_TOKEN",
  value: REAL,
  hosts: ["api.github.com"],
  readOnly: false,
  ...overrides,
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SecretsError, `expected a SecretsError, got ${String(error)}`);
    // No error may carry a real value, whatever the input was.
    assert.ok(!error.message.includes(REAL), `error message leaks the value: ${error.message}`);
    return error.code;
  }
  return undefined;
}

test("parseSecrets accepts a well-formed list and returns plain copies", () => {
  const input = [secret(), secret({ envVar: "NPM_TOKEN", hosts: ["registry.npmjs.org", "npm.example.org"], readOnly: true })];
  assert.deepEqual(parseSecrets(input), input);
  assert.deepEqual(parseSecrets([]), []);
});

test("parseSecrets enforces the shape and the limits, always as BAD_REQUEST", () => {
  const bad: unknown[] = [
    "x",
    {},
    [null],
    [{}],
    [secret({ envVar: "lower" })],
    [secret({ envVar: "1ABC" })],
    [secret({ envVar: "A-B" })],
    [secret({ envVar: "" })],
    [secret({ envVar: "A".repeat(129) })],
    [secret({ value: "" })],
    [secret({ value: "x".repeat(4097) })],
    [secret({ value: "é".repeat(2049) })], // 4098 bytes
    [secret({ value: "line1\nline2" })],
    [secret({ value: "nul\u0000byte" })],
    [secret({ hosts: [] })],
    [secret({ hosts: "api.github.com" as unknown as string[] })],
    [secret({ hosts: [7 as unknown as string] })],
    [secret({ hosts: ["*"] })],
    [secret({ hosts: ["*.com"] })],
    // Secret hosts are exact names: no wildcard at all, even a narrow one, or one under a public
    // suffix that many unrelated parties share.
    [secret({ hosts: ["*.github.com"] })],
    [secret({ hosts: ["*.github.io"] })],
    [secret({ hosts: ["*.co.uk"] })],
    [secret({ hosts: ["*.vercel.app"] })],
    [secret({ hosts: ["api.*.com"] })],
    [secret({ hosts: ["api.github.com:443"] })],
    [secret({ hosts: ["10.0.0.1"] })],
    [secret({ hosts: ["8.8.8.8"] })],
    [secret({ hosts: ["[2001:db8::1]"] })],
    [secret({ hosts: ["https://api.github.com"] })],
    [secret({ hosts: Array.from({ length: 51 }, (_, i) => `h${i}.example.com`) })],
    [secret({ readOnly: "yes" as unknown as boolean })],
    [{ envVar: "A", value: "v", hosts: ["a.example.com"] }],
    [secret(), secret({ hosts: ["other.example.com"] })], // duplicate env var
    Array.from({ length: 21 }, (_, i) => secret({ envVar: `S${i}` })),
  ];
  for (const input of bad) {
    assert.equal(code(() => parseSecrets(input)), "BAD_REQUEST", JSON.stringify(input).slice(0, 120));
  }
  // The largest accepted: 20 secrets, a 4096-byte value, 50 hosts for one secret, 200 hosts in all.
  const hosts = (n: number, tag: string) => Array.from({ length: n }, (_, j) => `h${j}.${tag}.example.com`);
  const biggest = Array.from({ length: 20 }, (_, i) =>
    secret({ envVar: `S${i}`, value: "x".repeat(4096), hosts: hosts(10, `s${i}`) }),
  );
  assert.equal(parseSecrets(biggest).length, 20);
  assert.equal(parseSecrets([secret({ hosts: hosts(50, "one") })]).length, 1);
  // One distinct host more across the whole wrap is refused, and the message names the limit.
  const tooMany = [...biggest.slice(0, 19), secret({ envVar: "LAST", hosts: hosts(11, "last") })];
  assert.equal(code(() => parseSecrets(tooMany)), "BAD_REQUEST");
  assert.throws(() => parseSecrets(tooMany), /at most 200 distinct hosts across all secrets/);
  // The limit counts distinct hosts, the way the vault does: the same hosts bound to many secrets,
  // in any letter case, are counted once.
  const shared = hosts(50, "shared");
  const sameHosts = Array.from({ length: 5 }, (_, i) =>
    secret({ envVar: `D${i}`, hosts: i % 2 === 0 ? shared : shared.map((host) => host.toUpperCase()) }),
  );
  assert.equal(parseSecrets(sameHosts).length, 5);
  // 200 distinct hosts split over secrets that also repeat one another's hosts are still accepted...
  const overlapping = [
    secret({ envVar: "O1", hosts: hosts(50, "a") }),
    secret({ envVar: "O2", hosts: [...hosts(50, "a").slice(25), ...hosts(25, "b")] }),
    secret({ envVar: "O3", hosts: hosts(50, "c") }),
    secret({ envVar: "O4", hosts: hosts(50, "d") }),
    secret({ envVar: "O5", hosts: [...hosts(25, "b"), ...hosts(25, "e")] }),
  ];
  assert.equal(parseSecrets(overlapping).length, 5); // 50 + 25 + 50 + 50 + 25 new ones = 200 distinct
  // ...and one more distinct host is not.
  assert.equal(code(() => parseSecrets([...overlapping, secret({ envVar: "O6", hosts: ["extra.example.com"] })])), "BAD_REQUEST");
});

test("registerSecrets refuses when TLS termination is not active, before registering anything", () => {
  const registry = new SentinelRegistry();
  assert.equal(code(() => registerSecrets(registry, [secret()], false)), "POLICY_INVALID");
  assert.equal(registry.size, 0);
  // No secrets is fine with or without TLS.
  assert.deepEqual(registerSecrets(registry, [], false), {});
});

test("registerSecrets registers one sentinel per secret and returns only the placeholders", () => {
  const registry = new SentinelRegistry();
  const env = registerSecrets(
    registry,
    [secret(), secret({ envVar: "NPM_TOKEN", value: "npm-REAL-xyz", hosts: ["registry.npmjs.org"] })],
    true,
  );
  assert.deepEqual(Object.keys(env).sort(), ["GITHUB_TOKEN", "NPM_TOKEN"]);
  for (const sentinel of Object.values(env)) assert.match(sentinel, /^fake_value_[0-9a-f-]{36}/);
  assert.ok(!JSON.stringify(env).includes(REAL));
  assert.ok(!JSON.stringify(env).includes("npm-REAL-xyz"));
  assert.equal(registry.size, 2);
});

test("a sentinel becomes the real value only on the hosts of its own secret", () => {
  const registry = new SentinelRegistry();
  const env = registerSecrets(
    registry,
    [secret(), secret({ envVar: "NPM_TOKEN", value: "npm-REAL-xyz", hosts: ["registry.npmjs.org"] })],
    true,
  );
  const sent = (host: string, name: string): string => {
    const headers: Record<string, string> = { authorization: `Bearer ${env[name]}` };
    registry.substituteInHeaders(headers, host, matchesDomainPattern);
    return headers.authorization as string;
  };
  assert.equal(sent("api.github.com", "GITHUB_TOKEN"), `Bearer ${REAL}`);
  assert.equal(sent("evil.example.com", "GITHUB_TOKEN"), `Bearer ${env.GITHUB_TOKEN}`);
  // One secret's placeholder is not laundered through another secret's host.
  assert.equal(sent("registry.npmjs.org", "GITHUB_TOKEN"), `Bearer ${env.GITHUB_TOKEN}`);
  assert.equal(sent("registry.npmjs.org", "NPM_TOKEN"), "Bearer npm-REAL-xyz");
});

test("registering again keeps the placeholder and takes the new value", () => {
  const registry = new SentinelRegistry();
  const first = registerSecrets(registry, [secret()], true);
  const second = registerSecrets(registry, [secret({ value: "rotated-value-1" })], true);
  assert.equal(second.GITHUB_TOKEN, first.GITHUB_TOKEN);
  const headers: Record<string, string> = { authorization: first.GITHUB_TOKEN as string };
  registry.substituteInHeaders(headers, "api.github.com", matchesDomainPattern);
  assert.equal(headers.authorization, "rotated-value-1");
});
