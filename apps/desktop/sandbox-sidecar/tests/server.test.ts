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
import { SANDBOX_PROTOCOL_VERSION } from "../src/protocol.js";
import type {
  AuditEntry,
  InitConfig,
  Request,
  Response,
  SidecarEvent,
  WrapNetwork,
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
  lastInitConfig?: unknown;
  binShells: Array<string | undefined>;
  commands: string[];
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
    commands: [] as string[],
    lastInitConfig: undefined as unknown,
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
      fake.lastInitConfig = config;
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
      fake.commands.push(command);
      if (fake.wrapError) throw fake.wrapError;
      if (command === "true" || command === "exit 0") {
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
  let consumedEvents = 0;
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim() !== "") {
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

  return { send, events, nextAsk, stop };
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
  const harness = await initHarness(srt, () => new Set(["93.184.216.7"]));
  assert.ok(srt.ask);
  await wrapCommand(harness);
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

test("linux wrap and probe add write denies only for existing credential paths inside the wrap's workspace", async () => {
  const home = mkdtempSync(join(tmpRoot, "linux-home-"));
  mkdirSync(join(home, ".ssh"));
  // The user granted $HOME itself (a second root is a normal workspace; ~/.cargo style read
  // roots are not writable and must never get a write deny, or bwrap cannot bind them).
  mkdirSync(join(home, ".cargo"));
  writeFileSync(join(home, ".cargo", "credentials.toml"), "x");
  const init = linuxInit({ home, workspaceRoots: [home, workspaceRoot], readRoots: [join(home, ".cargo")] });
  const srt = makeFakeSrt();
  const harness = await initHarness(srt, undefined, init);
  const denyWrite = () =>
    (srt.lastCustomConfig as { filesystem: { denyWrite: Array<{ path: string }> } }).filesystem.denyWrite.map(
      (entry) => entry.path,
    );
  const wrap = async (root: string) => {
    const response = await harness.send({
      op: "wrap",
      commandId: "c".repeat(22),
      command: "echo hi",
      cwd: root,
      workspaceRoot: root,
    });
    assert.equal(response.ok, true, `wrap failed: ${JSON.stringify(response)}`);
    // The host cleans up after every command; a command id cannot be wrapped twice before that.
    await harness.send({ op: "cleanup", commandId: "c".repeat(22) });
  };
  await wrap(home);
  // The static entry survives; existing credential paths inside the writable home are added;
  // absent paths (which srt would otherwise create as placeholders in the real home) are not.
  assert.deepEqual(denyWrite(), ["/tmp/claude", join(home, ".cargo/credentials.toml"), join(home, ".ssh")]);
  // Checked per command: a path that appears later is covered by the next wrap.
  mkdirSync(join(home, ".aws"));
  await wrap(home);
  assert.deepEqual(denyWrite(), [
    "/tmp/claude",
    join(home, ".cargo/credentials.toml"),
    join(home, ".ssh"),
    join(home, ".aws"),
  ]);
  // A wrap in another workspace root: nothing writable contains the credential paths.
  await wrap(workspaceRoot);
  assert.deepEqual(denyWrite(), ["/tmp/claude"]);
  const probe = await harness.send({ op: "probe" });
  assert.equal(probe.ok, true, `probe failed: ${JSON.stringify(probe)}`);
  // probe wraps init's first workspace root (here the granted home).
  assert.deepEqual(denyWrite(), [
    "/tmp/claude",
    join(home, ".cargo/credentials.toml"),
    join(home, ".ssh"),
    join(home, ".aws"),
  ]);
  await harness.stop();
});

// ---------------------------------------------------------------------------------------------
// win32: Windows-shaped paths with an injected `pathExists`, so these run on any OS.
// ---------------------------------------------------------------------------------------------

const WIN_RG = "C:\\app\\sandbox\\rg.exe";
const WIN_SRT = "C:\\Program Files\\SourceWeft\\sandbox\\srt-win.exe";
const WIN_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const WIN_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WIN_WORKSPACE = "C:\\Users\\u\\ws";

function win32Init(overrides: Partial<InitConfig> = {}): InitConfig {
  return {
    platform: "win32",
    home: "C:\\Users\\u",
    workspaceRoots: [WIN_WORKSPACE],
    readRoots: ["C:\\Users\\u\\.cargo\\bin"],
    helpers: { ripgrep: WIN_RG },
    windows: { srtWin: WIN_SRT, shell: WIN_BASH },
    ...overrides,
  };
}

/** Everything the win32 helper check looks for exists, plus whatever `extra` names. */
function winPathExists(extra: Iterable<string> = []): Partial<ServerDeps> {
  const present = new Set([WIN_RG, WIN_SRT, WIN_BASH, WIN_POWERSHELL, ...extra]);
  return { pathExists: (path) => present.has(path) };
}

type WinCustomConfig = {
  filesystem: {
    allowRead: unknown[];
    allowWrite: unknown[];
    denyRead: Array<{ path: string; literal: boolean }>;
    denyWrite: Array<{ path: string; literal: boolean }>;
  };
};

test("win32 init builds the namespaced windows config and passes it to srt", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt, undefined, win32Init(), winPathExists());
  const config = srt.lastInitConfig as ReturnType<typeof buildConfig>;
  // The server adds only the plain-HTTP audit hook (`filterRequest`) to `buildConfig`'s result.
  const { filterRequest, ...network } = config.network;
  assert.equal(typeof filterRequest, "function");
  assert.deepEqual({ ...config, network }, buildConfig(win32Init()));
  assert.deepEqual(config.windows, {
    srtWin: { path: WIN_SRT },
    sandboxUser: "sourceweft-sandbox",
    proxyPortRange: [60180, 60189],
  });
  assert.deepEqual(config.filesystem.allowWrite, [{ path: WIN_WORKSPACE, literal: true }]);
  assert.deepEqual(config.filesystem.denyRead, []);
  await harness.stop();
});

test("win32 init validation: root count and the windows block are POLICY_INVALID", async () => {
  for (const config of [
    win32Init({ workspaceRoots: ["C:\\a", "C:\\b", "C:\\c"] }),
    win32Init({ workspaceRoots: [] }),
    win32Init({ windows: undefined }),
    win32Init({ workspaceRoots: ["ws"] }),
    win32Init({ workspaceRoots: ["\\\\srv\\share\\ws"] }),
    win32Init({ workspaceRoots: ["\\\\?\\C:\\ws"] }),
    win32Init({ windows: { srtWin: "srt-win.exe", shell: WIN_BASH } }),
  ]) {
    const srt = makeFakeSrt();
    const harness = startHarness(srt, undefined, winPathExists());
    expectError(await harness.send({ op: "init", config }), "POLICY_INVALID");
    assert.equal(srt.lastInitConfig, undefined, "srt must never see an invalid policy");
    await harness.stop();
  }
});

test("a windows block on linux is POLICY_INVALID", async () => {
  const harness = startHarness(makeFakeSrt());
  expectError(
    await harness.send({
      op: "init",
      config: linuxInit({ windows: { srtWin: WIN_SRT, shell: WIN_BASH } }),
    }),
    "POLICY_INVALID",
  );
  await harness.stop();
});

test("win32 init with a missing srt-win or shell is HELPER_MISSING and names it", async () => {
  for (const missing of [WIN_SRT, WIN_BASH, WIN_RG]) {
    const present = new Set([WIN_RG, WIN_SRT, WIN_BASH]);
    present.delete(missing);
    const srt = makeFakeSrt();
    const harness = startHarness(srt, undefined, { pathExists: (path) => present.has(path) });
    const response = await harness.send({ op: "init", config: win32Init() });
    expectError(response, "HELPER_MISSING");
    if (!response.ok) assert.ok(response.error.message.includes(missing), response.error.message);
    assert.equal(srt.lastInitConfig, undefined);
    await harness.stop();
  }
});

test("win32 init prefixes srt's WindowsSandboxError code on the message", async () => {
  for (const code of ["not_provisioned", "reinstall_required", "wfp_fence_inactive"]) {
    const srt = makeFakeSrt();
    const error = Object.assign(new Error("Windows sandbox user is not provisioned"), {
      name: "WindowsSandboxError",
      code,
    });
    srt.initError = error;
    const harness = startHarness(srt, undefined, winPathExists());
    const response = await harness.send({ op: "init", config: win32Init() });
    expectError(response, "SANDBOX_UNAVAILABLE");
    if (!response.ok) {
      assert.equal(response.error.message, `[${code}] Windows sandbox user is not provisioned`);
    }
    await harness.stop();
  }
});

test("win32 init leaves other failures unprefixed, and linux never prefixes", async () => {
  // A plain error, and a Node-style `code` that is not a WindowsSandboxError.
  const srt = makeFakeSrt();
  srt.initError = Object.assign(new Error("EACCES: spawn"), { code: "EACCES" });
  const harness = startHarness(srt, undefined, winPathExists());
  const response = await harness.send({ op: "init", config: win32Init() });
  expectError(response, "SANDBOX_UNAVAILABLE");
  if (!response.ok) assert.equal(response.error.message, "EACCES: spawn");
  await harness.stop();

  const linux = makeFakeSrt();
  linux.initError = Object.assign(new Error("bwrap failed"), { name: "WindowsSandboxError", code: "x" });
  const linuxHarness = startHarness(linux);
  const linuxResponse = await linuxHarness.send({ op: "init", config: linuxInit() });
  expectError(linuxResponse, "SANDBOX_UNAVAILABLE");
  if (!linuxResponse.ok) assert.equal(linuxResponse.error.message, "bwrap failed");
  await linuxHarness.stop();
});

test("win32 wrap passes only the per-command denies and the host-chosen shell, never a grant", async () => {
  const profile = "C:\\Users\\u";
  const init = win32Init({ home: profile, workspaceRoots: [profile], readRoots: [] });
  const ssh = `${profile}\\.ssh`;
  const npmrc = `${profile}\\.npmrc`;
  const srt = makeFakeSrt();
  const harness = await initHarness(srt, undefined, init, winPathExists([ssh, npmrc]));
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "echo hi",
    cwd: `${profile}\\src`,
    workspaceRoot: profile,
  });
  assert.equal(response.ok, true, `wrap failed: ${JSON.stringify(response)}`);
  assert.deepEqual(srt.binShells, [WIN_BASH]);
  assert.deepEqual(srt.commands, ["echo hi"]);
  const custom = srt.lastCustomConfig as WinCustomConfig;
  // Exactly the filesystem block, with empty grants (srt throws on a non-empty one) and the
  // existing credential paths denied for read AND write; the absent ones are not listed.
  assert.deepEqual(srt.lastCustomConfig, {
    filesystem: {
      allowRead: [],
      allowWrite: [],
      denyRead: [ssh, npmrc].map((path) => ({ path, literal: true })),
      denyWrite: [ssh, npmrc].map((path) => ({ path, literal: true })),
    },
  });
  assert.deepEqual(custom.filesystem.allowRead, []);
  assert.deepEqual(custom.filesystem.allowWrite, []);
  await harness.stop();
});

test("win32 wrap denies nothing that is absent or outside the workspace and read roots", async () => {
  const srt = makeFakeSrt();
  // The credential paths exist, but the workspace is elsewhere (and the read root is a cargo bin).
  const harness = await initHarness(
    srt,
    undefined,
    win32Init(),
    winPathExists(["C:\\Users\\u\\.ssh", "C:\\Users\\u\\.npmrc"]),
  );
  const response = await harness.send({
    op: "wrap",
    commandId: "c".repeat(22),
    command: "dir",
    cwd: WIN_WORKSPACE,
    workspaceRoot: WIN_WORKSPACE,
  });
  assert.equal(response.ok, true, `wrap failed: ${JSON.stringify(response)}`);
  const custom = srt.lastCustomConfig as WinCustomConfig;
  assert.deepEqual(custom.filesystem.denyRead, []);
  assert.deepEqual(custom.filesystem.denyWrite, []);
  await harness.stop();
});

test("win32 wrap checks workspaceRoot and cwd with Windows semantics", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt, undefined, win32Init(), winPathExists());
  const wrap = (workspaceRoot: string, cwd: string) =>
    harness.send({ op: "wrap", commandId: "c".repeat(22), command: "dir", cwd, workspaceRoot });
  // Wire form (forward slashes) and a different case are the same directory.
  assert.equal((await wrap("c:/USERS/u/ws", "c:/users/U/ws/pkg")).ok, true);
  await harness.send({ op: "cleanup", commandId: "c".repeat(22) });
  expectError(await wrap("C:\\Users\\u\\other", "C:\\Users\\u\\other"), "POLICY_INVALID");
  expectError(await wrap(WIN_WORKSPACE, "C:\\Users\\u"), "POLICY_INVALID");
  expectError(await wrap(`${WIN_WORKSPACE}\\..\\other`, `${WIN_WORKSPACE}\\..\\other`), "POLICY_INVALID");
  expectError(await wrap("\\\\srv\\share\\ws", "\\\\srv\\share\\ws"), "POLICY_INVALID");
  expectError(await wrap("relative", "relative"), "POLICY_INVALID");
  await harness.stop();
});

test("win32 honours the per-command network policy: strict denies, an allow rule allows, the guard still wins", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(srt, undefined, win32Init(), winPathExists());
  assert.ok(srt.ask, "init must register an ask callback on win32 too");
  const wrapWin = async (network?: WrapNetwork) => {
    const response = await harness.send({
      op: "wrap",
      commandId: "c".repeat(22),
      command: "dir",
      cwd: WIN_WORKSPACE,
      workspaceRoot: WIN_WORKSPACE,
      ...(network === undefined ? {} : { network }),
    });
    assert.equal(response.ok, true, JSON.stringify(response));
  };
  await wrapWin({ mode: "strict", allow: ["allowed.example.com"] });
  assert.deepEqual(await srt.ask?.({ host: "example.com", port: 443 }), {
    allow: false,
    reason: "host is not on the allow list (strict network mode)",
  });
  assert.equal(await srt.ask?.({ host: "allowed.example.com", port: 443 }), true);
  assert.deepEqual((await srt.ask?.({ host: "10.0.0.1", port: 80 })) !== true, true);
  const entries = await auditOf(harness);
  assert.deepEqual(
    entries.map((entry) => [entry.host, entry.decision, entry.source]),
    [
      ["example.com", "deny", "strict"],
      ["allowed.example.com", "allow", "rule"],
      ["10.0.0.1", "deny", "guard"],
    ],
  );
  await harness.send({ op: "cleanup", commandId: "c".repeat(22) });
  // Without a policy the connection is open (and audited), as on the other platforms.
  await wrapWin();
  assert.equal(await srt.ask?.({ host: "example.com", port: 443 }), true);
  await harness.stop();
});

test("win32 uses powershell when the host chose it, and probes with a command both shells run", async () => {
  const srt = makeFakeSrt();
  const harness = await initHarness(
    srt,
    undefined,
    win32Init({ windows: { srtWin: WIN_SRT, shell: WIN_POWERSHELL } }),
    winPathExists(),
  );
  // The probe's child cannot start off Windows (the workspace is a Windows path), so the
  // response is not asserted: what matters is what was wrapped, and that it was released.
  await harness.send({ op: "probe" });
  assert.deepEqual(srt.binShells, [WIN_POWERSHELL]);
  assert.deepEqual(srt.commands, ["exit 0"]);
  assert.deepEqual(srt.lastCustomConfig, {
    filesystem: { allowRead: [], allowWrite: [], denyRead: [], denyWrite: [] },
  });
  assert.equal(srt.cleanupCalls, 1);
  await harness.stop();
});

test("linux and darwin probes still wrap `true`", async () => {
  const linux = makeFakeSrt();
  const linuxHarness = await initHarness(linux);
  await linuxHarness.send({ op: "probe" });
  assert.deepEqual(linux.commands, ["true"]);
  await linuxHarness.stop();
  const darwin = makeFakeSrt();
  const darwinHarness = await initHarness(darwin, undefined, darwinInit());
  await darwinHarness.send({ op: "probe" });
  assert.deepEqual(darwin.commands, ["true"]);
  await darwinHarness.stop();
});
