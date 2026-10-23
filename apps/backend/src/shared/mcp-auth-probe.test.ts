import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { MCP_PROBE_LIMITS, probeMcpEndpointAuth } from "./mcp-auth-probe";

const ENDPOINT = "https://mcp.example.com/mcp";
const SERVER_CARD = "https://mcp.example.com/.well-known/mcp/server-card.json";

type Fetch = typeof globalThis.fetch & ReturnType<typeof vi.fn>;

function answering(response: Response) {
  return vi.fn(async () => response) as unknown as Fetch;
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** The requests made to the endpoint itself, parsed. */
function endpointRequests(fetch: Fetch) {
  return fetch.mock.calls
    .filter(([url]) => String(url) === ENDPOINT)
    .map(([, init]) => {
      const request = init as RequestInit & { headers: Record<string, string> };
      return {
        method: request.method,
        headers: request.headers,
        body: request.body ? JSON.parse(String(request.body)) : undefined,
      };
    });
}

test("a 401 naming protected-resource metadata is an OAuth challenge", async () => {
  const fetch = answering(
    new Response(null, {
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      },
    }),
  );
  assert.equal((await probeMcpEndpointAuth(ENDPOINT, fetch)).result, "oauth");
});

test("a 401 without protected-resource metadata asks for some credential", async () => {
  assert.equal(
    (
      await probeMcpEndpointAuth(
        ENDPOINT,
        routing(
          new Response(null, {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="api"' },
          }),
        ),
      )
    ).result,
    "credential",
  );
  assert.deepEqual(
    await probeMcpEndpointAuth(
      ENDPOINT,
      routing(new Response(null, { status: 401 })),
    ),
    { result: "credential" },
  );
});

/** The endpoint answers `initialize` with `challenge`; other URLs by `routes`. */
function routing(
  challenge: Response | ((init: RequestInit) => Response | Promise<Response>),
  routes: Record<string, () => Response | Promise<Response>> = {},
) {
  return vi.fn(async (input: unknown, init: RequestInit) => {
    const url = String(input);
    if (url === ENDPOINT) {
      return typeof challenge === "function" ? challenge(init) : challenge;
    }
    const route = routes[url];
    return route ? route() : new Response(null, { status: 404 });
  }) as unknown as Fetch;
}

const PATH_METADATA =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const ROOT_METADATA =
  "https://mcp.example.com/.well-known/oauth-protected-resource";

function metadata(body: unknown) {
  return () => json(body);
}

test("a bare 401 with path-specific protected-resource metadata is OAuth", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [PATH_METADATA]: metadata({
      resource: ENDPOINT,
      authorization_servers: ["https://auth.example.com"],
    }),
  });
  assert.equal((await probeMcpEndpointAuth(ENDPOINT, fetch)).result, "oauth");
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA, SERVER_CARD],
  );
  const [, init] = fetch.mock.calls[1]!;
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  assert.equal("authorization" in init.headers, false);
});

test("oversized protected-resource metadata is not read", async () => {
  const padding = "x".repeat(70 * 1024);
  const fetch = routing(new Response(null, { status: 401 }), {
    [PATH_METADATA]: metadata({
      authorization_servers: ["https://auth.example.com"],
      padding,
    }),
  });
  assert.equal(
    (await probeMcpEndpointAuth(ENDPOINT, fetch)).result,
    "credential",
  );
});

test("a bare 401 falls back to the origin's protected-resource metadata", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [ROOT_METADATA]: metadata({
      authorization_servers: ["https://auth.example.com"],
    }),
  });
  assert.equal((await probeMcpEndpointAuth(ENDPOINT, fetch)).result, "oauth");
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA, ROOT_METADATA, SERVER_CARD],
  );
});

test("an endpoint at the origin root looks up one metadata location", async () => {
  const root = "https://mcp.example.com/?key=secret";
  const fetch = vi.fn(async (input: unknown) =>
    String(input) === root
      ? new Response(null, { status: 401 })
      : new Response(null, { status: 404 }),
  ) as unknown as Fetch;
  assert.equal((await probeMcpEndpointAuth(root, fetch)).result, "credential");
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [root, ROOT_METADATA, SERVER_CARD],
  );
});

test("metadata naming no authorization server leaves a bare 401 a credential", async () => {
  for (const body of [
    { resource: ENDPOINT },
    { authorization_servers: [] },
    { authorization_servers: "https://auth.example.com" },
    null,
  ]) {
    assert.equal(
      (
        await probeMcpEndpointAuth(
          ENDPOINT,
          routing(new Response(null, { status: 401 }), {
            [PATH_METADATA]: metadata(body),
            [ROOT_METADATA]: metadata(body),
          }),
        )
      ).result,
      "credential",
      JSON.stringify(body),
    );
  }
  assert.equal(
    (
      await probeMcpEndpointAuth(
        ENDPOINT,
        routing(new Response(null, { status: 401 }), {
          [PATH_METADATA]: () => new Response("<html>", { status: 200 }),
          [ROOT_METADATA]: () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://auth.example.com/metadata" },
            }),
        }),
      )
    ).result,
    "credential",
  );
});

test("a failed metadata lookup leaves a bare 401 a credential, not an error", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [PATH_METADATA]: () => {
      throw new TypeError("fetch failed");
    },
    [ROOT_METADATA]: () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(
    (await probeMcpEndpointAuth(ENDPOINT, fetch)).result,
    "credential",
  );
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA, ROOT_METADATA, SERVER_CARD],
  );
});

test("the metadata lookup shares the probe's time budget", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn(async (input: unknown, init: RequestInit) =>
      String(input) === ENDPOINT
        ? new Response(null, { status: 401 })
        : new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
    ) as unknown as Fetch;
    const probe = probeMcpEndpointAuth(ENDPOINT, fetch);
    await vi.advanceTimersByTimeAsync(5000);
    assert.deepEqual(await probe, { result: "credential" });
    // Neither the root location nor the server card is tried once the budget
    // is spent.
    assert.equal(fetch.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
  }
});

test("a challenge naming its metadata reads that location, not the well-known ones", async () => {
  const fetch = routing(
    new Response(null, {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${PATH_METADATA}"`,
      },
    }),
    {
      [PATH_METADATA]: metadata({
        resource: ENDPOINT,
        authorization_servers: ["https://auth.example.com"],
        resource_name: "Example MCP",
        resource_documentation: "https://docs.example.com/mcp",
      }),
    },
  );
  assert.deepEqual(await probeMcpEndpointAuth(ENDPOINT, fetch), {
    result: "oauth",
    authMetadata: {
      resourceName: "Example MCP",
      resourceDocumentation: "https://docs.example.com/mcp",
    },
  });
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA, SERVER_CARD],
  );
});

test("a challenge naming metadata on another origin stays OAuth, read from the well-known location", async () => {
  const fetch = routing(
    new Response(null, {
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://elsewhere.example/.well-known/oauth-protected-resource"',
      },
    }),
    { [ROOT_METADATA]: metadata({ resource_name: "Example" }) },
  );
  assert.deepEqual(await probeMcpEndpointAuth(ENDPOINT, fetch), {
    result: "oauth",
    authMetadata: { resourceName: "Example" },
  });
  assert.equal(
    fetch.mock.calls.some(([url]) =>
      String(url).startsWith("https://elsewhere.example/"),
    ),
    false,
  );
});

test("issue #367: a 401's metadata keeps its human fields, bounded and https only", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [PATH_METADATA]: metadata({
      authorization_servers: ["https://auth.example.com"],
      resource_name: ` ${"n".repeat(600)} `,
      resource_documentation: "http://docs.example.com/mcp",
    }),
  });
  const probe = await probeMcpEndpointAuth(ENDPOINT, fetch);
  assert.equal(probe.result, "oauth");
  assert.deepEqual(probe.authMetadata, {
    resourceName: "n".repeat(MCP_PROBE_LIMITS.stringChars),
  });
  // The documentation URL is a link for the page: it is never fetched.
  assert.equal(
    fetch.mock.calls.some(([url]) => String(url).includes("docs.example.com")),
    false,
  );

  const bare = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(new Response(null, { status: 401 }), {
      [PATH_METADATA]: metadata({
        authorization_servers: ["https://auth.example.com"],
      }),
    }),
  );
  assert.deepEqual(bare, { result: "oauth" });
});

test("anything but a 401 is open", async () => {
  for (const status of [200, 307, 403, 404, 500]) {
    assert.deepEqual(
      await probeMcpEndpointAuth(
        ENDPOINT,
        answering(new Response(null, { status })),
      ),
      { result: "open" },
      `status ${status}`,
    );
  }
});

test("the probe is one unauthenticated initialize that does not follow redirects", async () => {
  const fetch = answering(new Response(null, { status: 200 }));
  await probeMcpEndpointAuth(ENDPOINT, fetch);
  // An endpoint that said nothing is asked nothing more; only the origin's
  // server card is looked up.
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, SERVER_CARD],
  );
  const [url, init] = fetch.mock.calls[0]!;
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.equal("authorization" in init.headers, false);
  assert.equal(JSON.parse(init.body).method, "initialize");
});

test("network failures are thrown to the caller", async () => {
  const fetch = vi.fn(async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    () => probeMcpEndpointAuth(ENDPOINT, fetch),
    /fetch failed/,
  );
});

// ---------------------------------------------------------------------------
// Issue #367 W1: an open endpoint's self-description and tools.
// ---------------------------------------------------------------------------

const INITIALIZE_RESULT = {
  protocolVersion: "2025-03-26",
  capabilities: { tools: { listChanged: true }, prompts: {} },
  serverInfo: {
    name: "example-mcp",
    title: "Example MCP",
    version: "2.1.0",
    description: "Example's own MCP server.",
    websiteUrl: "https://example.com/",
    icons: [{ src: "https://example.com/icon.png", mimeType: "image/png" }],
  },
  instructions: "Call `search` before `fetch`.",
};

const TOOLS = [
  {
    name: "search",
    title: "Search",
    description: "Find documents.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  { name: "fetch", inputSchema: { type: "object" } },
];

type Message = { id?: number; method?: string; params?: { cursor?: string } };

/**
 * An open MCP server: answers `initialize` with `INITIALIZE_RESULT` and
 * `tools/list` with `tools`, both as `frame`d responses; notifications get
 * a 202. `session` is the `Mcp-Session-Id` it issues.
 */
function openServer(options: {
  tools?: unknown[] | ((cursor: string | undefined) => unknown);
  frame?: (body: unknown) => Response;
  session?: string;
  initialize?: unknown;
}) {
  const frame = options.frame ?? ((body: unknown) => json(body));
  return (init: RequestInit) => {
    if (init.method === "DELETE") return new Response(null, { status: 200 });
    const message = JSON.parse(String(init.body)) as Message;
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? (options.initialize ?? INITIALIZE_RESULT)
        : message.method === "tools/list"
          ? typeof options.tools === "function"
            ? options.tools(message.params?.cursor)
            : { tools: options.tools ?? TOOLS }
          : undefined;
    const response = result
      ? frame({ jsonrpc: "2.0", id: message.id, result })
      : json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
    if (options.session)
      response.headers.set("mcp-session-id", options.session);
    return response;
  };
}

test("an open endpoint's initialize answer and tool list are kept", async () => {
  const fetch = routing(openServer({}));
  const probe = await probeMcpEndpointAuth(ENDPOINT, fetch);
  assert.deepEqual(probe, {
    result: "open",
    selfDescription: {
      serverInfo: INITIALIZE_RESULT.serverInfo,
      instructions: INITIALIZE_RESULT.instructions,
      capabilities: INITIALIZE_RESULT.capabilities,
    },
    tools: TOOLS,
  });
  // initialize, then notifications/initialized, then tools/list — a client's
  // handshake — all without a credential, the protocol version negotiated.
  const requests = endpointRequests(fetch);
  assert.deepEqual(
    requests.map((request) => [request.method, request.body?.method]),
    [
      ["POST", "initialize"],
      ["POST", "notifications/initialized"],
      ["POST", "tools/list"],
    ],
  );
  for (const request of requests) {
    assert.equal("authorization" in request.headers, false);
  }
  assert.equal(
    requests[0]!.body.params.clientInfo.name,
    "sourceweft-auth-probe",
  );
  assert.equal(requests[1]!.headers["mcp-protocol-version"], "2025-03-26");
  assert.equal(requests[2]!.headers["mcp-protocol-version"], "2025-03-26");
  assert.equal("mcp-session-id" in requests[2]!.headers, false);
  assert.equal(requests[2]!.body.id !== requests[0]!.body.id, true);
});

test("an open endpoint that lists no tools is validated with an empty list", async () => {
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(openServer({ tools: [] })),
  );
  assert.deepEqual(probe.tools, []);
  assert.equal(probe.selfDescription?.serverInfo?.name, "example-mcp");
});

test("a tools/list that fails leaves the tools absent, the description kept", async () => {
  for (const tools of [
    () => ({ notTools: true }),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    const probe = await probeMcpEndpointAuth(
      ENDPOINT,
      routing(
        openServer({
          tools: tools as (cursor: string | undefined) => unknown,
        }),
      ),
    );
    assert.equal(probe.result, "open");
    assert.equal(probe.selfDescription?.serverInfo?.name, "example-mcp");
    assert.equal("tools" in probe, false);
  }
  // A JSON-RPC error (the server does not list tools) is a failure too.
  const errorFetch = routing((init: RequestInit) => {
    const message = JSON.parse(String(init.body)) as Message;
    if (message.id === undefined) return new Response(null, { status: 202 });
    return message.method === "initialize"
      ? json({ jsonrpc: "2.0", id: message.id, result: INITIALIZE_RESULT })
      : json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
  });
  const probe = await probeMcpEndpointAuth(ENDPOINT, errorFetch);
  assert.equal("tools" in probe, false);
  assert.ok(probe.selfDescription);
});

test("an open endpoint answering with an error, HTML or nothing keeps no description", async () => {
  for (const response of [
    json({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "Unauthorized" },
    }),
    new Response("<html>Sign in</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
    json({ jsonrpc: "2.0", id: 99, result: INITIALIZE_RESULT }),
    json({ ok: true }),
  ]) {
    const fetch = routing(response);
    assert.deepEqual(await probeMcpEndpointAuth(ENDPOINT, fetch), {
      result: "open",
    });
    assert.equal(endpointRequests(fetch).length, 1);
  }
});

test("SSE-framed answers are read, and the stream is not waited on", async () => {
  // A Streamable HTTP server answering over SSE, keeping the stream open after
  // its response the way one does.
  const frame = (body: unknown) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        controller.enqueue(
          encoder.encode(
            `event: message\r\nid: 7\r\ndata: ${JSON.stringify(body)}\r\n\r\n`,
          ),
        );
        // Never closed.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(openServer({ frame })),
  );
  assert.equal(probe.selfDescription?.serverInfo?.name, "example-mcp");
  assert.deepEqual(probe.tools, TOOLS);
});

test("the session the server opens is carried through the handshake and ended", async () => {
  const fetch = routing(openServer({ session: "sess-1" }));
  const probe = await probeMcpEndpointAuth(ENDPOINT, fetch);
  assert.deepEqual(probe.tools, TOOLS);
  const requests = endpointRequests(fetch);
  assert.deepEqual(
    requests.map((request) => [
      request.method,
      request.body?.method,
      request.headers["mcp-session-id"],
    ]),
    [
      ["POST", "initialize", undefined],
      ["POST", "notifications/initialized", "sess-1"],
      ["POST", "tools/list", "sess-1"],
      ["DELETE", undefined, "sess-1"],
    ],
  );
});

test("tools/list pages are followed up to the tool cap", async () => {
  const pages: Record<string, unknown> = {
    first: { tools: [TOOLS[0]], nextCursor: "two" },
    two: { tools: [TOOLS[1]], nextCursor: "three" },
    three: { tools: [{ name: "third" }] },
  };
  const fetch = routing(
    openServer({ tools: (cursor) => pages[cursor ?? "first"] }),
  );
  const probe = await probeMcpEndpointAuth(ENDPOINT, fetch);
  assert.deepEqual(
    probe.tools?.map((tool) => tool.name),
    ["search", "fetch", "third"],
  );
  const lists = endpointRequests(fetch).filter(
    (request) => request.body?.method === "tools/list",
  );
  assert.deepEqual(
    lists.map((request) => request.body.params.cursor),
    [undefined, "two", "three"],
  );
  // Distinct request ids per page.
  assert.equal(new Set(lists.map((request) => request.body.id)).size, 3);
});

test("self-description and tools are kept within the contract's bounds", async () => {
  const many = Array.from({ length: 250 }, (_, index) => ({
    name: `tool-${index}`,
    description: "d".repeat(3000),
    inputSchema: { type: "object" },
  }));
  const fetch = routing(
    openServer({
      initialize: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: {
          name: "n".repeat(600),
          title: "t".repeat(600),
          version: "1",
          description: "d".repeat(600),
          websiteUrl: "http://example.com",
          icons: [
            { src: "https://example.com/1.png" },
            { src: "http://example.com/2.png" },
            { src: "not a url" },
            "https://example.com/string.png",
            { src: "https://example.com/3.png", sizes: ["48x48"] },
            { src: "https://example.com/4.png" },
            { src: "https://example.com/5.png" },
            { src: "https://example.com/6.png" },
            { src: "https://example.com/7.png" },
          ],
        },
        instructions: "漢".repeat(5000),
      },
      tools: [...many, { noName: true }, { name: "   " }],
    }),
  );
  const probe = await probeMcpEndpointAuth(ENDPOINT, fetch);
  const info = probe.selfDescription?.serverInfo;
  assert.ok(info);
  assert.equal(info.name.length, MCP_PROBE_LIMITS.stringChars);
  assert.equal(info.title?.length, MCP_PROBE_LIMITS.stringChars);
  assert.equal(info.description?.length, MCP_PROBE_LIMITS.stringChars);
  assert.equal(info.websiteUrl, undefined);
  assert.deepEqual(info.icons, [
    { src: "https://example.com/1.png" },
    { src: "https://example.com/3.png", sizes: ["48x48"] },
    { src: "https://example.com/4.png" },
    { src: "https://example.com/5.png" },
    { src: "https://example.com/6.png" },
  ]);
  const instructions = probe.selfDescription?.instructions ?? "";
  assert.ok(
    Buffer.byteLength(instructions, "utf8") <=
      MCP_PROBE_LIMITS.instructionsBytes,
  );
  assert.ok(Buffer.byteLength(instructions, "utf8") > 8000);
  assert.equal(probe.tools?.length, MCP_PROBE_LIMITS.tools);
  assert.equal(
    probe.tools?.[0]?.description?.length,
    MCP_PROBE_LIMITS.toolDescriptionChars,
  );
  // 250 offered, 200 kept: not the whole list.
  assert.equal(probe.toolsTruncated, true);
});

test("a complete tool list is not marked truncated; the caps mark it so", async () => {
  const complete = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(openServer({})),
  );
  assert.equal("toolsTruncated" in complete, false);

  // Pages remain after the last one followed.
  const endless = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(
      openServer({
        tools: (cursor) => ({
          tools: [{ name: `tool-${cursor ?? "first"}` }],
          nextCursor: `${cursor ?? "first"}+`,
        }),
      }),
    ),
  );
  assert.equal(endless.tools?.length, MCP_PROBE_LIMITS.toolPages);
  assert.equal(endless.toolsTruncated, true);

  // The kept list as a whole is bounded in bytes.
  const heavy = Array.from({ length: 40 }, (_, index) => ({
    name: `heavy-${index}`,
    inputSchema: { pad: "x".repeat(20 * 1024) },
  }));
  const bulky = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(openServer({ tools: heavy })),
  );
  assert.ok(bulky.tools && bulky.tools.length < heavy.length);
  assert.ok(
    Buffer.byteLength(JSON.stringify(bulky.tools), "utf8") <=
      MCP_PROBE_LIMITS.toolsBytes,
  );
  assert.equal(bulky.toolsTruncated, true);
});

test("a tool whose schemas are too large is dropped, and the list marked truncated", async () => {
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(
      openServer({
        tools: [
          TOOLS[0],
          { name: "huge", inputSchema: { pad: "x".repeat(40 * 1024) } },
          TOOLS[1],
        ],
      }),
    ),
  );
  // The oversize entry is dropped; the ones after it are kept.
  assert.deepEqual(probe.tools, TOOLS);
  assert.equal(probe.toolsTruncated, true);
  // Annotations count toward the same bound.
  const annotated = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(
      openServer({
        tools: [{ name: "a", annotations: { pad: "x".repeat(40 * 1024) } }],
      }),
    ),
  );
  assert.deepEqual(annotated.tools, []);
  assert.equal(annotated.toolsTruncated, true);
});

test("oversized capabilities are dropped; the rest of the description is kept", async () => {
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(
      openServer({
        initialize: {
          ...INITIALIZE_RESULT,
          capabilities: { experimental: { pad: "x".repeat(5 * 1024) } },
        },
      }),
    ),
  );
  assert.equal(probe.selfDescription?.serverInfo?.name, "example-mcp");
  assert.equal("capabilities" in (probe.selfDescription ?? {}), false);
});

test("URLs with credentials in them, or too long, are dropped", async () => {
  const long = `https://example.com/${"p".repeat(2100)}`;
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(
      openServer({
        initialize: {
          ...INITIALIZE_RESULT,
          serverInfo: {
            name: "x",
            websiteUrl: "https://user:secret@example.com/",
            icons: [
              { src: "https://user:secret@example.com/icon.png" },
              { src: long },
              { src: "https://example.com/ok.png" },
            ],
          },
        },
      }),
    ),
  );
  assert.deepEqual(probe.selfDescription?.serverInfo, {
    name: "x",
    icons: [{ src: "https://example.com/ok.png" }],
  });
  const challenged = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(new Response(null, { status: 401 }), {
      [PATH_METADATA]: metadata({
        authorization_servers: ["https://auth.example.com"],
        resource_documentation: "https://user:secret@docs.example.com/mcp",
      }),
    }),
  );
  assert.deepEqual(challenged, { result: "oauth" });
});

test("an SSE answer split across chunks, with events before it, is read once complete", async () => {
  const frame = (body: unknown) => {
    const encoder = new TextEncoder();
    const text = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
    const chunks = [
      ": hello\n\n",
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n',
      text.slice(0, 20),
      text.slice(20, 60),
      text.slice(60),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        // Left open.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(openServer({ frame })),
  );
  assert.equal(probe.selfDescription?.serverInfo?.name, "example-mcp");
  assert.deepEqual(probe.tools, TOOLS);
  assert.equal("toolsTruncated" in probe, false);
});

test("an oversized initialize answer or tool list is dropped, not stored in part", async () => {
  const huge = { ...INITIALIZE_RESULT, instructions: "x".repeat(1100 * 1024) };
  assert.deepEqual(
    await probeMcpEndpointAuth(
      ENDPOINT,
      routing(openServer({ initialize: huge })),
    ),
    { result: "open" },
  );
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(
      openServer({
        tools: [{ name: "big", inputSchema: { pad: "x".repeat(1100 * 1024) } }],
      }),
    ),
  );
  assert.ok(probe.selfDescription);
  assert.equal("tools" in probe, false);
});

test("the origin's server card is kept as published when it serves one", async () => {
  const card = {
    serverInfo: { name: "example-mcp", version: "2.1.0" },
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
  };
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(openServer({}), { [SERVER_CARD]: () => json(card) }),
  );
  assert.deepEqual(probe.serverCard, card);

  // A 401 endpoint's card is kept too.
  const challenged = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(new Response(null, { status: 401 }), {
      [SERVER_CARD]: () => json(card),
    }),
  );
  assert.deepEqual(challenged, { result: "credential", serverCard: card });
});

test("no server card, a non-JSON one, an empty one or one too large is left out", async () => {
  for (const route of [
    undefined,
    () => new Response("<html>", { status: 200 }),
    () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    () => json({}),
    () => json([1, 2]),
    () => json({ pad: "x".repeat(70 * 1024) }),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/card.json" },
      }),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    const probe = await probeMcpEndpointAuth(
      ENDPOINT,
      routing(openServer({}), route ? { [SERVER_CARD]: route } : {}),
    );
    assert.equal("serverCard" in probe, false);
    assert.deepEqual(probe.tools, TOOLS);
  }
});
