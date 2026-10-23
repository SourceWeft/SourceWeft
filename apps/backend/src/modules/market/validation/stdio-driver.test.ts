import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import {
  MCP_STDIO_DRIVER_FILE,
  stdioDriverSource,
} from "./stdio-driver-source";
import { parseStdioDriverResult } from "./stdio-state";

/**
 * `stdio-driver.mjs` run as the sandbox runs it, against fake MCP servers
 * written as small Node scripts: the handshake and its framing, the
 * timeouts, the output caps, the install/start split, and the environment
 * the server is given.
 */

const run = promisify(execFile);
const DRIVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  MCP_STDIO_DRIVER_FILE,
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

/** A fake server script, answering stdin line by line with `handlers`. */
function fakeServer(body: string) {
  return `
    const { createInterface } = require("node:readline");
    const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    let initialized = false;
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      ${body}
    });
  `;
}

async function runDriver(input: {
  server?: string;
  start?: string;
  install?: string;
  env?: Record<string, string>;
  runTimeoutMs?: number;
  installTimeoutMs?: number;
  processEnv?: Record<string, string>;
}) {
  const dir = mkdtempSync(path.join(tmpdir(), "stdio-driver-"));
  dirs.push(dir);
  if (input.server) writeFileSync(path.join(dir, "server.cjs"), input.server);
  writeFileSync(
    path.join(dir, "plan.json"),
    JSON.stringify({
      install: input.install ?? "",
      start: input.start ?? "node server.cjs",
      env: input.env ?? {},
      installTimeoutMs: input.installTimeoutMs ?? 10_000,
      runTimeoutMs: input.runTimeoutMs ?? 10_000,
      cpuSeconds: 30,
    }),
  );
  const { stdout } = await run(
    process.execPath,
    [DRIVER, "plan.json", "result.json"],
    { cwd: dir, env: { ...process.env, ...input.processEnv } },
  );
  const text = readFileSync(path.join(dir, "result.json"), "utf8");
  const result = parseStdioDriverResult(text);
  assert.ok(result, `driver wrote no parsable result: ${text}`);
  return { result, stdout, dir };
}

test("the driver's source is the file next to it", () => {
  assert.equal(stdioDriverSource(), readFileSync(DRIVER, "utf8"));
});

test("initialize, initialized, then tools/list across pages; banners on stdout are skipped", async () => {
  const { result, stdout } = await runDriver({
    server: `
      process.stdout.write("Starting fake server...\\n");
      ${fakeServer(`
        if (m.method === "initialize") {
          out({ jsonrpc: "2.0", id: m.id, result: {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "fake", version: "0.1", title: "Fake", websiteUrl: "https://fake.example" },
            instructions: "Be nice.",
            capabilities: { tools: { listChanged: true } },
          }});
        } else if (m.method === "notifications/initialized") {
          initialized = true;
        } else if (m.method === "tools/list") {
          if (!initialized) { out({ jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "not initialized" } }); return; }
          if (!m.params.cursor) {
            out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "one", description: "first" }], nextCursor: "p2" } });
          } else {
            out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "two", inputSchema: { type: "object" } }] } });
          }
        }
      `)}
    `,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.deepEqual(result.serverInfo, {
    name: "fake",
    version: "0.1",
    title: "Fake",
    websiteUrl: "https://fake.example",
  });
  assert.equal(result.instructions, "Be nice.");
  assert.deepEqual(result.capabilities, { tools: { listChanged: true } });
  assert.deepEqual(
    result.tools.map((tool) => (tool as { name: string }).name),
    ["one", "two"],
  );
  assert.match(stdout, /^ok tools=2 /);
});

test("the server sees the plan's placeholders and an allowlist of the host environment, nothing else", async () => {
  const { result } = await runDriver({
    processEnv: {
      HOST_SECRET_FOR_TEST: "real-secret",
      PATH: process.env.PATH ?? "",
    },
    env: { NOTION_TOKEN: "placeholder" },
    server: fakeServer(`
      if (m.method === "initialize") {
        out({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "env", description: JSON.stringify({ secret: process.env.HOST_SECRET_FOR_TEST ?? null, token: process.env.NOTION_TOKEN, path: Boolean(process.env.PATH) }) } } });
      } else if (m.method === "tools/list") {
        out({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
      }
    `),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const seen = JSON.parse(
    (result.serverInfo as { description: string }).description,
  ) as Record<string, unknown>;
  assert.deepEqual(seen, { secret: null, token: "placeholder", path: true });
  assert.equal(JSON.stringify(result).includes("real-secret"), false);
});

test("a server that exits before answering initialize is a start failure with its stderr", async () => {
  const { result, stdout } = await runDriver({
    start: "echo 'missing NOTION_TOKEN' >&2; exit 3",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "start");
  assert.equal(result.exitCode, 3);
  assert.match(
    result.detail,
    /exited with 3 before answering initialize: missing NOTION_TOKEN/,
  );
  assert.match(stdout, /^failed reason=start /);
});

test("an install that fails stops before the start; its last lines are the detail", async () => {
  const { result } = await runDriver({
    install: "echo 'npm ERR! 404 Not Found' >&2; exit 1",
    start: "echo should-not-run > started.txt; node server.cjs",
    server: fakeServer(""),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "install");
  assert.match(result.detail, /install exited with 1: npm ERR! 404 Not Found/);
  assert.ok(result.timings.installMs >= 0);
});

test("an install that runs past its budget is a timeout", async () => {
  const { result } = await runDriver({
    install: "sleep 30",
    installTimeoutMs: 300,
    server: fakeServer(""),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "timeout");
  assert.match(result.detail, /install did not finish/);
});

test("a server that never answers is a timeout, and its process group is killed", async () => {
  const { result, dir } = await runDriver({
    runTimeoutMs: 2000,
    server: `
      require("node:fs").writeFileSync("pid.txt", String(process.pid));
      setInterval(() => {}, 1000);
    `,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "timeout");
  assert.match(result.detail, /did not answer initialize within 2 s/);
  const pid = Number(readFileSync(path.join(dir, "pid.txt"), "utf8"));
  // SIGKILL follows SIGTERM after 2 s; allow the group a moment to go.
  const deadline = Date.now() + 4000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the fake server outlived the driver");
});

test("an error answer to initialize is a protocol failure", async () => {
  const { result } = await runDriver({
    server: fakeServer(`
      if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "unsupported protocol version" } });
    `),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "protocol");
  assert.match(result.detail, /unsupported protocol version/);
});

test("a server that exits after initialize, before tools/list, is a protocol failure", async () => {
  const { result } = await runDriver({
    server: fakeServer(`
      if (m.method === "initialize") { out({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "x" } } }); }
      if (m.method === "tools/list") process.exit(0);
    `),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "protocol");
  assert.match(result.detail, /before answering tools\/list/);
});

test("a frame over the line limit is a protocol failure, not a hang", async () => {
  const { result } = await runDriver({
    server: `
      process.stdout.write("x".repeat(3 * 1024 * 1024));
      setInterval(() => {}, 1000);
    `,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "protocol");
  assert.match(result.detail, /larger than the line limit/);
});

test("tools are capped at 200 across pages", async () => {
  const { result } = await runDriver({
    server: fakeServer(`
      if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "many" } } });
      if (m.method === "tools/list") {
        const page = Number(m.params.cursor ?? 0);
        const tools = Array.from({ length: 150 }, (_, i) => ({ name: "t" + page + "-" + i }));
        out({ jsonrpc: "2.0", id: m.id, result: { tools, nextCursor: String(page + 1) } });
      }
    `),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.tools.length, 200);
});
