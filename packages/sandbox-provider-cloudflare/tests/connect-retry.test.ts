import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failedBeforeRequest,
  fetchAfterConnectRetry,
} from "../src/connect-retry";

const tls = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(
      new Error(
        "Client network socket disconnected before secure TLS connection was established",
      ),
      { code: "ECONNRESET" },
    ),
  });
test("a proven pre-TLS reset reconnects without changing request content", async () => {
  let calls = 0;
  const init = { method: "POST", body: "exact command" };
  const fetcher = (async (_url, options) => {
    calls++;
    assert.equal(options, init);
    if (calls < 3) throw tls();
    return new Response("ok");
  }) as typeof fetch;
  assert.equal(
    await (
      await fetchAfterConnectRetry(
        fetcher,
        "https://bridge.invalid/exec",
        init,
        0,
      )
    ).text(),
    "ok",
  );
  assert.equal(calls, 3);
});
test("unknown resets and response failures never replay a possibly executed command", async () => {
  for (const error of [
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    Object.assign(new Error("headers timed out"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    }),
  ]) {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      throw error;
    }) as typeof fetch;
    await assert.rejects(
      fetchAfterConnectRetry(
        fetcher,
        "https://bridge.invalid/exec",
        { method: "POST", body: "command" },
        0,
      ),
      (value) => value === error,
    );
    assert.equal(calls, 1);
  }
});
test("retry budget and cancellation are finite", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    throw tls();
  }) as typeof fetch;
  await assert.rejects(
    fetchAfterConnectRetry(fetcher, "https://bridge.invalid", {}, 0),
  );
  assert.equal(calls, 3);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchAfterConnectRetry(
      fetcher,
      "https://bridge.invalid",
      { signal: controller.signal },
      0,
    ),
  );
  assert.equal(calls, 3);
});
test("a response, even an HTTP failure, is not retried", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response("busy", { status: 503 });
  }) as typeof fetch;
  assert.equal(
    (await fetchAfterConnectRetry(fetcher, "https://bridge.invalid", {}, 0))
      .status,
    503,
  );
  assert.equal(calls, 1);
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(failedBeforeRequest(cyclic), false);
});
