import {
  SandboxProviderError,
  SANDBOX_PROVIDER_ERROR_CODES,
  isSandboxInstanceMissingError,
} from "@sourceweft/builtin-tool-sandbox";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  EXEC_HEARTBEAT_MARKER,
  CLOUDFLARE_SANDBOX_PATH_POLICY,
  CloudflareBridgeHttpError,
  CloudflareSandboxProvider,
  SOURCEWEFT_SANDBOX_STAMP_PATH,
  extractExitCode,
  extractSseText,
  mapCloudflareProviderError,
  workspaceRelativePath,
} from "../src/cloudflare-provider";
import { createCloudflareSandboxProviderFactory } from "../src/provider-factory";

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
) {
  const bridge = createMockBridge(routes);
  const provider = new CloudflareSandboxProvider({
    bridgeUrl: BRIDGE_URL,
    apiKey: API_KEY,
    maxOutputChars,
    fetchImpl: bridge.fetchImpl,
  });
  return { provider, requests: bridge.requests };
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
  test("creates a sandbox and writes the identity stamp", async () => {
    const { provider, requests } = createProvider([
      [/^POST .*\/v1\/sandbox$/, () => Response.json({ id: "sb-1" })],
      [/^PUT /, () => new Response(null, { status: 200 })],
    ]);

    const sandbox = await provider.createSandbox({
      ttlSeconds: 3600,
      labels: { thread_id: "t-1" },
    });

    assert.equal(sandbox.id, "sb-1");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(
      requests[1]?.url,
      `${BRIDGE_URL}/v1/sandbox/sb-1/file/workspace/${SOURCEWEFT_SANDBOX_STAMP_PATH.slice("/workspace/".length)}`,
    );
    assert.deepEqual(requests[1]?.body, new TextEncoder().encode("sb-1"));
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
    assert.deepEqual(body.argv, ["sh", "-lc", "echo 'hello world'"]);
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
    assert.equal(body.argv[2], "cd '/workspace/in put' && ls");
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
    assert.equal(body.argv[2], "quick-job");
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
    assert.equal(body.argv[2], `mkdir -p '/workspace/out put'\\''s'`);
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
    assert.match(body.argv[2], /^python3 -c /);
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
    for (const [status, code] of [
      [403, SANDBOX_PROVIDER_ERROR_CODES.authentication],
      [500, SANDBOX_PROVIDER_ERROR_CODES.unavailable],
    ] as const) {
      const { provider } = createProvider([
        [/^GET /, () => new Response(new Uint8Array())],
        [/^POST .*\/exec$/, () => new Response("metadata failed", { status })],
      ]);
      await assert.rejects(
        provider.downloadFile({
          providerSandboxId: "sb-1",
          sandboxPath: "/workspace/file",
        }),
        (error: unknown) =>
          error instanceof SandboxProviderError && error.code === code,
      );
    }
  });
  test("quoted metadata paths cannot execute shell substitutions", async () => {
    const { execFileSync } = await import("node:child_process");
    const path = "/workspace/a' ; printf PWNED ; #$(printf INJECTED)\nΩ.txt";
    const { provider, requests } = createProvider([
      [/^GET /, () => new Response(new Uint8Array())],
      [
        /^POST .*\/exec$/,
        (request) => {
          const { argv } = JSON.parse(String(request.body));
          const output = execFileSync("/bin/sh", ["-c", argv[2]], {
            encoding: "utf8",
          });
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
