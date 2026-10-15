import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createS3ObjectStore } from "../src/store/object-store";
for (const partial of [true, false])
  test(`bulk object cleanup ${partial ? "rejects per-object errors even with HTTP 200" : "counts only successful batches"}`, async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("content-type", "application/xml");
        if (request.method === "GET")
          response.end(
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Contents><Key>prefix/a</Key></Contents><Contents><Key>prefix/b</Key></Contents></ListBucketResult>',
          );
        else
          response.end(
            partial
              ? '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Error><Key>prefix/b</Key><Code>AccessDenied</Code><Message>denied</Message></Error></DeleteResult>'
              : '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>',
          );
      });
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
      requestTimeoutMs: 2000,
    });
    try {
      if (partial)
        await assert.rejects(
          store.deletePrefix("prefix/"),
          /cleanup was incomplete: 1 objects failed \(AccessDenied\)/,
        );
      else assert.equal(await store.deletePrefix("prefix/"), 2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

for (const code of ["NoSuchKey", "NoSuchBucket", "AccessDenied"])
  test(`object GET classifies ${code} independently of HTTP 404`, async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end(
        `<Error><Code>${code}</Code><Message>fixture</Message></Error>`,
      );
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
      requestTimeoutMs: 2000,
    });
    try {
      if (code === "NoSuchKey") assert.equal(await store.get("missing"), null);
      else
        await assert.rejects(
          store.get("missing"),
          (error) => error instanceof Error && error.name === code,
        );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
