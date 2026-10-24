// A fake MCP server over stdio for the CLI's tests: newline-delimited
// JSON-RPC on stdin/stdout. It prints a banner line (not JSON) to stdout
// first, logs to stderr, answers `initialize`, accepts the `initialized`
// notification, asks the client for its roots (a server→client request the
// client must answer "method not found"), and serves `tools/list` in two
// pages. One tool's description says whether FAKE_MCP_TOKEN was set, never
// what it was: the test proves the environment reached the server and that
// nothing of it landed in the file.

import process from "node:process";
import { createInterface } from "node:readline";

process.stdout.write("fake mcp server starting up\n");
process.stderr.write("fake-mcp: listening on stdio\n");

/** The test sets this variable; the server only reports that it is there. */
const TOKEN_VARIABLE = "FAKE_MCP_TOKEN";

const PAGE_ONE = [
  {
    name: "alpha",
    title: "Alpha",
    description: "First tool",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "beta",
    description: "Second tool",
    inputSchema: { type: "object" },
  },
];
const PAGE_TWO = [
  {
    name: "gamma",
    description: `Third tool; ${TOKEN_VARIABLE} is ${
      process.env[TOKEN_VARIABLE] ? "set" : "unset"
    }`,
    inputSchema: "not an object",
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  },
  // A duplicate of page one's first tool: the client keeps the first.
  { name: "alpha", description: "Duplicate alpha", inputSchema: {} },
];

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "fake-mcp",
          version: "1.2.3",
          banner: "x".repeat(1500),
        },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    // A request of the client, and a notification it must ignore.
    send({ jsonrpc: "2.0", id: 9001, method: "roots/list", params: {} });
    send({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "hello" },
    });
    return;
  }
  if (message.method === "tools/list") {
    const cursor = message.params?.cursor;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result:
        cursor === "page-2"
          ? { tools: PAGE_TWO }
          : { tools: PAGE_ONE, nextCursor: "page-2" },
    });
    return;
  }
  if (message.method !== undefined && message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }
  // Responses to the server's own request (roots/list) are dropped.
});
rl.on("close", () => process.exit(0));
