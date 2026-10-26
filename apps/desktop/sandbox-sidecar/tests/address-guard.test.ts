import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalHost, deniedReason } from "../src/address-guard.js";

const own = new Set(["192.168.1.57"]);
for (const h of [
  "localhost",
  "api.localhost",
  "127.0.0.1",
  "[::1]",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "10.0.0.1",
  "172.16.5.5",
  "192.168.1.1",
  "100.64.0.1",
  "169.254.169.254",
  "100.100.100.200",
  "168.63.129.16",
  "192.0.0.192",
  "fd00:ec2::254",
  "fc00::1",
  "fe80::1",
  "224.0.0.1",
  "0.0.0.0",
  "192.168.1.57",
])
  test(`denies ${h}`, () => assert.notEqual(deniedReason(h, own), null));
for (const h of [
  "registry.npmjs.org",
  "github.com",
  "8.8.8.8",
  "2606:4700:4700::1111",
  "10.0.0.1.nip.io",
])
  test(`allows ${h} (names are left to the resolved-address check)`, () =>
    assert.equal(deniedReason(h, own), null));

// Fix round 1 (review): IPv4-compatible IPv6 in hex-group form, zone ids, and
// trailing-dot/uppercase hostnames must not bypass the guard; `::` and `::1` (bare, not
// bracketed) must stay denied too.
for (const h of [
  "::7f00:1", // IPv4-compatible (deprecated) hex-group form of 127.0.0.1
  "0:0:0:0:0:0:7f00:1", // same, fully expanded (no "::" compression)
  "[::7f00:1]", // same, bracketed
  "::ffff:0a00:0001", // IPv4-mapped hex-group form of 10.0.0.1 (RFC1918)
  "fe80::1%en0", // link-local with a zone id
  "localhost.", // trailing-dot absolute name
  "LOCALHOST.", // uppercase + trailing dot
  "api.localhost.", // *.localhost + trailing dot
  "127.0.0.1.", // IPv4 literal + trailing dot
  "::FFFF:7F00:1", // uppercase IPv4-mapped hex-group form
  "::", // bare IPv6 unspecified address
  "::1", // bare IPv6 loopback address
])
  test(`denies ${h} (fix round 1 regression)`, () =>
    assert.notEqual(deniedReason(h, own), null));

// Fix round 2 (review): the own-address check must be family-aware — an own IPv4 address
// must also be denied via its IPv4-mapped/compatible (incl. hex-group) IPv6 forms, and an
// own IPv6 address must still match a host string carrying a zone id.
const ownRound2 = new Set(["203.0.113.7", "fe80::1234"]);
for (const h of [
  "203.0.113.7", // the own IPv4 address itself
  "::ffff:203.0.113.7", // IPv4-mapped, dotted form
  "::ffff:cb00:7107", // IPv4-mapped, hex-group form (cb00:7107 == 203.0.113.7)
  "::cb00:7107", // IPv4-compatible (deprecated), hex-group form
  "fe80::1234%en0", // the own IPv6 address with a zone id
])
  test(`denies ${h} (fix round 2: own address, family-aware)`, () =>
    assert.notEqual(deniedReason(h, ownRound2), null));
test("allows 203.0.113.8 (not an own address)", () =>
  assert.equal(deniedReason("203.0.113.8", ownRound2), null));

// Final review C1: srt's proxy dials the WHATWG-canonical spelling of a host, so every
// inet_aton spelling of a denied address must be denied too — including the host's own
// address written in shorthand.
for (const h of [
  "127.1", // shorthand → 127.0.0.1
  "127.1.", // shorthand + trailing dot
  "2130706433", // integer → 127.0.0.1
  "0x7f000001", // hex integer → 127.0.0.1
  "0x7f.0.0.1", // hex octet → 127.0.0.1
  "0177.0.0.1", // octal octet → 127.0.0.1
  "10.1", // shorthand → 10.0.0.1
  "169.254.43518", // shorthand → 169.254.169.254
  "2852039166", // integer → 169.254.169.254
  "0xa9fea9fe", // hex integer → 169.254.169.254
  "192.168.313", // own address 192.168.1.57 in shorthand
  "3232235833", // own address 192.168.1.57 as an integer
  "[127.1]", // bracketed shorthand (not an IPv6 literal, still canonicalised)
])
  test(`denies ${h} (C1: canonical IPv4 spelling)`, () =>
    assert.notEqual(deniedReason(h, own), null));

test("canonicalHost matches what srt dials for every spelling", () => {
  for (const [raw, dialed] of [
    ["127.1", "127.0.0.1"],
    ["2130706433", "127.0.0.1"],
    ["0x7f.0.0.1", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["10.1", "10.0.0.1"],
    ["2852039166", "169.254.169.254"],
    ["Api.Example.COM.", "api.example.com"],
    ["[::1]", "::1"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["例え.jp", "xn--r8jz45g.jp"],
  ] as const)
    assert.equal(canonicalHost(raw), dialed, raw);
});

// Hosts srt itself cannot canonicalise fall back to the raw spelling there; this guard cannot
// judge what that dials, so it denies them.
for (const h of ["foo.123", "1.2.3.4.5", "fe80::1%en0", "bad host", ""])
  test(`denies ${JSON.stringify(h)} (C1: not canonicalisable)`, () =>
    assert.notEqual(deniedReason(h, own), null));

for (const h of ["134744072", "8.8.8.8.", "a_b.example.com", "64:ff9b::808:808"])
  test(`allows ${h} (canonical form is public)`, () =>
    assert.equal(deniedReason(h, own), null));

// M2: parity with srt's own address classes.
for (const h of [
  "0.1.2.3", // 0.0.0.0/8
  "255.255.255.255", // limited broadcast
  "64:ff9b::a00:1", // NAT64 of 10.0.0.1
  "64:ff9b::7f00:1", // NAT64 of 127.0.0.1
  "2002:7f00:1::", // 6to4 of 127.0.0.1
  "2002:a9fe:a9fe::1", // 6to4 of 169.254.169.254
  "::ffff:0:7f00:1", // IPv4-translated 127.0.0.1
])
  test(`denies ${h} (M2: srt address-class parity)`, () =>
    assert.notEqual(deniedReason(h, own), null));

// The guard must judge exactly the spelling srt dials: compare against srt's own
// canonicalisation (an internal module of the pinned srt release, imported only here).
test("canonicalHost agrees with srt's canonicalizeHost", async () => {
  const { canonicalizeHost } = await import(
    "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js"
  );
  for (const raw of [
    "127.1",
    "127.1.",
    "2130706433",
    "0x7f000001",
    "0x7f.0.0.1",
    "0177.0.0.1",
    "10.1",
    "169.254.43518",
    "2852039166",
    "192.168.313",
    "[127.1]",
    "Api.Example.COM.",
    "[::1]",
    "::7f00:1",
    "0:0:0:0:0:0:7f00:1",
    "64:ff9b::a00:1",
    "例え.jp",
    "10.0.0.1.nip.io",
    "foo.123",
    "fe80::1%en0",
  ]) {
    const srt: string | undefined = canonicalizeHost(raw);
    const ours = canonicalHost(raw);
    if (srt === undefined) assert.equal(ours, null, raw);
    // srt spells an IPv4-mapped literal as its IPv4 address; this guard keeps the IPv6 form
    // and matches it through the embedded entries, so only compare the other forms.
    else if (!/ffff/i.test(raw)) assert.equal(ours, srt, raw);
  }
});
