import assert from "node:assert/strict";
import test from "node:test";
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

test("validates public HTTPS endpoints with DNS resolution", async () => {
  assert.equal(
    await validatePublicHttpsEndpoint("https://api.example.com/v1/", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]),
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
  assert.throws(() => sanitizeCustomHeaders({ HOST: "example.com" }), /not allowed/);
  assert.throws(
    () => sanitizeCustomHeaders({ "x-forwarded-for": "127.0.0.1" }),
    /not allowed/,
  );
});
