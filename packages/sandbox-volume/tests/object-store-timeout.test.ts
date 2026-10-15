import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createS3ObjectStore } from "../src/store/object-store";
for (const phase of ["headers", "body"] as const)
  test(`object GET deadline aborts a stalled ${phase} response`, async () => {
    const server = createServer((_request, response) => {
      if (phase === "body") {
        response.writeHead(200, { "content-length": "1000" });
        response.write("partial");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const store = createS3ObjectStore({
      bucket: "test",
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      requestTimeoutMs: 100,
    });
    try {
      const started = Date.now();
      await assert.rejects(store.get("stalled"));
      assert.ok(Date.now() - started < 3000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

test("individual GC deletion also has an abort deadline", async () => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const store = createS3ObjectStore({
    bucket: "test",
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    requestTimeoutMs: 100,
  });
  try {
    await assert.rejects(store.deleteObject!("stalled"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
