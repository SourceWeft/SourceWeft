import assert from "node:assert/strict";
import { test } from "vitest";
import { validatePublicHttpUrl } from "./url-safety";

test("allows public http and https URLs", () => {
  assert.equal(
    validatePublicHttpUrl("https://example.com/a"),
    "https://example.com/a",
  );
  assert.equal(
    validatePublicHttpUrl("http://example.com/"),
    "http://example.com/",
  );
});

test("rejects non-http URLs", () => {
  assert.throws(
    () => validatePublicHttpUrl("file:///etc/passwd"),
    /http or https/,
  );
});

test("rejects localhost and private IP URLs", () => {
  assert.throws(
    () => validatePublicHttpUrl("http://localhost:3000"),
    /not allowed/,
  );
  assert.throws(
    () => validatePublicHttpUrl("http://127.0.0.1:3000"),
    /not allowed/,
  );
  assert.throws(
    () => validatePublicHttpUrl("http://192.168.1.1"),
    /not allowed/,
  );
});

test("rejects credential URLs", () => {
  assert.throws(
    () => validatePublicHttpUrl("https://user:pass@example.com"),
    /credentials/,
  );
});
