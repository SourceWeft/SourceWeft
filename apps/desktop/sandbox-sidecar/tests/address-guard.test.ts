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
