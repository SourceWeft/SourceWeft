import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  boundedMcpListedTools,
  listMcpEndpointTools,
  MCP_TOOL_LISTING_LIMITS,
} from "./mcp-tool-listing";

const ENDPOINT = "https://mcp.example.com/mcp";

type JsonRpc = { id?: number; method: string; params?: { cursor?: string } };

/**
 * A Streamable HTTP endpoint answering each JSON-RPC request through
 * `answer`; notifications are accepted, and the optional GET stream is not
 * offered.
 */
function endpoint(answer: (message: JsonRpc) => unknown) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    requests.push(request.clone());
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = (await request.json()) as JsonRpc;
    if (message.id === undefined) return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: answer(message),
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

function initializeResult() {
  return {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "example", version: "1" },
  };
}

test("lists the endpoint's tools after initialize, with no credentials sent", async () => {
  const { fetch, requests } = endpoint((message) =>
    message.method === "initialize"
      ? initializeResult()
      : {
          tools: [
            {
              name: "search",
              title: "Search",
              description: " Search the index. ",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
              annotations: { readOnlyHint: true, custom: "dropped" },
            },
          ],
        },
  );

  const tools = await listMcpEndpointTools(ENDPOINT, "streamable_http", fetch);

  assert.deepEqual(tools, [
    {
      name: "search",
      title: "Search",
      description: "Search the index.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
    },
  ]);
  const methods = await Promise.all(
    requests
      .filter((request) => request.method === "POST")
      .map(async (request) => ((await request.json()) as JsonRpc).method),
  );
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  for (const request of requests) {
    assert.equal(request.url, ENDPOINT);
    assert.equal(request.headers.get("authorization"), null);
  }
});

test("follows tools/list pages until the cursor ends", async () => {
  const { fetch } = endpoint((message) => {
    if (message.method === "initialize") return initializeResult();
    return message.params?.cursor === "2"
      ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
      : {
          tools: [{ name: "first", inputSchema: { type: "object" } }],
          nextCursor: "2",
        };
  });

  const tools = await listMcpEndpointTools(ENDPOINT, "streamable_http", fetch);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["first", "second"],
  );
});

test("a malformed tool is dropped without failing the listing", async () => {
  const { fetch } = endpoint((message) =>
    message.method === "initialize"
      ? initializeResult()
      : {
          tools: [
            { name: "ok", inputSchema: { type: "object" } },
            // No inputSchema type: the SDK's strict listTools rejects this page.
            { name: "loose", inputSchema: { properties: {} } },
            { description: "no name" },
            "not a tool",
          ],
        },
  );

  const tools = await listMcpEndpointTools(ENDPOINT, "streamable_http", fetch);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["ok", "loose"],
  );
});

test("an endpoint that answers with an error fails the listing", async () => {
  const fetch = vi.fn(
    async () => new Response("nope", { status: 500 }),
  ) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    listMcpEndpointTools(ENDPOINT, "streamable_http", fetch),
  );
});

test("responses past the byte budget fail the listing", async () => {
  const description = "d".repeat(64 * 1024);
  const { fetch } = endpoint((message) =>
    message.method === "initialize"
      ? initializeResult()
      : {
          tools: Array.from(
            {
              length: Math.ceil(
                MCP_TOOL_LISTING_LIMITS.responseBytes / description.length,
              ),
            },
            (_, index) => ({
              name: `tool_${index}`,
              description,
              inputSchema: { type: "object" },
            }),
          ),
        },
  );

  await assert.rejects(
    listMcpEndpointTools(ENDPOINT, "streamable_http", fetch),
  );
});

test("listed tools are bounded: count, repeats, names, text and schema size", () => {
  const tools = boundedMcpListedTools([
    { name: "x".repeat(MCP_TOOL_LISTING_LIMITS.nameChars + 1) },
    { name: "  " },
    {
      name: "big",
      title: "t".repeat(500),
      description: "d".repeat(5_000),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "q".repeat(20_000) },
          limit: { type: "integer" },
          other: null,
        },
        required: ["query", "missing"],
      },
    },
    { name: "big", description: "a repeat" },
    ...Array.from({ length: MCP_TOOL_LISTING_LIMITS.tools + 5 }, (_, i) => ({
      name: `tool_${i}`,
    })),
  ]);

  assert.equal(tools.length, MCP_TOOL_LISTING_LIMITS.tools);
  const [big] = tools;
  assert.equal(big?.name, "big");
  assert.equal(big?.title?.length, MCP_TOOL_LISTING_LIMITS.titleChars);
  assert.equal(
    big?.description?.length,
    MCP_TOOL_LISTING_LIMITS.descriptionChars,
  );
  assert.deepEqual(big?.inputSchema, {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer" },
      other: {},
    },
    required: ["query"],
  });
  assert.equal(tools.filter((tool) => tool.name === "big").length, 1);
  assert.deepEqual(tools[1], {
    name: "tool_0",
    inputSchema: {},
    annotations: {},
  });
});
