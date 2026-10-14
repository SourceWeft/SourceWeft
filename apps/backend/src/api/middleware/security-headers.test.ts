import assert from "node:assert/strict";
import { test } from "vitest";
import { createRouteTestApp } from "../../test/hono";
import { securityHeadersMiddleware } from "./security-headers";

const createTestApp = () =>
  createRouteTestApp((app) => {
    app.use("*", securityHeadersMiddleware);
    app.get("/plain", (c) => c.json({ ok: true }));
    app.get("/own", (c) => {
      c.header(
        "Content-Security-Policy",
        "frame-ancestors 'self' https://web.example",
      );
      c.header("Referrer-Policy", "same-origin");
      c.header("Strict-Transport-Security", "max-age=60");
      return c.body("<p>hi</p>");
    });
    app.get("/boom", () => {
      throw new Error("boom");
    });
  });

const baseline = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function assertHeaders(response: Response, expected: Record<string, string>) {
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(response.headers.get(name), value, name);
  }
}

test("adds the baseline headers to an ordinary response", async () => {
  const response = await createTestApp().request("http://localhost/plain");

  assert.equal(response.status, 200);
  assertHeaders(response, baseline);
});

test("adds the baseline headers to not-found and error responses", async () => {
  const app = createTestApp();

  const missing = await app.request("http://localhost/nope");
  assert.equal(missing.status, 404);
  assertHeaders(missing, baseline);

  const failed = await app.request("http://localhost/boom");
  assert.equal(failed.status, 500);
  assertHeaders(failed, baseline);
});

test("never replaces a header the route set itself", async () => {
  const response = await createTestApp().request("http://localhost/own");

  assertHeaders(response, {
    "content-security-policy": "frame-ancestors 'self' https://web.example",
    "referrer-policy": "same-origin",
    "strict-transport-security": "max-age=60",
    "x-content-type-options": "nosniff",
  });
});

test("sets no framing headers: public share bytes are framed cross-origin", async () => {
  const response = await createTestApp().request("http://localhost/plain");

  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(response.headers.get("content-security-policy"), null);
});
