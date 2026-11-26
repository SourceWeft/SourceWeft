import assert from "node:assert/strict";
import { test } from "vitest";
import { createApp } from "./app";

// Desktop sign-in hands its one-time token back only through the local
// `sourceweft://` deep link. The server-side rendezvous that the desktop app
// used to poll must stay gone: anything that lets a token be collected from
// the server reopens a remote pickup channel.
test("does not serve the removed desktop sign-in rendezvous", async () => {
  const app = createApp();

  const poll = await app.request(
    `http://localhost/v1/desktop-auth/poll?state=${"a".repeat(32)}`,
  );
  const complete = await app.request(
    "http://localhost/v1/desktop-auth/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "a".repeat(32), token: "token" }),
    },
  );

  assert.equal(poll.status, 404);
  assert.equal(complete.status, 404);
});

test("every API response carries the baseline security headers and no framing header", async () => {
  const response = await createApp().request("http://localhost/v1/health");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  // Public share bytes are framed by the (cross-origin) web app and carry
  // their own `frame-ancestors`; a global framing header would break them.
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(response.headers.get("content-security-policy"), null);
});

// Issue #767: the readiness endpoint sits beside the liveness one and leaves
// it as it was, a fixed answer that reads nothing.
test("GET /v1/health keeps its fixed liveness body next to the readiness endpoint", async () => {
  const app = createApp();

  const health = await app.request("http://localhost/v1/health");
  const body = (await health.json()) as Record<string, unknown>;
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(body).sort(), [
    "commit",
    "service",
    "status",
    "timestamp",
  ]);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "backend-api");

  const ready = await app.request("http://localhost/v1/health/ready");
  const report = (await ready.json()) as Record<string, unknown>;
  assert.equal(ready.status, 200);
  assert.equal(report.status, "ok");
  assert.deepEqual(Object.keys(report.checks as object), [
    "database",
    "catalog",
  ]);
});
