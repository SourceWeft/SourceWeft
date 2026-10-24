import {
  SandboxProviderError,
  SANDBOX_PROVIDER_ERROR_CODES,
  isSandboxInstanceMissingError,
} from "@sourceweft/builtin-tool-sandbox";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  EXEC_HEARTBEAT_MARKER,
  EXEC_STAMP_GUARD_EXIT_CODE,
  EXEC_STAMP_MISMATCH_MARKER,
  CLOUDFLARE_SANDBOX_PATH_POLICY,
  CloudflareBridgeHttpError,
  CloudflareSandboxProvider,
  READINESS_PROBE_BACKOFF_MS,
  READINESS_PROBE_BUDGET_MS,
  READINESS_PROBE_COMMAND_TIMEOUT_MS,
  SOURCEWEFT_SANDBOX_STAMP_PATH,
  UNAVAILABLE_RETRY_BACKOFF_MS,
  extractExitCode,
  extractSseText,
  mapCloudflareProviderError,
  workspaceRelativePath,
} from "../src/cloudflare-provider";
import { createCloudflareSandboxProviderFactory } from "../src/provider-factory";
import type { ProviderClock } from "../src/cloudflare-provider";

const BRIDGE_URL = "https://bridge.example.workers.dev";
const API_KEY = "test-api-key";

type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | string | null;
  signal: AbortSignal | null;
};

type RouteHandler = (request: RecordedRequest) => Response;

function sseResponse(blocks: Array<{ event: string; data: string }>) {
  const payload = blocks
    .map(({ event, data }) => `event: ${event}\ndata: ${data}\n\n`)
    .join("");
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function createMockBridge(routes: Array<[RegExp, RouteHandler]>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const body =
      init?.body instanceof Uint8Array
        ? init.body
        : typeof init?.body === "string"
          ? init.body
          : null;
    const recorded: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
      signal: init?.signal ?? null,
    };
    requests.push(recorded);
    for (const [pattern, handler] of routes) {
      if (pattern.test(`${recorded.method} ${url}`)) {
        return handler(recorded);
      }
    }
    return new Response("no route", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function createProvider(
  routes: Array<[RegExp, RouteHandler]>,
  maxOutputChars = 10_000,
  clock?: ProviderClock,
) {
  const bridge = createMockBridge(routes);
  const provider = new CloudflareSandboxProvider({
    bridgeUrl: BRIDGE_URL,
    apiKey: API_KEY,
    maxOutputChars,
    fetchImpl: bridge.fetchImpl,
    clock,
  });
  return { provider, requests: bridge.requests };
}

/**
 * Fake clock for the readiness probe: every sleep advances virtual time by
 * its full duration instantly and is recorded, and honours abort like the
 * real one.
 */
function createFakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  const clock: ProviderClock = {
    now: () => now,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      now += ms;
    },
  };
  return { clock, sleeps, now: () => now };
}

const STAMP_ROUTE = /^GET .*\.sourceweft-sandbox-id$/;
const EXEC_ROUTE = /^POST .*\/exec$/;

function execExit(exitCode: number) {
  return sseResponse([
    { event: "exit", data: JSON.stringify({ exit_code: exitCode }) },
  ]);
}

/** Bridge routes for a healthy create: create, stamp write, stamp read, exec. */
function readyCreateRoutes(
  exec: RouteHandler = () => execExit(0),
): Array<[RegExp, RouteHandler]> {
  return [
    [/^POST .*\/v1\/sandbox$/, () => Response.json({ id: "sb-1" })],
    [/^PUT /, () => new Response(null, { status: 200 })],
    [STAMP_ROUTE, () => new Response("sb-1\n")],
    [EXEC_ROUTE, exec],
    [/^DELETE /, () => new Response(null, { status: 200 })],
  ];
}

/**
 * Every exec line starts with the identity guard (EXEC_STAMP_GUARD_EXIT_CODE):
 * `[ "$(cat '<stamp>' 2>/dev/null)" = '<id>' ] || { printf '%s' '<marker><nonce>'; exit 203; }; `.
 * Returns the argv with that prefix removed, asserting it was there.
 */
const STAMP_GUARD_PREFIX =
  /^\[ "\$\(cat '\/workspace\/\.sourceweft-sandbox-id' 2>\/dev\/null\)" = '[^']*' \] \|\| \{ printf '%s' '[^']*'; exit 203; \}; /u;

function withoutStampGuard(argv: string[]) {
  const line = argv[2] ?? "";
  assert.match(line, STAMP_GUARD_PREFIX);
  return [...argv.slice(0, 2), line.replace(STAMP_GUARD_PREFIX, "")];
}

/**
 * A bridge whose exec route runs the shell line FOR REAL: `/workspace` is
 * rewritten to a temp directory standing in for the container filesystem,
 * so the identity guard, `cd` and the command go through `sh` exactly as the
 * bridge runs them. `restart()` is the SDK's "assuming stopped" restart — a
 * fresh container behind the same name with an empty filesystem. File GETs
 * are served from the same directory (a 404 for anything absent).
 */
function createContainerBridge(sandboxId = "sb-1") {
  const root = mkdtempSync(join(tmpdir(), "sourceweft-cf-container-"));
  const stampPath = join(root, ".sourceweft-sandbox-id");
  const ran: string[] = [];
  const rewrite = (line: string) => line.split("/workspace").join(root);
  const bridge = {
    root,
    ran,
    rewrite,
    boot: (id = sandboxId) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(stampPath, id);
    },
    restart: () => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    exec: ((request) => {
      const { argv } = JSON.parse(String(request.body)) as { argv: string[] };
      const line = rewrite(argv[2] ?? "");
      ran.push(line);
      const result = spawnSync("sh", ["-c", line], { encoding: "utf8" });
      return sseResponse([
        ...(result.stdout
          ? [
              {
                event: "stdout",
                data: Buffer.from(result.stdout).toString("base64"),
              },
            ]
          : []),
        ...(result.stderr
          ? [
              {
                event: "stderr",
                data: Buffer.from(result.stderr).toString("base64"),
              },
            ]
          : []),
        { event: "exit", data: JSON.stringify({ exit_code: result.status }) },
      ]);
    }) satisfies RouteHandler,
    file: ((request) => {
      const relative = decodeURIComponent(
        new URL(request.url).pathname.split("/file/workspace/")[1] ?? "",
      );
      const path = join(root, relative);
      return existsSync(path)
        ? new Response(readFileSync(path))
        : new Response("not found", { status: 404 });
    }) satisfies RouteHandler,
  };
  return bridge;
}

function methodsOf(requests: RecordedRequest[]) {
  return requests.map(
    (request) => `${request.method} ${new URL(request.url).pathname}`,
  );
}

describe("path policy", () => {
  test("exposes the /workspace path policy", () => {
    assert.equal(CLOUDFLARE_SANDBOX_PATH_POLICY.workspaceRoot, "/workspace");
    assert.deepEqual(
      [...CLOUDFLARE_SANDBOX_PATH_POLICY.readWriteRoots],
      ["/workspace"],
    );
    assert.deepEqual(
      [...CLOUDFLARE_SANDBOX_PATH_POLICY.prepareTargetRoots],
      ["/workspace/input", "/workspace"],
    );
    assert.deepEqual(
      [...CLOUDFLARE_SANDBOX_PATH_POLICY.collectSourceRoots],
      ["/workspace/output", "/workspace"],
    );
  });
});

describe("workspaceRelativePath", () => {
  test("maps workspace paths onto bridge route segments", () => {
    assert.equal(
      workspaceRelativePath("/workspace/input/a.txt"),
      "input/a.txt",
    );
  });

  test("percent-encodes path segments", () => {
    assert.equal(
      workspaceRelativePath("/workspace/out put/a b.txt"),
      "out%20put/a%20b.txt",
    );
  });

  test("rejects paths outside /workspace", () => {
    assert.throws(
      () => workspaceRelativePath("/etc/passwd"),
      /SANDBOX_FILE_PATH_DENIED/,
    );
  });

  test("rejects traversal segments", () => {
    assert.throws(
      () => workspaceRelativePath("/workspace/../etc/passwd"),
      /SANDBOX_FILE_PATH_DENIED/,
    );
  });

  test("rejects the bare workspace root", () => {
    assert.throws(
      () => workspaceRelativePath("/workspace/"),
      /SANDBOX_FILE_PATH_DENIED/,
    );
  });
});

describe("SSE payload extraction", () => {
  test("extracts text from JSON object payloads", () => {
    assert.equal(extractSseText('{"text":"hello"}'), "hello");
    assert.equal(extractSseText('{"data":"chunk"}'), "chunk");
  });

  test("extracts text from JSON string and plain payloads", () => {
    assert.equal(extractSseText('"quoted"'), "quoted");
    assert.equal(extractSseText("plain text"), "plain text");
  });

  test("decodes raw-base64 payloads (deployed bridge format)", () => {
    assert.equal(
      extractSseText(Buffer.from("hello-stdout\n").toString("base64")),
      "hello-stdout\n",
    );
    // Short non-multiple-of-4 strings pass through untouched.
    assert.equal(extractSseText("200"), "200");
  });

  test("extracts exit codes from JSON and plain payloads", () => {
    assert.equal(extractExitCode('{"exitCode":3}'), 3);
    assert.equal(extractExitCode('{"code":0}'), 0);
    assert.equal(extractExitCode("7"), 7);
    assert.equal(extractExitCode("not a number"), null);
  });
});

describe("CloudflareSandboxProvider", () => {
  test("creates a sandbox, writes the identity stamp and probes readiness", async () => {
    const { clock, sleeps } = createFakeClock();
    const { provider, requests } = createProvider(
      readyCreateRoutes(),
      10_000,
      clock,
    );

    const sandbox = await provider.createSandbox({
      ttlSeconds: 3600,
      labels: { thread_id: "t-1" },
    });

    assert.equal(sandbox.id, "sb-1");
    assert.deepEqual(methodsOf(requests), [
      "POST /v1/sandbox",
      "PUT /v1/sandbox/sb-1/file/workspace/.sourceweft-sandbox-id",
      "GET /v1/sandbox/sb-1/file/workspace/.sourceweft-sandbox-id",
      "POST /v1/sandbox/sb-1/exec",
    ]);
    assert.equal(requests[0]?.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(
      requests[1]?.url,
      `${BRIDGE_URL}/v1/sandbox/sb-1/file/workspace/${SOURCEWEFT_SANDBOX_STAMP_PATH.slice("/workspace/".length)}`,
    );
    assert.deepEqual(requests[1]?.body, new TextEncoder().encode("sb-1"));
    const probe = JSON.parse(String(requests[3]?.body)) as {
      argv: string[];
      timeout_ms: number;
    };
    assert.deepEqual(withoutStampGuard(probe.argv), ["sh", "-lc", "true"]);
    assert.equal(probe.timeout_ms, READINESS_PROBE_COMMAND_TIMEOUT_MS);
    assert.deepEqual(sleeps, []);
  });

  test("fails clearly when create returns no id", async () => {
    const { provider } = createProvider([
      [/^POST .*\/v1\/sandbox$/, () => Response.json({})],
    ]);
    await assert.rejects(
      provider.createSandbox({ ttlSeconds: 60, labels: {} }),
      /SANDBOX_PROVIDER_ERROR/,
    );
  });

  test("health check passes when the stamp matches", async () => {
    const { provider, requests } = createProvider([
      [/^GET .*\.sourceweft-sandbox-id$/, () => new Response("sb-9\n")],
    ]);
    const result = await provider.checkSandboxHealth("sb-9");
    assert.deepEqual(result, { id: "sb-9" });
    assert.equal(
      requests[0]?.url,
      `${BRIDGE_URL}/v1/sandbox/sb-9/file/workspace/.sourceweft-sandbox-id`,
    );
  });

  test("health check reports an expired sandbox when the stamp is missing", async () => {
    const { provider } = createProvider([
      [/^GET /, () => new Response("not found", { status: 404 })],
    ]);
    await assert.rejects(
      provider.checkSandboxHealth("sb-9"),
      /SANDBOX_NOT_FOUND_OR_EXPIRED/,
    );
  });

  test("health check does not turn an arbitrary bad request into instance expiry", async () => {
    const { provider } = createProvider([
      [
        /^GET /,
        () =>
          new Response('{"error":"Invalid sandbox ID format"}', {
            status: 400,
          }),
      ],
    ]);
    await assert.rejects(
      provider.checkSandboxHealth("stale-db-row-id"),
      (error: unknown) =>
        error instanceof SandboxProviderError &&
        error.code === SANDBOX_PROVIDER_ERROR_CODES.unknown &&
        !isSandboxInstanceMissingError(error),
    );
  });

  test("health check reports an expired sandbox when the stamp mismatches", async () => {
    const { provider } = createProvider([
      [/^GET /, () => new Response("some-other-sandbox")],
    ]);
    await assert.rejects(
      provider.getSandbox("sb-9"),
      /SANDBOX_NOT_FOUND_OR_EXPIRED/,
    );
  });

  test("executes commands over SSE and preserves the raw command", async () => {
    // Deployed-bridge wire format: stdout/stderr data is raw base64 of the
    // chunk, exit data is {"exit_code":N} (live-verified 2026-08-16).
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const { provider, requests } = createProvider([
      [
        /^POST .*\/exec$/,
        () =>
          sseResponse([
            { event: "stdout", data: b64("hello ") },
            { event: "stdout", data: b64("world") },
            { event: "stderr", data: b64("\nwarn") },
            { event: "exit", data: '{"exit_code":0}' },
          ]),
      ],
    ]);

    const result = await provider.execute({
      providerSandboxId: "sb-1",
      command: "echo 'hello world'",
      timeoutMs: 30_000,
      maxOutputChars: 10_000,
    });

    assert.equal(result.output, "hello world\nwarn");
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);

    const body = JSON.parse(String(requests[0]?.body)) as {
      argv: string[];
      timeout_ms: number;
    };
    assert.deepEqual(withoutStampGuard(body.argv), [
      "sh",
      "-lc",
      "echo 'hello world'",
    ]);
    assert.equal(body.timeout_ms, 30_000);
  });

  test("wraps cwd into the shell line", async () => {
    const { provider, requests } = createProvider([
      [/^POST .*\/exec$/, () => sseResponse([{ event: "exit", data: "0" }])],
    ]);

    await provider.execute({
      providerSandboxId: "sb-1",
      command: "ls",
      cwd: "/workspace/in put",
      timeoutMs: 5_000,
      maxOutputChars: 100,
    });

    const body = JSON.parse(String(requests[0]?.body)) as { argv: string[] };
    assert.equal(
      withoutStampGuard(body.argv)[2],
      "cd '/workspace/in put' && ls",
    );
  });

  test("wraps long-budget commands with a heartbeat and filters the marker", async () => {
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const { provider, requests } = createProvider([
      [
        /^POST .*\/exec$/,
        () =>
          sseResponse([
            { event: "stdout", data: b64("real output\n") },
            { event: "stderr", data: b64(`${EXEC_HEARTBEAT_MARKER}\n`) },
            { event: "stdout", data: b64("more output") },
            { event: "exit", data: '{"exit_code":0}' },
          ]),
      ],
    ]);

    const result = await provider.execute({
      providerSandboxId: "sb-1",
      command: "long-silent-job",
      timeoutMs: 480_000,
      maxOutputChars: 10_000,
    });

    assert.equal(result.output, "real output\nmore output");
    const body = JSON.parse(String(requests[0]?.body)) as { argv: string[] };
    assert.ok(body.argv[2]?.includes("( long-silent-job )"));
    assert.ok(body.argv[2]?.includes(EXEC_HEARTBEAT_MARKER));
  });

  test("keeps short-budget commands unwrapped", async () => {
    const { provider, requests } = createProvider([
      [/^POST .*\/exec$/, () => sseResponse([{ event: "exit", data: "0" }])],
    ]);
    await provider.execute({
      providerSandboxId: "sb-1",
      command: "quick-job",
      timeoutMs: 120_000,
      maxOutputChars: 100,
    });
    const body = JSON.parse(String(requests[0]?.body)) as { argv: string[] };
    assert.equal(withoutStampGuard(body.argv)[2], "quick-job");
  });

  test("returns non-zero exit codes as normal command results", async () => {
    const { provider } = createProvider([
      [
        /^POST .*\/exec$/,
        () =>
          sseResponse([
            { event: "stderr", data: '{"text":"boom"}' },
            { event: "exit", data: '{"exitCode":2}' },
          ]),
      ],
    ]);

    const result = await provider.execute({
      providerSandboxId: "sb-1",
      command: "false",
      timeoutMs: 5_000,
      maxOutputChars: 100,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.output, "boom");
  });

  test("truncates streamed output at maxOutputChars", async () => {
    const { provider } = createProvider([
      [
        /^POST .*\/exec$/,
        () =>
          sseResponse([
            { event: "stdout", data: JSON.stringify({ text: "a".repeat(50) }) },
            { event: "stdout", data: JSON.stringify({ text: "b".repeat(50) }) },
            { event: "exit", data: "0" },
          ]),
      ],
    ]);

    const result = await provider.execute({
      providerSandboxId: "sb-1",
      command: "yes",
      timeoutMs: 5_000,
      maxOutputChars: 60,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.output.startsWith("a".repeat(50)));
    assert.ok(result.output.endsWith("[output truncated]"));
    // Exit code still collected after truncation because the stream drains.
    assert.equal(result.exitCode, 0);
  });

  test("surfaces stream error events as provider errors", async () => {
    const { provider } = createProvider([
      [
        /^POST .*\/exec$/,
        () =>
          sseResponse([
            { event: "error", data: '{"text":"container crashed"}' },
          ]),
      ],
    ]);

    await assert.rejects(
      provider.execute({
        providerSandboxId: "sb-1",
        command: "true",
        timeoutMs: 5_000,
        maxOutputChars: 100,
      }),
      /SANDBOX_PROVIDER_ERROR.*container crashed/,
    );
  });

  test("uploads and downloads workspace files", async () => {
    const payload = new TextEncoder().encode("file-bytes");
    const controller = new AbortController();
    const { provider, requests } = createProvider([
      [/^PUT /, () => new Response(null, { status: 200 })],
      [/^GET /, () => new Response(payload)],
    ]);

    await provider.uploadFile({
      providerSandboxId: "sb-1",
      sandboxPath: "/workspace/input/a.txt",
      content: payload,
    });
    const downloaded = await provider.downloadFile({
      providerSandboxId: "sb-1",
      sandboxPath: "/workspace/output/b.txt",
      signal: controller.signal,
      timeoutMs: 5_000,
    });

    assert.equal(
      requests[0]?.url,
      `${BRIDGE_URL}/v1/sandbox/sb-1/file/workspace/input/a.txt`,
    );
    assert.equal(requests[1]?.signal, controller.signal);
    assert.equal(requests[0]?.method, "PUT");
    assert.equal(
      requests[1]?.url,
      `${BRIDGE_URL}/v1/sandbox/sb-1/file/workspace/output/b.txt`,
    );
    assert.ok(Buffer.from(payload).equals(downloaded));
  });

  test("maps missing downloads to SANDBOX_FILE_NOT_FOUND", async () => {
    const { provider } = createProvider([
      // The stamp is intact, so the miss is the file's, not the container's.
      [STAMP_ROUTE, () => new Response("sb-1\n")],
      [/^GET /, () => new Response("nope", { status: 404 })],
    ]);
    await assert.rejects(
      provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/output/missing.txt",
      }),
      /SANDBOX_FILE_NOT_FOUND/,
    );
  });

  test("deletes sandboxes through the bridge", async () => {
    const { provider, requests } = createProvider([
      [/^DELETE /, () => new Response(null, { status: 200 })],
    ]);
    await provider.deleteSandbox("sb-1");
    assert.equal(requests[0]?.method, "DELETE");
    assert.equal(requests[0]?.url, `${BRIDGE_URL}/v1/sandbox/sb-1`);
  });

  test("confirms execution cancellation by deleting the sandbox", async () => {
    const { provider, requests } = createProvider([
      [/^DELETE /, () => new Response(null, { status: 200 })],
    ]);

    assert.deepEqual(
      await provider.cancelExecution({
        providerSandboxId: "sb-1",
        executionId: "execution-1",
        reason: "user_cancelled",
      }),
      { confirmed: true, mode: "sandbox" },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "DELETE");
    assert.equal(requests[0]?.url, `${BRIDGE_URL}/v1/sandbox/sb-1`);
  });

  test("treats an already absent sandbox as confirmed cancellation", async () => {
    const { provider } = createProvider([
      [/^DELETE /, () => new Response("missing", { status: 404 })],
    ]);

    assert.deepEqual(
      await provider.cancelExecution({
        providerSandboxId: "sb-1",
        executionId: "execution-1",
        reason: "user_cancelled",
      }),
      { confirmed: true, mode: "sandbox" },
    );
  });

  test("ensureDirectory shells a quoted mkdir -p", async () => {
    const { provider, requests } = createProvider([
      [/^POST .*\/exec$/, () => sseResponse([{ event: "exit", data: "0" }])],
    ]);
    await provider.ensureDirectory({
      providerSandboxId: "sb-1",
      directory: "/workspace/out put's",
    });
    const body = JSON.parse(String(requests[0]?.body)) as { argv: string[] };
    assert.equal(
      withoutStampGuard(body.argv)[2],
      `mkdir -p '/workspace/out put'\\''s'`,
    );
  });

  test("ensureDirectory maps mkdir failures", async () => {
    const { provider } = createProvider([
      [
        /^POST .*\/exec$/,
        () =>
          sseResponse([
            { event: "stderr", data: '{"text":"read-only"}' },
            { event: "exit", data: "1" },
          ]),
      ],
    ]);
    await assert.rejects(
      provider.ensureDirectory({
        providerSandboxId: "sb-1",
        directory: "/workspace/x",
      }),
      /SANDBOX_DIRECTORY_CREATE_FAILED/,
    );
  });

  test("requires bridge URL and API key", () => {
    assert.throws(
      () =>
        new CloudflareSandboxProvider({
          bridgeUrl: "",
          apiKey: "k",
          maxOutputChars: 100,
        }),
      /SANDBOX_NOT_CONFIGURED: CF_SANDBOX_BRIDGE_URL/,
    );
    assert.throws(
      () =>
        new CloudflareSandboxProvider({
          bridgeUrl: BRIDGE_URL,
          apiKey: "",
          maxOutputChars: 100,
        }),
      /SANDBOX_NOT_CONFIGURED: CF_SANDBOX_API_KEY/,
    );
  });
});

describe("createSandbox readiness probe", () => {
  test("exports the probe thresholds", () => {
    assert.equal(READINESS_PROBE_COMMAND_TIMEOUT_MS, 5_000);
    assert.equal(READINESS_PROBE_BUDGET_MS, 90_000);
    assert.deepEqual([...READINESS_PROBE_BACKOFF_MS], [1_000, 2_000, 4_000]);
  });

  test("retries unavailable probes with 1s/2s backoff until the container answers", async () => {
    const { clock, sleeps } = createFakeClock();
    let execCalls = 0;
    const { provider, requests } = createProvider(
      readyCreateRoutes(() =>
        ++execCalls < 3
          ? new Response("not ready", { status: 503 })
          : execExit(0),
      ),
      10_000,
      clock,
    );

    const sandbox = await provider.createSandbox({
      ttlSeconds: 60,
      labels: {},
    });

    assert.equal(sandbox.id, "sb-1");
    assert.equal(execCalls, 3);
    assert.deepEqual(sleeps, [1_000, 2_000]);
    assert.deepEqual(methodsOf(requests), [
      "POST /v1/sandbox",
      "PUT /v1/sandbox/sb-1/file/workspace/.sourceweft-sandbox-id",
      "GET /v1/sandbox/sb-1/file/workspace/.sourceweft-sandbox-id",
      "POST /v1/sandbox/sb-1/exec",
      "GET /v1/sandbox/sb-1/file/workspace/.sourceweft-sandbox-id",
      "POST /v1/sandbox/sb-1/exec",
      "GET /v1/sandbox/sb-1/file/workspace/.sourceweft-sandbox-id",
      "POST /v1/sandbox/sb-1/exec",
    ]);
    assert.ok(!requests.some((request) => request.method === "DELETE"));
  });

  test("treats a probe that does not exit 0 as not ready yet", async () => {
    const { clock, sleeps } = createFakeClock();
    let execCalls = 0;
    const { provider } = createProvider(
      readyCreateRoutes(() => execExit(++execCalls < 2 ? 127 : 0)),
      10_000,
      clock,
    );

    await provider.createSandbox({ ttlSeconds: 60, labels: {} });

    assert.equal(execCalls, 2);
    assert.deepEqual(sleeps, [1_000]);
  });

  test("fails closed and deletes the sandbox when the budget is exhausted", async () => {
    const { clock, sleeps, now } = createFakeClock();
    let execCalls = 0;
    const { provider, requests } = createProvider(
      readyCreateRoutes(() => {
        execCalls += 1;
        return new Response("not ready", { status: 503 });
      }),
      10_000,
      clock,
    );

    await assert.rejects(
      provider.createSandbox({ ttlSeconds: 60, labels: {} }),
      (error: unknown) =>
        error instanceof SandboxProviderError &&
        error.code === SANDBOX_PROVIDER_ERROR_CODES.unavailable &&
        error.phase === "create" &&
        /sandbox did not become ready within 90s after create/.test(
          error.message,
        ) &&
        error.cause instanceof SandboxProviderError &&
        error.cause.code === SANDBOX_PROVIDER_ERROR_CODES.unavailable,
    );

    // 1s, 2s, then 4s capped: 3s + 21 * 4s = 87s; the next 4s would cross 90s.
    assert.deepEqual(sleeps, [1_000, 2_000, ...Array<number>(21).fill(4_000)]);
    assert.equal(now(), 87_000);
    assert.ok(now() < READINESS_PROBE_BUDGET_MS);
    assert.ok(now() + 4_000 >= READINESS_PROBE_BUDGET_MS);
    assert.equal(execCalls, sleeps.length + 1);
    assert.equal(requests.at(-1)?.method, "DELETE");
    assert.equal(new URL(requests.at(-1)!.url).pathname, "/v1/sandbox/sb-1");
  });

  test("retries a probe whose exec times out", async () => {
    const { clock, sleeps } = createFakeClock();
    let execCalls = 0;
    const { provider } = createProvider(
      readyCreateRoutes(() =>
        ++execCalls < 2
          ? new Response("gateway timeout", { status: 504 })
          : execExit(0),
      ),
      10_000,
      clock,
    );

    await provider.createSandbox({ ttlSeconds: 60, labels: {} });

    assert.equal(execCalls, 2);
    assert.deepEqual(sleeps, [1_000]);
  });

  test("retries when the stamp read itself is temporarily unavailable", async () => {
    const { clock, sleeps } = createFakeClock();
    let stampReads = 0;
    const { provider, requests } = createProvider(
      [
        [/^POST .*\/v1\/sandbox$/, () => Response.json({ id: "sb-1" })],
        [/^PUT /, () => new Response(null, { status: 200 })],
        [
          STAMP_ROUTE,
          () =>
            ++stampReads < 2
              ? new Response("warming", { status: 503 })
              : new Response("sb-1\n"),
        ],
        [EXEC_ROUTE, () => execExit(0)],
      ],
      10_000,
      clock,
    );

    await provider.createSandbox({ ttlSeconds: 60, labels: {} });

    assert.equal(stampReads, 2);
    assert.deepEqual(sleeps, [1_000]);
    assert.equal(
      requests.filter((request) =>
        EXEC_ROUTE.test(`${request.method} ${request.url}`),
      ).length,
      1,
    );
  });

  test("does not retry authentication failures and still deletes the sandbox", async () => {
    const { clock, sleeps } = createFakeClock();
    let execCalls = 0;
    const { provider, requests } = createProvider(
      readyCreateRoutes(() => {
        execCalls += 1;
        return new Response("forbidden", { status: 401 });
      }),
      10_000,
      clock,
    );

    await assert.rejects(
      provider.createSandbox({ ttlSeconds: 60, labels: {} }),
      (error: unknown) =>
        error instanceof SandboxProviderError &&
        error.code === SANDBOX_PROVIDER_ERROR_CODES.authentication,
    );

    assert.equal(execCalls, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(requests.at(-1)?.method, "DELETE");
  });

  test("does not retry a stamp mismatch", async () => {
    const { clock, sleeps } = createFakeClock();
    const { provider, requests } = createProvider(
      [
        [/^POST .*\/v1\/sandbox$/, () => Response.json({ id: "sb-1" })],
        [/^PUT /, () => new Response(null, { status: 200 })],
        [STAMP_ROUTE, () => new Response("sb-other\n")],
        [EXEC_ROUTE, () => execExit(0)],
        [/^DELETE /, () => new Response(null, { status: 200 })],
      ],
      10_000,
      clock,
    );

    await assert.rejects(
      provider.createSandbox({ ttlSeconds: 60, labels: {} }),
      (error: unknown) => isSandboxInstanceMissingError(error),
    );

    assert.deepEqual(sleeps, []);
    assert.ok(
      !requests.some((request) =>
        EXEC_ROUTE.test(`${request.method} ${request.url}`),
      ),
    );
    assert.equal(requests.at(-1)?.method, "DELETE");
  });

  test("stops immediately when the signal aborts during a probe attempt", async () => {
    const { clock, sleeps } = createFakeClock();
    const controller = new AbortController();
    const reason = new DOMException("turn cancelled", "AbortError");
    let execCalls = 0;
    const { provider, requests } = createProvider(
      readyCreateRoutes((request) => {
        execCalls += 1;
        controller.abort(reason);
        assert.equal(request.signal?.aborted, true);
        return new Response("not ready", { status: 503 });
      }),
      10_000,
      clock,
    );

    await assert.rejects(
      provider.createSandbox({
        ttlSeconds: 60,
        labels: {},
        signal: controller.signal,
      }),
      (error: unknown) => error === reason,
    );

    assert.equal(execCalls, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(requests.at(-1)?.method, "DELETE");
  });

  test("stops immediately when the signal aborts during backoff (real timer)", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled mid-backoff");
    let execCalls = 0;
    const { provider, requests } = createProvider(
      readyCreateRoutes(() => {
        execCalls += 1;
        return new Response("not ready", { status: 503 });
      }),
    );

    const startedAt = Date.now();
    const pending = provider.createSandbox({
      ttlSeconds: 60,
      labels: {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 20);

    await assert.rejects(pending, (error: unknown) => error === reason);

    assert.ok(Date.now() - startedAt < READINESS_PROBE_BACKOFF_MS[0]!);
    assert.equal(execCalls, 1);
    assert.equal(requests.at(-1)?.method, "DELETE");
  });

  test("does not run a probe when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const { provider, requests } = createProvider(readyCreateRoutes());

    await assert.rejects(
      provider.createSandbox({
        ttlSeconds: 60,
        labels: {},
        signal: controller.signal,
      }),
      /already cancelled/,
    );

    assert.ok(
      !requests.some((request) =>
        EXEC_ROUTE.test(`${request.method} ${request.url}`),
      ),
    );
    assert.equal(requests.at(-1)?.method, "DELETE");
  });

  test("health checks stay stamp-only and never exec", async () => {
    const { provider, requests } = createProvider([
      [STAMP_ROUTE, () => new Response("sb-9\n")],
      [EXEC_ROUTE, () => assert.fail("health check must not exec")],
    ]);

    await provider.checkSandboxHealth("sb-9");
    await provider.getSandbox("sb-9");

    assert.deepEqual(methodsOf(requests), [
      "GET /v1/sandbox/sb-9/file/workspace/.sourceweft-sandbox-id",
      "GET /v1/sandbox/sb-9/file/workspace/.sourceweft-sandbox-id",
    ]);
  });
});

/** Answers with each listed status in turn, then delegates to `ok`. */
function statusSequence(
  statuses: readonly number[],
  ok: RouteHandler,
): RouteHandler & { calls: () => number } {
  let calls = 0;
  const handler = (request: RecordedRequest) => {
    const status = statuses[calls];
    calls += 1;
    return status === undefined
      ? ok(request)
      : new Response("busy", { status });
  };
  return Object.assign(handler, { calls: () => calls });
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof SandboxProviderError && error.code === code;
}

/**
 * A clock whose sleep never elapses on its own: it records the delay, then
 * stays pending until the signal aborts (rejecting with its reason).
 */
function createPendingClock() {
  const sleeps: number[] = [];
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const clock: ProviderClock = {
    now: () => 0,
    sleep: (ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        sleeps.push(ms);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        markStarted();
      }),
  };
  return { clock, sleeps, started };
}

function countRequests(requests: RecordedRequest[], pattern: RegExp) {
  return requests.filter((request) =>
    pattern.test(`${request.method} ${request.url}`),
  ).length;
}

describe("unavailable retry", () => {
  test("exports the retry backoff", () => {
    assert.deepEqual([...UNAVAILABLE_RETRY_BACKOFF_MS], [1_000, 2_000, 4_000]);
  });

  test("GET retries 503s with 1s/2s backoff until the bridge answers", async () => {
    const { clock, sleeps } = createFakeClock();
    const stamp = statusSequence([503, 503], () => new Response("sb-1\n"));
    const { provider, requests } = createProvider(
      [[STAMP_ROUTE, stamp]],
      10_000,
      clock,
    );

    assert.deepEqual(await provider.getSandbox("sb-1"), { id: "sb-1" });
    assert.equal(requests.length, 3);
    assert.deepEqual(sleeps, [1_000, 2_000]);
  });

  test("health check and download GETs retry too", async () => {
    const { clock, sleeps } = createFakeClock();
    const { provider, requests } = createProvider(
      [
        [STAMP_ROUTE, statusSequence([502], () => new Response("sb-1\n"))],
        [/^GET /, statusSequence([503], () => new Response("bytes"))],
      ],
      10_000,
      clock,
    );

    await provider.checkSandboxHealth("sb-1");
    const downloaded = await provider.downloadFile({
      providerSandboxId: "sb-1",
      sandboxPath: "/workspace/output/a.txt",
    });

    assert.equal(downloaded.toString(), "bytes");
    assert.equal(requests.length, 4);
    assert.deepEqual(sleeps, [1_000, 1_000]);
  });

  test("PUT re-sends the same upload bytes after 503s", async () => {
    const { clock, sleeps } = createFakeClock();
    const payload = new TextEncoder().encode("file-bytes");
    const { provider, requests } = createProvider(
      [
        [
          /^PUT /,
          statusSequence([503, 503], () => new Response(null, { status: 200 })),
        ],
      ],
      10_000,
      clock,
    );

    await provider.uploadFile({
      providerSandboxId: "sb-1",
      sandboxPath: "/workspace/input/a.txt",
      content: payload,
    });

    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.method, "PUT");
      assert.deepEqual(request.body, payload);
    }
    assert.deepEqual(sleeps, [1_000, 2_000]);
  });

  test("DELETE retries 503s", async () => {
    const { clock, sleeps } = createFakeClock();
    const { provider, requests } = createProvider(
      [
        [
          /^DELETE /,
          statusSequence([503, 503], () => new Response(null, { status: 200 })),
        ],
      ],
      10_000,
      clock,
    );

    await provider.deleteSandbox("sb-1");

    assert.equal(requests.length, 3);
    assert.deepEqual(sleeps, [1_000, 2_000]);
  });

  test("retries 429 and network failures", async () => {
    const { clock, sleeps } = createFakeClock();
    let networkCalls = 0;
    const { provider, requests } = createProvider(
      [
        [STAMP_ROUTE, statusSequence([429], () => new Response("sb-1\n"))],
        [
          /^DELETE /,
          () => {
            networkCalls += 1;
            if (networkCalls < 2) {
              throw new TypeError("fetch failed");
            }
            return new Response(null, { status: 200 });
          },
        ],
      ],
      10_000,
      clock,
    );

    await provider.getSandbox("sb-1");
    await provider.deleteSandbox("sb-1");

    assert.equal(requests.length, 4);
    assert.deepEqual(sleeps, [1_000, 1_000]);
  });

  test("gives up after four attempts with the normal unavailable error", async () => {
    const { clock, sleeps } = createFakeClock();
    const { provider, requests } = createProvider(
      [[STAMP_ROUTE, () => new Response("busy", { status: 503 })]],
      10_000,
      clock,
    );
    const expected = mapCloudflareProviderError(
      new CloudflareBridgeHttpError(503, "get", "busy"),
      "get",
    );

    await assert.rejects(
      provider.getSandbox("sb-1"),
      (error: unknown) =>
        hasCode(SANDBOX_PROVIDER_ERROR_CODES.unavailable)(error) &&
        (error as Error).message === expected.message,
    );
    assert.equal(requests.length, 4);
    assert.deepEqual(sleeps, [1_000, 2_000, 4_000]);
  });

  test("never retries auth, missing, timeout or unknown failures", async () => {
    const cases: Array<[string, RouteHandler, string]> = [
      [
        "401",
        () => new Response("no", { status: 401 }),
        SANDBOX_PROVIDER_ERROR_CODES.authentication,
      ],
      [
        "403",
        () => new Response("no", { status: 403 }),
        SANDBOX_PROVIDER_ERROR_CODES.authentication,
      ],
      [
        "404",
        () => new Response("no", { status: 404 }),
        SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
      ],
      [
        "408",
        () => new Response("slow", { status: 408 }),
        SANDBOX_PROVIDER_ERROR_CODES.timeout,
      ],
      [
        "504",
        () => new Response("slow", { status: 504 }),
        SANDBOX_PROVIDER_ERROR_CODES.timeout,
      ],
      [
        "400",
        () => new Response("bad", { status: 400 }),
        SANDBOX_PROVIDER_ERROR_CODES.unknown,
      ],
      [
        "fetch abort",
        () => {
          throw new DOMException("This operation was aborted", "AbortError");
        },
        SANDBOX_PROVIDER_ERROR_CODES.timeout,
      ],
      [
        "fetch timeout",
        () => {
          throw new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          );
        },
        SANDBOX_PROVIDER_ERROR_CODES.timeout,
      ],
    ];
    for (const [name, handler, code] of cases) {
      const { clock, sleeps } = createFakeClock();
      const { provider, requests } = createProvider(
        [[STAMP_ROUTE, handler]],
        10_000,
        clock,
      );
      await assert.rejects(provider.getSandbox("sb-1"), hasCode(code), name);
      assert.equal(requests.length, 1, name);
      assert.deepEqual(sleeps, [], name);
    }
  });

  test("never retries a missing download", async () => {
    const { clock, sleeps } = createFakeClock();
    const { provider, requests } = createProvider(
      [
        [STAMP_ROUTE, () => new Response("sb-1\n")],
        [/^GET /, () => new Response("nope", { status: 404 })],
      ],
      10_000,
      clock,
    );

    await assert.rejects(
      provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/output/missing.txt",
      }),
      hasCode(SANDBOX_PROVIDER_ERROR_CODES.fileMissing),
    );
    // One file GET, then the stamp read that proves the container is still
    // ours (see "a download miss checks the stamp"); no retry of either.
    assert.deepEqual(methodsOf(requests), [
      "GET /v1/sandbox/sb-1/file/workspace/output/missing.txt",
      "GET /v1/sandbox/sb-1/file/workspace/.sourceweft-sandbox-id",
    ]);
    assert.deepEqual(sleeps, []);
  });

  test("an abort during backoff rejects with the reason and stops fetching", async () => {
    const { clock, sleeps, started } = createPendingClock();
    const controller = new AbortController();
    const reason = new Error("cancelled mid-backoff");
    const { provider, requests } = createProvider(
      [[/^GET /, () => new Response("busy", { status: 503 })]],
      10_000,
      clock,
    );

    const pending = provider.downloadFile({
      providerSandboxId: "sb-1",
      sandboxPath: "/workspace/output/a.txt",
      signal: controller.signal,
    });
    await started;
    controller.abort(reason);

    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(requests.length, 1);
    assert.deepEqual(sleeps, [1_000]);
  });

  test("a failure after the signal aborted is not retried", async () => {
    const { clock, sleeps } = createFakeClock();
    const controller = new AbortController();
    const { provider, requests } = createProvider(
      [
        [
          /^GET /,
          () => {
            controller.abort(new Error("cancelled"));
            return new Response("busy", { status: 503 });
          },
        ],
      ],
      10_000,
      clock,
    );

    await assert.rejects(
      provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/output/a.txt",
        signal: controller.signal,
      }),
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(sleeps, []);
  });
});

describe("create leaves unavailable retries to the manager", () => {
  const CREATE_ROUTE = /^POST .*\/v1\/sandbox$/;

  test("sends the create POST once and surfaces unavailable", async () => {
    const outcomes: Array<[string, RouteHandler]> = [
      ["503", () => new Response("busy", { status: 503 })],
      ["429", () => new Response("slow down", { status: 429 })],
      ["500", () => new Response("boom", { status: 500 })],
      ["502", () => new Response("bad gateway", { status: 502 })],
      [
        "network",
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    ];
    for (const [name, handler] of outcomes) {
      const { clock, sleeps } = createFakeClock();
      const { provider, requests } = createProvider(
        [[CREATE_ROUTE, handler]],
        10_000,
        clock,
      );

      await assert.rejects(
        provider.createSandbox({ ttlSeconds: 60, labels: {} }),
        hasCode(SANDBOX_PROVIDER_ERROR_CODES.unavailable),
        name,
      );
      assert.equal(requests.length, 1, name);
      assert.deepEqual(sleeps, [], name);
    }
  });

  test("sends the identity stamp PUT once and surfaces unavailable", async () => {
    const { clock, sleeps } = createFakeClock();
    const [create] = readyCreateRoutes();
    const { provider, requests } = createProvider(
      [create!, [/^PUT /, () => new Response("busy", { status: 503 })]],
      10_000,
      clock,
    );

    await assert.rejects(
      provider.createSandbox({ ttlSeconds: 60, labels: {} }),
      hasCode(SANDBOX_PROVIDER_ERROR_CODES.unavailable),
    );
    assert.deepEqual(methodsOf(requests), [
      "POST /v1/sandbox",
      "PUT /v1/sandbox/sb-1/file/workspace/.sourceweft-sandbox-id",
    ]);
    assert.deepEqual(sleeps, []);
  });

  test("deletes a failed sandbox with a single attempt", async () => {
    const { clock, sleeps } = createFakeClock();
    const [create, put, stamp] = readyCreateRoutes();
    const { provider, requests } = createProvider(
      [
        create!,
        put!,
        stamp!,
        [EXEC_ROUTE, () => new Response("forbidden", { status: 401 })],
        [/^DELETE /, () => new Response("busy", { status: 503 })],
      ],
      10_000,
      clock,
    );

    await assert.rejects(
      provider.createSandbox({ ttlSeconds: 60, labels: {} }),
      hasCode(SANDBOX_PROVIDER_ERROR_CODES.authentication),
    );
    assert.equal(countRequests(requests, /^DELETE /), 1);
    assert.deepEqual(sleeps, []);
  });

  test("the readiness probe does not nest retries inside its own polling", async () => {
    const { clock, sleeps } = createFakeClock();
    const [create, put, , exec, del] = readyCreateRoutes();
    const { provider, requests } = createProvider(
      [
        create!,
        put!,
        [STAMP_ROUTE, () => new Response("warming", { status: 503 })],
        exec!,
        del!,
      ],
      10_000,
      clock,
    );

    await assert.rejects(
      provider.createSandbox({ ttlSeconds: 60, labels: {} }),
      /sandbox did not become ready within 90s/,
    );

    // Same schedule as an exec-failure probe: one stamp read per probe
    // attempt, no hidden 1s/2s/4s request retries inside an attempt.
    assert.deepEqual(sleeps, [1_000, 2_000, ...Array<number>(21).fill(4_000)]);
    assert.equal(countRequests(requests, STAMP_ROUTE), sleeps.length + 1);
    assert.equal(countRequests(requests, EXEC_ROUTE), 0);
  });
});

describe("executeSystem unavailable retry", () => {
  const command = {
    providerSandboxId: "sb-1",
    command: "mkdir -p /workspace/x",
    timeoutMs: 5_000,
    maxOutputChars: 100,
  };

  test("retries an idempotent system command whose exec was refused", async () => {
    const { clock, sleeps } = createFakeClock();
    const exec = statusSequence([503], () => execExit(0));
    const { provider, requests } = createProvider(
      [[EXEC_ROUTE, exec]],
      10_000,
      clock,
    );

    const result = await provider.executeSystem({
      ...command,
      idempotent: true,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(
        (JSON.parse(String(request.body)) as { timeout_ms: number }).timeout_ms,
        5_000,
      );
    }
    assert.deepEqual(sleeps, [1_000]);
  });

  test("runs a system command once unless it is declared idempotent", async () => {
    const { clock, sleeps } = createFakeClock();
    const { provider, requests } = createProvider(
      [[EXEC_ROUTE, () => new Response("busy", { status: 503 })]],
      10_000,
      clock,
    );

    await assert.rejects(
      provider.executeSystem(command),
      hasCode(SANDBOX_PROVIDER_ERROR_CODES.unavailable),
    );
    await assert.rejects(
      provider.executeSystem({ ...command, idempotent: false }),
      hasCode(SANDBOX_PROVIDER_ERROR_CODES.unavailable),
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(sleeps, []);
  });

  test("never retries an idempotent command that timed out", async () => {
    const { clock, sleeps } = createFakeClock();
    const { provider, requests } = createProvider(
      [[EXEC_ROUTE, () => new Response("slow", { status: 504 })]],
      10_000,
      clock,
    );

    await assert.rejects(
      provider.executeSystem({ ...command, idempotent: true }),
      hasCode(SANDBOX_PROVIDER_ERROR_CODES.timeout),
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(sleeps, []);
  });

  test("never retries a model command, even if it claims to be idempotent", async () => {
    const { clock, sleeps } = createFakeClock();
    const { provider, requests } = createProvider(
      [[EXEC_ROUTE, () => new Response("busy", { status: 503 })]],
      10_000,
      clock,
    );

    await assert.rejects(
      provider.execute(command),
      hasCode(SANDBOX_PROVIDER_ERROR_CODES.unavailable),
    );
    await assert.rejects(
      provider.execute({ ...command, idempotent: true } as Parameters<
        CloudflareSandboxProvider["execute"]
      >[0]),
      hasCode(SANDBOX_PROVIDER_ERROR_CODES.unavailable),
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(sleeps, []);
  });

  test("never retries an idempotent command after other 5xx or a mid-stream failure", async () => {
    const outcomes: Array<[string, RouteHandler]> = [
      ["500", () => new Response("boom", { status: 500 })],
      ["502", () => new Response("bad gateway", { status: 502 })],
      [
        "stream error",
        () =>
          sseResponse([{ event: "error", data: '{"text":"socket hang up"}' }]),
      ],
    ];
    for (const [name, handler] of outcomes) {
      const { clock, sleeps } = createFakeClock();
      const { provider, requests } = createProvider(
        [[EXEC_ROUTE, handler]],
        10_000,
        clock,
      );

      await assert.rejects(
        provider.executeSystem({ ...command, idempotent: true }),
        name,
      );
      assert.equal(requests.length, 1, name);
      assert.deepEqual(sleeps, [], name);
    }
  });

  test("retries an idempotent command refused with 429 or never connected", async () => {
    const failures: Array<[string, () => Response]> = [
      ["429", () => new Response("slow down", { status: 429 })],
      [
        "ECONNREFUSED",
        () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), {
              code: "ECONNREFUSED",
            }),
          });
        },
      ],
    ];
    for (const [name, fail] of failures) {
      const { clock, sleeps } = createFakeClock();
      let calls = 0;
      const { provider } = createProvider(
        [[EXEC_ROUTE, () => (++calls < 2 ? fail() : execExit(0))]],
        10_000,
        clock,
      );

      const result = await provider.executeSystem({
        ...command,
        idempotent: true,
      });

      assert.equal(result.exitCode, 0, name);
      assert.equal(calls, 2, name);
      assert.deepEqual(sleeps, [1_000], name);
    }
  });

  test("an abort during idempotent backoff rejects with the reason", async () => {
    const { clock, sleeps, started } = createPendingClock();
    const controller = new AbortController();
    const reason = new DOMException("turn cancelled", "AbortError");
    const { provider, requests } = createProvider(
      [[EXEC_ROUTE, () => new Response("busy", { status: 503 })]],
      10_000,
      clock,
    );

    const pending = provider.executeSystem({
      ...command,
      idempotent: true,
      signal: controller.signal,
    });
    await started;
    controller.abort(reason);

    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(requests.length, 1);
    assert.deepEqual(sleeps, [1_000]);
  });

  test("ensureDirectory retries a refused mkdir", async () => {
    const { clock, sleeps } = createFakeClock();
    const exec = statusSequence([503], () => execExit(0));
    const { provider, requests } = createProvider(
      [[EXEC_ROUTE, exec]],
      10_000,
      clock,
    );

    await provider.ensureDirectory({
      providerSandboxId: "sb-1",
      directory: "/workspace/x",
    });

    assert.equal(exec.calls(), 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(sleeps, [1_000]);
  });
});

describe("mapCloudflareProviderError", () => {
  test("maps auth failures", () => {
    for (const status of [401, 403]) {
      const mapped = mapCloudflareProviderError(
        new CloudflareBridgeHttpError(status, "execute", "denied"),
        "execute",
      );
      assert.match(mapped.message, /SANDBOX_PROVIDER_AUTH_FAILED/);
    }
  });

  test("distinguishes instance 404s from file and unknown operation 404s", () => {
    for (const [phase, code] of [
      ["download", "SANDBOX_FILE_NOT_FOUND"],
      ["execute", "SANDBOX_PROVIDER_ERROR"],
      ["get", "SANDBOX_NOT_FOUND_OR_EXPIRED"],
      ["delete", "SANDBOX_NOT_FOUND_OR_EXPIRED"],
    ] as const) {
      const cause = new CloudflareBridgeHttpError(404, phase, "");
      const mapped = mapCloudflareProviderError(cause, phase);
      assert.equal((mapped as { code?: string }).code, code);
      assert.equal(mapped.cause, cause);
      assert.equal(
        isSandboxInstanceMissingError(mapped),
        phase === "get" || phase === "delete",
      );
    }
  });

  test("maps timeouts and aborts", () => {
    assert.match(
      mapCloudflareProviderError(
        new Error("The operation was aborted"),
        "execute",
      ).message,
      /SANDBOX_COMMAND_TIMEOUT/,
    );
    assert.match(
      mapCloudflareProviderError(
        new CloudflareBridgeHttpError(504, "execute", ""),
        "execute",
      ).message,
      /SANDBOX_COMMAND_TIMEOUT/,
    );
  });

  test("maps 5xx and network failures to retryable unhealthy", () => {
    assert.match(
      mapCloudflareProviderError(
        new CloudflareBridgeHttpError(503, "create", ""),
        "create",
      ).message,
      /SANDBOX_NOT_READY_OR_UNHEALTHY/,
    );
    assert.match(
      mapCloudflareProviderError(new TypeError("fetch failed"), "create")
        .message,
      /SANDBOX_NOT_READY_OR_UNHEALTHY/,
    );
  });

  test("passes through platform-coded errors unchanged", () => {
    const original = new Error("SANDBOX_FILE_PATH_DENIED: nope");
    assert.equal(mapCloudflareProviderError(original, "upload"), original);
  });

  test("falls back to a generic provider error with a diagnostic", () => {
    const mapped = mapCloudflareProviderError(
      new Error("something odd"),
      "upload",
    );
    assert.match(
      mapped.message,
      /SANDBOX_PROVIDER_ERROR: sandbox provider upload failed: something odd/,
    );
  });
});

describe("createCloudflareSandboxProviderFactory", () => {
  test("reports configured when both settings are present", () => {
    const factory = createCloudflareSandboxProviderFactory({
      bridgeUrl: BRIDGE_URL,
      apiKey: API_KEY,
      maxOutputChars: 100,
    });
    const status = factory.getConfigurationStatus();
    assert.equal(status.configured, true);
    assert.deepEqual(status.missing, []);
    assert.equal(factory.id, "cloudflare");
    assert.equal(factory.createProvider().id, "cloudflare");
  });

  test("names each missing setting", () => {
    const factory = createCloudflareSandboxProviderFactory({
      bridgeUrl: "",
      apiKey: "",
      maxOutputChars: 100,
    });
    const status = factory.getConfigurationStatus();
    assert.equal(status.configured, false);
    assert.deepEqual(status.missing, [
      "CF_SANDBOX_BRIDGE_URL",
      "CF_SANDBOX_API_KEY",
    ]);
  });
});

describe("ambiguous empty download metadata", () => {
  const metadata = (value: unknown, exit = 0) =>
    sseResponse([
      {
        event: "stdout",
        data: Buffer.from(JSON.stringify(value)).toString("base64"),
      },
      { event: "exit", data: JSON.stringify({ exit_code: exit }) },
    ]);
  const missing = {
    protocol: "sourceweft-file-stat-v1",
    kind: "missing",
    errno: 2,
  };
  test("only authoritative missing classifies HTTP 200 empty as fileMissing", async () => {
    const { provider, requests } = createProvider([
      [/^GET /, () => new Response(new Uint8Array())],
      [/^POST .*\/exec$/, () => metadata(missing)],
    ]);
    await assert.rejects(
      provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/missing.txt",
        timeoutMs: 1234,
      }),
      (error: unknown) =>
        error instanceof SandboxProviderError &&
        error.code === SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
    );
    assert.equal(requests.length, 2);
    const body = JSON.parse(String(requests[1]!.body));
    assert(body.timeout_ms > 0 && body.timeout_ms <= 1234);
    assert.match(withoutStampGuard(body.argv)[2] ?? "", /^python3 -c /);
  });
  test("a confirmed empty regular file remains a real zero-byte file", async () => {
    const { provider, requests } = createProvider([
      [/^GET /, () => new Response(new Uint8Array())],
      [
        /^POST .*\/exec$/,
        () =>
          metadata({
            protocol: "sourceweft-file-stat-v1",
            kind: "regular",
            size: 0,
          }),
      ],
    ]);
    assert.equal(
      (
        await provider.downloadFile({
          providerSandboxId: "sb-1",
          sandboxPath: "/workspace/empty.txt",
        })
      ).length,
      0,
    );
    assert.equal(requests.length, 2);
    assert(JSON.parse(String(requests[1]!.body)).timeout_ms <= 5000);
  });
  test("nonempty downloads keep their original HTTP-only behavior", async () => {
    const { provider, requests } = createProvider([
      [/^GET /, () => new Response("bytes")],
    ]);
    assert.equal(
      (
        await provider.downloadFile({
          providerSandboxId: "sb-1",
          sandboxPath: "/workspace/present.txt",
        })
      ).toString(),
      "bytes",
    );
    assert.equal(requests.length, 1);
  });
  const invalid = [
    [
      "incomplete nonempty file",
      { protocol: "sourceweft-file-stat-v1", kind: "regular", size: 20 },
      /SANDBOX_FILE_DOWNLOAD_INCOMPLETE/,
    ],
    [
      "directory",
      { protocol: "sourceweft-file-stat-v1", kind: "not_regular" },
      /SANDBOX_FILE_NOT_REGULAR/,
    ],
    [
      "permission denial",
      { protocol: "sourceweft-file-stat-v1", kind: "error", errno: 13 },
      /SANDBOX_FILE_METADATA_FAILED/,
    ],
    [
      "I/O error",
      { protocol: "sourceweft-file-stat-v1", kind: "error", errno: 5 },
      /SANDBOX_FILE_METADATA_FAILED/,
    ],
    [
      "wrong protocol",
      { protocol: "other", kind: "missing", errno: 2 },
      /SANDBOX_FILE_METADATA_INVALID/,
    ],
    [
      "wrong missing errno",
      { protocol: "sourceweft-file-stat-v1", kind: "missing", errno: 13 },
      /SANDBOX_FILE_METADATA_INVALID/,
    ],
    [
      "extra fields",
      { ...missing, success: true },
      /SANDBOX_FILE_METADATA_INVALID/,
    ],
    [
      "negative size",
      { protocol: "sourceweft-file-stat-v1", kind: "regular", size: -1 },
      /SANDBOX_FILE_METADATA_INVALID/,
    ],
    [
      "fractional size",
      { protocol: "sourceweft-file-stat-v1", kind: "regular", size: 0.5 },
      /SANDBOX_FILE_METADATA_INVALID/,
    ],
    ["non-object", [], /SANDBOX_FILE_METADATA_INVALID/],
  ] as const;
  for (const [name, value, expected] of invalid)
    test(`${name} is never missing`, async () => {
      const { provider } = createProvider([
        [/^GET /, () => new Response(new Uint8Array())],
        [/^POST .*\/exec$/, () => metadata(value)],
      ]);
      await assert.rejects(
        provider.downloadFile({
          providerSandboxId: "sb-1",
          sandboxPath: "/workspace/file",
        }),
        expected,
      );
    });
  test("nonzero metadata execution cannot claim missing", async () => {
    const { provider } = createProvider([
      [/^GET /, () => new Response(new Uint8Array())],
      [/^POST .*\/exec$/, () => metadata(missing, 1)],
    ]);
    await assert.rejects(
      provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/file",
      }),
      /SANDBOX_FILE_METADATA_FAILED/,
    );
  });
  test("invalid or truncated metadata output fails closed", async () => {
    for (const output of [
      "not JSON",
      JSON.stringify(missing) + "x".repeat(3000),
    ]) {
      const { provider } = createProvider([
        [/^GET /, () => new Response(new Uint8Array())],
        [
          /^POST .*\/exec$/,
          () =>
            sseResponse([
              { event: "stdout", data: Buffer.from(output).toString("base64") },
              { event: "exit", data: "0" },
            ]),
        ],
      ]);
      await assert.rejects(
        provider.downloadFile({
          providerSandboxId: "sb-1",
          sandboxPath: "/workspace/file",
        }),
        /SANDBOX_FILE_METADATA_(INVALID|FAILED)/,
      );
    }
  });
  test("metadata transport failures retain auth/unavailable classification", async () => {
    for (const [status, code, execCalls] of [
      [403, SANDBOX_PROVIDER_ERROR_CODES.authentication, 1],
      // The stat script is idempotent, but a 500 is not a refusal.
      [500, SANDBOX_PROVIDER_ERROR_CODES.unavailable, 1],
      // A 503 refusal is retried before giving up.
      [503, SANDBOX_PROVIDER_ERROR_CODES.unavailable, 4],
    ] as const) {
      const { clock } = createFakeClock();
      const { provider, requests } = createProvider(
        [
          [/^GET /, () => new Response(new Uint8Array())],
          [
            /^POST .*\/exec$/,
            () => new Response("metadata failed", { status }),
          ],
        ],
        10_000,
        clock,
      );
      await assert.rejects(
        provider.downloadFile({
          providerSandboxId: "sb-1",
          sandboxPath: "/workspace/file",
        }),
        (error: unknown) =>
          error instanceof SandboxProviderError && error.code === code,
      );
      assert.equal(
        requests.filter((request) => request.method === "POST").length,
        execCalls,
      );
    }
  });
  test("metadata retries stay inside the download budget", async () => {
    const { clock, sleeps, now } = createFakeClock();
    const { provider, requests } = createProvider(
      [
        [/^GET /, () => new Response(new Uint8Array())],
        [/^POST .*\/exec$/, () => new Response("busy", { status: 503 })],
      ],
      10_000,
      clock,
    );
    const expected = mapCloudflareProviderError(
      new CloudflareBridgeHttpError(503, "execute", "busy"),
      "execute",
    );

    await assert.rejects(
      provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/file",
        timeoutMs: 7_000,
      }),
      (error: unknown) =>
        error instanceof SandboxProviderError &&
        error.code === SANDBOX_PROVIDER_ERROR_CODES.unavailable &&
        error.message === expected.message,
    );
    // 0 + 1s + 5s attempt fits 7s; 1s + 2s + 5s would not, so no 2nd retry.
    assert.equal(requests.filter((r) => r.method === "POST").length, 2);
    assert.deepEqual(sleeps, [1_000]);
    assert.ok(now() <= 7_000);
  });
  test("quoted metadata paths cannot execute shell substitutions", async () => {
    const { execFileSync } = await import("node:child_process");
    const path = "/workspace/a' ; printf PWNED ; #$(printf INJECTED)\nΩ.txt";
    // The shell line runs for real, so the stamp guard needs a container
    // filesystem that carries the stamp (otherwise it refuses to run).
    const container = createContainerBridge();
    container.boot();
    try {
      const { provider, requests } = createProvider([
        [/^GET /, () => new Response(new Uint8Array())],
        [
          /^POST .*\/exec$/,
          (request) => {
            const { argv } = JSON.parse(String(request.body));
            const output = execFileSync(
              "/bin/sh",
              ["-c", container.rewrite(argv[2])],
              { encoding: "utf8" },
            );
            assert.doesNotMatch(output, /PWNED|INJECTED/);
            assert.deepEqual(JSON.parse(output), missing);
            return sseResponse([
              { event: "stdout", data: Buffer.from(output).toString("base64") },
              { event: "exit", data: "0" },
            ]);
          },
        ],
      ]);
      await assert.rejects(
        provider.downloadFile({ providerSandboxId: "sb-1", sandboxPath: path }),
        (error: unknown) =>
          error instanceof SandboxProviderError &&
          error.code === SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
      );
      assert(requests[0]!.url.includes("%23"));
      assert(requests[0]!.url.includes("%0A"));
    } finally {
      container.cleanup();
    }
  });
  test("cancellation after the empty response prevents a metadata command", async () => {
    const controller = new AbortController();
    const { provider, requests } = createProvider([
      [
        /^GET /,
        () => {
          controller.abort(new DOMException("cancelled", "AbortError"));
          return new Response(new Uint8Array());
        },
      ],
    ]);
    await assert.rejects(
      provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/file",
        signal: controller.signal,
      }),
    );
    assert.equal(requests.length, 1);
  });
  test("cancellation during metadata is forwarded and cannot accept a late empty result", async () => {
    const controller = new AbortController();
    const { provider, requests } = createProvider([
      [/^GET /, () => new Response(new Uint8Array())],
      [
        /^POST .*\/exec$/,
        (request) => {
          controller.abort(new DOMException("cancelled", "AbortError"));
          assert.equal(request.signal?.aborted, true);
          return metadata({
            protocol: "sourceweft-file-stat-v1",
            kind: "regular",
            size: 0,
          });
        },
      ],
    ]);
    await assert.rejects(
      provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/file",
        signal: controller.signal,
      }),
    );
    assert.equal(requests.length, 2);
  });
  test("an exhausted original timeout does not start a metadata command", async () => {
    const originalNow = Date.now;
    let calls = 0;
    const { provider, requests } = createProvider([
      [/^GET /, () => new Response(new Uint8Array())],
    ]);
    Date.now = () => (calls++ === 0 ? 0 : 100);
    try {
      await assert.rejects(
        provider.downloadFile({
          providerSandboxId: "sb-1",
          sandboxPath: "/workspace/file",
          timeoutMs: 50,
        }),
        (error: unknown) =>
          error instanceof SandboxProviderError &&
          error.code === SANDBOX_PROVIDER_ERROR_CODES.timeout,
      );
      assert.equal(requests.length, 1);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("mid-run container replacement (Issue #323 follow-up)", () => {
  const instanceMissing = hasCode(SANDBOX_PROVIDER_ERROR_CODES.instanceMissing);

  test("exports the guard contract", () => {
    assert.equal(EXEC_STAMP_GUARD_EXIT_CODE, 203);
    assert.equal(
      EXEC_STAMP_MISMATCH_MARKER,
      "\u001f[sourceweft-stamp-mismatch]\u001f",
    );
  });

  test('a container the SDK restarts between two successful commands ("assuming stopped") is refused by the next exec, which never runs the command', async () => {
    const container = createContainerBridge();
    container.boot();
    try {
      const { provider, requests } = createProvider([
        [EXEC_ROUTE, container.exec],
        [/^GET .*\/file\/workspace\//, container.file],
      ]);
      const run = (command: string) =>
        provider.execute({
          providerSandboxId: "sb-1",
          command,
          cwd: "/workspace",
          timeoutMs: 5_000,
          maxOutputChars: 1_000,
        });

      const first = await run("echo first > marker.txt && echo ran");
      assert.deepEqual(first, {
        output: "ran\n",
        exitCode: 0,
        truncated: false,
      });
      assert.ok(existsSync(join(container.root, "marker.txt")));

      // The Worker logged "Failed to check container status, assuming
      // stopped" and the SDK started a fresh container behind the same name.
      container.restart();
      await assert.rejects(
        run("echo second > marker.txt && echo ran"),
        (error: unknown) =>
          instanceMissing(error) &&
          /container was replaced and the command did not run/u.test(
            (error as Error).message,
          ),
      );
      // The guard exits before `cd` and the command: nothing ran on the
      // fresh container, and it took no extra round trip (one exec each).
      assert.equal(existsSync(join(container.root, "marker.txt")), false);
      assert.deepEqual(methodsOf(requests), [
        "POST /v1/sandbox/sb-1/exec",
        "POST /v1/sandbox/sb-1/exec",
      ]);
      // The acquisition-time check agrees with the in-exec guard.
      await assert.rejects(
        provider.checkSandboxHealth("sb-1"),
        instanceMissing,
      );
    } finally {
      container.cleanup();
    }
  });

  test("a stamp that names another sandbox is a replaced container too", async () => {
    const container = createContainerBridge();
    container.boot("sb-other");
    try {
      const { provider } = createProvider([[EXEC_ROUTE, container.exec]]);
      await assert.rejects(
        provider.execute({
          providerSandboxId: "sb-1",
          command: "echo ran",
          timeoutMs: 5_000,
          maxOutputChars: 1_000,
        }),
        instanceMissing,
      );
    } finally {
      container.cleanup();
    }
  });

  test("the guard precedes the heartbeat wrapper of a long-budget command", async () => {
    const container = createContainerBridge();
    container.boot();
    container.restart();
    try {
      const { provider } = createProvider([[EXEC_ROUTE, container.exec]]);
      await assert.rejects(
        provider.execute({
          providerSandboxId: "sb-1",
          command: "sleep 30",
          timeoutMs: 130_000,
          maxOutputChars: 1_000,
        }),
        instanceMissing,
      );
      assert.ok(container.ran[0]?.includes(EXEC_HEARTBEAT_MARKER));
      assert.ok(
        container.ran[0]!.indexOf(".sourceweft-sandbox-id") <
          container.ran[0]!.indexOf(EXEC_HEARTBEAT_MARKER),
      );
    } finally {
      container.cleanup();
    }
  });

  test("a command that merely prints the mismatch marker is an ordinary result", async () => {
    const container = createContainerBridge();
    container.boot();
    try {
      const { provider } = createProvider([[EXEC_ROUTE, container.exec]]);
      const result = await provider.execute({
        providerSandboxId: "sb-1",
        command: `printf '%s' '${EXEC_STAMP_MISMATCH_MARKER}forged'; exit ${EXEC_STAMP_GUARD_EXIT_CODE}`,
        timeoutMs: 5_000,
        maxOutputChars: 1_000,
      });
      assert.equal(result.exitCode, EXEC_STAMP_GUARD_EXIT_CODE);
      assert.equal(result.output, `${EXEC_STAMP_MISMATCH_MARKER}forged`);
    } finally {
      container.cleanup();
    }
  });

  test("system commands (ensureDirectory, the empty-download stat) carry the same guard", async () => {
    const container = createContainerBridge();
    container.boot();
    container.restart();
    try {
      const { provider } = createProvider([
        [EXEC_ROUTE, container.exec],
        [/^GET /, () => new Response(new Uint8Array())],
      ]);
      await assert.rejects(
        provider.ensureDirectory({
          providerSandboxId: "sb-1",
          directory: "/workspace/out",
        }),
        instanceMissing,
      );
      assert.equal(existsSync(join(container.root, "out")), false);
      // An HTTP 200 + zero bytes download is confirmed by a stat exec, which
      // the guard turns into the instance verdict instead of "missing file".
      await assert.rejects(
        provider.downloadFile({
          providerSandboxId: "sb-1",
          sandboxPath: "/workspace/output/report.pdf",
        }),
        instanceMissing,
      );
    } finally {
      container.cleanup();
    }
  });

  test("a download miss checks the stamp: a replaced container is the instance missing, not the file", async () => {
    const stampGone = createProvider([
      [
        /^GET .*\/file\/workspace\//,
        () => new Response("nope", { status: 404 }),
      ],
    ]);
    await assert.rejects(
      stampGone.provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/output/report.pdf",
      }),
      instanceMissing,
    );
    assert.deepEqual(methodsOf(stampGone.requests), [
      "GET /v1/sandbox/sb-1/file/workspace/output/report.pdf",
      "GET /v1/sandbox/sb-1/file/workspace/.sourceweft-sandbox-id",
    ]);

    // Stamp intact: the file really is missing, as before.
    const stampOk = createProvider([
      [STAMP_ROUTE, () => new Response("sb-1\n")],
      [/^GET /, () => new Response("nope", { status: 404 })],
    ]);
    await assert.rejects(
      stampOk.provider.downloadFile({
        providerSandboxId: "sb-1",
        sandboxPath: "/workspace/output/report.pdf",
      }),
      hasCode(SANDBOX_PROVIDER_ERROR_CODES.fileMissing),
    );

    // A hit never pays for a stamp read.
    const hit = createProvider([[/^GET /, () => new Response("bytes")]]);
    assert.equal(
      (
        await hit.provider.downloadFile({
          providerSandboxId: "sb-1",
          sandboxPath: "/workspace/output/report.pdf",
        })
      ).toString(),
      "bytes",
    );
    assert.deepEqual(methodsOf(hit.requests), [
      "GET /v1/sandbox/sb-1/file/workspace/output/report.pdf",
    ]);
  });
});
