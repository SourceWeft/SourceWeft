import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deniedReason } from "../src/address-guard.js";
import type { InitConfig, Request, Response } from "../src/protocol.js";
import { startServer } from "../src/server.js";
import type { SrtLike } from "../src/server.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// A real, existing file to use as the "ripgrep" helper path — `init` checks helper paths with
// `fs.existsSync`, so the happy-path fixtures below need one that is actually there.
const tmpRoot = mkdtempSync(join(tmpdir(), "srt-sidecar-test-"));
const rgPath = join(tmpRoot, "rg");
writeFileSync(rgPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const workspaceRoot = join(tmpRoot, "ws");
mkdirSync(workspaceRoot, { recursive: true });

function linuxInit(overrides: Partial<InitConfig> = {}): InitConfig {
  return {
    platform: "linux",
    home: join(tmpRoot, "home"),
    workspaceRoots: [workspaceRoot],
    readRoots: [],
    helpers: { ripgrep: rgPath },
    ...overrides,
  };
}

/** A fake `SrtLike`, driving the server's error mapping and merged-config logic without any
 * real sandboxing. `wrapWithSandboxArgv("true", ...)` — what `probe` always wraps — returns an
 * argv that, when actually spawned by `probe`'s `runProbe`, exits with `probeExit.code` after
 * writing `probeExit.stderr`, so the probe-failure test exercises a real child process rather
 * than a hand-rolled exit code. */
function makeFakeSrt(): SrtLike & {
  ask?: (
    params: { host: string; port: number | undefined },
  ) => Promise<boolean | { allow: false; reason: string }>;
  lastCustomConfig?: unknown;
  probeExit: { code: number; stderr: string };
  initError?: Error;
  wrapError?: Error;
  cleanupCalls: number;
  resetCalls: number;
} {
  const fake = {
    askCallbackDenyReason: true as const,
    probeExit: { code: 0, stderr: "" },
    cleanupCalls: 0,
    resetCalls: 0,
    ask: undefined as
      | ((
          params: { host: string; port: number | undefined },
        ) => Promise<boolean | { allow: false; reason: string }>)
      | undefined,
    lastCustomConfig: undefined as unknown,
    initError: undefined as Error | undefined,
    wrapError: undefined as Error | undefined,
    async initialize(
      _config: unknown,
      askCallback?: (
        params: { host: string; port: number | undefined },
      ) => Promise<boolean | { allow: false; reason: string }>,
    ): Promise<void> {
      if (fake.initError) throw fake.initError;
      fake.ask = askCallback;
    },
    async wrapWithSandboxArgv(
      command: string,
      _binShell?: string,
      customConfig?: unknown,
      _abortSignal?: AbortSignal,
      _cwd?: string,
      _options?: { commandId?: string },
    ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
      fake.lastCustomConfig = customConfig;
      if (fake.wrapError) throw fake.wrapError;
      if (command === "true") {
        const script = `process.stderr.write(${JSON.stringify(fake.probeExit.stderr)});process.exit(${fake.probeExit.code})`;
        return { argv: [process.execPath, "-e", script], env: { FAKE_ENV: "1" } };
      }
      return { argv: ["/bin/echo", "hi"], env: { FAKE_ENV: "1" } };
    },
    annotateStderrWithSandboxFailures(commandIdOrCommand: string, stderr: string): string {
      return `annotated(${commandIdOrCommand}):${stderr}`;
    },
    cleanupAfterCommand(): void {
      fake.cleanupCalls += 1;
    },
    async reset(): Promise<void> {
      fake.resetCalls += 1;
    },
  };
  return fake;
}

/** `Omit<Request, "id">` would collapse the discriminated union into one intersected shape;
 * this distributes the omission over each union member instead, so `{ op: "init", config }`
 * (no `commandId`) and `{ op: "wrap", commandId, ... }` (no `config`) are both still valid. */
type DistributiveOmit<T, K extends keyof never | string> = T extends unknown ? Omit<T, K> : never;
type RequestInput = DistributiveOmit<Request, "id"> & { id?: string };

type Harness = {
  send: (request: RequestInput) => Promise<Response>;
  stop: () => Promise<void>;
};

let nextId = 0;
function allocateId(): string {
  nextId += 1;
  return `req-${nextId}`;
}

function startHarness(srt: ReturnType<typeof makeFakeSrt>, ownAddresses: () => Set<string> = () => new Set()): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses: Response[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim() !== "") responses.push(JSON.parse(line) as Response);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  const serverPromise = startServer(input, output, { srt, ownAddresses });

  async function send(request: RequestInput): Promise<Response> {
    const id = request.id ?? allocateId();
    const before = responses.length;
    input.write(`${JSON.stringify({ ...request, id })}\n`);
    while (responses.length === before) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return responses[responses.length - 1] as Response;
  }

  async function stop(): Promise<void> {
    input.end();
    await serverPromise;
  }

  return { send, stop };
}

function expectError(response: Response, code: string): asserts response is Response & { ok: false } {
  assert.equal(response.ok, false, `expected an error response, got ${JSON.stringify(response)}`);
  if (!response.ok) {
    assert.equal(response.error.code, code);
  }
}

async function initHarness(
  srt: ReturnType<typeof makeFakeSrt>,
  ownAddresses?: () => Set<string>,
  config: InitConfig = linuxInit(),
): Promise<Harness> {
  const harness = startHarness(srt, ownAddresses);
  const response = await harness.send({ op: "init", config });
  assert.equal(response.ok, true, `init failed: ${JSON.stringify(response)}`);
  return harness;
}

test("wrap before init is NOT_INITIALIZED", async () => {
  const harness = startHarness(makeFakeSrt());
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "true",
    cwd: workspaceRoot,
    workspaceRoot,
  });
  expectError(response, "NOT_INITIALIZED");
  await harness.stop();
});

test("init with a missing helper is HELPER_MISSING and names it", async () => {
  const harness = startHarness(makeFakeSrt());
  const response = await harness.send({
    op: "init",
    config: linuxInit({ helpers: { ripgrep: "/nope/rg" } }),
  });
  expectError(response, "HELPER_MISSING");
  if (!response.ok) assert.match(response.error.message, /\/nope\/rg/);
  await harness.stop();
});

test("init with a missing bwrapPath is HELPER_MISSING and names it", async () => {
  const harness = startHarness(makeFakeSrt());
  const response = await harness.send({
    op: "init",
    config: linuxInit({ bwrapPath: "/nope/bwrap" }),
  });
  expectError(response, "HELPER_MISSING");
  if (!response.ok) assert.match(response.error.message, /\/nope\/bwrap/);
  await harness.stop();
});

test("init with a relative path is POLICY_INVALID", async () => {
  const harness = startHarness(makeFakeSrt());
  const response = await harness.send({
    op: "init",
    config: linuxInit({ home: "relative/home" }),
  });
  expectError(response, "POLICY_INVALID");
  await harness.stop();
});

test("init surfaces an srt.initialize throw as SANDBOX_UNAVAILABLE", async () => {
  const srt = makeFakeSrt();
  srt.initError = new Error("bwrap: setup failed");
  const harness = startHarness(srt);
  const response = await harness.send({ op: "init", config: linuxInit() });
  expectError(response, "SANDBOX_UNAVAILABLE");
  if (!response.ok) assert.match(response.error.message, /bwrap: setup failed/);
  await harness.stop();
});

test("wrap passes the workspace as the only write root", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: workspaceRoot,
    workspaceRoot,
  });
  assert.equal(response.ok, true, `wrap failed: ${JSON.stringify(response)}`);
  const customConfig = srt.lastCustomConfig as {
    filesystem: { allowWrite: Array<{ path: string; literal: true }> };
  };
  assert.deepEqual(customConfig.filesystem.allowWrite, [{ path: workspaceRoot, literal: true }]);
  await harness.stop();
});

test("wrap surfaces an srt.wrapWithSandboxArgv throw as SANDBOX_UNAVAILABLE", async () => {
  const srt = makeFakeSrt();
  srt.wrapError = new Error("proxy failed to start");
  const harness = await initHarness(srt);
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: workspaceRoot,
    workspaceRoot,
  });
  expectError(response, "SANDBOX_UNAVAILABLE");
  if (!response.ok) assert.match(response.error.message, /proxy failed to start/);
  await harness.stop();
});

test("ask callback denies private literals with a reason, and allows public ones", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask, "init must register an ask callback");
  const expectedReason = deniedReason("10.0.0.1", new Set());
  assert.ok(expectedReason !== null);
  assert.deepEqual(await srt.ask({ host: "10.0.0.1", port: 80 }), {
    allow: false,
    reason: `public internet only: ${expectedReason}`,
  });
  assert.equal(await srt.ask({ host: "example.com", port: 443 }), true);
  await harness.stop();
});

test("ask callback denies the sidecar host's own addresses", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt, () => new Set(["203.0.113.7"]));
  assert.ok(srt.ask);
  const result = await srt.ask({ host: "203.0.113.7", port: 443 });
  assert.equal(typeof result, "object");
  if (typeof result === "object") {
    assert.equal(result.allow, false);
    assert.match(result.reason, /own network interfaces/);
  }
  await harness.stop();
});

test("ask callback falls back to a plain false when askCallbackDenyReason is unsupported", async () => {
  const srt = makeFakeSrt();
  (srt as { askCallbackDenyReason?: true }).askCallbackDenyReason = undefined;
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  assert.equal(await srt.ask({ host: "10.0.0.1", port: 80 }), false);
  await harness.stop();
});

test("probe reports SANDBOX_UNAVAILABLE with stderr when the wrapped true fails", async () => {
  const srt = makeFakeSrt();
  srt.probeExit = { code: 1, stderr: "bwrap: loopback: Failed RTM_NEWADDR" };
  const harness = await initHarness(srt);
  const response = await harness.send({ op: "probe" });
  expectError(response, "SANDBOX_UNAVAILABLE");
  if (!response.ok) assert.match(response.error.message, /RTM_NEWADDR/);
  await harness.stop();
});

test("probe succeeds when the wrapped true exits zero", async () => {
  const srt = makeFakeSrt();
  srt.probeExit = { code: 0, stderr: "" };
  const harness = await initHarness(srt);
  const response = await harness.send({ op: "probe" });
  assert.equal(response.ok, true, `probe failed: ${JSON.stringify(response)}`);
  if (response.ok) assert.equal(response.result, true);
  await harness.stop();
});

test("probe before init is NOT_INITIALIZED", async () => {
  const harness = startHarness(makeFakeSrt());
  const response = await harness.send({ op: "probe" });
  expectError(response, "NOT_INITIALIZED");
  await harness.stop();
});

test("violations op returns the annotated stderr from srt", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const response = await harness.send({
    op: "violations",
    commandId: "c".repeat(22),
    stderr: "permission denied",
  });
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.equal(response.result, `annotated(${"c".repeat(22)}):permission denied`);
  }
  await harness.stop();
});

test("cleanup op calls srt.cleanupAfterCommand", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const response = await harness.send({ op: "cleanup", commandId: "c".repeat(22) });
  assert.equal(response.ok, true);
  assert.equal(srt.cleanupCalls, 1);
  await harness.stop();
});

test("shutdown calls srt.reset and ends the server", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const response = await harness.send({ op: "shutdown" });
  assert.equal(response.ok, true);
  assert.equal(srt.resetCalls, 1);
  await harness.stop();
});

test("a malformed JSON line is BAD_REQUEST with id \"?\"", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses: Response[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim() !== "") responses.push(JSON.parse(line) as Response);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  const serverPromise = startServer(input, output, { srt: makeFakeSrt(), ownAddresses: () => new Set() });
  input.write("{ not json\n");
  while (responses.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expectError(responses[0] as Response, "BAD_REQUEST");
  assert.equal((responses[0] as Response).id, "?");
  input.end();
  await serverPromise;
});

test("an unknown op is BAD_REQUEST and echoes the request id", async () => {
  const harness = startHarness(makeFakeSrt());
  const response = await harness.send({ op: "not-a-real-op" } as unknown as Request);
  expectError(response, "BAD_REQUEST");
  await harness.stop();
});

test("main strips proxy variables", () => {
  const result = spawnSync(join(packageRoot, "node_modules/.bin/tsx"), ["src/main.ts", "--print-env"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      HTTP_PROXY: "http://proxy.example:8080",
      https_proxy: "http://proxy.example:8080",
      ALL_PROXY: "socks5://proxy.example:1080",
      No_Proxy: "localhost",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const remaining = JSON.parse(result.stdout.trim()) as string[];
  assert.deepEqual(remaining, []);
});
