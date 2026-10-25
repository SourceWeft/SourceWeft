import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deniedReason } from "../src/address-guard.js";
import { buildConfig, perWrapReadRoots, perWrapWriteDenies } from "../src/policy.js";
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

/** The darwin shape of `InitConfig`: ripgrep is the only helper (macOS has no bubblewrap and no
 * seccomp helper), exactly what the Rust host sends on macOS. */
function darwinInit(overrides: Partial<InitConfig> = {}): InitConfig {
  return linuxInit({ platform: "darwin", helpers: { ripgrep: rgPath }, ...overrides });
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
  binShells: Array<string | undefined>;
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
    binShells: [] as Array<string | undefined>,
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
      binShell?: string,
      customConfig?: unknown,
      _abortSignal?: AbortSignal,
      _cwd?: string,
      _options?: { commandId?: string },
    ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
      fake.lastCustomConfig = customConfig;
      fake.binShells.push(binShell);
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

/** The merged config srt should see for any command wrapped under `root` against `init`:
 * everything `buildConfig` itself produces, untouched — except that `allowRead` is exactly
 * `root` plus `init.readRoots` (Ruling R14; never the other init workspace roots) and exactly
 * `root` is added to `allowWrite`. Used by the merge-invariant tests for both `wrap` and `probe`
 * below, so a future change can't silently widen (or narrow) anything beyond those fields. */
function expectedMergedConfig(root: string, init: InitConfig = linuxInit()) {
  const base = buildConfig(init);
  return {
    denyRead: base.filesystem.denyRead,
    denyWrite: base.filesystem.denyWrite,
    allowRead: [root, ...perWrapReadRoots(init)].map((path) => ({ path, literal: true })),
    network: base.network,
    allowWrite: [{ path: root, literal: true }],
  };
}

function assertMergeInvariant(
  customConfig: unknown,
  root: string,
  init: InitConfig = linuxInit(),
): void {
  const config = customConfig as {
    filesystem: {
      denyRead: unknown;
      denyWrite: unknown;
      allowRead: unknown;
      allowWrite: Array<{ path: string; literal: true }>;
    };
    network: unknown;
  };
  const expected = expectedMergedConfig(root, init);
  assert.deepEqual(config.filesystem.denyRead, expected.denyRead);
  assert.deepEqual(config.filesystem.denyWrite, expected.denyWrite);
  assert.deepEqual(config.filesystem.allowRead, expected.allowRead);
  assert.deepEqual(config.network, expected.network);
  assert.deepEqual(config.filesystem.allowWrite, expected.allowWrite);
}

// Ruling R14: with several init workspace roots, a command wrapped in one of them is given
// read access to that root and the read roots only, not to its sibling workspaces.
test("wrap re-allows only its own workspace root and the read roots", async () => {
  const otherRoot = join(tmpRoot, "other-ws");
  mkdirSync(otherRoot, { recursive: true });
  const init = linuxInit({
    workspaceRoots: [workspaceRoot, otherRoot],
    readRoots: [join(tmpRoot, "toolchain")],
    denyRoots: [join(tmpRoot, "home", "app", "local-host")],
  });
  const srt = makeFakeSrt();
  const harness = await initHarness(srt, undefined, init);
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: otherRoot,
    workspaceRoot: otherRoot,
  });
  assert.equal(response.ok, true, `wrap failed: ${JSON.stringify(response)}`);
  assertMergeInvariant(srt.lastCustomConfig, otherRoot, init);
  const allowRead = (srt.lastCustomConfig as { filesystem: { allowRead: Array<{ path: string }> } })
    .filesystem.allowRead.map((entry) => entry.path);
  assert.ok(!allowRead.includes(workspaceRoot), `sibling workspace re-allowed: ${allowRead}`);
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

// Fix round 1 review: pin the whole merge invariant, not just `allowWrite` — `wrap` and
// `probe` must each hand srt a config whose `denyRead`/`allowRead`/`network` are untouched
// from `buildConfig(init)`, with `allowWrite` widened to exactly the one workspace root.
test("wrap's merged config keeps denyRead/denyWrite/network from buildConfig untouched", async () => {
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
  assertMergeInvariant(srt.lastCustomConfig, workspaceRoot);
  await harness.stop();
});

test("probe's merged config keeps denyRead/denyWrite/network from buildConfig untouched", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const response = await harness.send({ op: "probe" });
  assert.equal(response.ok, true, `probe failed: ${JSON.stringify(response)}`);
  assertMergeInvariant(srt.lastCustomConfig, workspaceRoot);
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

// Fix round 1 review: `workspaceRoot` (the only input that widens write access) and `cwd`
// (what srt resolves a relative literal against) must be validated against `init`'s own
// `workspaceRoots`, not handed to srt as-is.
test("wrap with a relative workspaceRoot is POLICY_INVALID", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: workspaceRoot,
    workspaceRoot: "relative/ws",
  });
  expectError(response, "POLICY_INVALID");
  await harness.stop();
});

test("wrap with a workspaceRoot outside every init workspace root is POLICY_INVALID", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const outside = join(tmpRoot, "not-the-workspace");
  mkdirSync(outside, { recursive: true });
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: outside,
    workspaceRoot: outside,
  });
  expectError(response, "POLICY_INVALID");
  await harness.stop();
});

test("wrap with a workspaceRoot that escapes via .. traversal is POLICY_INVALID", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const escaping = `${workspaceRoot}/../escaped`;
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: escaping,
    workspaceRoot: escaping,
  });
  expectError(response, "POLICY_INVALID");
  await harness.stop();
});

test("wrap with a cwd outside workspaceRoot is POLICY_INVALID", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const outsideCwd = join(tmpRoot, "not-the-workspace-either");
  mkdirSync(outsideCwd, { recursive: true });
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: outsideCwd,
    workspaceRoot,
  });
  expectError(response, "POLICY_INVALID");
  await harness.stop();
});

test("wrap with a workspaceRoot nested inside an init workspace root is ok", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const nested = join(workspaceRoot, "nested", "deeper");
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: nested,
    workspaceRoot: nested,
  });
  assert.equal(response.ok, true, `wrap failed: ${JSON.stringify(response)}`);
  const customConfig = srt.lastCustomConfig as {
    filesystem: { allowWrite: Array<{ path: string; literal: true }> };
  };
  assert.deepEqual(customConfig.filesystem.allowWrite, [{ path: nested, literal: true }]);
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
  const harness = await initHarness(srt, () => new Set(["93.184.216.7"]));
  assert.ok(srt.ask);
  const result = await srt.ask({ host: "93.184.216.7", port: 443 });
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
  // Final review M3: the probe's wrap is released even when the probe fails.
  assert.equal(srt.cleanupCalls, 1);
  await harness.stop();
});

test("probe succeeds when the wrapped true exits zero", async () => {
  const srt = makeFakeSrt();
  srt.probeExit = { code: 0, stderr: "" };
  const harness = await initHarness(srt);
  const response = await harness.send({ op: "probe" });
  assert.equal(response.ok, true, `probe failed: ${JSON.stringify(response)}`);
  if (response.ok) assert.equal(response.result, true);
  // Final review M3: exactly one cleanup for the probe's one wrap.
  assert.equal(srt.cleanupCalls, 1);
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

// Fix round 1 review: a crashed/killed parent never sends `shutdown` — it just closes the
// sidecar's stdin, so EOF alone must tear srt down (`startServer`'s `teardown`), exactly as
// an explicit `shutdown` would, or a dead parent orphans a sidecar with its sandbox proxies
// still open.
test("ending input without a shutdown request still calls srt.reset (EOF teardown)", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.equal(srt.resetCalls, 0, "reset must not run before input ends");
  await harness.stop(); // ends `input` (EOF) without ever sending "shutdown"
  assert.equal(srt.resetCalls, 1);
});

test("ending input before init never calls srt.reset (nothing to tear down)", async () => {
  const srt = makeFakeSrt();
  const harness = startHarness(srt);
  await harness.stop();
  assert.equal(srt.resetCalls, 0);
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
  const response = await harness.send({
    id: "unknown-op-request",
    op: "not-a-real-op",
  } as unknown as Request);
  expectError(response, "BAD_REQUEST");
  assert.equal(response.id, "unknown-op-request");
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

// Fix round 2 review: `process.exit(0)` right after `startServer` resolves can race the
// pipe write of the last response line (the `shutdown` ack here) and drop it. This spawns the
// real `main.ts` entry point — real `srt`, real `SandboxManager.initialize`/`reset` — over a
// real stdin/stdout pipe (as the Rust host uses, never a TTY), the one place that race can
// actually happen; a `PassThrough`-driven `startServer` test, unlike this one, can't exercise
// it. `SandboxManager` always sandboxes for the actual host OS, not `InitConfig.platform`, so
// this only exercises a real sandbox session where that host OS has one srt supports — on
// this Mac, that's Seatbelt on darwin; skipped elsewhere rather than failing on an
// environment this test was never meant to assert anything about.
test(
  "main flushes the shutdown ack to stdout before exiting (real srt)",
  { skip: process.platform === "darwin" ? false : `requires real srt sandboxing on darwin; running on ${process.platform}` },
  async () => {
    const mainTmpRoot = mkdtempSync(join(tmpdir(), "srt-sidecar-main-flush-"));
    const mainWorkspaceRoot = join(mainTmpRoot, "ws");
    mkdirSync(mainWorkspaceRoot, { recursive: true });

    const child = spawn(join(packageRoot, "node_modules/.bin/tsx"), ["src/main.ts"], {
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });

    const initRequest = {
      id: "1",
      op: "init",
      config: {
        platform: "darwin",
        home: join(mainTmpRoot, "home"),
        workspaceRoots: [mainWorkspaceRoot],
        readRoots: [],
        // Never actually executed by `init` — only `fs.existsSync`-checked — so any real file
        // stands in for ripgrep here.
        helpers: { ripgrep: process.execPath },
      },
    };
    // Both lines are written back to back, without waiting for the init reply first: the
    // server loop still processes them one at a time, and this maximizes the chance of
    // catching the race (the shorter the gap between the last write and `process.exit(0)`,
    // the more likely an unfixed version is to lose it).
    child.stdin.write(`${JSON.stringify(initRequest)}\n`);
    child.stdin.write(`${JSON.stringify({ id: "2", op: "shutdown" })}\n`);
    child.stdin.end();

    const code = await exited;
    assert.equal(code, 0, `main.ts exited with ${String(code)}; stderr: ${stderr}`);

    const lines = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Response);
    assert.equal(lines.length, 2, `expected exactly 2 response lines, got: ${JSON.stringify(lines)}`);
    assert.equal(lines[0]?.id, "1");
    assert.equal(lines[0]?.ok, true, `init failed: ${JSON.stringify(lines[0])}`);
    assert.equal(lines[1]?.id, "2");
    assert.equal(lines[1]?.ok, true, `shutdown failed: ${JSON.stringify(lines[1])}`);
  },
);

test("darwin wrap and probe pass /bin/bash as srt's binShell; linux leaves srt's default", async () => {
  const darwin = makeFakeSrt();
  const darwinHarness = await initHarness(darwin, undefined, darwinInit());
  assert.equal(
    (await darwinHarness.send({ op: "probe" })).ok,
    true,
  );
  assert.equal(
    (
      await darwinHarness.send({
        op: "wrap",
        commandId: "c".repeat(22),
        command: "echo hi",
        cwd: workspaceRoot,
        workspaceRoot,
      })
    ).ok,
    true,
  );
  assert.deepEqual(darwin.binShells, ["/bin/bash", "/bin/bash"]);
  await darwinHarness.stop();

  const linux = makeFakeSrt();
  const linuxHarness = await initHarness(linux);
  await linuxHarness.send({ op: "probe" });
  await linuxHarness.send({
    op: "wrap",
    commandId: "d".repeat(22),
    command: "echo hi",
    cwd: workspaceRoot,
    workspaceRoot,
  });
  assert.deepEqual(linux.binShells, [undefined, undefined]);
  await linuxHarness.stop();
});

// A granted $HOME is writable, so the credential paths must reach srt as `denyWrite` for every
// wrap — the overlay's empty `denyWrite` must not replace them.
test("darwin wrap keeps the credential denyWrite entries from buildConfig", async () => {
  const srt = makeFakeSrt();
  const init = darwinInit();
  const harness = await initHarness(srt, undefined, init);
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: workspaceRoot,
    workspaceRoot,
  });
  assert.equal(response.ok, true, `wrap failed: ${JSON.stringify(response)}`);
  const denied = (srt.lastCustomConfig as { filesystem: { denyWrite: Array<{ path: string }> } })
    .filesystem.denyWrite.map((entry) => entry.path);
  for (const relative of [".ssh", ".aws", ".gnupg", "Library/Keychains"])
    assert.ok(denied.includes(`${init.home}/${relative}`), `${relative} must be write-denied`);
  assertMergeInvariant(srt.lastCustomConfig, workspaceRoot, init);
  await harness.stop();
});

test("linux wrap and probe add write denies only for credential paths that exist at that moment", async () => {
  const home = mkdtempSync(join(tmpRoot, "linux-home-"));
  mkdirSync(join(home, ".ssh"));
  const init = linuxInit({ home });
  const srt = makeFakeSrt();
  const harness = await initHarness(srt, undefined, init);
  const denyWrite = () =>
    (srt.lastCustomConfig as { filesystem: { denyWrite: Array<{ path: string }> } }).filesystem.denyWrite.map(
      (entry) => entry.path,
    );
  const wrap = async () => {
    const response = await harness.send({
      op: "wrap",
      commandId: "c".repeat(22),
      command: "echo hi",
      cwd: workspaceRoot,
      workspaceRoot,
    });
    assert.equal(response.ok, true, `wrap failed: ${JSON.stringify(response)}`);
  };
  await wrap();
  // The static entry survives; the existing directory is added; absent paths (which srt would
  // otherwise create as placeholders in the real home) are not.
  assert.deepEqual(denyWrite(), ["/tmp/claude", join(home, ".ssh")]);
  // Checked per command: a path that appears later is covered by the next wrap.
  mkdirSync(join(home, ".aws"));
  await wrap();
  assert.deepEqual(denyWrite(), ["/tmp/claude", join(home, ".ssh"), join(home, ".aws")]);
  assert.deepEqual(perWrapWriteDenies(init), [join(home, ".ssh"), join(home, ".aws")]);
  const probe = await harness.send({ op: "probe" });
  assert.equal(probe.ok, true, `probe failed: ${JSON.stringify(probe)}`);
  assert.deepEqual(denyWrite(), ["/tmp/claude", join(home, ".ssh"), join(home, ".aws")]);
  await harness.stop();
});
