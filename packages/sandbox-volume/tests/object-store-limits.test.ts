import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createS3ObjectStore } from "../src/store/object-store";

async function fixture(handler: (response: ServerResponse) => void) {
  const server = createServer((_request, response) => handler(response));
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
    requestTimeoutMs: 1500,
  });
  return {
    store,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

for (const body of ["", "<html><body>upstream route missing</body></html>"])
  test(`an unclassified 404 ${body ? "HTML" : "empty"} response is not an absent WAL object`, async () => {
    const f = await fixture((response) => {
      response.writeHead(404, { "content-type": "text/html" });
      response.end(body);
    });
    try {
      await assert.rejects(f.store.get("manifest"));
    } finally {
      await f.close();
    }
  });

test("HEAD retains its bodyless missing-object contract for helper publication", async () => {
  const f = await fixture((response) => {
    response.writeHead(404);
    response.end();
  });
  try {
    assert.equal(await f.store.size("missing"), null);
  } finally {
    await f.close();
  }
});

test("object GET cancels an oversized declared body before consuming it", async () => {
  const f = await fixture((response) => {
    response.writeHead(200, { "content-length": 1024 * 1024 });
    response.write(Buffer.alloc(1024));
  });
  try {
    await assert.rejects(
      f.store.get("manifest", { maxBytes: 8192 }),
      /object.*size limit/i,
    );
  } finally {
    await f.close();
  }
});

test("chunked object GET stops an unbounded producer at its byte budget", async () => {
  let sent = 0;
  let disconnected = false;
  const f = await fixture((response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    const timer = setInterval(() => {
      sent += 4096;
      response.write(Buffer.alloc(4096));
    }, 5);
    response.on("close", () => {
      clearInterval(timer);
      disconnected = true;
    });
  });
  try {
    await assert.rejects(
      f.store.get("manifest", { maxBytes: 8192 }),
      /object.*size limit/i,
    );
    const deadline = Date.now() + 1000;
    while (!disconnected && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(disconnected, true);
    assert.ok(sent < 1024 * 1024, `read ${sent} bytes after an 8 KiB budget`);
  } finally {
    await f.close();
  }
});

test("the exact byte budget remains readable and truncated success is never returned", async () => {
  const expected = Buffer.alloc(8192, 42);
  const exact = await fixture((response) => {
    response.writeHead(200);
    response.end(expected);
  });
  try {
    assert.deepEqual(
      Buffer.from(
        (await exact.store.get("manifest", { maxBytes: expected.length }))!,
      ),
      expected,
    );
  } finally {
    await exact.close();
  }
  const truncated = await fixture((response) => {
    response.writeHead(200, { "content-length": expected.length });
    response.write(expected.subarray(0, 1024));
    setTimeout(() => response.destroy(), 10);
  });
  try {
    await assert.rejects(
      truncated.store.get("manifest", { maxBytes: expected.length }),
    );
  } finally {
    await truncated.close();
  }
});
