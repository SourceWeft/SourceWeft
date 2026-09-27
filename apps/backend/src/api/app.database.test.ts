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
