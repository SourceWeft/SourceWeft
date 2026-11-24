import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  createDavClient,
  WebDavError,
} from "@sourceweft/builtin-connector-webdav";
import { afterEach, test } from "vitest";
import { createCredentialedFetchScope } from "./public-fetch";

/**
 * Proves the real credentialed controlled-fetch scope (the one the WebDAV
 * adapter runs against in production) follows a same-origin redirect with the
 * Authorization header intact and refuses a cross-origin one — the behaviour
 * that the adapter's own dav-client relies on now that it no longer forces
 * redirect:"manual" (finding F5). The package cannot import backend code, so
 * the proof lives here, driving `createDavClient` over `scope.fetch`.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];

async function listen(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const COLLECTION_207 =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav2/</d:href>` +
  `<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>` +
  `<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const credential = { username: "alice", secret: "app-password" };
const expectedAuth = `Basic ${Buffer.from("alice:app-password", "utf8").toString("base64")}`;

test("a same-origin PROPFIND redirect is followed and still carries Authorization", async () => {
  let authOnFinal: string | undefined;
  const origin = await listen((req, res) => {
    if (req.url === "/dav/") {
      res.statusCode = 301;
      res.setHeader("location", "/dav2/");
      res.end();
      return;
    }
    authOnFinal = req.headers.authorization;
    res.statusCode = 207;
    res.setHeader("content-type", "application/xml; charset=utf-8");
    res.end(COLLECTION_207);
  });
  const scope = createCredentialedFetchScope([origin]);
  try {
    const client = createDavClient({
      fetch: scope.fetch,
      endpoint: new URL(`${origin}/dav/`),
      credential,
    });
    const entries = await client.propfind("/", 1);
    assert.equal(entries.length, 1);
    assert.equal(authOnFinal, expectedAuth);
  } finally {
    await scope.close();
  }
});

test("a same-origin GET redirect is followed and still carries Authorization", async () => {
  let authOnFinal: string | undefined;
  const origin = await listen((req, res) => {
    if (req.url === "/dav/a.txt") {
      res.statusCode = 302;
      res.setHeader("location", "/dav/a2.txt");
      res.end();
      return;
    }
    authOnFinal = req.headers.authorization;
    res.statusCode = 200;
    res.end("hello");
  });
  const scope = createCredentialedFetchScope([origin]);
  try {
    const client = createDavClient({
      fetch: scope.fetch,
      endpoint: new URL(`${origin}/dav/`),
      credential,
    });
    const result = await client.get("/a.txt", { maxBytes: 1000 });
    assert.equal(new TextDecoder().decode(result.body), "hello");
    assert.equal(authOnFinal, expectedAuth);
  } finally {
    await scope.close();
  }
});

test("a cross-origin redirect is refused with zero requests at the target", async () => {
  let targetHits = 0;
  const target = await listen((_req, res) => {
    targetHits++;
    res.end("leaked");
  });
  const origin = await listen((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", `${target}/dav/`);
    res.end();
  });
  const scope = createCredentialedFetchScope([origin, target]);
  try {
    const client = createDavClient({
      fetch: scope.fetch,
      endpoint: new URL(`${origin}/dav/`),
      credential,
    });
    await assert.rejects(client.propfind("/", 1), (error: unknown) => {
      assert.ok(error instanceof WebDavError);
      assert.equal(error.code, "WEBDAV_BLOCKED_ENDPOINT");
      return true;
    });
    assert.equal(targetHits, 0);
  } finally {
    await scope.close();
  }
});
