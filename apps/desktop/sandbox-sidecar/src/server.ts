/**
 * The sidecar's server loop: reads `Request` lines from `input`, writes matching `Response`
 * lines to `output`, and drives srt (through the `SrtLike` subset of `SandboxManager` that
 * this process actually uses) to build the sidecar-lifetime sandbox config on `init` and to
 * wrap each later command on `wrap`. See `src/protocol.ts` for the wire shapes (kept in sync
 * with the Rust client at `apps/desktop/src-tauri/src/local_host/sidecar.rs`) and
 * `src/policy.ts` for how an `InitConfig` becomes a `SandboxRuntimeConfig`.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createNetworkPolicy, PROBE_COMMAND_ID } from "./network-policy.js";
import type { AskHostAnswer, AskHostRequest } from "./network-policy.js";
import {
  assertCwdWithinWorkspace,
  assertWorkspaceRootAllowed,
  auditFilterRequest,
  buildConfig,
  perCommandConfig,
  perWrapReadRoots,
} from "./policy.js";
import { SANDBOX_PROTOCOL_VERSION } from "./protocol.js";
import type {
  AuditResult,
  InitConfig,
  Request,
  Response,
  SidecarErrorCode,
  SidecarEvent,
  WrapNetwork,
  WrapResult,
} from "./protocol.js";

/**
 * The subset of `SandboxManager` (from `@anthropic-ai/sandbox-runtime`) this server actually
 * calls. Kept narrow so tests can drive the server with a fake that implements only this,
 * rather than the whole `ISandboxManager` surface. `main.ts` passes the real `SandboxManager`
 * singleton, which satisfies this structurally.
 */
export type SrtLike = {
  initialize(
    runtimeConfig: SandboxRuntimeConfig,
    sandboxAskCallback?: (
      params: { host: string; port: number | undefined },
    ) => Promise<boolean | { allow: false; reason: string }>,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: { commandId?: string },
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  annotateStderrWithSandboxFailures(commandIdOrCommand: string, stderr: string): string;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
  /**
   * Present (and `true`) on srt releases that understand an ask callback's
   * `{ allow: false, reason }` answer; absent on older releases, which read any truthy
   * answer (including that object) as an allow. Checked before ever returning that shape —
   * see `askCallback` below.
   */
  readonly askCallbackDenyReason?: true;
};

export type ServerDeps = {
  srt: SrtLike;
  ownAddresses: () => Set<string>;
  /**
   * The private directory `main.ts` made srt's `os.tmpdir()` (Linux only), which the policy
   * re-allows for reading so srt's bridge sockets stay reachable; see `buildConfig`.
   */
  runtimeDir?: string;
  /**
   * How long an unanswered network approval waits before it is denied; the policy's own 150 s
   * default when absent. Exists so tests need not wait that long; nothing configures it.
   */
  askTimeoutMs?: number;
};

const KNOWN_ERROR_CODES: readonly SidecarErrorCode[] = [
  "NOT_INITIALIZED",
  "HELPER_MISSING",
  "SANDBOX_UNAVAILABLE",
  "POLICY_INVALID",
  "BAD_REQUEST",
];

function isSidecarErrorCode(value: unknown): value is SidecarErrorCode {
  return (
    typeof value === "string" &&
    (KNOWN_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** An error that already carries the exact `SidecarErrorCode` to report on the wire. */
class SidecarError extends Error {
  constructor(
    readonly code: SidecarErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SidecarError";
  }
}

function notInitialized(): SidecarError {
  return new SidecarError("NOT_INITIALIZED", "sidecar has not received init yet");
}

/** How long a cached `ownAddresses()` snapshot is reused for the ask callback. */
const OWN_ADDRESSES_TTL_MS = 30_000;

/** How long `probe` waits for the wrapped `true` to exit before giving up. */
const PROBE_TIMEOUT_MS = 20_000;

/** How long shutdown (explicit or EOF-triggered) waits for `srt.reset()` before giving up on it. */
const RESET_TIMEOUT_MS = 5_000;

/** Rejects with a timeout error if `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    // Not unref'd: if `promise` hangs, this timer is what ends the wait, and on Node 22 an event
    // loop with nothing else alive would drain first and abandon the awaiting caller. It is always
    // cleared once `promise` settles, so it never holds the process up beyond that.
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type InitializedState = {
  config: InitConfig;
  runtimeConfig: SandboxRuntimeConfig;
  /** `perWrapReadRoots(config, deps.runtimeDir)`, computed once at `init`. */
  wrapReadRoots: string[];
};

/**
 * Checks every helper path named in `config` — `helpers.ripgrep` always, `helpers.applySeccomp`
 * and `helpers.javaAgentJar` when given, and `bwrapPath` when given — against the filesystem,
 * and throws `HELPER_MISSING` naming the first one that does not exist.
 */
function checkHelpersExist(config: InitConfig): void {
  const candidates: string[] = [config.helpers.ripgrep];
  if (config.helpers.applySeccomp !== undefined) candidates.push(config.helpers.applySeccomp);
  if (config.helpers.javaAgentJar !== undefined) candidates.push(config.helpers.javaAgentJar);
  if (config.bwrapPath !== undefined) candidates.push(config.bwrapPath);

  for (const path of candidates) {
    if (!existsSync(path)) {
      throw new SidecarError("HELPER_MISSING", `sandbox helper not found at ${path}`);
    }
  }
}

/**
 * Merges `perCommandConfig(workspaceRoot, readRoots)` onto `base`: `filesystem.allowWrite` is
 * concatenated (the one field a per-command overlay is allowed to widen), `filesystem.allowRead`
 * is *replaced* by the overlay's (this command's own workspace root plus `perWrapReadRoots`,
 * Ruling R14 — never the other init workspace roots), and every other field (network, denyRead,
 * denyWrite, ripgrep, bwrapPath, seccomp, the java agent jar) passes straight through from
 * `base` unchanged. The result is a *complete* `SandboxRuntimeConfig`, suitable as
 * `wrapWithSandboxArgv`'s `customConfig`: srt reads each `customConfig` field in preference to
 * the one `initialize` was given only when the former is defined, so handing it a complete
 * config (rather than just the overlay) guarantees nothing from `base` is lost to that.
 */
function mergedConfigFor(
  base: SandboxRuntimeConfig,
  readRoots: readonly string[],
  workspaceRoot: string,
): SandboxRuntimeConfig {
  const overlay = perCommandConfig(workspaceRoot, readRoots);
  return {
    ...base,
    filesystem: {
      ...base.filesystem,
      allowRead: overlay.filesystem?.allowRead ?? [],
      allowWrite: [...base.filesystem.allowWrite, ...(overlay.filesystem?.allowWrite ?? [])],
    },
  };
}

/** Drops `undefined` values so `NodeJS.ProcessEnv` fits the wire's `Record<string, string>`. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Runs `argv` (no shell) with `env` in `cwd`, collecting stderr, bounded by `PROBE_TIMEOUT_MS`. */
function runProbe(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error("probe produced an empty argv"));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

/**
 * Reads `Request` lines from `input` and writes matching `Response` lines to `output` until a
 * `shutdown` request is handled or `input` ends. Never rejects: every per-request failure is
 * reported on the wire as that request's `Response`, never thrown out of this function.
 */
export async function startServer(
  input: Readable,
  output: Writable,
  deps: ServerDeps,
): Promise<void> {
  let state: InitializedState | null = null;
  let ownAddressesCache: Set<string> | null = null;
  let ownAddressesCachedAt = 0;

  function write(response: Response): void {
    output.write(`${JSON.stringify(response)}\n`);
  }

  /** An unsolicited line (`event` instead of `id`); whole lines only, like `write`. */
  function writeEvent(event: SidecarEvent): void {
    output.write(`${JSON.stringify(event)}\n`);
  }

  /** Approvals raised to the host and not yet answered, by `askId`. */
  const pendingAsks = new Map<string, (answer: AskHostAnswer) => void>();

  /**
   * Announces a connection that needs the user's approval as an `ask` event line and waits for
   * the host's `ask.reply`. The network policy owns the deadline: when its signal fires (timeout,
   * or the command finished) the pending entry is dropped, so a late reply is an unknown `askId`.
   */
  function askHost(request: AskHostRequest): Promise<AskHostAnswer> {
    const askId = randomUUID();
    return new Promise<AskHostAnswer>((resolve) => {
      pendingAsks.set(askId, resolve);
      request.signal.addEventListener("abort", () => pendingAsks.delete(askId), { once: true });
      writeEvent({
        event: "ask",
        askId,
        commandId: request.commandId,
        host: request.host,
        port: request.port,
        ...(request.suggestedBy === undefined ? {} : { suggestedBy: request.suggestedBy }),
      });
    });
  }

  const networkPolicy = createNetworkPolicy({
    ownAddresses: getOwnAddresses,
    askHost,
    ...(deps.askTimeoutMs === undefined ? {} : { askTimeoutMs: deps.askTimeoutMs }),
  });

  function getOwnAddresses(): Set<string> {
    const now = Date.now();
    if (ownAddressesCache === null || now - ownAddressesCachedAt >= OWN_ADDRESSES_TTL_MS) {
      ownAddressesCache = deps.ownAddresses();
      ownAddressesCachedAt = now;
    }
    return ownAddressesCache;
  }

  /**
   * srt's ask callback: every connection srt's proxy has no configured rule for (`allowedDomains`
   * stays empty, so that is all of them) is decided by the network policy — address guard first,
   * then the active command's mode, allow list and approvals.
   */
  async function askCallback(params: {
    host: string;
    port: number | undefined;
  }): Promise<boolean | { allow: false; reason: string }> {
    const decision = await networkPolicy.decide(params);
    if (decision === true) return true;
    // See `SrtLike.askCallbackDenyReason`'s doc: only return the `{ allow: false, reason }`
    // shape when srt is known to understand it; otherwise a plain `false` is the only safe
    // deny, since some releases read any truthy answer (including that object) as an allow.
    if (deps.srt.askCallbackDenyReason !== true) return false;
    return decision;
  }

  async function handleInit(config: InitConfig): Promise<{ protocolVersion: number }> {
    checkHelpersExist(config);
    const base = buildConfig(config, deps.runtimeDir);
    // The plain-HTTP audit hook is attached here rather than in `buildConfig` because it closes
    // over this server's network policy; it never denies (see `auditFilterRequest`).
    const runtimeConfig: SandboxRuntimeConfig = {
      ...base,
      network: { ...base.network, filterRequest: auditFilterRequest(networkPolicy.beginHttp) },
    };
    ownAddressesCache = deps.ownAddresses();
    ownAddressesCachedAt = Date.now();
    try {
      await deps.srt.initialize(runtimeConfig, askCallback);
    } catch (error) {
      throw new SidecarError(
        "SANDBOX_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
      );
    }
    state = { config, runtimeConfig, wrapReadRoots: perWrapReadRoots(config, deps.runtimeDir) };
    return { protocolVersion: SANDBOX_PROTOCOL_VERSION };
  }

  async function handleWrap(request: {
    commandId: string;
    command: string;
    cwd: string;
    workspaceRoot: string;
    network?: WrapNetwork;
  }): Promise<WrapResult> {
    if (state === null) throw notInitialized();
    // A command id names live policy state (network rules, approvals, audit) until its `cleanup`:
    // reusing one would silently replace it, and `probe` is srt's id for the probe wrap.
    if (request.commandId === PROBE_COMMAND_ID) {
      throw new SidecarError("BAD_REQUEST", `commandId ${JSON.stringify(PROBE_COMMAND_ID)} is reserved`);
    }
    if (networkPolicy.has(request.commandId)) {
      throw new SidecarError(
        "BAD_REQUEST",
        `commandId ${JSON.stringify(request.commandId)} is already wrapped; send cleanup first`,
      );
    }
    // Fix round 1 review: `workspaceRoot` is the only input that widens write access, and
    // `cwd` is what srt resolves a relative literal path against — neither is otherwise
    // constrained, so a bad value here (relative, outside every init workspace root, or
    // escaping one via `..`) must never reach srt's filesystem policy unchecked.
    const workspaceRoot = assertWorkspaceRootAllowed(
      request.workspaceRoot,
      state.config.workspaceRoots,
    );
    const cwd = assertCwdWithinWorkspace(request.cwd, workspaceRoot);
    const customConfig = mergedConfigFor(
      state.runtimeConfig,
      state.wrapReadRoots,
      workspaceRoot,
    );
    try {
      const { argv, env } = await deps.srt.wrapWithSandboxArgv(
        request.command,
        undefined,
        customConfig,
        undefined,
        cwd,
        { commandId: request.commandId },
      );
      // Registered before the reply, so the policy is in place before the host can spawn the
      // command; a failed wrap (above) registers nothing. No `network` means `open`.
      networkPolicy.register(request.commandId, request.network ?? { mode: "open", allow: [] });
      return { argv, env: cleanEnv(env) };
    } catch (error) {
      throw new SidecarError(
        "SANDBOX_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function handleViolations(request: { commandId: string; stderr: string }): string {
    if (state === null) throw notInitialized();
    return deps.srt.annotateStderrWithSandboxFailures(request.commandId, request.stderr);
  }

  function handleCleanup(commandId: string): null {
    if (state === null) throw notInitialized();
    // The host drains the command's audit (`audit`) before it cleans up; this drops what is left.
    networkPolicy.unregister(commandId);
    deps.srt.cleanupAfterCommand();
    return null;
  }

  function handleAudit(commandId: string): AuditResult {
    if (state === null) throw notInitialized();
    return { entries: networkPolicy.drainAudit(commandId) };
  }

  function handleAskReply(request: { askId: string; allow: boolean; reason?: string }): null {
    const resolve = pendingAsks.get(request.askId);
    if (resolve === undefined) {
      throw new SidecarError(
        "BAD_REQUEST",
        `no pending ask ${JSON.stringify(request.askId)} (unknown, already answered or timed out)`,
      );
    }
    pendingAsks.delete(request.askId);
    resolve({
      allow: request.allow,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    });
    return null;
  }

  async function handleProbe(): Promise<true> {
    if (state === null) throw notInitialized();
    const workspaceRoot = state.config.workspaceRoots[0];
    if (workspaceRoot === undefined) {
      throw new SidecarError("SANDBOX_UNAVAILABLE", "init had no workspaceRoots to probe with");
    }
    const customConfig = mergedConfigFor(
      state.runtimeConfig,
      state.wrapReadRoots,
      workspaceRoot,
    );
    let argv: string[];
    let env: Record<string, string>;
    try {
      const wrapped = await deps.srt.wrapWithSandboxArgv(
        "true",
        undefined,
        customConfig,
        undefined,
        workspaceRoot,
        { commandId: "probe" },
      );
      argv = wrapped.argv;
      env = cleanEnv(wrapped.env);
    } catch (error) {
      throw new SidecarError(
        "SANDBOX_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
      );
    }
    // Final review M3: srt counts every successful wrap and defers its cleanup until a matching
    // `cleanupAfterCommand`, exactly as for a `wrap` request, so release it once the probe has
    // run — whether it succeeded, failed or could not be spawned. A failed wrap (above) has
    // already been undone by srt itself.
    let probed: { code: number | null; stderr: string };
    try {
      probed = await runProbe(argv, env, workspaceRoot);
    } finally {
      deps.srt.cleanupAfterCommand();
    }
    const { code, stderr } = probed;
    if (code !== 0) {
      throw new SidecarError(
        "SANDBOX_UNAVAILABLE",
        stderr.length > 0 ? stderr : `sandbox probe exited with code ${String(code)}`,
      );
    }
    return true;
  }

  // Fix round 1 review: the sidecar must never outlive its parent with srt's proxy/listener
  // machinery still running. `handleShutdown` is the *explicit* path (an orderly `shutdown`
  // request), but a parent that crashes or is killed closes `input` without ever sending one
  // — so `input` ending (EOF) is treated exactly like `shutdown` below, via this same
  // best-effort, bounded teardown, guarded so it only ever runs once no matter which path
  // reaches it first.
  let tornDown = false;
  async function teardown(): Promise<void> {
    if (tornDown) return;
    tornDown = true;
    if (state === null) return;
    try {
      await withTimeout(deps.srt.reset(), RESET_TIMEOUT_MS);
    } catch {
      // Best effort: a hung or throwing `reset()` must not block shutdown (explicit or EOF)
      // any further — there is nothing more this process can do about it either way.
    }
  }

  async function handleShutdown(): Promise<null> {
    await teardown();
    return null;
  }

  async function dispatch(request: Request): Promise<unknown> {
    switch (request.op) {
      case "init":
        return handleInit(request.config);
      case "wrap":
        return handleWrap(request);
      case "violations":
        return handleViolations(request);
      case "cleanup":
        return handleCleanup(request.commandId);
      case "audit":
        return handleAudit(request.commandId);
      case "ask.reply":
        return handleAskReply(request);
      case "probe":
        return handleProbe();
      case "shutdown":
        return handleShutdown();
    }
  }

  const rl = createInterface({ input, terminal: false });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "") continue;

      let id = "?";
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        write({
          id,
          ok: false,
          error: {
            code: "BAD_REQUEST",
            message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
        continue;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "id" in parsed &&
        typeof (parsed as { id: unknown }).id === "string"
      ) {
        id = (parsed as { id: string }).id;
      }

      try {
        const request = asRequest(parsed, id);
        const result = await dispatch(request);
        write({ id: request.id, ok: true, result });
        if (request.op === "shutdown") {
          break;
        }
      } catch (error) {
        const code = isSidecarErrorCode((error as { code?: unknown } | undefined)?.code)
          ? (error as { code: SidecarErrorCode }).code
          : "SANDBOX_UNAVAILABLE";
        const message = error instanceof Error ? error.message : String(error);
        write({ id, ok: false, error: { code, message } });
      }
    }
  } finally {
    rl.close();
    // Reached either because `shutdown` broke the loop (where `handleShutdown` already ran
    // `teardown()`, so this is a no-op) or because `input` ended without one — the EOF case
    // `teardown()`'s own doc comment above describes.
    await teardown();
  }
}

/**
 * Validates that `parsed` has the shape of a `Request` and returns it as one, or throws
 * `BAD_REQUEST` naming what is wrong. `id` is the already-extracted id (or `"?"`), used only
 * for the thrown error's wire id via the caller — this function itself never needs it beyond
 * requiring `parsed.id` to be that same string.
 */
function asRequest(parsed: unknown, id: string): Request {
  if (typeof parsed !== "object" || parsed === null) {
    throw new SidecarError("BAD_REQUEST", "request line must decode to a JSON object");
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id !== id) {
    throw new SidecarError("BAD_REQUEST", "request must have a string \"id\"");
  }
  if (typeof value.op !== "string") {
    throw new SidecarError("BAD_REQUEST", "request must have a string \"op\"");
  }

  switch (value.op) {
    case "init":
      if (typeof value.config !== "object" || value.config === null) {
        throw new SidecarError("BAD_REQUEST", "\"init\" request must have a \"config\" object");
      }
      return { id, op: "init", config: value.config as InitConfig };
    case "wrap":
      if (
        typeof value.commandId !== "string" ||
        typeof value.command !== "string" ||
        typeof value.cwd !== "string" ||
        typeof value.workspaceRoot !== "string"
      ) {
        throw new SidecarError(
          "BAD_REQUEST",
          "\"wrap\" request must have string commandId, command, cwd and workspaceRoot",
        );
      }
      return {
        id,
        op: "wrap",
        commandId: value.commandId,
        command: value.command,
        cwd: value.cwd,
        workspaceRoot: value.workspaceRoot,
        ...(value.network === undefined ? {} : { network: asWrapNetwork(value.network) }),
      };
    case "violations":
      if (typeof value.commandId !== "string" || typeof value.stderr !== "string") {
        throw new SidecarError(
          "BAD_REQUEST",
          "\"violations\" request must have string commandId and stderr",
        );
      }
      return { id, op: "violations", commandId: value.commandId, stderr: value.stderr };
    case "cleanup":
      if (typeof value.commandId !== "string") {
        throw new SidecarError("BAD_REQUEST", "\"cleanup\" request must have a string commandId");
      }
      return { id, op: "cleanup", commandId: value.commandId };
    case "audit":
      if (typeof value.commandId !== "string") {
        throw new SidecarError("BAD_REQUEST", "\"audit\" request must have a string commandId");
      }
      return { id, op: "audit", commandId: value.commandId };
    case "ask.reply":
      if (
        typeof value.askId !== "string" ||
        typeof value.allow !== "boolean" ||
        (value.reason !== undefined && typeof value.reason !== "string")
      ) {
        throw new SidecarError(
          "BAD_REQUEST",
          "\"ask.reply\" request must have a string askId, a boolean allow and an optional string reason",
        );
      }
      return {
        id,
        op: "ask.reply",
        askId: value.askId,
        allow: value.allow,
        ...(value.reason === undefined ? {} : { reason: value.reason }),
      };
    case "probe":
      return { id, op: "probe" };
    case "shutdown":
      return { id, op: "shutdown" };
    default:
      throw new SidecarError("BAD_REQUEST", `unknown op ${JSON.stringify(value.op)}`);
  }
}

/** The largest network policy a `wrap` may carry. */
const MAX_NETWORK_DOMAINS = 500;
const MAX_NETWORK_DOMAIN_LENGTH = 255;

/**
 * Validates a `wrap` request's `network` field: a mode in the enum, at most 500 `allow` entries
 * of at most 255 characters each, and an optional `suggested` map of the same bounds with string
 * values. Whether an entry is a *valid domain pattern* is not judged here: the policy drops
 * invalid ones (never widening) so a single bad entry cannot fail a whole command.
 */
function asWrapNetwork(value: unknown): WrapNetwork {
  const bad = (what: string): SidecarError =>
    new SidecarError("BAD_REQUEST", `"wrap" request network ${what}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw bad("must be an object");
  }
  const network = value as Record<string, unknown>;
  if (network.mode !== "open" && network.mode !== "ask" && network.mode !== "strict") {
    throw bad("mode must be \"open\", \"ask\" or \"strict\"");
  }
  const allow = network.allow;
  if (!Array.isArray(allow) || allow.length > MAX_NETWORK_DOMAINS) {
    throw bad(`allow must be an array of at most ${MAX_NETWORK_DOMAINS} strings`);
  }
  for (const entry of allow) {
    if (typeof entry !== "string" || entry.length > MAX_NETWORK_DOMAIN_LENGTH) {
      throw bad(`allow entries must be strings of at most ${MAX_NETWORK_DOMAIN_LENGTH} characters`);
    }
  }
  const result: WrapNetwork = { mode: network.mode, allow: allow as string[] };
  if (network.suggested !== undefined) {
    const suggested = network.suggested;
    if (typeof suggested !== "object" || suggested === null || Array.isArray(suggested)) {
      throw bad("suggested must be an object");
    }
    const entries = Object.entries(suggested);
    if (entries.length > MAX_NETWORK_DOMAINS) {
      throw bad(`suggested must have at most ${MAX_NETWORK_DOMAINS} entries`);
    }
    for (const [domain, skill] of entries) {
      if (
        domain.length > MAX_NETWORK_DOMAIN_LENGTH ||
        typeof skill !== "string" ||
        skill.length > MAX_NETWORK_DOMAIN_LENGTH
      ) {
        throw bad(`suggested must map domains to skill names of at most ${MAX_NETWORK_DOMAIN_LENGTH} characters`);
      }
    }
    result.suggested = suggested as Record<string, string>;
  }
  return result;
}
