import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertDaytonaCommandSucceeded,
  DAYTONA_SANDBOX_PATH_POLICY,
  DaytonaSandboxProvider,
  GITHUB_INGESTION_ALLOW_CIDRS,
  isDaytonaImageReference,
  mapDaytonaProviderError,
  normalizeDaytonaDownloadResult,
  resolveDaytonaNetworkPolicyOptions,
  resolveDaytonaSandboxTarget,
} from "../src/daytona-provider";
import type {
  DaytonaSandboxClient,
  DaytonaSandboxInstance,
} from "../src/daytona-provider";

function createMockDaytonaSandboxClient(input?: {
  id?: string;
  executeResult?: unknown;
  uploadFilesResult?: Array<{ path: string; error: string | null }>;
  downloadResult?: unknown;
  downloadFilesResult?: Array<{
    path: string;
    content: Uint8Array | null;
    error: string | null;
  }>;
  closeError?: Error;
}) {
  const calls = {
    create: [] as unknown[],
    fromId: [] as unknown[],
    executeCommand: [] as unknown[],
    uploadFiles: [] as unknown[],
    downloadFiles: [] as unknown[],
    uploadFile: [] as unknown[],
    downloadFile: [] as unknown[],
    close: 0,
  };
  const sandbox: DaytonaSandboxInstance = {
    id: input?.id ?? "sandbox_test",
    uploadFiles: async (...args: unknown[]) => {
      calls.uploadFiles.push(args);
      return (
        input?.uploadFilesResult ?? [
          {
            path: (args[0] as Array<[string, Uint8Array]>)[0]?.[0] ?? "",
            error: null,
          },
        ]
      );
    },
    downloadFiles: async (...args: unknown[]) => {
      calls.downloadFiles.push(args);
      if (input?.downloadFilesResult) {
        return input.downloadFilesResult;
      }
      return [
        {
          path: (args[0] as string[])[0] ?? "",
          content: normalizeDaytonaDownloadResult(
            input?.downloadResult ?? Buffer.from("downloaded", "utf8"),
          ),
          error: null,
        },
      ];
    },
    instance: {
      process: {
        executeCommand: async (...args: unknown[]) => {
          calls.executeCommand.push(args);
          return input?.executeResult ?? { output: "ok", exitCode: 0 };
        },
      },
      fs: {
        uploadFile: async (...args: unknown[]) => {
          calls.uploadFile.push(args);
        },
        downloadFile: async (...args: unknown[]) => {
          calls.downloadFile.push(args);
          return input?.downloadResult ?? Buffer.from("downloaded", "utf8");
        },
      },
    },
    close: async () => {
      calls.close += 1;
      if (input?.closeError) {
        throw input.closeError;
      }
    },
  };
  const client: DaytonaSandboxClient = {
    create: async (options) => {
      calls.create.push(options);
      return sandbox;
    },
    fromId: async (...args) => {
      calls.fromId.push(args);
      return sandbox;
    },
  };
  return { calls, client, sandbox };
}

describe("isDaytonaImageReference", () => {
  test("detects tagged registry image references", () => {
    assert.equal(
      isDaytonaImageReference(
        "ghcr.io/sourceweft/sourceweft-sandbox-base:node20-tools0.1.0-latest",
      ),
      true,
    );
    assert.equal(isDaytonaImageReference("daytonaio/sandbox:0.8.0"), true);
    assert.equal(isDaytonaImageReference("daytonaio/sandbox"), true);
    assert.equal(
      isDaytonaImageReference("ghcr.io/sourceweft/sourceweft-sandbox-base"),
      true,
    );
    assert.equal(isDaytonaImageReference("node:20-bookworm"), true);
    assert.equal(
      isDaytonaImageReference("localhost:5000/sourceweft/runtime:dev"),
      true,
    );
  });

  test("detects digest image references", () => {
    assert.equal(
      isDaytonaImageReference(
        "ghcr.io/sourceweft/sourceweft-sandbox-base@sha256:e902768f08a0dc24cbfb976160dd40107774227ad8f8ddce65efb6f5c8b77b97",
      ),
      true,
    );
  });

  test("leaves plain Daytona snapshot names as snapshots", () => {
    assert.equal(isDaytonaImageReference("sourceweft-sandbox-base"), false);
    assert.equal(isDaytonaImageReference("daytona-small"), false);
    assert.equal(isDaytonaImageReference("sourceweft-runtime-test"), false);
  });
});

describe("normalizeDaytonaDownloadResult", () => {
  test("keeps Buffer results as stable bytes", () => {
    const input = Buffer.from("hello", "utf8");

    assert.deepEqual(normalizeDaytonaDownloadResult(input), input);
  });

  test("normalizes Uint8Array results", () => {
    const input = new Uint8Array([104, 101, 108, 108, 111]);

    assert.deepEqual(
      normalizeDaytonaDownloadResult(input),
      Buffer.from("hello", "utf8"),
    );
  });

  test("normalizes ArrayBuffer results", () => {
    const input = new Uint8Array([104, 101, 108, 108, 111]).buffer;

    assert.deepEqual(
      normalizeDaytonaDownloadResult(input),
      Buffer.from("hello", "utf8"),
    );
  });

  test("normalizes string results as UTF-8", () => {
    assert.deepEqual(
      normalizeDaytonaDownloadResult("hello"),
      Buffer.from("hello", "utf8"),
    );
  });

  test("fails clearly for unsupported result types", () => {
    assert.throws(
      () => normalizeDaytonaDownloadResult({ content: "hello" }),
      /SANDBOX_DOWNLOAD_UNSUPPORTED_RESULT/,
    );
  });
});

describe("resolveDaytonaSandboxTarget", () => {
  test("uses explicit snapshot target", () => {
    assert.deepEqual(
      resolveDaytonaSandboxTarget({
        snapshot: "sourceweft-sandbox-2026-06-09",
      }).target,
      {
        kind: "snapshot",
        value: "sourceweft-sandbox-2026-06-09",
        source: "DAYTONA_SANDBOX_SNAPSHOT",
      },
    );
  });

  test("uses explicit image target", () => {
    assert.deepEqual(
      resolveDaytonaSandboxTarget({
        image: "ghcr.io/sourceweft/sourceweft/sourceweft-sandbox:2026-06-09",
      }).target,
      {
        kind: "image",
        value: "ghcr.io/sourceweft/sourceweft/sourceweft-sandbox:2026-06-09",
        source: "DAYTONA_SANDBOX_IMAGE",
      },
    );
  });

  test("rejects simultaneous explicit image and snapshot", () => {
    const resolved = resolveDaytonaSandboxTarget({
      snapshot: "sourceweft-sandbox",
      image: "ghcr.io/sourceweft/sourceweft-sandbox:latest",
    });

    assert.equal(resolved.configured, false);
    assert.match(resolved.missing.join(", "), /mutually exclusive/u);
  });

  test("requires a snapshot or image target", () => {
    const resolved = resolveDaytonaSandboxTarget({});

    assert.equal(resolved.configured, false);
    assert.deepEqual(resolved.missing, [
      "DAYTONA_SANDBOX_SNAPSHOT or DAYTONA_SANDBOX_IMAGE",
    ]);
  });
});

describe("resolveDaytonaNetworkPolicyOptions", () => {
  test("leaves network options untouched for default/undefined", () => {
    assert.deepEqual(resolveDaytonaNetworkPolicyOptions(undefined), {});
    assert.deepEqual(resolveDaytonaNetworkPolicyOptions("default"), {});
  });

  test("maps block-all to networkBlockAll", () => {
    assert.deepEqual(resolveDaytonaNetworkPolicyOptions("block-all"), {
      networkBlockAll: true,
    });
  });

  test("maps ingestion-github to a CIDR networkAllowList", () => {
    assert.deepEqual(resolveDaytonaNetworkPolicyOptions("ingestion-github"), {
      networkAllowList: GITHUB_INGESTION_ALLOW_CIDRS.join(","),
    });
  });
});

describe("DaytonaSandboxProvider", () => {
  test("exposes Daytona sandbox path policy", () => {
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: createMockDaytonaSandboxClient().client,
    });

    assert.deepEqual(provider.pathPolicy, DAYTONA_SANDBOX_PATH_POLICY);
  });

  test("creates sandboxes with the configured snapshot target", async () => {
    const { calls, client } = createMockDaytonaSandboxClient();
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      apiUrl: "http://daytona.test",
      snapshot: "sourceweft-sandbox-2026-06-09",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    const sandbox = await provider.createSandbox({
      labels: { sourceweft: "true" },
      ttlSeconds: 3600,
    });

    assert.equal(sandbox.id, "sandbox_test");
    assert.deepEqual(calls.create[0], {
      auth: {
        apiKey: "test-key",
        apiUrl: "http://daytona.test",
      },
      language: "typescript",
      labels: { sourceweft: "true" },
      autoDeleteInterval: 60,
      snapshot: "sourceweft-sandbox-2026-06-09",
    });
    assert.equal(
      Object.hasOwn(calls.create[0] as Record<string, unknown>, "image"),
      false,
    );
  });

  test("creates sandboxes with the configured image target", async () => {
    const { calls, client } = createMockDaytonaSandboxClient();
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      image: "ghcr.io/sourceweft/sourceweft/sourceweft-sandbox:2026-06-09",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    await provider.createSandbox({
      labels: { sourceweft: "true" },
      ttlSeconds: 61,
    });

    assert.deepEqual(calls.create[0], {
      auth: {
        apiKey: "test-key",
      },
      language: "typescript",
      labels: { sourceweft: "true" },
      autoDeleteInterval: 2,
      image: "ghcr.io/sourceweft/sourceweft/sourceweft-sandbox:2026-06-09",
    });
    assert.equal(
      Object.hasOwn(calls.create[0] as Record<string, unknown>, "snapshot"),
      false,
    );
  });

  test("translates block-all network policy into SDK create params", async () => {
    const { calls, client } = createMockDaytonaSandboxClient();
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    await provider.createSandbox({
      labels: { sourceweft: "true" },
      ttlSeconds: 3600,
      networkPolicy: "block-all",
    });

    const options = calls.create[0] as Record<string, unknown>;
    assert.equal(options.networkBlockAll, true);
    assert.equal(Object.hasOwn(options, "networkAllowList"), false);
  });

  test("translates ingestion-github network policy into a CIDR allow list", async () => {
    const { calls, client } = createMockDaytonaSandboxClient();
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    await provider.createSandbox({
      labels: { sourceweft: "true" },
      ttlSeconds: 3600,
      networkPolicy: "ingestion-github",
    });

    const options = calls.create[0] as Record<string, unknown>;
    assert.equal(
      options.networkAllowList,
      GITHUB_INGESTION_ALLOW_CIDRS.join(","),
    );
    assert.equal(Object.hasOwn(options, "networkBlockAll"), false);
  });

  test("omits network options when no policy is provided", async () => {
    const { calls, client } = createMockDaytonaSandboxClient();
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    await provider.createSandbox({
      labels: { sourceweft: "true" },
      ttlSeconds: 3600,
    });

    const options = calls.create[0] as Record<string, unknown>;
    assert.equal(Object.hasOwn(options, "networkBlockAll"), false);
    assert.equal(Object.hasOwn(options, "networkAllowList"), false);
  });

  test("connects by ID for execute and preserves raw command, cwd, and timeout", async () => {
    const { calls, client } = createMockDaytonaSandboxClient({
      executeResult: {
        output: "x".repeat(12),
        exitCode: 0,
      },
    });
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    const result = await provider.execute({
      providerSandboxId: "sandbox_123",
      command: "GITHUB_TOKEN=caller-secret touch /work/a.md",
      cwd: "/workspace/ppt-deck",
      timeoutMs: 2500,
      maxOutputChars: 5,
    });

    assert.deepEqual(calls.fromId[0], [
      "sandbox_123",
      {
        auth: { apiKey: "test-key" },
        timeout: 3,
      },
    ]);
    assert.deepEqual(calls.executeCommand[0], [
      "GITHUB_TOKEN=caller-secret touch /work/a.md",
      "/workspace/ppt-deck",
      undefined,
      3,
    ]);
    assert.deepEqual(result, {
      output: "xxxxx\n\n[output truncated]",
      exitCode: 0,
      truncated: true,
    });
  });

  test("does not wrap execute commands or inject credential env", async () => {
    const { calls, client } = createMockDaytonaSandboxClient();
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    await provider.execute({
      providerSandboxId: "sandbox_123",
      command: "npm test",
      cwd: "/workspace",
      timeoutMs: 1000,
      maxOutputChars: 100,
    });

    assert.deepEqual(calls.executeCommand[0], [
      "npm test",
      "/workspace",
      undefined,
      1,
    ]);
  });

  test("returns non-zero execute exit codes as normal command results", async () => {
    const { client } = createMockDaytonaSandboxClient({
      executeResult: {
        artifacts: { stderr: "tests failed" },
        exitCode: 1,
      },
    });
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    assert.deepEqual(
      await provider.execute({
        providerSandboxId: "sandbox_123",
        command: "npm test",
        cwd: "/workspace/ppt-deck",
        timeoutMs: 2500,
        maxOutputChars: 100,
      }),
      {
        output: "tests failed",
        exitCode: 1,
        truncated: false,
      },
    );
  });

  test("connects by ID for upload, download, mkdir, and delete", async () => {
    const { calls, client } = createMockDaytonaSandboxClient({
      downloadResult: "hello",
    });
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    await provider.uploadFile({
      providerSandboxId: "sandbox_123",
      sandboxPath: "/workspace/input/a.txt",
      content: new TextEncoder().encode("hello"),
    });
    assert.deepEqual(calls.uploadFiles[0], [
      [["/workspace/input/a.txt", new TextEncoder().encode("hello")]],
    ]);
    assert.deepEqual(calls.uploadFile, []);

    assert.deepEqual(
      await provider.downloadFile({
        providerSandboxId: "sandbox_123",
        sandboxPath: "/workspace/output/a.txt",
      }),
      Buffer.from("hello", "utf8"),
    );
    assert.deepEqual(calls.downloadFiles[0], [["/workspace/output/a.txt"]]);
    assert.deepEqual(calls.downloadFile, []);

    await provider.ensureDirectory({
      providerSandboxId: "sandbox_123",
      directory: "/workspace/output",
    });
    assert.deepEqual(calls.executeCommand.at(-1), [
      "mkdir -p '/workspace/output'",
    ]);

    await provider.deleteSandbox("sandbox_123");
    assert.equal(calls.close, 1);
  });

  test("confirms execution cancellation by closing the sandbox", async () => {
    const { calls, client } = createMockDaytonaSandboxClient();
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    assert.deepEqual(
      await provider.cancelExecution({
        providerSandboxId: "sandbox_123",
        executionId: "execution-1",
        reason: "timed_out",
      }),
      { confirmed: true, mode: "sandbox" },
    );
    assert.equal(calls.close, 1);
  });

  test("treats an already absent sandbox as confirmed cancellation", async () => {
    const { client } = createMockDaytonaSandboxClient({
      closeError: new Error("sandbox not found"),
    });
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    assert.deepEqual(
      await provider.cancelExecution({
        providerSandboxId: "sandbox_123",
        executionId: "execution-1",
        reason: "timed_out",
      }),
      { confirmed: true, mode: "sandbox" },
    );
  });

  test("maps official upload wrapper file errors", async () => {
    const { client } = createMockDaytonaSandboxClient({
      uploadFilesResult: [
        {
          path: "/skills/demo/index.ts",
          error: "bulk upload failed: permission denied",
        },
      ],
    });
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    await assert.rejects(
      () =>
        provider.uploadFile({
          providerSandboxId: "sandbox_123",
          sandboxPath: "/skills/demo/index.ts",
          content: new TextEncoder().encode("export {};"),
        }),
      /SANDBOX_PROVIDER_ERROR: sandbox provider upload failed: bulk upload failed: permission denied/u,
    );
  });

  test("maps official download wrapper missing file errors", async () => {
    const { client } = createMockDaytonaSandboxClient({
      downloadFilesResult: [
        {
          path: "/workspace/missing.txt",
          content: null,
          error: "file not found",
        },
      ],
    });
    const provider = new DaytonaSandboxProvider({
      apiKey: "test-key",
      snapshot: "sourceweft-sandbox",
      maxOutputChars: 100,
      daytonaSandbox: client,
    });

    await assert.rejects(
      () =>
        provider.downloadFile({
          providerSandboxId: "sandbox_123",
          sandboxPath: "/workspace/missing.txt",
        }),
      /SANDBOX_FILE_NOT_FOUND/u,
    );
  });

  test("rejects incomplete or conflicting target configuration", () => {
    assert.throws(
      () =>
        new DaytonaSandboxProvider({
          apiKey: "test-key",
          maxOutputChars: 100,
          daytonaSandbox: createMockDaytonaSandboxClient().client,
        }),
      /SANDBOX_NOT_CONFIGURED/u,
    );

    assert.throws(
      () =>
        new DaytonaSandboxProvider({
          apiKey: "test-key",
          snapshot: "sourceweft-sandbox",
          image: "ghcr.io/sourceweft/sourceweft-sandbox:latest",
          maxOutputChars: 100,
          daytonaSandbox: createMockDaytonaSandboxClient().client,
        }),
      /mutually exclusive/u,
    );
  });
});

describe("assertDaytonaCommandSucceeded", () => {
  test("passes successful command results", () => {
    assert.equal(
      assertDaytonaCommandSucceeded(
        { exitCode: 0, artifacts: { stdout: "ok" } },
        { code: "SANDBOX_DIRECTORY_CREATE_FAILED", maxOutputChars: 100 },
      ).output,
      "ok",
    );
  });

  test("throws a normalized error for non-zero exit codes", () => {
    assert.throws(
      () =>
        assertDaytonaCommandSucceeded(
          { exitCode: 1, artifacts: { stderr: "permission denied" } },
          { code: "SANDBOX_DIRECTORY_CREATE_FAILED", maxOutputChars: 100 },
        ),
      /SANDBOX_DIRECTORY_CREATE_FAILED/,
    );
  });
});

describe("mapDaytonaProviderError", () => {
  test("classifies 404 by operation and preserves the native cause", () => {
    for (const [operation, expected] of [
      ["download", "SANDBOX_FILE_NOT_FOUND"],
      ["execute", "SANDBOX_PROVIDER_ERROR"],
      ["get", "SANDBOX_NOT_FOUND_OR_EXPIRED"],
    ] as const) {
      const cause = { statusCode: 404 };
      const error = mapDaytonaProviderError(cause, operation);
      assert.equal(error.code, expected);
      assert.equal(error.cause, cause);
      assert.equal(error.phase, operation);
      assert.equal(mapDaytonaProviderError(error, "upload"), error);
    }
    assert.equal(
      mapDaytonaProviderError(
        {
          code: "sandbox_not_found",
          statusCode: 404,
        },
        "download",
      ).code,
      "SANDBOX_NOT_FOUND_OR_EXPIRED",
    );
    assert.equal(
      mapDaytonaProviderError(new Error("file does not exist"), "execute").code,
      "SANDBOX_PROVIDER_ERROR",
    );
  });

  test("maps provider auth failures", () => {
    assert.match(
      mapDaytonaProviderError({ status: 401 }, "create").message,
      /SANDBOX_PROVIDER_AUTH_FAILED/,
    );
    assert.match(
      mapDaytonaProviderError(new Error("invalid api key"), "get").message,
      /SANDBOX_PROVIDER_AUTH_FAILED/,
    );
  });

  test("maps missing or expired sandboxes", () => {
    assert.match(
      mapDaytonaProviderError({ statusCode: 404 }, "get").message,
      /SANDBOX_NOT_FOUND_OR_EXPIRED/,
    );
    assert.match(
      mapDaytonaProviderError(new Error("sandbox not found"), "execute")
        .message,
      /SANDBOX_NOT_FOUND_OR_EXPIRED/,
    );
  });

  test("maps missing downloaded files without exposing provider details", () => {
    assert.match(
      mapDaytonaProviderError(
        new Error("file not found: /tmp/result.txt"),
        "download",
      ).message,
      /SANDBOX_FILE_NOT_FOUND/,
    );
    assert.match(
      mapDaytonaProviderError(new Error("ENOENT: no such file"), "download")
        .message,
      /SANDBOX_FILE_NOT_FOUND/,
    );
  });

  test("maps command timeouts", () => {
    assert.match(
      mapDaytonaProviderError({ status: 504 }, "execute").message,
      /SANDBOX_COMMAND_TIMEOUT/,
    );
    assert.match(
      mapDaytonaProviderError(new Error("process timed out"), "execute")
        .message,
      /SANDBOX_COMMAND_TIMEOUT/,
    );
  });

  test("maps not-started container IP failures to recoverable sandbox health errors", () => {
    assert.match(
      mapDaytonaProviderError(
        new Error(
          "bad request: failed to resolve container IP after 3 attempts: no IP address found. Is the Sandbox started?",
        ),
        "mkdir",
      ).message,
      /SANDBOX_NOT_READY_OR_UNHEALTHY/u,
    );
  });

  test("maps unknown failures to generic provider errors", () => {
    assert.match(
      mapDaytonaProviderError(new Error("connection reset"), "upload").message,
      /SANDBOX_PROVIDER_ERROR/,
    );
  });

  test("redacts secret-like diagnostics and signed URLs in provider errors", () => {
    const error = mapDaytonaProviderError(
      new Error(
        "failed GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 sk-testsecret1234567890 https://s3.example.com/file.pdf?X-Amz-Signature=secret&X-Amz-Credential=key&safe=1",
      ),
      "execute",
    );

    assert.match(error.message, /SANDBOX_PROVIDER_ERROR/u);
    assert.doesNotMatch(error.message, /ghp_abcdefghijklmnopqrstuvwxyz/u);
    assert.doesNotMatch(error.message, /sk-testsecret/u);
    assert.doesNotMatch(error.message, /secret/u);
    assert.doesNotMatch(error.message, /key&safe/u);
    assert.match(error.message, /GITHUB_TOKEN=\[redacted\]/u);
    assert.match(error.message, /X-Amz-Signature=%5Bredacted%5D/u);
    assert.match(error.message, /X-Amz-Credential=%5Bredacted%5D/u);
  });
});
