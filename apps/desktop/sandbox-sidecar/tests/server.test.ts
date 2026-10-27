import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SentinelRegistry } from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-sentinel.js";
import { matchesDomainPattern } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { deniedReason } from "../src/address-guard.js";
import { ensureCa } from "../src/tls.js";
import { buildConfig, perWrapReadRoots } from "../src/policy.js";
import { SANDBOX_PROTOCOL_VERSION } from "../src/protocol.js";
import type {
  AuditEntry,
  InitConfig,
  Request,
  Response,
  SidecarEvent,
  WrapNetwork,
  WrapSecret,
} from "../src/protocol.js";
import { startServer } from "../src/server.js";
import type { ServerDeps, SrtLike } from "../src/server.js";

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
  /** The config `initialize` last received. */
  initConfig?: { network: Record<string, unknown>; credentials?: unknown; filesystem: { denyRead: unknown } };
  wrapCalls: number;
  /** srt's real sentinel registry, so substitution can be exercised end to end. */
  registry: SentinelRegistry;
  probeExit: { code: number; stderr: string };
  initError?: Error;
  wrapError?: Error;
  cleanupCalls: number;
  resetCalls: number;
} {
  const fake = {
    askCallbackDenyReason: true as const,
    probeExit: { code: 0, stderr: "" },
    wrapCalls: 0,
    registry: new SentinelRegistry(),
    initConfig: undefined as ReturnType<typeof makeFakeSrt>["initConfig"],
    getSentinelRegistry: () => fake.registry,
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
      config: unknown,
      askCallback?: (
        params: { host: string; port: number | undefined },
      ) => Promise<boolean | { allow: false; reason: string }>,
    ): Promise<void> {
      if (fake.initError) throw fake.initError;
      fake.initConfig = config as typeof fake.initConfig;
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
      fake.wrapCalls += 1;
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
  /** Unsolicited `event` lines the sidecar has written so far, oldest first. */
  events: SidecarEvent[];
  /** Every line the sidecar wrote, verbatim. */
  raw: string[];
  /** Writes one line as-is (not necessarily valid JSON) and waits for the reply to it. */
  sendRaw: (line: string) => Promise<Response>;
  /** Resolves with the next `ask` event beyond the `seen` that were already consumed. */
  nextAsk: () => Promise<SidecarEvent>;
  stop: () => Promise<void>;
};

let nextId = 0;
function allocateId(): string {
  nextId += 1;
  return `req-${nextId}`;
}

function startHarness(
  srt: ReturnType<typeof makeFakeSrt>,
  ownAddresses: () => Set<string> = () => new Set(),
  extra: Partial<ServerDeps> = {},
): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses: Response[] = [];
  const events: SidecarEvent[] = [];
  const raw: string[] = [];
  let consumedEvents = 0;
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim() !== "") {
        raw.push(line);
        const parsed = JSON.parse(line) as Response | SidecarEvent;
        if ("event" in parsed) events.push(parsed);
        else responses.push(parsed);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  const serverPromise = startServer(input, output, { srt, ownAddresses, ...extra });

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

  async function nextAsk(): Promise<SidecarEvent> {
    const deadline = Date.now() + 5_000;
    while (events.length <= consumedEvents) {
      assert.ok(Date.now() < deadline, "no ask event arrived within 5s");
      await new Promise((resolve) => setImmediate(resolve));
    }
    const event = events[consumedEvents] as SidecarEvent;
    consumedEvents += 1;
    return event;
  }

  async function sendRaw(line: string): Promise<Response> {
    const before = responses.length;
    input.write(`${line}\n`);
    while (responses.length === before) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return responses[responses.length - 1] as Response;
  }

  return { send, raw, sendRaw, events, nextAsk, stop };
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
  extra: Partial<ServerDeps> = {},
): Promise<Harness> {
  const harness = startHarness(srt, ownAddresses, extra);
  const response = await harness.send({ op: "init", config });
  assert.equal(response.ok, true, `init failed: ${JSON.stringify(response)}`);
  return harness;
}

test("init replies with the bundle's protocol version", async () => {
  const harness = startHarness(makeFakeSrt());
  const response = await harness.send({ op: "init", config: linuxInit() });
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.deepEqual(response.result, { protocolVersion: SANDBOX_PROTOCOL_VERSION });
    assert.deepEqual(response.result, { protocolVersion: 3 });
  }
  // Pinned: bumping the constant is deliberate, and the Rust host's copy must move with it.
  assert.equal(SANDBOX_PROTOCOL_VERSION, 3);
  await harness.stop();
});

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
  // The server adds exactly one thing to `buildConfig`'s network section: the audit request hook.
  const { filterRequest, ...network } = config.network as { filterRequest?: unknown };
  assert.equal(typeof filterRequest, "function", "the plain-HTTP audit hook must be installed");
  assert.deepEqual(network, expected.network);
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

/** Wraps `commandId` (default: a fixed one) with `network`, asserting the wrap succeeded. */
async function wrapCommand(
  harness: Harness,
  network?: WrapNetwork,
  commandId = "c".repeat(22),
): Promise<void> {
  const response = await harness.send({
    op: "wrap",
    commandId,
    command: "echo hi",
    cwd: workspaceRoot,
    workspaceRoot,
    ...(network === undefined ? {} : { network }),
  });
  assert.equal(response.ok, true, `wrap failed: ${JSON.stringify(response)}`);
}

async function auditOf(harness: Harness, commandId = "c".repeat(22)): Promise<AuditEntry[]> {
  const response = await harness.send({ op: "audit", commandId });
  assert.equal(response.ok, true, `audit failed: ${JSON.stringify(response)}`);
  return (response as { ok: true; result: { entries: AuditEntry[] } }).result.entries;
}

test("ask callback denies private literals with a reason, and allows public ones", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask, "init must register an ask callback");
  await wrapCommand(harness); // no `network`: open
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
  await wrapCommand(harness);
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
  await wrapCommand(harness, { mode: "strict", allow: ["example.com"] });
  // Both the guard's denial and the policy's own come back as a bare `false` on such an srt...
  assert.equal(await srt.ask({ host: "10.0.0.1", port: 80 }), false);
  assert.equal(await srt.ask({ host: "unlisted.example", port: 443 }), false);
  // ...and an allow is still `true`.
  assert.equal(await srt.ask({ host: "example.com", port: 443 }), true);
  await harness.stop();
});

test("with no wrapped command every connection is denied (fail closed)", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  assert.deepEqual(await srt.ask({ host: "example.com", port: 443 }), {
    allow: false,
    reason: "no single active command",
  });
  await harness.stop();
});

test("two wrapped commands at once deny every connection; cleanup of one restores the other", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, undefined, "a".repeat(22));
  await wrapCommand(harness, undefined, "b".repeat(22));
  assert.deepEqual(await srt.ask({ host: "example.com", port: 443 }), {
    allow: false,
    reason: "no single active command",
  });
  await harness.send({ op: "cleanup", commandId: "b".repeat(22) });
  assert.equal(await srt.ask({ host: "example.com", port: 443 }), true);
  await harness.stop();
});

test("the probe wrap is not counted: a wrap after or around a probe is still the single active command", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  assert.equal((await harness.send({ op: "probe" })).ok, true);
  await wrapCommand(harness, { mode: "strict", allow: ["example.com"] });
  assert.equal((await harness.send({ op: "probe" })).ok, true);
  // If the probe had registered itself there would now be two active commands and this would deny.
  assert.equal(await srt.ask({ host: "example.com", port: 443 }), true);
  assert.equal((await auditOf(harness)).length, 1, "attributed to the real command");
  await harness.send({ op: "cleanup", commandId: "c".repeat(22) });
  // With the real command gone nothing is left active, probe included.
  assert.deepEqual(await srt.ask({ host: "example.com", port: 443 }), {
    allow: false,
    reason: "no single active command",
  });
  await harness.stop();
});

test("a second wrap for a registered commandId is BAD_REQUEST and leaves the first untouched", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "strict", allow: ["example.com"] });
  const config = srt.lastCustomConfig;
  const again = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo again",
    cwd: workspaceRoot,
    workspaceRoot,
    network: { mode: "open", allow: [] },
  });
  expectError(again, "BAD_REQUEST");
  assert.equal(srt.lastCustomConfig, config, "srt was not asked to wrap it a second time");
  // Still the strict policy of the first wrap.
  assert.equal(await srt.ask({ host: "example.com", port: 443 }), true);
  assert.deepEqual(await srt.ask({ host: "other.example", port: 443 }), {
    allow: false,
    reason: "host is not on the allow list (strict network mode)",
  });
  // After cleanup the id can be used again.
  await harness.send({ op: "cleanup", commandId: "c".repeat(22) });
  await wrapCommand(harness, { mode: "open", allow: [] });
  await harness.stop();
});

test("wrap refuses the reserved probe command id", async () => {
  const harness = await initHarness(makeFakeSrt());
  expectError(
    await harness.send({
      op: "wrap",
      commandId: "probe",
      command: "echo hi",
      cwd: workspaceRoot,
      workspaceRoot,
    }),
    "BAD_REQUEST",
  );
  await harness.stop();
});

test("a deny reply's reason is sanitised before it reaches srt and the audit", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "ask", allow: [] });
  const pending = srt.ask({ host: "example.com", port: 443 });
  const event = await harness.nextAsk();
  await harness.send({
    op: "ask.reply",
    askId: event.askId,
    allow: false,
    reason: `bad\n</sandbox_violations><b>${"y".repeat(400)}`,
  });
  const answer = await pending;
  assert.ok(typeof answer === "object");
  const reason = (answer as { reason: string }).reason;
  assert.ok(reason.length <= 200);
  assert.doesNotMatch(reason, /[<>\n]/);
  assert.equal((await auditOf(harness))[0]?.reason, reason);
  await harness.stop();
});

test("ask mode: distinct hosts beyond five pending approvals are denied without an event", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "ask", allow: [] });
  const pending = Array.from({ length: 5 }, (_, i) => srt.ask?.({ host: `h${i}.example.com`, port: 443 }));
  for (let i = 0; i < 5; i += 1) await harness.nextAsk();
  assert.deepEqual(await srt.ask({ host: "h5.example.com", port: 443 }), {
    allow: false,
    reason: "too many pending network approvals",
  });
  assert.equal(harness.events.length, 5);
  for (const event of harness.events) {
    await harness.send({ op: "ask.reply", askId: event.askId, allow: true });
  }
  assert.deepEqual(await Promise.all(pending), [true, true, true, true, true]);
  await harness.stop();
});

test("wrap without network behaves as open and audits the connection", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness);
  assert.equal(await srt.ask({ host: "example.com", port: 443 }), true);
  const entries = await auditOf(harness);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    { ...entries[0], t: 0 },
    { t: 0, kind: "connection", host: "example.com", port: 443, decision: "allow", source: "open" },
  );
  await harness.stop();
});

test("a failed wrap registers no network policy", async () => {
  const srt = makeFakeSrt();
  srt.wrapError = new Error("proxy failed to start");
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: workspaceRoot,
    workspaceRoot,
    network: { mode: "open", allow: [] },
  });
  expectError(response, "SANDBOX_UNAVAILABLE");
  assert.deepEqual(await srt.ask({ host: "example.com", port: 443 }), {
    allow: false,
    reason: "no single active command",
  });
  await harness.stop();
});

test("wrap validates its network policy", async () => {
  const bad: unknown[] = [
    "open",
    null,
    [],
    {},
    { mode: "paranoid", allow: [] },
    { mode: "ask" },
    { mode: "ask", allow: "example.com" },
    { mode: "ask", allow: [42] },
    { mode: "ask", allow: Array.from({ length: 501 }, (_, i) => `h${i}.example.com`) },
    { mode: "ask", allow: ["a".repeat(256)] },
    { mode: "ask", allow: [], suggested: ["x"] },
    { mode: "ask", allow: [], suggested: { "example.com": 7 } },
    { mode: "ask", allow: [], suggested: { ["a".repeat(256)]: "skill" } },
  ];
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  for (const network of bad) {
    const response = await harness.send({
      op: "wrap",
      commandId: "c".repeat(22),
      command: "echo hi",
      cwd: workspaceRoot,
      workspaceRoot,
      network,
    } as unknown as Request);
    expectError(response, "BAD_REQUEST");
  }
  // 500 domains of 255 characters is the largest policy accepted.
  await wrapCommand(harness, {
    mode: "ask",
    allow: Array.from({ length: 500 }, (_, i) => `${"a".repeat(240)}${String(i).padStart(3, "0")}.com`),
    suggested: { "example.com": "skill" },
  });
  await harness.stop();
});

test("the address guard still denies a private host named by an allow rule, in every mode", async () => {
  for (const mode of ["open", "ask", "strict"] as const) {
    const srt = makeFakeSrt();
    const harness = await initHarness(srt);
    assert.ok(srt.ask);
    await wrapCommand(harness, { mode, allow: ["10.0.0.1", "10.0.0.1:80", "app.localhost"] });
    const reason = deniedReason("10.0.0.1", new Set());
    assert.ok(reason !== null);
    assert.deepEqual(
      await srt.ask({ host: "10.0.0.1", port: 80 }),
      { allow: false, reason: `public internet only: ${reason}` },
      mode,
    );
    assert.equal(harness.events.length, 0, `${mode}: the guard must not raise an approval`);
    await harness.stop();
  }
});

test("ask mode: concurrent connections raise one ask event; the reply resolves them all", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "ask", allow: [], suggested: { "pypi.org": "py-skill" } });
  const first = srt.ask({ host: "pypi.org", port: 443 });
  const second = srt.ask({ host: "PyPI.org.", port: 443 });
  const event = await harness.nextAsk();
  assert.deepEqual(Object.keys(event).sort(), ["askId", "commandId", "event", "host", "port", "suggestedBy"]);
  assert.equal(event.event, "ask");
  assert.equal(event.commandId, "c".repeat(22));
  assert.equal(event.host, "pypi.org");
  assert.equal(event.port, 443);
  assert.equal(event.suggestedBy, "py-skill");
  assert.ok(event.askId.length >= 16);
  assert.ok(!("id" in event), "an event line has no response id");

  const reply = await harness.send({ op: "ask.reply", askId: event.askId, allow: true });
  assert.deepEqual(reply, { id: reply.id, ok: true, result: null });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(harness.events.length, 1, "the second connection shared the first ask");

  // Approved for the command: no further ask.
  assert.equal(await srt.ask({ host: "pypi.org", port: 443 }), true);
  assert.equal(harness.events.length, 1);
  const entries = await auditOf(harness);
  assert.deepEqual(entries.map((e) => [e.decision, e.source]), [["allow", "approval"]]);
  await harness.stop();
});

test("ask mode: an ask without a suggestion has no suggestedBy; a deny reply carries its reason", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "ask", allow: ["allowed.example"] });
  assert.equal(await srt.ask({ host: "allowed.example", port: 443 }), true);
  assert.equal(harness.events.length, 0, "an allow-list host is never asked about");
  const pending = srt.ask({ host: "other.example", port: 443 });
  const event = await harness.nextAsk();
  assert.ok(!("suggestedBy" in event));
  await harness.send({ op: "ask.reply", askId: event.askId, allow: false, reason: "denied by user" });
  assert.deepEqual(await pending, { allow: false, reason: "denied by user" });
  // Any other reason is the system's, not the user's.
  const second = srt.ask({ host: "third.example", port: 443 });
  const secondEvent = await harness.nextAsk();
  await harness.send({ op: "ask.reply", askId: secondEvent.askId, allow: false, reason: "device is offline" });
  assert.deepEqual(await second, { allow: false, reason: "device is offline" });
  assert.deepEqual(
    (await auditOf(harness)).map((e) => [e.host, e.decision, e.source, e.reason]),
    [
      ["allowed.example", "allow", "rule", undefined],
      ["other.example", "deny", "user", "denied by user"],
      ["third.example", "deny", "unavailable", "device is offline"],
    ],
  );
  await harness.stop();
});

test("strict mode never raises an ask", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "strict", allow: [] });
  assert.deepEqual(await srt.ask({ host: "example.com", port: 443 }), {
    allow: false,
    reason: "host is not on the allow list (strict network mode)",
  });
  assert.equal(harness.events.length, 0);
  await harness.stop();
});

test("ask.reply with an unknown or already answered askId is BAD_REQUEST", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  expectError(await harness.send({ op: "ask.reply", askId: "nope", allow: true }), "BAD_REQUEST");
  await wrapCommand(harness, { mode: "ask", allow: [] });
  const pending = srt.ask({ host: "example.com", port: 443 });
  const event = await harness.nextAsk();
  assert.equal((await harness.send({ op: "ask.reply", askId: event.askId, allow: true })).ok, true);
  await pending;
  expectError(await harness.send({ op: "ask.reply", askId: event.askId, allow: false }), "BAD_REQUEST");
  await harness.stop();
});

test("ask.reply validates its fields", async () => {
  const harness = await initHarness(makeFakeSrt());
  for (const bad of [
    { op: "ask.reply", allow: true },
    { op: "ask.reply", askId: "x" },
    { op: "ask.reply", askId: "x", allow: "yes" },
    { op: "ask.reply", askId: "x", allow: true, reason: 3 },
  ]) {
    expectError(await harness.send(bad as unknown as Request), "BAD_REQUEST");
  }
  await harness.stop();
});

test("an unanswered ask is denied after the injected timeout, and a late reply is BAD_REQUEST", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt, undefined, linuxInit(), { askTimeoutMs: 25 });
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "ask", allow: [] });
  const pending = srt.ask({ host: "example.com", port: 443 });
  const event = await harness.nextAsk();
  assert.deepEqual(await pending, { allow: false, reason: "approval timed out" });
  expectError(await harness.send({ op: "ask.reply", askId: event.askId, allow: true }), "BAD_REQUEST");
  assert.deepEqual(
    (await auditOf(harness)).map((e) => [e.decision, e.source]),
    [["deny", "timeout"]],
  );
  await harness.stop();
});

test("audit drains, requires init, and cleanup drops the command's policy and pending asks", async () => {
  const early = startHarness(makeFakeSrt());
  expectError(await early.send({ op: "audit", commandId: "x" }), "NOT_INITIALIZED");
  await early.stop();

  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "ask", allow: [] });
  assert.equal((await auditOf(harness)).length, 0);
  const pending = srt.ask({ host: "example.com", port: 443 });
  await harness.nextAsk();
  await harness.send({ op: "cleanup", commandId: "c".repeat(22) });
  assert.deepEqual(await pending, { allow: false, reason: "command finished" });
  assert.deepEqual(await auditOf(harness), []);
  assert.deepEqual(await srt.ask({ host: "example.com", port: 443 }), {
    allow: false,
    reason: "no single active command",
  });
  await harness.stop();
});

test("the installed request hook allows everything and audits plain HTTP without a query", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "ask", allow: ["example.com"] });
  assert.equal(await srt.ask({ host: "example.com", port: 80 }), true);
  const hook = (srt.lastCustomConfig as {
    network: { filterRequest: (request: globalThis.Request, info?: unknown) => Promise<{ action: string; onResponse?: (status: number, headers: object) => void }> };
  }).network.filterRequest;
  const decision = await hook(new globalThis.Request("http://example.com/a/b?secret=1"), {
    scheme: "http",
    target: { host: "example.com", port: 80 },
    requestTarget: "/a/b?secret=1",
  });
  assert.equal(decision.action, "allow");
  decision.onResponse?.(200, {});
  const entries = await auditOf(harness);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    { ...entries[1], t: 0 },
    {
      t: 0,
      kind: "http",
      host: "example.com",
      port: 80,
      decision: "allow",
      source: "rule",
      method: "GET",
      path: "/a/b",
      status: 200,
    },
  );
  assert.ok(!JSON.stringify(entries).includes("secret"));
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
// this Mac, that's `sandbox-exec` on darwin; skipped elsewhere rather than failing on an
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


// ---- Secrets, TLS termination and write approvals (Plan 5) ------------------------------------

const REAL = "ghp_REAL-secret-value-0123456789";

/** One CA generated once (RSA key generation is slow); each test gets its own copy of the files. */
let templateCaDir: Promise<string> | undefined;
async function freshCaDir(): Promise<string> {
  templateCaDir ??= (async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "srt-sidecar-template-ca-")), "ca");
    await ensureCa(dir);
    return dir;
  })();
  const target = join(mkdtempSync(join(tmpdir(), "srt-sidecar-test-ca-")), "ca");
  cpSync(await templateCaDir, target, { recursive: true });
  return target;
}

async function initWithTls(
  srt: ReturnType<typeof makeFakeSrt>,
  extra: Partial<ServerDeps> = {},
): Promise<{ harness: Harness; caDir: string }> {
  const caDir = await freshCaDir();
  const harness = await initHarness(srt, undefined, linuxInit({ tls: { caDir } }), extra);
  return { harness, caDir };
}

const tokenSecret = (overrides: Partial<WrapSecret> = {}): WrapSecret => ({
  envVar: "GITHUB_TOKEN",
  value: REAL,
  hosts: ["api.github.com"],
  readOnly: false,
  ...overrides,
});

async function wrapWithSecrets(
  harness: Harness,
  secrets: WrapSecret[],
  network?: WrapNetwork,
  commandId = "c".repeat(22),
): Promise<Response> {
  return harness.send({
    op: "wrap",
    commandId,
    command: "echo hi",
    cwd: workspaceRoot,
    workspaceRoot,
    secrets,
    ...(network === undefined ? {} : { network }),
  });
}

test("without init.tls the sidecar is dormant: no TLS termination, no credentials, empty secretEnv", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  assert.equal(srt.initConfig?.network.tlsTerminate, undefined);
  assert.equal(srt.initConfig?.credentials, undefined);
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: workspaceRoot,
    workspaceRoot,
  });
  assert.equal(response.ok, true);
  if (response.ok) assert.deepEqual((response.result as { secretEnv: unknown }).secretEnv, {});
  await harness.stop();
});

test("init.tls creates the CA and enables TLS termination with an empty credentials block", async () => {
  const srt = makeFakeSrt();
  const { harness, caDir } = await initWithTls(srt);
  assert.deepEqual(srt.initConfig?.network.tlsTerminate, {
    caCertPath: join(caDir, "ca.crt"),
    caKeyPath: join(caDir, "ca.key"),
  });
  assert.deepEqual(srt.initConfig?.credentials, {});
  assert.deepEqual(srt.initConfig?.network.allowedDomains, [], "the policy still lives in the ask callback");
  const denied = (srt.initConfig?.filesystem.denyRead as Array<{ path: string }>).map((entry) => entry.path);
  assert.ok(denied.includes(join(caDir, "ca.key")));
  assert.equal(statSync(join(caDir, "ca.key")).mode & 0o777, 0o600);
  assert.equal(typeof srt.initConfig?.network.filterRequest, "function");
  await harness.stop();
});

test("init.tls must be an object with an absolute caDir", async () => {
  for (const tls of [{ caDir: "relative/ca" }, { caDir: 7 }, {}, "yes"]) {
    const harness = startHarness(makeFakeSrt());
    const response = await harness.send({
      op: "init",
      config: linuxInit({ tls: tls as unknown as { caDir: string } }),
    });
    assert.equal(response.ok, false, JSON.stringify(tls));
    if (!response.ok) assert.ok(["POLICY_INVALID", "BAD_REQUEST"].includes(response.error.code));
    await harness.stop();
  }
});

test("init.tls surfaces an srt that cannot terminate TLS as SANDBOX_UNAVAILABLE", async () => {
  const srt = makeFakeSrt();
  srt.initError = new Error("tlsTerminate needs Node, or Bun 1.4 or later (this is Bun 1.2.14)");
  const harness = startHarness(srt);
  const response = await harness.send({
    op: "init",
    config: linuxInit({ tls: { caDir: await freshCaDir() } }),
  });
  expectError(response, "SANDBOX_UNAVAILABLE");
  if (!response.ok) assert.match(response.error.message, /tlsTerminate/);
  await harness.stop();
});

test("wrap with secrets but no init.tls is refused (POLICY_INVALID), before srt wraps anything", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt);
  const response = await wrapWithSecrets(harness, [tokenSecret()]);
  expectError(response, "POLICY_INVALID");
  assert.equal(srt.wrapCalls, 0);
  assert.equal(srt.registry.size, 0);
  assert.ok(!JSON.stringify(response).includes(REAL));
  await harness.stop();
});

test("wrap with secrets returns placeholders in secretEnv and registers the real value only in srt's registry", async () => {
  const srt = makeFakeSrt();
  const { harness } = await initWithTls(srt);
  const response = await wrapWithSecrets(harness, [
    tokenSecret(),
    tokenSecret({ envVar: "NPM_TOKEN", value: "npm-REAL-xyz", hosts: ["registry.npmjs.org"] }),
  ]);
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) return;
  const result = response.result as { argv: string[]; env: Record<string, string>; secretEnv: Record<string, string> };
  assert.deepEqual(Object.keys(result.secretEnv).sort(), ["GITHUB_TOKEN", "NPM_TOKEN"]);
  for (const sentinel of Object.values(result.secretEnv)) assert.match(sentinel, /^fake_value_/);
  assert.ok(!JSON.stringify(result).includes(REAL));
  assert.ok(!JSON.stringify(result).includes("npm-REAL-xyz"));
  // The placeholder, sent to its own host, is swapped for the real value; to any other it is not.
  const headers = (host: string): string => {
    const h: Record<string, string> = { authorization: `Bearer ${result.secretEnv.GITHUB_TOKEN}` };
    srt.registry.substituteInHeaders(h, host, matchesDomainPattern);
    return h.authorization as string;
  };
  assert.equal(headers("api.github.com"), `Bearer ${REAL}`);
  assert.notEqual(headers("evil.example.com"), `Bearer ${REAL}`);
  await harness.stop();
});

test("cleanup drops the command's secrets from srt's registry", async () => {
  const srt = makeFakeSrt();
  const { harness } = await initWithTls(srt);
  await wrapWithSecrets(harness, [tokenSecret()]);
  assert.equal(srt.registry.size, 1);
  await harness.send({ op: "cleanup", commandId: "c".repeat(22) });
  assert.equal(srt.registry.size, 0);
  await harness.stop();
});

test("a wrap that srt fails leaves no secret registered", async () => {
  const srt = makeFakeSrt();
  srt.wrapError = new Error("proxy failed to start");
  const { harness } = await initWithTls(srt);
  expectError(await wrapWithSecrets(harness, [tokenSecret()]), "SANDBOX_UNAVAILABLE");
  assert.equal(srt.registry.size, 0);
  await harness.stop();
});

test("invalid secrets are BAD_REQUEST and never echo a value", async () => {
  const srt = makeFakeSrt();
  const { harness } = await initWithTls(srt);
  for (const secrets of [
    [tokenSecret({ envVar: "lower" })],
    [tokenSecret({ hosts: ["10.0.0.1"] })],
    [tokenSecret({ hosts: [] })],
    [tokenSecret({ value: `${REAL}\n` })],
    [tokenSecret({ readOnly: "x" as unknown as boolean })],
  ]) {
    const response = await wrapWithSecrets(harness, secrets);
    expectError(response, "BAD_REQUEST");
    assert.ok(!JSON.stringify(response).includes(REAL), JSON.stringify(response));
  }
  assert.equal(srt.wrapCalls, 0);
  await harness.stop();
});

test("a read-only secret host: a write raises a request ask, the reply decides, reads never ask", async () => {
  const srt = makeFakeSrt();
  const { harness } = await initWithTls(srt);
  assert.ok(srt.ask);
  await wrapWithSecrets(harness, [tokenSecret({ readOnly: true })], { mode: "open", allow: [] });
  assert.equal(await srt.ask({ host: "api.github.com", port: 443 }), true);
  const hook = srt.initConfig?.network.filterRequest as (
    request: globalThis.Request,
    info?: unknown,
  ) => Promise<{ action: string; status?: number; reason?: string; onResponse?: (s: number, h: object) => void }>;
  const info = { scheme: "https", target: { host: "api.github.com", port: 443 } };

  const read = await hook(new globalThis.Request("https://api.github.com/user"), { ...info, requestTarget: "/user" });
  assert.equal(read.action, "allow");
  assert.equal(harness.events.length, 0);

  const write = hook(new globalThis.Request("https://api.github.com/repos/a/b/issues?x=1", { method: "POST" }), {
    ...info,
    requestTarget: "/repos/a/b/issues?x=1",
  });
  const event = await harness.nextAsk();
  assert.deepEqual(Object.keys(event).sort(), ["askId", "commandId", "event", "host", "kind", "method", "path", "port"]);
  assert.equal(event.kind, "request");
  assert.equal(event.method, "POST");
  assert.equal(event.path, "/repos/a/b/issues");
  assert.equal(event.host, "api.github.com");
  assert.equal(event.port, 443);
  assert.equal((await harness.send({ op: "ask.reply", askId: event.askId, allow: false, reason: "denied by user" })).ok, true);
  assert.deepEqual(await write, { action: "deny", status: 403, reason: "denied by user" });

  const entries = await auditOf(harness);
  const denial = entries.find((e) => e.kind === "http" && e.decision === "deny");
  assert.deepEqual(
    [denial?.method, denial?.path, denial?.status, denial?.source, denial?.reason],
    ["POST", "/repos/a/b/issues", 403, "user", "denied by user"],
  );
  assert.ok(!JSON.stringify(entries).includes(REAL));
  await harness.stop();
});

test("a host ask still has no kind, method or path on the wire", async () => {
  const srt = makeFakeSrt();
  const { harness } = await initWithTls(srt);
  assert.ok(srt.ask);
  await wrapCommand(harness, { mode: "ask", allow: [] });
  const pending = srt.ask({ host: "example.com", port: 443 });
  const event = await harness.nextAsk();
  assert.deepEqual(Object.keys(event).sort(), ["askId", "commandId", "event", "host", "port"]);
  await harness.send({ op: "ask.reply", askId: event.askId, allow: true });
  await pending;
  await harness.stop();
});

test("the address guard stays first: a secret-bound name does not make a private address reachable", async () => {
  const srt = makeFakeSrt();
  const { harness } = await initWithTls(srt);
  assert.ok(srt.ask);
  // localhost is a legal name to bind; it must still be denied at the connection.
  await wrapWithSecrets(harness, [tokenSecret({ hosts: ["localhost", "app.localhost"] })], {
    mode: "open",
    allow: ["localhost", "app.localhost"],
  });
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "10.0.0.1"]) {
    const answer = await srt.ask({ host, port: 443 });
    assert.equal(typeof answer, "object", host);
    assert.match((answer as { reason: string }).reason, /^public internet only/);
  }
  await harness.stop();
});

test("the real secret value appears in nothing the sidecar emits", async () => {
  const stderrLines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const srt = makeFakeSrt();
  let harness: Harness;
  const everything: unknown[] = [];
  try {
    ({ harness } = await initWithTls(srt));
    assert.ok(srt.ask);
    const wrapped = await wrapWithSecrets(
      harness,
      [tokenSecret({ readOnly: true }), tokenSecret({ envVar: "BAD name", value: `${REAL}-second` })],
      { mode: "ask", allow: ["api.github.com"] },
    );
    everything.push(wrapped); // BAD_REQUEST: the second secret has an invalid name
    const ok = await wrapWithSecrets(harness, [tokenSecret({ readOnly: true })], {
      mode: "ask",
      allow: ["api.github.com", "bad entry with spaces"],
    });
    everything.push(ok);
    // A write approval, an audit, the violations text, and cleanup.
    const hook = srt.initConfig?.network.filterRequest as (r: globalThis.Request, i?: unknown) => Promise<{ onResponse?: (s: number, h: object) => void }>;
    await srt.ask?.({ host: "api.github.com", port: 443 });
    const write = hook(new globalThis.Request("https://api.github.com/x", { method: "DELETE" }), {
      scheme: "https",
      target: { host: "api.github.com", port: 443 },
    });
    const event = await harness.nextAsk();
    await harness.send({ op: "ask.reply", askId: event.askId, allow: true });
    (await write).onResponse?.(204, {});
    everything.push(await auditOf(harness));
    everything.push(await harness.send({ op: "violations", commandId: "c".repeat(22), stderr: "boom" }));
    // Errors: a malformed line that contains the value, and a bad secret shape.
    everything.push(await harness.sendRaw(`{"id":"r1","op":"wrap","commandId":"x","secrets":[{"value":"${REAL}"`));
    everything.push(
      await harness.send({ op: "wrap", commandId: "y", command: "x", cwd: workspaceRoot, workspaceRoot, secrets: [{ envVar: "A", value: REAL }] } as unknown as Request),
    );
    await harness.send({ op: "cleanup", commandId: "c".repeat(22) });
    // What the fake srt was handed (everything it would hand a child) and what the host received.
    everything.push(srt.lastCustomConfig, srt.initConfig, harness.raw, harness.events);
    await harness.stop();
  } finally {
    process.stderr.write = realWrite;
  }
  const scan = JSON.stringify([everything, stderrLines]);
  assert.ok(!scan.includes(REAL), "the real value leaked into an emitted artefact");
  assert.ok(scan.includes("fake_value_"), "the scan really covered a wrap result");
  assert.ok(!harness.raw.join("\n").includes(REAL));
});

test("a request body carrying the command's placeholder raises a flagged request ask over the wire", async () => {
  const srt = makeFakeSrt();
  const { harness } = await initWithTls(srt);
  assert.ok(srt.ask);
  const wrapped = await wrapWithSecrets(harness, [tokenSecret()], { mode: "open", allow: [] });
  assert.ok(wrapped.ok);
  const placeholder = (wrapped as { ok: true; result: { secretEnv: Record<string, string> } }).result.secretEnv
    .GITHUB_TOKEN as string;
  assert.equal(await srt.ask({ host: "api.github.com", port: 443 }), true);
  const hook = srt.initConfig?.network.filterRequest as (
    request: globalThis.Request,
    info?: unknown,
  ) => Promise<{ action: string; status?: number; reason?: string }>;
  const info = { scheme: "https", target: { host: "api.github.com", port: 443 } };

  const clean = await hook(new globalThis.Request("https://api.github.com/gists", { method: "POST", body: "{}" }), info);
  assert.equal(clean.action, "allow");
  assert.equal(harness.events.length, 0);

  const pending = hook(
    new globalThis.Request("https://api.github.com/gists?x=1", { method: "POST", body: `{"content":"${placeholder}"}` }),
    { ...info, requestTarget: "/gists?x=1" },
  );
  const event = await harness.nextAsk();
  assert.deepEqual(Object.keys(event).sort(), [
    "askId", "commandId", "event", "host", "kind", "method", "path", "port", "secretInBody",
  ]);
  assert.equal(event.secretInBody, true);
  assert.equal(event.path, "/gists");
  assert.ok(!JSON.stringify(event).includes(placeholder));
  await harness.send({ op: "ask.reply", askId: event.askId, allow: false, reason: "denied by user" });
  assert.deepEqual(await pending, {
    action: "deny",
    status: 403,
    reason: "request body contains a stored secret: denied by user",
  });
  await harness.stop();
});
