import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isPublicIpAddress,
  sanitizeCustomHeaders,
  validatePublicHttpsEndpoint,
} from "./public-endpoint";

test("identifies public and non-public IP addresses", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicIpAddress("127.0.0.1"), false);
  assert.equal(isPublicIpAddress("10.0.0.1"), false);
  assert.equal(isPublicIpAddress("172.16.0.1"), false);
  assert.equal(isPublicIpAddress("192.168.1.1"), false);
  assert.equal(isPublicIpAddress("169.254.169.254"), false);
  assert.equal(isPublicIpAddress("0.0.0.0"), false);
  assert.equal(isPublicIpAddress("::1"), false);
  assert.equal(isPublicIpAddress("fc00::1"), false);
  assert.equal(isPublicIpAddress("fd00::1"), false);
  assert.equal(isPublicIpAddress("::ffff:10.0.0.1"), false);
});

test("preserves every IPv4 exclusion, including both range endpoints and mapped forms", () => {
  const ranges = [
    ["0.0.0.0", "0.255.255.255"],
    ["10.0.0.0", "10.255.255.255"],
    ["100.64.0.0", "100.127.255.255"],
    ["127.0.0.0", "127.255.255.255"],
    ["169.254.0.0", "169.254.255.255"],
    ["172.16.0.0", "172.31.255.255"],
    ["192.168.0.0", "192.168.255.255"],
    ["192.0.0.0", "192.0.0.255"],
    ["192.0.2.0", "192.0.2.255"],
    ["198.18.0.0", "198.19.255.255"],
    ["198.51.100.0", "198.51.100.255"],
    ["203.0.113.0", "203.0.113.255"],
    ["224.0.0.0", "239.255.255.255"],
    ["240.0.0.0", "255.255.255.255"],
  ];
  for (const address of ranges.flat()) {
    const mapped = new URL(`https://[::ffff:${address}]`).hostname.slice(1, -1);
    for (const form of [address, `::ffff:${address}`, mapped]) {
      assert.equal(isPublicIpAddress(form), false, form);
    }
  }
  for (const address of [
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ]) {
    assert.equal(isPublicIpAddress(address), true, address);
    assert.equal(isPublicIpAddress(`::ffff:${address}`), true, address);
  }
});

test("classifies expanded IPv6 and the whole link-local range", () => {
  for (const address of [
    "0:0:0:0:0:0:0:0",
    "0:0:0:0:0:0:0:1",
    "0:0:0:0:0:ffff:7f00:1",
    "fc00::",
    "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe80::",
    "fe90::1",
    "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "ff00::",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  for (const address of [
    "2606:4700:4700::1111",
    "::ffff:808:808",
    "fe7f::1",
    "fec0::1",
  ]) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
  // These transition prefixes are outside this change's policy scope.
  for (const address of ["::2", "64:ff9b::808:808", "2002:808:808::1"]) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
  for (const invalid of ["", "127.1", "256.1.1.1", "not-an-ip"]) {
    assert.equal(isPublicIpAddress(invalid), false, invalid);
  }
});

test("endpoint validation rejects normalized mapped loopback and mixed DNS answers", async () => {
  await assert.rejects(
    validatePublicHttpsEndpoint("https://[::ffff:127.0.0.1]/v1"),
    /not allowed/,
  );
  await assert.rejects(
    validatePublicHttpsEndpoint("https://[fe90::1]/v1"),
    /not allowed/,
  );
  await assert.rejects(
    validatePublicHttpsEndpoint("https://mixed.example", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "::ffff:7f00:1", family: 6 },
    ]),
    /public addresses/,
  );
  assert.equal(
    await validatePublicHttpsEndpoint("https://[::ffff:8.8.8.8]/v1"),
    "https://[::ffff:808:808]/v1",
  );
});

test("validates public HTTPS endpoints with DNS resolution", async () => {
  assert.equal(
    await validatePublicHttpsEndpoint(
      "https://api.example.com/v1/",
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    ),
    "https://api.example.com/v1",
  );
});

test("rejects unsafe endpoint URLs", async () => {
  await assert.rejects(
    validatePublicHttpsEndpoint("http://api.example.com/v1"),
    /HTTPS/,
  );
  await assert.rejects(
    validatePublicHttpsEndpoint("https://user:pass@example.com"),
    /credentials/,
  );
  await assert.rejects(
    validatePublicHttpsEndpoint("https://localhost:8080"),
    /not allowed/,
  );
  await assert.rejects(
    validatePublicHttpsEndpoint("https://service.local"),
    /not allowed/,
  );
  await assert.rejects(
    validatePublicHttpsEndpoint("https://127.0.0.1"),
    /not allowed/,
  );
  await assert.rejects(
    validatePublicHttpsEndpoint("https://[::1]"),
    /not allowed/,
  );
});

test("rejects hostnames that resolve to non-public addresses", async () => {
  await assert.rejects(
    validatePublicHttpsEndpoint("https://metadata.example.com", async () => [
      { address: "169.254.169.254", family: 4 },
    ]),
    /public addresses/,
  );
});

test("rejects hostnames without A or AAAA records", async () => {
  await assert.rejects(
    validatePublicHttpsEndpoint("https://empty.example.com", async () => []),
    /resolve/,
  );
});

test("sanitizes custom headers and rejects dangerous names", () => {
  assert.deepEqual(sanitizeCustomHeaders({ " X-Feature ": " enabled " }), {
    "X-Feature": "enabled",
  });

  assert.throws(
    () => sanitizeCustomHeaders({ Authorization: "Bearer token" }),
    /not allowed/,
  );
  assert.throws(
    () => sanitizeCustomHeaders({ HOST: "example.com" }),
    /not allowed/,
  );
  assert.throws(
    () => sanitizeCustomHeaders({ "x-forwarded-for": "127.0.0.1" }),
    /not allowed/,
  );
});
