import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MARKET_MCP_INSPECT_LIMITS,
  marketMcpInspectFileSchema,
  submitMarketMcpOwnerToolsRequestSchema,
} from "@sourceweft/market-contracts";
import {
  mcpInspectCommand,
  mcpSubmitToolsCommand,
  parseHeaderOption,
} from "../src/commands/mcp";
import { EXIT, McpInspectError, UsageError } from "../src/errors";
import {
  boundInspectedTools,
  boundServerInfo,
  reduceTargetUrl,
} from "../src/mcp/bound";
import { parseSseData } from "../src/mcp/http";
import { createRegistryClient } from "../src/registry/client";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/fake-mcp-stdio.mjs", import.meta.url),
);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

describe("bounding what a server lists", () => {
  it("cuts descriptions, titles and names to the contract", () => {
    const { tools } = boundInspectedTools([
      {
        name: "n".repeat(MARKET_MCP_INSPECT_LIMITS.nameChars + 10),
        title: "t".repeat(MARKET_MCP_INSPECT_LIMITS.titleChars + 10),
        description: "d".repeat(MARKET_MCP_INSPECT_LIMITS.descriptionChars + 1),
        inputSchema: { type: "object" },
      },
    ]);
    assert.equal(tools.length, 1);
    const [tool] = tools;
    assert.equal(tool?.name.length, MARKET_MCP_INSPECT_LIMITS.nameChars);
    assert.equal(tool?.title?.length, MARKET_MCP_INSPECT_LIMITS.titleChars);
    assert.equal(
      tool?.description?.length,
      MARKET_MCP_INSPECT_LIMITS.descriptionChars,
    );
    assert.ok(tool?.description?.endsWith("…"));
    // A short description is left alone.
    const short = boundInspectedTools([{ name: "a", description: "fine" }]);
    assert.equal(short.tools[0]?.description, "fine");
  });

  it("keeps the first of duplicate names and drops nameless entries", () => {
    const { tools, truncated } = boundInspectedTools([
      { name: "a", description: "first" },
      { name: "a", description: "second" },
      { description: "no name" },
      { name: "" },
      "not an object",
      { name: "b" },
    ]);
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.description]),
      [
        ["a", "first"],
        ["b", undefined],
      ],
    );
    assert.equal(truncated, false);
  });

  it("caps the count and reports the cut", () => {
    const many = Array.from(
      { length: MARKET_MCP_INSPECT_LIMITS.tools + 50 },
      (_, i) => ({ name: `tool-${i}` }),
    );
    const { tools, truncated } = boundInspectedTools(many);
    assert.equal(tools.length, MARKET_MCP_INSPECT_LIMITS.tools);
    assert.equal(truncated, true);
  });

  it("replaces oversize or non-object schemas and annotations", () => {
    const big = {
      type: "object",
      description: "x".repeat(MARKET_MCP_INSPECT_LIMITS.schemaBytes),
    };
    const { tools } = boundInspectedTools([
      {
        name: "a",
        inputSchema: big,
        outputSchema: big,
        annotations: ["not", "an", "object"],
      },
      {
        name: "b",
        inputSchema: "nope",
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ]);
    assert.deepEqual(tools[0], { name: "a", inputSchema: {}, annotations: {} });
    assert.deepEqual(tools[1], {
      name: "b",
      inputSchema: {},
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
    for (const tool of tools) {
      assert.ok(marketMcpInspectFileSchema.shape.tools.element.safeParse(tool).success);
    }
  });

  it("records a URL as its origin only: hosted servers put secrets in the path", () => {
    assert.equal(
      reduceTargetUrl("https://user:pw@mcp.example.com/v1/mcp?key=abc#frag"),
      "https://mcp.example.com",
    );
    assert.equal(
      reduceTargetUrl("https://mcp.zapier.com/api/mcp/s/NjQyMzQ1-secret/mcp"),
      "https://mcp.zapier.com",
    );
    assert.equal(
      reduceTargetUrl("http://127.0.0.1:8080/?token=x"),
      "http://127.0.0.1:8080",
    );
  });

  it("keeps short serverInfo values only", () => {
    assert.deepEqual(
      boundServerInfo({
        name: "demo",
        version: "1.0",
        blob: "y".repeat(1_001),
        nested: { ok: true },
      }),
      { name: "demo", version: "1.0", nested: { ok: true } },
    );
    assert.equal(boundServerInfo("demo"), undefined);
    assert.equal(boundServerInfo(null), undefined);
  });

  it("reads SSE data lines", () => {
    assert.deepEqual(
      parseSseData(
        ': comment\n\nevent: message\nid: 1\ndata: {"a":1}\n\ndata: line one\ndata:line two\r\n\r\ndata: tail',
      ),
      ['{"a":1}', "line one\nline two", "tail"],
    );
  });

  it("parses --header lines", () => {
    assert.deepEqual(parseHeaderOption("Authorization: Bearer x y"), [
      "Authorization",
      "Bearer x y",
    ]);
    assert.deepEqual(parseHeaderOption("X-Api-Key:abc"), ["X-Api-Key", "abc"]);
    for (const bad of ["Authorization", ": value", "Name:", "Bad Name: v"]) {
      assert.throws(() => parseHeaderOption(bad), UsageError, bad);
    }
  });
});

describe("mcp inspect over stdio", () => {
  let dir: string;
  const command = `"${process.execPath}" "${FIXTURE}"`;
  // The fixture reports whether this variable is set, never its value.
  const TOKEN_VARIABLE = "FAKE_MCP_TOKEN";
  const SECRET = "hunter2-only-in-the-environment";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-mcp-stdio-"));
    process.env[TOKEN_VARIABLE] = SECRET;
  });
  after(async () => {
    delete process.env[TOKEN_VARIABLE];
    await rm(dir, { recursive: true, force: true });
  });

  it("lists both pages, bounds the tools and writes a valid file without the environment", async () => {
    const lines: string[] = [];
    const file = await mcpInspectCommand(
      { out: (line) => lines.push(line), version: "0.0.0-test", cwd: dir },
      { stdio: command, out: "tools.json", force: false, json: false },
    );
    const text = await readFile(join(dir, "tools.json"), "utf8");
    const parsed = marketMcpInspectFileSchema.parse(JSON.parse(text));
    assert.deepEqual(parsed, file);

    assert.deepEqual(
      parsed.tools.map((tool) => tool.name),
      ["alpha", "beta", "gamma"],
    );
    // The first listing of a duplicate name wins.
    assert.equal(parsed.tools[0]?.description, "First tool");
    assert.deepEqual(parsed.tools[0]?.annotations, { readOnlyHint: true });
    // A non-object inputSchema is replaced; an outputSchema object is kept.
    assert.deepEqual(parsed.tools[2]?.inputSchema, {});
    assert.deepEqual(parsed.tools[2]?.outputSchema, {
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
    // The environment reached the server, and none of it reached the file.
    assert.match(parsed.tools[2]?.description ?? "", /FAKE_MCP_TOKEN is set/u);
    assert.ok(!text.includes(SECRET));

    assert.deepEqual(parsed.target, { kind: "stdio", command });
    assert.equal(parsed.protocolVersion, "2025-06-18");
    assert.deepEqual(parsed.serverInfo, { name: "fake-mcp", version: "1.2.3" });
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.generatedBy, "sourceweft-cli/0.0.0-test");
    assert.ok(!Number.isNaN(Date.parse(parsed.generatedAt)));

    assert.ok(lines.some((line) => line.startsWith("alpha — First tool")));
    assert.ok(
      lines.some((line) =>
        line.startsWith(`Wrote 3 tools to ${join(dir, "tools.json")}`),
      ),
    );
    assert.ok(lines.some((line) => line.includes("submit-tools")));
  });

  it("refuses to overwrite without --force, and prints JSON with --json", async () => {
    await assert.rejects(
      mcpInspectCommand(
        { out: () => {}, version: "0.0.0-test", cwd: dir },
        { stdio: command, out: "tools.json", force: false, json: false },
      ),
      (error: unknown) =>
        error instanceof McpInspectError &&
        /already exists/u.test(error.message),
    );
    const lines: string[] = [];
    const file = await mcpInspectCommand(
      { out: (line) => lines.push(line), version: "0.0.0-test", cwd: dir },
      { stdio: command, out: "tools.json", force: true, json: true },
    );
    assert.deepEqual(JSON.parse(lines[0] ?? ""), file);
    assert.ok(!lines.some((line) => line.startsWith("alpha — ")));
  });

  it("reports a server that is not one", async () => {
    await assert.rejects(
      mcpInspectCommand(
        { out: () => {}, version: "0.0.0-test", cwd: dir },
        {
          stdio: `"${process.execPath}" -e "process.stderr.write('boom\\n'); process.exit(3)"`,
          out: "never.json",
          force: false,
          json: false,
        },
      ),
      (error: unknown) =>
        error instanceof McpInspectError &&
        /exited with 3/u.test(error.message) &&
        /boom/u.test(error.message),
    );
  });

  it("needs exactly one of --url and --stdio", async () => {
    for (const input of [
      { force: false, json: false },
      { url: "https://x.example/mcp", stdio: "node s.js", force: false, json: false },
      { stdio: "node s.js", headers: ["A: b"], force: false, json: false },
      { url: "http://example.com/mcp", force: false, json: false },
    ]) {
      await assert.rejects(
        mcpInspectCommand({ out: () => {}, version: "0", cwd: dir }, input),
        UsageError,
        JSON.stringify(input),
      );
    }
  });
});

describe("mcp inspect over Streamable HTTP", () => {
  let server: Server;
  let base = "";
  let dir: string;
  const seen: { method?: string; auth?: string; session?: string; rpc?: string }[] =
    [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-mcp-http-"));
    server = createServer(async (req, res) => {
      const auth = req.headers.authorization;
      const session = req.headers["mcp-session-id"];
      const record = {
        method: req.method,
        auth,
        session: Array.isArray(session) ? session.join(",") : session,
      };
      if (auth !== "Bearer secret") {
        seen.push(record);
        res.statusCode = 401;
        res.setHeader("www-authenticate", "Bearer");
        res.end("unauthorized");
        return;
      }
      if (req.method === "DELETE") {
        seen.push(record);
        res.statusCode = 200;
        res.end();
        return;
      }
      const body = JSON.parse(await readBody(req)) as {
        id?: number;
        method: string;
        params?: { cursor?: string };
      };
      seen.push({ ...record, rpc: body.method });
      if (body.method === "initialize") {
        res.setHeader("mcp-session-id", "sess-42");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fake-http", version: "9" },
            },
          }),
        );
        return;
      }
      if (body.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === "tools/list") {
        if (record.session !== "sess-42") {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "no session" }));
          return;
        }
        const page =
          body.params?.cursor === "two"
            ? { tools: [{ name: "two", description: "Second", inputSchema: {} }] }
            : {
                tools: [{ name: "one", description: "First", inputSchema: {} }],
                nextCursor: "two",
              };
        res.setHeader("content-type", "text/event-stream");
        res.write(": keep-alive\n\n");
        // A notification in the stream, to be ignored.
        res.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: { level: "info", data: "ignore me" },
          })}\n\n`,
        );
        res.write(
          `event: message\nid: 7\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: page,
          })}\n\n`,
        );
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    base = await listen(server);
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("speaks JSON and event-stream framings, echoes the session and keeps secrets out of the file", async () => {
    seen.length = 0;
    const lines: string[] = [];
    const file = await mcpInspectCommand(
      { out: (line) => lines.push(line), version: "0.0.0-test", cwd: dir },
      {
        url: `${base}/mcp?key=abc`,
        headers: ["Authorization: Bearer secret"],
        out: "http.json",
        force: false,
        json: false,
      },
    );
    const text = await readFile(join(dir, "http.json"), "utf8");
    assert.deepEqual(marketMcpInspectFileSchema.parse(JSON.parse(text)), file);
    assert.deepEqual(file.target, { kind: "url", url: base });
    assert.ok(!text.includes("secret"));
    assert.ok(!text.includes("abc"));
    assert.ok(!text.includes("/mcp"), "the path is not written either");
    assert.deepEqual(
      file.tools.map((tool) => tool.name),
      ["one", "two"],
    );
    assert.equal(file.protocolVersion, "2025-03-26");
    assert.deepEqual(file.serverInfo, { name: "fake-http", version: "9" });

    const rpc = seen.filter((entry) => entry.rpc);
    assert.deepEqual(
      rpc.map((entry) => entry.rpc),
      ["initialize", "notifications/initialized", "tools/list", "tools/list"],
    );
    for (const entry of rpc.slice(1)) {
      assert.equal(entry.session, "sess-42", entry.rpc);
    }
    assert.ok(seen.every((entry) => entry.auth === "Bearer secret"));
    assert.ok(lines.some((line) => line.startsWith("Wrote 2 tools to ")));
  });

  it("explains a 401 and points at --header", async () => {
    await assert.rejects(
      mcpInspectCommand(
        { out: () => {}, version: "0.0.0-test", cwd: dir },
        {
          url: `${base}/mcp`,
          headers: ["Authorization: Bearer wrong"],
          out: "never.json",
          force: false,
          json: false,
        },
      ),
      (error: unknown) =>
        error instanceof McpInspectError &&
        /refused the credentials \(HTTP 401\)/u.test(error.message) &&
        /--header/u.test(error.message),
    );
    await assert.rejects(
      mcpInspectCommand(
        { out: () => {}, version: "0.0.0-test", cwd: dir },
        { url: `${base}/mcp`, out: "never.json", force: false, json: false },
      ),
      McpInspectError,
    );
  });
});

describe("mcp submit-tools against a local registry", () => {
  let server: Server;
  let registry = "";
  let dir: string;
  const calls: {
    method?: string;
    url?: string;
    apiKey?: string | string[];
    contentType?: string;
    body: string;
  }[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-mcp-submit-"));
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      calls.push({
        method: req.method,
        url: req.url,
        apiKey: req.headers["x-api-key"],
        contentType: req.headers["content-type"],
        body,
      });
      res.setHeader("content-type", "application/json");
      const key = req.headers["x-api-key"];
      if (key === "claimless") {
        res.statusCode = 403;
        res.end(
          JSON.stringify({
            code: "MCP_CLAIM_REQUIRED",
            message: "A verified claim on this server is required",
          }),
        );
        return;
      }
      if (key === "bad") {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: "UNAUTHORIZED", message: "Unauthorized" }));
        return;
      }
      if (key === "invalid") {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            code: "VALIDATION_ERROR",
            message: "Invalid request body",
            details: { fieldErrors: { tools: ["Too many"] }, formErrors: [] },
          }),
        );
        return;
      }
      const parsed = JSON.parse(body) as { tools: unknown[] };
      res.end(
        JSON.stringify({
          data: {
            identifier: "com.example/demo",
            values: {},
            tools: {
              count: parsed.tools.length,
              submittedAt: "2026-10-24T10:00:00.000Z",
            },
            updatedAt: "2026-10-24T10:00:00.000Z",
          },
        }),
      );
    });
    registry = await listen(server);
    const file = marketMcpInspectFileSchema.parse({
      schemaVersion: 1,
      generatedBy: "sourceweft-cli/0.0.0-test",
      generatedAt: "2026-10-24T09:00:00.000Z",
      target: { kind: "url", url: "https://mcp.example.com/mcp" },
      protocolVersion: "2025-06-18",
      serverInfo: { name: "demo", version: "1" },
      tools: [
        { name: "one", description: "First", inputSchema: {}, annotations: {} },
        { name: "two", inputSchema: { type: "object" }, annotations: {} },
      ],
    });
    await writeFile(join(dir, "tools.json"), JSON.stringify(file));
    await writeFile(join(dir, "bad.json"), JSON.stringify({ tools: "nope" }));
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const context = (lines: string[], json = false) => ({
    client: createRegistryClient(registry),
    json,
    out: (line: string) => lines.push(line),
    cwd: dir,
  });

  it("PUTs the file's tools as one path segment under the API key", async () => {
    calls.length = 0;
    const lines: string[] = [];
    await mcpSubmitToolsCommand(context(lines), {
      identifier: "com.example/demo",
      file: "tools.json",
      apiKey: "k-123",
    });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call?.method, "PUT");
    assert.equal(
      call?.url,
      "/v1/market/mcp/com.example%2Fdemo/owner-overrides/tools",
    );
    assert.equal(call?.apiKey, "k-123");
    assert.match(call?.contentType ?? "", /^application\/json/u);
    const body = JSON.parse(call?.body ?? "") as Record<string, unknown>;
    assert.ok(submitMarketMcpOwnerToolsRequestSchema.safeParse(body).success);
    assert.ok(!("headers" in body));
    assert.ok(!("generatedBy" in body));
    assert.ok(!("schemaVersion" in body));
    // Never the target: the endpoint or command the owner inspected.
    assert.ok(!("target" in body));
    assert.ok(!call?.body?.includes("mcp.example.com"));
    assert.deepEqual(Object.keys(body).sort(), [
      "generatedAt",
      "serverInfo",
      "tools",
    ]);
    assert.deepEqual(lines, ["Submitted 2 tools for com.example/demo"]);

    const json: string[] = [];
    await mcpSubmitToolsCommand(context(json, true), {
      identifier: "com.example/demo",
      file: "tools.json",
      apiKey: "k-123",
    });
    assert.equal(
      (JSON.parse(json[0] ?? "") as { tools: { count: number } }).tools.count,
      2,
    );
  });

  it("maps 403, 401, 400 and a bad file to clear errors", async () => {
    const submit = (apiKey: string, file = "tools.json") =>
      mcpSubmitToolsCommand(context([]), {
        identifier: "com.example/demo",
        file,
        apiKey,
      });
    await assert.rejects(
      submit("claimless"),
      (error: unknown) =>
        error instanceof McpInspectError &&
        /no verified claim on com\.example\/demo/u.test(error.message),
    );
    await assert.rejects(
      submit("bad"),
      (error: unknown) =>
        error instanceof McpInspectError &&
        /API key was not accepted/u.test(error.message),
    );
    await assert.rejects(
      submit("invalid"),
      (error: unknown) =>
        error instanceof McpInspectError &&
        /Invalid request body/u.test(error.message) &&
        error.details.includes("tools: Too many"),
    );
    await assert.rejects(
      submit("k-123", "bad.json"),
      (error: unknown) =>
        error instanceof McpInspectError &&
        /not a file written by/u.test(error.message) &&
        error.details.length > 0,
    );
    await assert.rejects(
      submit("k-123", "missing.json"),
      (error: unknown) =>
        error instanceof McpInspectError && /Could not read/u.test(error.message),
    );
  });
});

describe("the binary's mcp commands", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", main, ...args], {
      encoding: "utf8",
    });

  it("mentions both commands in --help", () => {
    const help = run(["--help"]);
    assert.equal(help.status, EXIT.ok);
    assert.match(help.stdout, /mcp inspect/u);
    assert.match(help.stdout, /mcp submit-tools/u);
    assert.match(help.stdout, /--api-key/u);
  });

  it("exits 2 on bad usage", () => {
    const noTarget = run(["mcp", "inspect"]);
    assert.equal(noTarget.status, EXIT.usage);
    assert.match(noTarget.stderr, /--url|--stdio/u);
    const noKey = run(["mcp", "submit-tools", "com.example/demo", "tools.json"]);
    assert.equal(noKey.status, EXIT.usage);
    assert.match(noKey.stderr, /--api-key/u);
    assert.match(noKey.stderr, /Settings/u);
    for (const args of [
      ["mcp"],
      ["mcp", "bogus"],
      ["mcp", "inspect", "extra", "--stdio", "x"],
      ["mcp", "submit-tools", "only-one", "--api-key", "k"],
    ]) {
      assert.equal(run(args).status, EXIT.usage, args.join(" "));
    }
  });
});
