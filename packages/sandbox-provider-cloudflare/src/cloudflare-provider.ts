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
 *   expires the DB row and recreates.
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

export type CloudflareProviderOperation =
  | "create"
  | "get"
  | "delete"
  | "execute"
  | "upload"
  | "download"
  | "mkdir";

export type CloudflareSandboxProviderOptions = {
  bridgeUrl: string;
  apiKey: string;
  maxOutputChars: number;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

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
  return message.slice(0, 200);
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
    return new Error(
      "SANDBOX_PROVIDER_AUTH_FAILED: sandbox provider authentication failed. Check sandbox provider credentials and API URL.",
    );
  }

  if (status === 404 && operation === "download") {
    return new Error(
      "SANDBOX_FILE_NOT_FOUND: requested sandbox file was not found.",
    );
  }

  if (status === 404) {
    return new Error(
      "SANDBOX_NOT_FOUND_OR_EXPIRED: sandbox was not found or has expired. Retry the operation to create a fresh sandbox.",
    );
  }

  if (
    status === 408 ||
    status === 504 ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted")
  ) {
    return new Error(
      "SANDBOX_COMMAND_TIMEOUT: sandbox command exceeded the configured timeout.",
    );
  }

  if (
    status === 429 ||
    (status !== null && status >= 500) ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("socket")
  ) {
    return new Error(
      "SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox provider container is not ready or has no network address. Retry the operation to create a fresh sandbox.",
    );
  }

  const diagnostic = errorDiagnostic(error);
  return new Error(
    `SANDBOX_PROVIDER_ERROR: sandbox provider ${operation} failed${
      diagnostic ? `: ${diagnostic}` : ""
    }. Check backend logs for provider diagnostics.`,
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

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly id = "cloudflare";
  readonly pathPolicy = CLOUDFLARE_SANDBOX_PATH_POLICY;
  private readonly fetchImpl: typeof fetch;

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
  }

  async createSandbox(_input: {
    ttlSeconds: number;
    labels: Record<string, string>;
  }) {
    return this.withProviderErrorMapping("create", async () => {
      // Network options are deliberately absent: fully open egress is the
      // Cloudflare default and the product's goal state. TTL stays a
      // DB-enforced concern (the manager's expiry sweep calls deleteSandbox);
      // labels have no stock-bridge counterpart and the DB row already
      // carries the context.
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
      );
      return { id: payload.id };
    });
  }

  async getSandbox(providerSandboxId: string) {
    return this.withProviderErrorMapping("get", () =>
      this.verifyStamp(providerSandboxId),
    );
  }

  async checkSandboxHealth(providerSandboxId: string) {
    return this.withProviderErrorMapping("get", () =>
      this.verifyStamp(providerSandboxId),
    );
  }

  async deleteSandbox(providerSandboxId: string) {
    return this.withProviderErrorMapping("delete", async () => {
      await this.request(
        "delete",
        "DELETE",
        `/v1/sandbox/${encodeURIComponent(providerSandboxId)}`,
      );
    });
  }

  async execute(input: {
    providerSandboxId: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
  }) {
    return this.executeSystem(input);
  }

  async executeSystem(input: {
    providerSandboxId: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
  }): Promise<ExecuteResponse> {
    return this.withProviderErrorMapping("execute", async () => {
      const base = input.cwd
        ? `cd ${shellQuote(input.cwd)} && ${input.command}`
        : input.command;
      const command =
        input.timeoutMs > HEARTBEAT_THRESHOLD_MS
          ? `( while true; do sleep ${HEARTBEAT_INTERVAL_SECONDS}; printf '%s\\n' ${shellQuote(EXEC_HEARTBEAT_MARKER)} >&2; done ) & __sw_hb=$!; ( ${base} ); __sw_rc=$?; kill "$__sw_hb" 2>/dev/null; exit "$__sw_rc"`
          : base;
      const controller = new AbortController();
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
        return {
          output: truncated ? `${output}\n\n[output truncated]` : output,
          exitCode,
          truncated,
        };
      } finally {
        clearTimeout(abortTimer);
      }
    });
  }

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
    sandboxPath: string;
  }) {
    return this.withProviderErrorMapping("download", async () => {
      const response = await this.request(
        "download",
        "GET",
        this.filePath(input.providerSandboxId, input.sandboxPath),
      );
      return Buffer.from(await response.arrayBuffer());
    });
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
   * Read the stamp back and require it to match the sandbox id. A bridge 404
   * (no such file) and a mismatched id (fresh container behind the same DO
   * name) both mean the sandbox this row refers to no longer exists.
   */
  private async verifyStamp(providerSandboxId: string) {
    let response: Response;
    try {
      response = await this.request(
        "get",
        "GET",
        this.filePath(providerSandboxId, SOURCEWEFT_SANDBOX_STAMP_PATH),
      );
    } catch (error) {
      // 404 = stamp file missing; 400 = the bridge rejected the sandbox id as
      // format-invalid (live-verified), which means it cannot exist either way.
      if (
        error instanceof CloudflareBridgeHttpError &&
        (error.status === 404 || error.status === 400)
      ) {
        throw new Error(
          "SANDBOX_NOT_FOUND_OR_EXPIRED: sandbox was not found or has expired. Retry the operation to create a fresh sandbox.",
        );
      }
      throw error;
    }
    const stamp = (await response.text()).trim();
    if (stamp !== providerSandboxId) {
      throw new Error(
        "SANDBOX_NOT_FOUND_OR_EXPIRED: sandbox was not found or has expired. Retry the operation to create a fresh sandbox.",
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
  ) {
    await this.request(
      operation,
      "PUT",
      this.filePath(providerSandboxId, sandboxPath),
      {
        body: content,
        contentType: "application/octet-stream",
      },
    );
  }

  private async request(
    operation: CloudflareProviderOperation,
    method: string,
    path: string,
    init: {
      body?: BodyInit | Uint8Array;
      contentType?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
    };
    if (init.contentType) {
      headers["Content-Type"] = init.contentType;
    }
    const response = await this.fetchImpl(
      `${this.options.bridgeUrl}${path}`,
      {
        method,
        headers,
        // TS 5.9 types Uint8Array over ArrayBufferLike, which no longer
        // satisfies BodyInit's BufferSource; the runtime accepts it fine.
        body: init.body as BodyInit | undefined,
        signal: init.signal,
      },
    );
    if (!response.ok) {
      const detail = await response
        .text()
        .then((text) => text.slice(0, 200))
        .catch(() => "");
      throw new CloudflareBridgeHttpError(response.status, operation, detail);
    }
    return response;
  }

  private async withProviderErrorMapping<T>(
    operation: CloudflareProviderOperation,
    fn: () => Promise<T>,
  ) {
    try {
      return await fn();
    } catch (error) {
      throw mapCloudflareProviderError(error, operation);
    }
  }
}
