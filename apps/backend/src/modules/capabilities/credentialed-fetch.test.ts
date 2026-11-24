import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "vitest";
import { EndpointPolicyError } from "../../shared/security/endpoint-policy";
import {
  createCredentialedFetchScope,
  createPublicFetchScope,
} from "./public-fetch";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];

async function listen(handler: Handler) {
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

test("a listed http private origin is reachable", async () => {
  const origin = await listen((_req, res) => {
    res.statusCode = 207;
    res.end("ok");
  });
  const scope = createCredentialedFetchScope([origin]);
  try {
    const response = await scope.fetch(`${origin}/dav/`, {
      method: "PROPFIND",
    });
    assert.equal(response.status, 207);
    assert.equal(await response.text(), "ok");
  } finally {
    await scope.close();
  }
});

test("a private origin that is not listed is refused", async () => {
  let hits = 0;
  const origin = await listen((_req, res) => {
    hits++;
    res.end("ok");
  });
  const scope = createCredentialedFetchScope([]);
  try {
    await assert.rejects(scope.fetch(`${origin}/dav/`), EndpointPolicyError);
    assert.equal(hits, 0);
  } finally {
    await scope.close();
  }
});

test("a listed origin does not authorize a different private origin", async () => {
  let hits = 0;
  const other = await listen((_req, res) => {
    hits++;
    res.end("ok");
  });
  const listed = await listen((_req, res) => res.end("ok"));
  const scope = createCredentialedFetchScope([listed]);
  try {
    await assert.rejects(scope.fetch(`${other}/dav/`), EndpointPolicyError);
    assert.equal(hits, 0);
  } finally {
    await scope.close();
  }
});

test("a cross-origin redirect is refused even to another listed origin and the target sees no request", async () => {
  let secondHits = 0;
  const second = await listen((_req, res) => {
    secondHits++;
    res.end("leaked");
  });
  const first = await listen((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", `${second}/dav/`);
    res.end();
  });
  const scope = createCredentialedFetchScope([first, second]);
  try {
    await assert.rejects(
      scope.fetch(`${first}/dav/`, {
        headers: { authorization: "Basic dGVzdDp0ZXN0" },
      }),
      EndpointPolicyError,
    );
    assert.equal(secondHits, 0);
  } finally {
    await scope.close();
  }
});

test("a same-origin redirect is followed", async () => {
  const origin = await listen((req, res) => {
    if (req.url === "/dav") {
      res.statusCode = 301;
      res.setHeader("location", "/dav/");
      res.end();
      return;
    }
    res.end(`auth=${req.headers.authorization ?? ""}`);
  });
  const scope = createCredentialedFetchScope([origin]);
  try {
    const response = await scope.fetch(`${origin}/dav`, {
      headers: { authorization: "Basic dGVzdDp0ZXN0" },
    });
    assert.equal(await response.text(), "auth=Basic dGVzdDp0ZXN0");
  } finally {
    await scope.close();
  }
});

test("the public scope still refuses private addresses and http", async () => {
  const origin = await listen((_req, res) => res.end("ok"));
  const scope = createPublicFetchScope();
  try {
    await assert.rejects(scope.fetch(`${origin}/feed`), EndpointPolicyError);
    await assert.rejects(
      scope.fetch("https://10.0.0.1/feed"),
      EndpointPolicyError,
    );
  } finally {
    await scope.close();
  }
});

test("close leaves the credentialed scope unusable", async () => {
  const scope = createCredentialedFetchScope([]);
  await scope.close();
  await assert.rejects(scope.fetch("https://example.com/dav/"), /closed/);
});
