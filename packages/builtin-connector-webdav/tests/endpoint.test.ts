import assert from "node:assert/strict";
import test from "node:test";
import { WebDavError } from "../src/errors";
import { parseEndpoint, redactEndpoint } from "../src/endpoint";

function rejects(raw: string): WebDavError {
  try {
    parseEndpoint(raw);
  } catch (error) {
    assert.ok(error instanceof WebDavError, "expected WebDavError");
    return error;
  }
  assert.fail(`expected ${JSON.stringify(raw)} to be rejected`);
}

test("accepts https and http endpoints and adds a trailing slash to the base path", () => {
  const cases: Array<[string, string]> = [
    ["https://dav.example.com", "https://dav.example.com/"],
    ["https://dav.example.com/", "https://dav.example.com/"],
    [
      "https://cloud.example.com/remote.php/dav/files/alice",
      "https://cloud.example.com/remote.php/dav/files/alice/",
    ],
    ["  http://192.168.1.5:8080/dav/  ", "http://192.168.1.5:8080/dav/"],
    ["HTTPS://DAV.Example.COM:8443/x", "https://dav.example.com:8443/x/"],
    ["http://[::1]:5232/dav", "http://[::1]:5232/dav/"],
    ["https://h.example/My%20Files", "https://h.example/My%20Files/"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(parseEndpoint(raw).href, expected, raw);
  }
});

test("rejects userinfo, query, fragment, other schemes and malformed values", () => {
  const cases = [
    "",
    "   ",
    "not a url",
    "dav.example.com/path",
    "ftp://dav.example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "webdav://dav.example.com/",
    "https://user@dav.example.com/",
    "https://user:pw@dav.example.com/",
    "https://:pw@dav.example.com/",
    "https://@dav.example.com/",
    "https://dav.example.com/?token=abc",
    "https://dav.example.com/?",
    "https://dav.example.com/dav#frag",
    "https://dav.example.com/dav#",
    "https://dav.example.com/ dav",
    "https://dav.example.com/\tdav",
    "https://",
    `https://dav.example.com/${"a".repeat(2100)}`,
  ];
  for (const raw of cases) {
    const error = rejects(raw);
    assert.equal(error.code, "WEBDAV_ENDPOINT_INVALID", JSON.stringify(raw));
  }
});

test("rejected endpoints never echo the value (it may carry a secret)", () => {
  const error = rejects("https://alice:hunter2@dav.example.com/?token=SECRET");
  assert.equal(error.message.includes("hunter2"), false);
  assert.equal(error.message.includes("SECRET"), false);
  assert.equal(error.message.includes("alice"), false);
});

test("redactEndpoint keeps scheme, host and path only", () => {
  assert.equal(
    redactEndpoint(new URL("https://dav.example.com:8443/a/b/")),
    "https://dav.example.com:8443/a/b/",
  );
});
