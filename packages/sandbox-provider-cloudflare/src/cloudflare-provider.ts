import {
  SandboxProviderError,
  SANDBOX_PROVIDER_ERROR_CODES,
  isSandboxInstanceMissingError,
  redactSandboxText,
} from "@sourceweft/builtin-tool-sandbox";
import { randomUUID } from "node:crypto";
import type { ExecuteResponse } from "deepagents";
import type {
  SandboxProvider,
  SandboxProviderPathPolicy,
} from "@sourceweft/builtin-tool-sandbox";

/**
 * Provider for Cloudflare Sandboxes behind the STOCK Sandbox Bridge worker
 * (docs/architecture/cloudflare-sandbox-provider.md).
 *
 * Everything SourceWeft-specific is client-side in this file; the bridge is an
 * unmodified `cloudflare/sandbox-sdk/bridge/worker` template deployment. Two
 * consequences shape the implementation:
 *
 * - Liveness is a STAMP FILE, not an existence probe. Cloudflare's
 *   `getSandbox(name)` is lazy get-or-create and never 404s, so "does the
 *   sandbox still exist" is answered by reading back
 *   `/workspace/.sourceweft-sandbox-id` (written at create). A missing or
 *   mismatched stamp — including a container that slept and woke without its
 *   filesystem — surfaces as SANDBOX_NOT_FOUND_OR_EXPIRED so the manager
 *   expires the DB row and recreates. The stamp is checked at acquisition
 *   (get/health), inside every exec before the command runs, and behind every
 *   download miss (see EXEC_STAMP_GUARD_EXIT_CODE), so a container the SDK
 *   restarts between two commands cannot serve a command silently.
 * - `cwd` is wrapped into the shell line (`cd <cwd> && …`) because the stock
 *   bridge exec endpoint takes only argv + timeout.
 */

export const CLOUDFLARE_SANDBOX_PATH_POLICY: SandboxProviderPathPolicy =
  Object.freeze({
    workspaceRoot: "/workspace",
    defaultCwd: "/workspace",
    prepareTargetRoots: Object.freeze(["/workspace/input", "/workspace"]),
    collectSourceRoots: Object.freeze(["/workspace/output", "/workspace"]),
    readWriteRoots: Object.freeze(["/workspace"]),
  });

export const SOURCEWEFT_SANDBOX_STAMP_PATH =
  "/workspace/.sourceweft-sandbox-id";

const WORKSPACE_ROOT_PREFIX = "/workspace/";

const EMPTY_DOWNLOAD_METADATA_TIMEOUT_MS = 5_000;
const FILE_STAT_PROTOCOL = "sourceweft-file-stat-v1";
// Python is an existing declared image dependency. Paths are argv data, never
// interpolated into Python or evaluated as shell code. No file is opened/written.
const EMPTY_DOWNLOAD_STAT_SCRIPT = `import errno,json,os,stat,sys
try:
    info=os.stat(sys.argv[1],follow_symlinks=False)
except FileNotFoundError:
    result={"kind":"missing","errno":errno.ENOENT}
except OSError as error:
    result={"kind":"error","errno":error.errno}
else:
    result={"kind":"regular","size":info.st_size} if stat.S_ISREG(info.st_mode) else {"kind":"not_regular"}
print(json.dumps({"protocol":"sourceweft-file-stat-v1",**result},separators=(",",":")))`;

export type CloudflareProviderOperation =
  "create" | "get" | "delete" | "execute" | "upload" | "download" | "mkdir";

export type CloudflareSandboxProviderOptions = {
  bridgeUrl: string;
  apiKey: string;
  maxOutputChars: number;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Test seam for the readiness probe's wall clock and the probe/unavailable
   * retry backoff sleep; defaults to `Date.now` and an abortable `setTimeout`.
   */
  clock?: ProviderClock;
};

export type ProviderClock = {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_PROVIDER_CLOCK: ProviderClock = Object.freeze({
  now: () => Date.now(),
  sleep: sleepWithSignal,
});

/**
 * An HTTP failure from the bridge, carrying the status the error mapper keys
 * on. The response body is captured (truncated) as diagnostic detail only.
 */
export class CloudflareBridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly operation: CloudflareProviderOperation,
    detail: string,
  ) {
    super(`bridge responded ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "CloudflareBridgeHttpError";
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bridge file routes address paths relative to the workspace:
 * `/v1/sandbox/{id}/file/workspace/{relative}`. Every sandbox path the runtime
 * hands a provider is already policy-checked to live under /workspace; this
 * converts it to the route segment and rejects anything else defensively.
 */
export function workspaceRelativePath(sandboxPath: string): string {
  if (!sandboxPath.startsWith(WORKSPACE_ROOT_PREFIX)) {
    throw new Error(
      `SANDBOX_FILE_PATH_DENIED: ${sandboxPath} is outside the /workspace root.`,
    );
  }
  const relative = sandboxPath.slice(WORKSPACE_ROOT_PREFIX.length);
  if (!relative || relative.split("/").some((part) => part === "..")) {
    throw new Error(
      `SANDBOX_FILE_PATH_DENIED: ${sandboxPath} is not a valid workspace file path.`,
    );
  }
  return relative.split("/").map(encodeURIComponent).join("/");
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

function errorDiagnostic(error: unknown) {
  const message = errorMessage(error);
  return redactSandboxText(message).slice(0, 200);
}

export function mapCloudflareProviderError(
  error: unknown,
  operation: CloudflareProviderOperation,
) {
  const message = errorMessage(error).toLowerCase();
  const status =
    error instanceof CloudflareBridgeHttpError ? error.status : null;

  if (message.startsWith("sandbox_")) {
    // Already one of our platform codes (stamp mismatch, path denial, …).
    return error instanceof Error ? error : new Error(String(error));
  }

  if (status === 401 || status === 403) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.authentication,
      "SANDBOX_PROVIDER_AUTH_FAILED: sandbox provider authentication failed. Check sandbox provider credentials and API URL.",
      operation,
      error,
    );
  }

  if (status === 404 && operation === "download") {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
      "SANDBOX_FILE_NOT_FOUND: requested sandbox file was not found.",
      operation,
      error,
    );
  }

  if (status === 404 && (operation === "get" || operation === "delete")) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
      "SANDBOX_NOT_FOUND_OR_EXPIRED: sandbox was not found or has expired. Retry the operation to create a fresh sandbox.",
      operation,
      error,
    );
  }

  if (
    status === 408 ||
    status === 504 ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted")
  ) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.timeout,
      "SANDBOX_COMMAND_TIMEOUT: sandbox command exceeded the configured timeout.",
      operation,
      error,
    );
  }

  if (
    status === 429 ||
    (status !== null && status >= 500) ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("socket")
  ) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.unavailable,
      "SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox provider container is temporarily unavailable. Retry when the provider is available.",
      operation,
      error,
    );
  }

  const diagnostic = errorDiagnostic(error);
  return new SandboxProviderError(
    SANDBOX_PROVIDER_ERROR_CODES.unknown,
    `SANDBOX_PROVIDER_ERROR: sandbox provider ${operation} failed${
      diagnostic ? `: ${diagnostic}` : ""
    }. Check backend logs for provider diagnostics.`,
    operation,
    error,
  );
}

type SseEvent = { event: string; data: string };

/**
 * Minimal SSE parser over a fetch body. The stock bridge streams exec output
 * as `event: stdout|stderr|exit|error` blocks; `data:` payloads are passed to
 * the caller raw (they may be JSON or plain text depending on bridge version —
 * `extractSseText`/`extractExitCode` stay tolerant of both).
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        buffered += decoder.decode(value, { stream: true });
      }
      let separator: number;
      while ((separator = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice("event:".length).trim();
          } else if (line.startsWith("data:")) {
            data.push(line.slice("data:".length).trimStart());
          }
        }
        if (data.length > 0 || event !== "message") {
          yield { event, data: data.join("\n") };
        }
      }
      if (done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The deployed bridge (@cloudflare/sandbox 0.12.x) emits stdout/stderr `data:`
 * payloads as the raw base64 of the chunk bytes (live-verified 2026-08-16).
 * JSON shapes are kept as tolerance for other bridge versions, and anything
 * that is neither strict base64 nor JSON passes through as plain text.
 */
export function extractSseText(data: string): string {
  if (!data) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["text", "data", "chunk", "output", "line"]) {
        if (typeof record[key] === "string") {
          return record[key];
        }
      }
      return "";
    }
  } catch {
    // Not JSON — base64 or plain text.
  }
  if (data.length % 4 === 0 && BASE64_PATTERN.test(data)) {
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") === data) {
      return decoded.toString("utf8");
    }
  }
  return data;
}

export function extractExitCode(data: string): number | null {
  if (!data) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["exitCode", "exit_code", "code"]) {
        if (typeof record[key] === "number" && Number.isFinite(record[key])) {
          return record[key] as number;
        }
      }
    }
  } catch {
    const numeric = Number(data.trim());
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

/** Grace on top of the command budget before the client aborts the stream. */
const EXECUTE_ABORT_GRACE_MS = 15_000;

/**
 * Live-measured (2026-08-16): an exec SSE stream that stays SILENT dies
 * between 180s (passes) and 300s (reliably terminated) — an intermediary
 * drops idle streams, surfacing as "terminated" only when the container
 * finally writes. Chatty streams survive at least the 8-minute batch budget.
 *
 * Commands granted more than HEARTBEAT_THRESHOLD_MS are therefore wrapped
 * with a background stderr heartbeat that keeps bytes flowing; the marker is
 * control-character-delimited so it cannot collide with real output, and the
 * client strips it from the accumulated stream.
 */
const HEARTBEAT_THRESHOLD_MS = 120_000;
const HEARTBEAT_INTERVAL_SECONDS = 45;
export const EXEC_HEARTBEAT_MARKER = "[sourceweft-heartbeat]";

/*
 * Mid-run identity guard (Issue #323 follow-up, observed 2026-10-23). The
 * `@cloudflare/containers` runtime restarts a container whose status probe
 * fails transiently (the Worker logs "Failed to check container status,
 * assuming stopped"), and the fresh container behind the same name has an
 * empty /workspace and /skills. The acquisition-time stamp check cannot see
 * a swap that happens between two commands, so every exec re-reads the stamp
 * in the same shell line BEFORE the command: on a mismatch it prints a
 * nonce-tagged marker and exits with EXEC_STAMP_GUARD_EXIT_CODE instead of
 * running, and the client maps exactly that outcome (that exit code and only
 * the marker as output) to SANDBOX_NOT_FOUND_OR_EXPIRED. No extra round trip;
 * the per-attempt nonce keeps a command that merely prints the marker from
 * being mistaken for a replaced container, and the marker is control-character
 * delimited like the heartbeat's. Downloads check the stamp only behind a miss
 * (a fresh container has no files), see `downloadFile`.
 */
export const EXEC_STAMP_GUARD_EXIT_CODE = 203;
export const EXEC_STAMP_MISMATCH_MARKER =
  "\u001f[sourceweft-stamp-mismatch]\u001f";

/*
 * Readiness probe run at the end of `createSandbox` (S1 of the cold-start
 * recovery plan, Issue #323). Live-measured 2026-10-18: a cold Cloudflare
 * create takes 21–70 s and the first command then sat at 56–77 s or timed out,
 * because `POST /v1/sandbox` + stamp write returns before the container can
 * actually run a command. The probe re-reads the stamp and runs `true` until
 * the bridge answers, so cold start is paid inside create (where the manager
 * already retries and no tool budget is ticking) instead of by the first
 * model command.
 */
/** Single exec attempt budget for the probe's `true` command. */
export const READINESS_PROBE_COMMAND_TIMEOUT_MS = 5_000;
/** Total wall clock the probe may spend before create fails closed. */
export const READINESS_PROBE_BUDGET_MS = 90_000;
/** Backoff before each retry; the last entry repeats once the sequence is exhausted. */
export const READINESS_PROBE_BACKOFF_MS: readonly number[] = Object.freeze([
  1_000, 2_000, 4_000,
]);
const READINESS_PROBE_COMMAND = "true";
const READINESS_PROBE_MAX_OUTPUT_CHARS = 256;

/** Only transient provider failures keep the probe polling; everything else fails create. */
function isReadinessProbeRetryableError(error: unknown): boolean {
  return (
    error instanceof SandboxProviderError &&
    (error.code === SANDBOX_PROVIDER_ERROR_CODES.unavailable ||
      error.code === SANDBOX_PROVIDER_ERROR_CODES.timeout)
  );
}

/*
 * Bounded retry of transient unavailability (S4 of the cold-start recovery
 * plan, Issue #323): an idempotent operation that fails with
 * SANDBOX_NOT_READY_OR_UNHEALTHY is re-sent after each backoff entry in turn,
 * so the length of the sequence bounds the retries. Auth, missing-instance,
 * missing-file, timeout and unknown failures are never retried, nor is
 * anything once the caller's signal has aborted.
 */
/** Backoff before each retry; at most `length` retries (`length + 1` attempts). */
export const UNAVAILABLE_RETRY_BACKOFF_MS: readonly number[] = Object.freeze([
  1_000, 2_000, 4_000,
]);

/**
 * - `unavailable`: retry whatever maps to the `unavailable` provider code
 *   (GET/PUT/DELETE, which are safe to re-send).
 * - `notStarted`: retry only failures that prove the request never reached a
 *   command: an explicit HTTP 429/503 refusal, or a connection-level fetch
 *   rejection before any response (`fetch failed`, ECONNREFUSED, ECONNRESET).
 *   Other 5xx are excluded because an intermediary 500/502 can arrive while
 *   the first attempt is still running in the container (idempotent exec).
 * - `none`: single attempt.
 */
type UnavailableRetryPolicy = "unavailable" | "notStarted" | "none";

/** Fetch rejections raised before any response existed (see `notStarted`). */
const preResponseFailures = new WeakSet<object>();

/**
 * Abort reasons raised by a cancelled backoff sleep. They are cancellations,
 * not provider failures, so `withProviderErrorMapping` rethrows them as-is at
 * every nesting level. (A primitive reason cannot be tracked and is mapped
 * like any other abort.)
 */
const backoffAbortReasons = new WeakSet<object>();

function isUnavailableRetryable(
  error: unknown,
  operation: CloudflareProviderOperation,
  policy: UnavailableRetryPolicy,
): boolean {
  if (policy === "none") {
    return false;
  }
  const mapped = mapCloudflareProviderError(error, operation);
  if (
    !(mapped instanceof SandboxProviderError) ||
    mapped.code !== SANDBOX_PROVIDER_ERROR_CODES.unavailable
  ) {
    return false;
  }
  if (policy === "unavailable") {
    return true;
  }
  // `notStarted`: inspect the raw failure behind an already-mapped error.
  const raw = error instanceof SandboxProviderError ? error.cause : error;
  if (raw instanceof CloudflareBridgeHttpError) {
    return raw.status === 429 || raw.status === 503;
  }
  return (
    typeof raw === "object" && raw !== null && preResponseFailures.has(raw)
  );
}

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly id = "cloudflare";
  readonly pathPolicy = CLOUDFLARE_SANDBOX_PATH_POLICY;
  readonly cancellationScope = "sandbox" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: ProviderClock;

  constructor(private readonly options: CloudflareSandboxProviderOptions) {
    if (!options.bridgeUrl) {
      throw new Error(
        "SANDBOX_NOT_CONFIGURED: CF_SANDBOX_BRIDGE_URL is required.",
      );
    }
    if (!options.apiKey) {
      throw new Error(
        "SANDBOX_NOT_CONFIGURED: CF_SANDBOX_API_KEY is required.",
      );
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? DEFAULT_PROVIDER_CLOCK;
  }

  /**
   * `signal` is the optional host-cancellation signal of `CreateSandboxInput`
   * (typed inline so this provider does not depend on the shared type
   * carrying it): when it aborts, the readiness probe stops at once and the
   * half-created sandbox is deleted on a best-effort basis.
   */
  async createSandbox(input: {
    ttlSeconds: number;
    labels: Record<string, string>;
    signal?: AbortSignal;
  }) {
    const created = await this.withProviderErrorMapping("create", async () => {
      // Network options are deliberately absent: fully open egress is the
      // Cloudflare default and the product's goal state. TTL stays a
      // DB-enforced concern (the manager's expiry sweep calls deleteSandbox);
      // labels have no stock-bridge counterpart and the DB row already
      // carries the context.
      //
      // Neither the create POST nor the stamp PUT retries here: the manager
      // already retries a whole create that fails as unavailable (and logs
      // it), so a provider-level retry would only multiply attempts and push
      // the worst case past the manager's sibling wait.
      const response = await this.request("create", "POST", "/v1/sandbox");
      const payload = (await response.json()) as { id?: unknown };
      if (typeof payload.id !== "string" || !payload.id) {
        throw new Error("bridge create returned no sandbox id");
      }
      await this.putFile(
        "create",
        payload.id,
        SOURCEWEFT_SANDBOX_STAMP_PATH,
        new TextEncoder().encode(payload.id),
        "none",
      );
      return { id: payload.id };
    });
    try {
      await this.waitForSandboxReady(created.id, { signal: input.signal });
    } catch (error) {
      // Fail closed without leaving a container behind: the row for this id
      // is never written, so nothing else would ever delete it before TTL.
      // Single attempt: an abort must stop create at once, not after backoff.
      await this.deleteSandboxOnce(created.id).catch(() => undefined);
      throw error;
    }
    return created;
  }

  /**
   * Unavailable failures are retried with UNAVAILABLE_RETRY_BACKOFF_MS. The
   * interface carries no signal here, so that up-to-7 s backoff cannot be cut
   * short by a cancel.
   */
  async getSandbox(providerSandboxId: string) {
    return this.withProviderErrorMapping("get", () =>
      this.verifyStamp(providerSandboxId),
    );
  }

  /**
   * Unavailable failures are retried with UNAVAILABLE_RETRY_BACKOFF_MS. The
   * interface carries no signal here, so that up-to-7 s backoff cannot be cut
   * short by a cancel.
   */
  async checkSandboxHealth(providerSandboxId: string) {
    return this.withProviderErrorMapping("get", () =>
      this.verifyStamp(providerSandboxId),
    );
  }

  /**
   * Unavailable failures are retried with UNAVAILABLE_RETRY_BACKOFF_MS. The
   * interface carries no signal here, so that up-to-7 s backoff cannot be cut
   * short by a cancel.
   */
  async deleteSandbox(providerSandboxId: string) {
    return this.deleteSandboxWith(providerSandboxId, "unavailable");
  }

  /** Best-effort cleanup that must not wait out a retry backoff. */
  private async deleteSandboxOnce(providerSandboxId: string) {
    return this.deleteSandboxWith(providerSandboxId, "none");
  }

  private async deleteSandboxWith(
    providerSandboxId: string,
    retry: UnavailableRetryPolicy,
  ) {
    return this.withProviderErrorMapping("delete", async () => {
      await this.request(
        "delete",
        "DELETE",
        `/v1/sandbox/${encodeURIComponent(providerSandboxId)}`,
        { retry },
      );
    });
  }

  /** The stock bridge has no command-kill route, so cancellation is sandbox-scoped. */
  async cancelExecution(input: {
    providerSandboxId: string;
    executionId: string;
    reason: "user_cancelled" | "timed_out";
  }) {
    try {
      await this.deleteSandbox(input.providerSandboxId);
    } catch (error) {
      if (!isSandboxInstanceMissingError(error)) {
        throw error;
      }
    }
    return { confirmed: true, mode: "sandbox" } as const;
  }

  async execute(input: {
    providerSandboxId: string;
    executionId?: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal;
  }) {
    // Model commands are never retried: whatever the caller's object carries,
    // `idempotent` is forced off so the flag cannot leak through.
    return this.executeSystem({ ...input, idempotent: false });
  }

  async executeSystem(input: {
    providerSandboxId: string;
    executionId?: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal;
    /**
     * The caller asserts the command is safe to re-run. Only host-issued
     * system commands set it (model commands never do); a whole attempt whose
     * exec was refused (HTTP 429/503) or never connected is then retried with
     * UNAVAILABLE_RETRY_BACKOFF_MS, each attempt with the same `timeoutMs`.
     * Other 5xx, timeouts and aborts are never retried. Absent/false: one
     * attempt.
     */
    idempotent?: boolean;
  }): Promise<ExecuteResponse> {
    return this.executeSystemWithRetry(input);
  }

  /**
   * `deadline` (provider-clock ms) bounds the idempotent retries: a retry
   * whose backoff plus attempt timeout would end past it is not started.
   */
  private async executeSystemWithRetry(
    input: Parameters<CloudflareSandboxProvider["executeSystem"]>[0],
    deadline?: number,
  ): Promise<ExecuteResponse> {
    return this.withUnavailableRetry(
      "execute",
      input.idempotent === true ? "notStarted" : "none",
      input.signal,
      () => this.executeSystemAttempt(input),
      { deadline, attemptMs: input.timeoutMs },
    );
  }

  private async executeSystemAttempt(input: {
    providerSandboxId: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal;
  }): Promise<ExecuteResponse> {
    return this.withProviderErrorMapping("execute", async () => {
      const base = input.cwd
        ? `cd ${shellQuote(input.cwd)} && ${input.command}`
        : input.command;
      const guarded =
        input.timeoutMs > HEARTBEAT_THRESHOLD_MS
          ? // The loop writes the marker through fd 3 (a copy of stderr) while its `sleep` children
            // hold no exec pipes at all: once the loop is killed the orphaned sleep must not keep the
            // bridge's output stream open, which used to cost up to one heartbeat interval per command.
            `( while true; do sleep ${HEARTBEAT_INTERVAL_SECONDS} 3>&-; printf '%s\\n' ${shellQuote(EXEC_HEARTBEAT_MARKER)} >&3; done ) 3>&2 >/dev/null 2>&1 </dev/null & __sw_hb=$!; ( ${base} ); __sw_rc=$?; kill "$__sw_hb" 2>/dev/null; exit "$__sw_rc"`
          : base;
      // Identity guard first (see EXEC_STAMP_GUARD_EXIT_CODE): a replaced
      // container exits here, before `cd`, the heartbeat or the command.
      const guardOutput = `${EXEC_STAMP_MISMATCH_MARKER}${randomUUID()}`;
      const command = `[ "$(cat ${shellQuote(SOURCEWEFT_SANDBOX_STAMP_PATH)} 2>/dev/null)" = ${shellQuote(input.providerSandboxId)} ] || { printf '%s' ${shellQuote(guardOutput)}; exit ${EXEC_STAMP_GUARD_EXIT_CODE}; }; ${guarded}`;
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(input.signal?.reason);
      if (input.signal?.aborted) {
        forwardAbort();
      } else {
        input.signal?.addEventListener("abort", forwardAbort, { once: true });
      }
      const abortTimer = setTimeout(
        () => controller.abort(),
        input.timeoutMs + EXECUTE_ABORT_GRACE_MS,
      );
      try {
        const response = await this.request(
          "execute",
          "POST",
          `/v1/sandbox/${encodeURIComponent(input.providerSandboxId)}/exec`,
          {
            body: JSON.stringify({
              argv: ["sh", "-lc", command],
              timeout_ms: input.timeoutMs,
            }),
            contentType: "application/json",
            signal: controller.signal,
          },
        );
        if (!response.body) {
          throw new Error("bridge exec returned no response stream");
        }
        let output = "";
        let truncated = false;
        let exitCode: number | null = null;
        let streamError: string | null = null;
        for await (const { event, data } of parseSseStream(response.body)) {
          if (event === "stdout" || event === "stderr") {
            if (truncated) {
              continue; // Keep draining so the exit event still arrives.
            }
            const text = extractSseText(data)
              .split(`${EXEC_HEARTBEAT_MARKER}\n`)
              .join("")
              .split(EXEC_HEARTBEAT_MARKER)
              .join("");
            if (!text) {
              continue;
            }
            output += text;
            if (output.length > input.maxOutputChars) {
              output = output.slice(0, input.maxOutputChars);
              truncated = true;
            }
          } else if (event === "exit") {
            exitCode = extractExitCode(data);
          } else if (event === "error") {
            streamError = extractSseText(data) || data || "unknown error";
          }
        }
        if (streamError) {
          throw new Error(streamError);
        }
        if (exitCode === EXEC_STAMP_GUARD_EXIT_CODE && output === guardOutput) {
          throw new SandboxProviderError(
            SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
            "SANDBOX_NOT_FOUND_OR_EXPIRED: the sandbox identity stamp was missing or did not match when the command started; the container was replaced and the command did not run.",
            "execute",
          );
        }
        return {
          output: truncated ? `${output}\n\n[output truncated]` : output,
          exitCode,
          truncated,
        };
      } finally {
        clearTimeout(abortTimer);
        input.signal?.removeEventListener("abort", forwardAbort);
      }
    });
  }

  /**
   * Unavailable failures are retried with UNAVAILABLE_RETRY_BACKOFF_MS. The
   * interface carries no signal here, so that up-to-7 s backoff cannot be cut
   * short by a cancel.
   */
  async uploadFile(input: {
    providerSandboxId: string;
    sandboxPath: string;
    content: Uint8Array;
  }) {
    return this.withProviderErrorMapping("upload", () =>
      this.putFile(
        "upload",
        input.providerSandboxId,
        input.sandboxPath,
        input.content,
      ),
    );
  }

  async downloadFile(input: {
    providerSandboxId: string;
    executionId?: string;
    sandboxPath: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) {
    return this.withProviderErrorMapping("download", async () => {
      const startedAt = this.clock.now();
      let response: Response;
      try {
        response = await this.request(
          "download",
          "GET",
          this.filePath(input.providerSandboxId, input.sandboxPath),
          { signal: input.signal },
        );
      } catch (error) {
        if (
          error instanceof CloudflareBridgeHttpError &&
          error.status === 404
        ) {
          // A container the SDK replaced has no files at all, so a miss is
          // only a missing FILE once the stamp proves the container is still
          // the one this id was created for. Checked only on the miss path:
          // a hit costs nothing extra, and a fresh container cannot hit.
          await this.verifyStamp(
            input.providerSandboxId,
            "unavailable",
            input.signal,
          );
        }
        throw error;
      }
      const content = Buffer.from(await response.arrayBuffer());
      if (content.byteLength !== 0) return content;
      // The stock bridge can turn a missing-file stream into HTTP 200 + zero
      // bytes. Zero bytes alone never prove absence: preserve real empty files.
      await this.confirmEmptyDownload(input, startedAt);
      return content;
    });
  }

  private async confirmEmptyDownload(
    input: {
      providerSandboxId: string;
      executionId?: string;
      sandboxPath: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
    startedAt: number,
  ): Promise<void> {
    input.signal?.throwIfAborted();
    if (
      input.timeoutMs !== undefined &&
      (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
    ) {
      throw new Error(
        "SANDBOX_FILE_METADATA_INVALID: invalid download timeout.",
      );
    }
    const remaining =
      input.timeoutMs === undefined
        ? EMPTY_DOWNLOAD_METADATA_TIMEOUT_MS
        : input.timeoutMs - (this.clock.now() - startedAt);
    if (remaining <= 0) {
      throw new SandboxProviderError(
        SANDBOX_PROVIDER_ERROR_CODES.timeout,
        "SANDBOX_COMMAND_TIMEOUT: no download budget remains for metadata verification.",
        "download",
      );
    }
    // Retries stay inside the download's own budget when it has one.
    const result = await this.executeSystemWithRetry(
      {
        providerSandboxId: input.providerSandboxId,
        executionId: input.executionId,
        command: `python3 -c ${shellQuote(EMPTY_DOWNLOAD_STAT_SCRIPT)} ${shellQuote(input.sandboxPath)}`,
        timeoutMs: Math.min(EMPTY_DOWNLOAD_METADATA_TIMEOUT_MS, remaining),
        maxOutputChars: 2_048,
        signal: input.signal,
        idempotent: true,
      },
      input.timeoutMs === undefined ? undefined : startedAt + input.timeoutMs,
    );
    input.signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.truncated) {
      throw new Error(
        "SANDBOX_FILE_METADATA_FAILED: metadata command did not complete successfully.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.output);
    } catch {
      throw new Error(
        "SANDBOX_FILE_METADATA_INVALID: metadata command returned invalid JSON.",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        "SANDBOX_FILE_METADATA_INVALID: expected a structured metadata result.",
      );
    }
    const value = parsed as Record<string, unknown>;
    const fields = (...keys: string[]) =>
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key));
    if (value.protocol !== FILE_STAT_PROTOCOL) {
      throw new Error(
        "SANDBOX_FILE_METADATA_INVALID: metadata protocol mismatch.",
      );
    }
    if (
      value.kind === "missing" &&
      fields("protocol", "kind", "errno") &&
      value.errno === 2
    ) {
      throw new SandboxProviderError(
        SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
        "SANDBOX_FILE_NOT_FOUND: requested sandbox file was not found.",
        "download",
      );
    }
    if (
      value.kind === "regular" &&
      fields("protocol", "kind", "size") &&
      Number.isSafeInteger(value.size) &&
      (value.size as number) >= 0
    ) {
      if (value.size === 0) return;
      throw new Error(
        "SANDBOX_FILE_DOWNLOAD_INCOMPLETE: the bridge returned zero bytes for a nonempty regular file.",
      );
    }
    if (value.kind === "not_regular" && fields("protocol", "kind")) {
      throw new Error(
        "SANDBOX_FILE_NOT_REGULAR: empty download metadata does not describe a regular file.",
      );
    }
    if (
      value.kind === "error" &&
      fields("protocol", "kind", "errno") &&
      (value.errno === null ||
        (Number.isSafeInteger(value.errno) && (value.errno as number) > 0))
    ) {
      throw new Error(
        `SANDBOX_FILE_METADATA_FAILED: stat failed with errno ${value.errno}.`,
      );
    }
    throw new Error(
      "SANDBOX_FILE_METADATA_INVALID: metadata fields are not valid for the result kind.",
    );
  }

  async ensureDirectory(input: {
    providerSandboxId: string;
    directory: string;
  }) {
    return this.withProviderErrorMapping("mkdir", async () => {
      const result = await this.executeSystem({
        providerSandboxId: input.providerSandboxId,
        command: `mkdir -p ${shellQuote(input.directory)}`,
        timeoutMs: 30_000,
        maxOutputChars: this.options.maxOutputChars,
        idempotent: true,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `SANDBOX_DIRECTORY_CREATE_FAILED: mkdir failed${
            result.output ? `: ${result.output.slice(0, 200)}` : ""
          }`,
        );
      }
    });
  }

  /**
   * Poll `verifyStamp` + `true` until the container executes commands, or
   * fail closed with SANDBOX_NOT_READY_OR_UNHEALTHY once
   * READINESS_PROBE_BUDGET_MS is spent. Only `unavailable` and `timeout`
   * provider codes (plus a `true` that did not exit 0, which is the same
   * "container not serving yet" signal) are retried; auth, missing-instance
   * and unknown errors propagate at once. An aborted `signal` rethrows its
   * reason immediately, including mid-backoff.
   */
  private async waitForSandboxReady(
    providerSandboxId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const { signal } = options;
    const startedAt = this.clock.now();
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      try {
        // This loop is the retry: neither the stamp read nor the probe exec
        // (not idempotent-flagged) retries internally, so retries never nest
        // and the budget is not overshot.
        await this.withProviderErrorMapping("get", () =>
          this.verifyStamp(providerSandboxId, "none"),
        );
        const result = await this.executeSystem({
          providerSandboxId,
          command: READINESS_PROBE_COMMAND,
          timeoutMs: READINESS_PROBE_COMMAND_TIMEOUT_MS,
          maxOutputChars: READINESS_PROBE_MAX_OUTPUT_CHARS,
          signal,
        });
        if (result.exitCode === 0) {
          return;
        }
        throw new SandboxProviderError(
          SANDBOX_PROVIDER_ERROR_CODES.unavailable,
          `SANDBOX_NOT_READY_OR_UNHEALTHY: readiness probe exited with ${String(result.exitCode)}.`,
          "execute",
        );
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason;
        }
        if (!isReadinessProbeRetryableError(error)) {
          throw error;
        }
        const delayMs =
          READINESS_PROBE_BACKOFF_MS[
            Math.min(attempt, READINESS_PROBE_BACKOFF_MS.length - 1)
          ]!;
        const elapsedMs = this.clock.now() - startedAt;
        if (elapsedMs + delayMs >= READINESS_PROBE_BUDGET_MS) {
          throw new SandboxProviderError(
            SANDBOX_PROVIDER_ERROR_CODES.unavailable,
            `SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox did not become ready within ${READINESS_PROBE_BUDGET_MS / 1000}s after create. Retry the operation to create a fresh sandbox.`,
            "create",
            error,
          );
        }
        await this.clock.sleep(delayMs, signal);
      }
    }
  }

  /**
   * Read the stamp back and require it to match the sandbox id. A bridge 404
   * (no such file) and a mismatched id (fresh container behind the same DO
   * name) both mean the sandbox this row refers to no longer exists.
   */
  private async verifyStamp(
    providerSandboxId: string,
    retry: UnavailableRetryPolicy = "unavailable",
    signal?: AbortSignal,
  ) {
    let response: Response;
    try {
      response = await this.request(
        "get",
        "GET",
        this.filePath(providerSandboxId, SOURCEWEFT_SANDBOX_STAMP_PATH),
        { retry, signal },
      );
    } catch (error) {
      // A missing stamp proves identity loss; a generic 400 does not.
      if (error instanceof CloudflareBridgeHttpError && error.status === 404) {
        throw new SandboxProviderError(
          SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
          "SANDBOX_NOT_FOUND_OR_EXPIRED: sandbox identity stamp was not found.",
          "get",
          error,
        );
      }
      throw error;
    }
    const stamp = (await response.text()).trim();
    if (stamp !== providerSandboxId) {
      throw new SandboxProviderError(
        SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
        "SANDBOX_NOT_FOUND_OR_EXPIRED: sandbox identity stamp did not match.",
        "get",
      );
    }
    return { id: providerSandboxId };
  }

  private filePath(providerSandboxId: string, sandboxPath: string) {
    return `/v1/sandbox/${encodeURIComponent(providerSandboxId)}/file/workspace/${workspaceRelativePath(sandboxPath)}`;
  }

  private async putFile(
    operation: CloudflareProviderOperation,
    providerSandboxId: string,
    sandboxPath: string,
    content: Uint8Array,
    retry?: UnavailableRetryPolicy,
  ) {
    await this.request(
      operation,
      "PUT",
      this.filePath(providerSandboxId, sandboxPath),
      {
        body: content,
        contentType: "application/octet-stream",
        retry,
      },
    );
  }

  private async request(
    operation: CloudflareProviderOperation,
    method: string,
    path: string,
    init: {
      /**
       * Deliberately not a stream: a string or byte array can be re-sent
       * verbatim by the unavailable retry.
       */
      body?: string | Uint8Array;
      contentType?: string;
      signal?: AbortSignal;
      /**
       * Defaults to `unavailable` for GET/PUT/DELETE and `none` for POST: a
       * POST (create, exec) is never re-sent unless its caller opts in.
       */
      retry?: UnavailableRetryPolicy;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
    };
    if (init.contentType) {
      headers["Content-Type"] = init.contentType;
    }
    return this.withUnavailableRetry(
      operation,
      init.retry ?? (method === "POST" ? "none" : "unavailable"),
      init.signal,
      async () => {
        let response: Response;
        try {
          response = await this.fetchImpl(`${this.options.bridgeUrl}${path}`, {
            method,
            headers,
            // TS 5.9 types Uint8Array over ArrayBufferLike, which no longer
            // satisfies BodyInit's BufferSource; the runtime accepts it fine.
            body: init.body as BodyInit | undefined,
            signal: init.signal,
          });
        } catch (error) {
          if (typeof error === "object" && error !== null) {
            preResponseFailures.add(error);
          }
          throw error;
        }
        if (!response.ok) {
          const detail = await response
            .text()
            .then((text) => text.slice(0, 200))
            .catch(() => "");
          throw new CloudflareBridgeHttpError(
            response.status,
            operation,
            detail,
          );
        }
        return response;
      },
    );
  }

  /**
   * Run `attempt`, re-running it after each UNAVAILABLE_RETRY_BACKOFF_MS
   * entry while `policy` deems the failure retryable. The decision keys on
   * the mapped provider code (`mapCloudflareProviderError`), so status logic
   * lives in one place; the last failure is rethrown unchanged for the normal
   * mapping. An abort during the backoff rethrows the abort reason at once.
   * With a `deadline` (provider-clock ms), a retry whose backoff plus
   * `attemptMs` would end past it is not started.
   */
  private async withUnavailableRetry<T>(
    operation: CloudflareProviderOperation,
    policy: UnavailableRetryPolicy,
    signal: AbortSignal | undefined,
    attempt: () => Promise<T>,
    bounds: { deadline?: number; attemptMs?: number } = {},
  ): Promise<T> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await attempt();
      } catch (error) {
        const delayMs = UNAVAILABLE_RETRY_BACKOFF_MS[retry];
        if (
          delayMs === undefined ||
          signal?.aborted ||
          !isUnavailableRetryable(error, operation, policy) ||
          (bounds.deadline !== undefined &&
            this.clock.now() + delayMs + (bounds.attemptMs ?? 0) >
              bounds.deadline)
        ) {
          throw error;
        }
        try {
          await this.clock.sleep(delayMs, signal);
        } catch (abortReason) {
          if (typeof abortReason === "object" && abortReason !== null) {
            backoffAbortReasons.add(abortReason);
          }
          throw abortReason;
        }
      }
    }
  }

  private async withProviderErrorMapping<T>(
    operation: CloudflareProviderOperation,
    fn: () => Promise<T>,
  ) {
    try {
      return await fn();
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        backoffAbortReasons.has(error)
      ) {
        throw error;
      }
      throw mapCloudflareProviderError(error, operation);
    }
  }
}
