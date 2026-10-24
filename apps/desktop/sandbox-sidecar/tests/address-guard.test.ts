import assert from "node:assert/strict";
import { test } from "node:test";
import { deniedReason } from "../src/address-guard.js";

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
