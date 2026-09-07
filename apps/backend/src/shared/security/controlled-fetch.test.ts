import assert from "node:assert/strict";
import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "vitest";
import { createControlledFetch } from "./controlled-fetch";
import { EndpointPolicyError, validateEndpointUrl } from "./endpoint-policy";

const servers: Server[] = [];
const scopes: ReturnType<typeof createControlledFetch>[] = [];
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => scope.close()));
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
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
function scope(...args: Parameters<typeof createControlledFetch>) {
  const value = createControlledFetch(...args);
  scopes.push(value);
  return value;
}

test("validated DNS addresses are used by the socket, and response remains a native stream", async () => {
  const port = await serve((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end("data: first\n\n");
  });
  const origin = `http://localhost:${port}`;
  let lookups = 0;
  const requests = scope(
    { enforceAddressChecks: true, allowedInternalOrigins: [origin] },
    {
      lookup: async () => {
        lookups++;
        return [
          {
            address: lookups === 1 ? "127.0.0.1" : "169.254.169.254",
            family: 4,
          },
        ];
      },
    },
  );
  const response = await requests.fetch(`${origin}/events`);
  assert.equal(await response.text(), "data: first\n\n");
  assert.equal(lookups, 1, "socket must not repeat DNS after approving its IP");
});

test("a public precheck does not authorize later DNS rebinding; denial poisons only its scope", async () => {
  let lookups = 0;
  const lookup = async () => [
    { address: ++lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
  ];
  const policy = { enforceAddressChecks: true, allowedInternalOrigins: [] };
  await validateEndpointUrl("https://rebind.example", policy, lookup);
  const requests = scope(policy, { lookup });
  await assert.rejects(
    requests.fetch("https://rebind.example", {
      signal: AbortSignal.timeout(2000),
    }),
    EndpointPolicyError,
  );
  const count = lookups;
  await assert.rejects(
    requests.fetch("https://another.example"),
    EndpointPolicyError,
  );
  assert.equal(lookups, count);
  assert.throws(requests.throwIfDenied, EndpointPolicyError);
});

test("development policy survives scope copying and connects through the original DNS lookup", async () => {
  const port = await serve((_req, res) => res.end("development connection"));
  const policy = { enforceAddressChecks: false, allowedInternalOrigins: [] };
  let lookups = 0;
  const requests = scope(policy, {
    lookup: async () => {
      lookups++;
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  policy.enforceAddressChecks = true;
  const response = await requests.fetch(`http://model.internal:${port}/v1`);
  assert.equal(await response.text(), "development connection");
  assert.equal(lookups, 1);
  requests.throwIfDenied();
});

test.each([true, false])(
  "cross-origin redirects never forward credentials with address checks=%s",
  async (enforceAddressChecks) => {
    let reached = false;
    const targetPort = await serve((_req, res) => {
      reached = true;
      res.end("leak");
    });
    const target = `http://127.0.0.1:${targetPort}`;
    const port = await serve((_req, res) => {
      res.writeHead(307, { location: `${target}/token` });
      res.end();
    });
    const origin = `http://127.0.0.1:${port}`;
    const requests = scope({
      enforceAddressChecks,
      allowedInternalOrigins: [origin, target],
    });
    await assert.rejects(
      requests.fetch(origin, {
        method: "POST",
        headers: { "X-Private-Key": "test-key" },
        body: "private-body",
      }),
      /Cross-origin/,
    );
    assert.equal(reached, false);
  },
);

test("same-origin redirects preserve POST on 307 and explicit manual mode", async () => {
  const port = await serve((req, res) => {
    if (req.url === "/start") {
      res.writeHead(307, { location: "/end" });
      res.end();
      return;
    }
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => res.end(`${req.method}:${body}`));
  });
  const origin = `http://127.0.0.1:${port}`;
  const requests = scope({
    enforceAddressChecks: true,
    allowedInternalOrigins: [origin],
  });
  assert.equal(
    await (
      await requests.fetch(`${origin}/start`, {
        method: "POST",
        body: "payload",
      })
    ).text(),
    "POST:payload",
  );
  const manual = await requests.fetch(`${origin}/start`, {
    redirect: "manual",
  });
  assert.equal(manual.status, 307);
  await manual.body?.cancel();
});

test("caller cancellation and closing the scope terminate active streams", async () => {
  const port = await serve((_req, res) => {
    res.writeHead(200);
    res.write("first");
  });
  const origin = `http://127.0.0.1:${port}`;
  const requests = scope({
    enforceAddressChecks: true,
    allowedInternalOrigins: [origin],
  });
  const controller = new AbortController();
  const response = await requests.fetch(origin, { signal: controller.signal });
  controller.abort();
  await assert.rejects(response.text());
  const second = await requests.fetch(origin);
  await requests.close();
  await assert.rejects(second.text());
  await assert.rejects(requests.fetch(origin), /closed/);
});

test("credentialed URLs fail without echoing their credentials", async () => {
  const requests = scope({
    enforceAddressChecks: true,
    allowedInternalOrigins: [],
  });
  await assert.rejects(
    requests.fetch("https://user:do-not-echo@example.test"),
    (error: unknown) => {
      assert.ok(error instanceof EndpointPolicyError);
      assert.ok(!error.message.includes("do-not-echo"));
      return true;
    },
  );
});
