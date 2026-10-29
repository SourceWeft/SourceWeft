import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, test } from "vitest";

const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Request")!;
const responseDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Response")!;
afterEach(() => {
  // The adapter installs optimized globals by default, as it does in production.
  Object.defineProperty(globalThis, "Request", requestDescriptor);
  Object.defineProperty(globalThis, "Response", responseDescriptor);
});

async function listen(app: Hono) {
  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: 0,
  }) as Server;
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TCP listener");
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("Node adapter preserves JSON, streamed responses, client IP and the gateway's HTTP upgrade transport", async () => {
  const app = new Hono();
  app.post("/echo", async (c) => c.json(await c.req.json()));
  app.get("/ip", (c) => c.json(getConnInfo(c)));
  app.get("/events", (c) =>
    c.body(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
          controller.close();
        },
      }),
      200,
      { "Content-Type": "text/event-stream" },
    ),
  );
  const { server, url, port } = await listen(app);
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/socket") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (client) =>
      client.on("message", (message) => client.send(message)),
    );
  });
  let client: WebSocket | undefined;
  try {
    const json = await fetch(`${url}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ safe: true }),
    });
    expect(await json.json()).toEqual({ safe: true });
    const info = await (await fetch(`${url}/ip`)).json();
    expect(info.remote.address).toBe("127.0.0.1");
    expect(await (await fetch(`${url}/events`)).text()).toBe("data: ready\n\n");
    client = new WebSocket(`ws://127.0.0.1:${port}/socket`);
    await once(client, "open");
    const reply = once(client, "message");
    client.send("gateway-transport");
    expect(String((await reply)[0])).toBe("gateway-transport");
    const ended = once(client, "close");
    client.close();
    await ended;
  } finally {
    client?.terminate();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await close(server);
  }
});

test("static files cannot bypass prefix middleware through a second path decode", async () => {
  const root = await mkdtemp(join(tmpdir(), "sourceweft-adapter-"));
  await mkdir(join(root, "private"));
  await writeFile(
    join(root, "private", "hidden.txt"),
    "private-fixture-marker",
  );
  await writeFile(join(root, "hello world.txt"), "public-fixture-marker");
  const app = new Hono();
  app.use("/private/*", async (c) => c.text("Forbidden", 403));
  app.use("*", serveStatic({ root }));
  const { server, port, url } = await listen(app);
  try {
    expect(await (await fetch(`${url}/hello%20world.txt`)).text()).toBe(
      "public-fixture-marker",
    );
    expect((await fetch(`${url}/private/hidden.txt`)).status).toBe(403);
    const response = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const req = request(
          { hostname: "127.0.0.1", port, path: "/%%37%30rivate/hidden.txt" },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => resolve({ status: res.statusCode!, text }));
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("private-fixture-marker");
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});
