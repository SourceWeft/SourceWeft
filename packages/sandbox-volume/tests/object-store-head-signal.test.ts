import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createS3ObjectStore } from "../src/store/object-store";

test("HEAD composes caller cancellation with its own deadline and rejects forged signals", async () => {
  let requests = 0;
  let observed!: () => void;
  const arrived = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const server = createServer(() => {
    requests++;
    observed();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const store = createS3ObjectStore({
    bucket: "fixture",
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    requestTimeoutMs: 2000,
  });
  try {
    for (const signal of [
      { aborted: false },
      Object.create(AbortSignal.prototype),
    ])
      await assert.rejects(
        store.size("pack", { signal: signal as AbortSignal }),
        TypeError,
      );
    await assert.rejects(store.size("pack", { signal: AbortSignal.abort() }));
    assert.equal(requests, 0);
    const controller = new AbortController();
    const result = store.size("pack", { signal: controller.signal });
    const rejected = assert.rejects(result);
    await arrived;
    const at = Date.now();
    controller.abort();
    await rejected;
    assert.ok(Date.now() - at < 1000);
    assert.equal(requests, 1);
    const timeoutStore = createS3ObjectStore({
      bucket: "fixture",
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      requestTimeoutMs: 100,
    });
    const start = Date.now();
    await assert.rejects(
      timeoutStore.size("pack", { signal: new AbortController().signal }),
    );
    assert.ok(Date.now() - start < 2000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
