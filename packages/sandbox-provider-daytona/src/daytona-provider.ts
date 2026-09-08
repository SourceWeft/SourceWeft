import {
  SandboxProviderError,
  SANDBOX_PROVIDER_ERROR_CODES,
  isSandboxInstanceMissingError,
  redactSandboxText,
} from "@sourceweft/builtin-tool-sandbox";
import {
  DaytonaSandbox as LangChainDaytonaSandbox,
  DaytonaSandboxError,
} from "@langchain/daytona";
import type { DaytonaSandboxOptions } from "@langchain/daytona";
import type { ExecuteResponse } from "deepagents";
import type {
  SandboxNetworkPolicy,
  SandboxProvider,
  SandboxProviderPathPolicy,
} from "@sourceweft/builtin-tool-sandbox";

type CreateSandboxInput = {
  labels: Record<string, string>;
  snapshot?: string;
  ttlSeconds: number;
  networkPolicy?: SandboxNetworkPolicy;
};

/**
 * GitHub hosts the ingestion sandbox must reach to fetch+extract a submitted
 * repo (docs/architecture/skill-registry-index.md §Stage2). Recorded here as
 * the *intent* of the `ingestion-github` policy.
 *
 * NOTE (Daytona network API shape): Daytona exposes exactly two knobs on
 * `CreateSandboxBaseParams` — `networkBlockAll: boolean` and
 * `networkAllowList: string` (a comma-separated list of allowed **CIDR**
 * ranges, NOT host names). There is no host-name allow-list primitive, so a
 * faithful `ingestion-github` policy has to be expressed as GitHub's published
 * IP ranges (https://api.github.com/meta → `git`/`web`/`api`, plus the Fastly
 * ranges that serve raw.githubusercontent.com / codeload), which rotate over
 * time.
 */
export const GITHUB_INGESTION_HOSTS = Object.freeze([
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
]);

// TODO(skill-registry R0 §7.0): resolve these from api.github.com/meta and
// refresh periodically — the static ranges below WILL drift. They are a
// best-effort stand-in until the ingestion-sandbox migration wires a live
// resolver. (github.com/codeload = 140.82.112.0/20 & 143.55.64.0/20;
// raw.githubusercontent.com is Fastly-served = 185.199.108.0/22; api =
// 192.30.252.0/22.)
export const GITHUB_INGESTION_ALLOW_CIDRS = Object.freeze([
  "140.82.112.0/20",
  "143.55.64.0/20",
  "185.199.108.0/22",
  "192.30.252.0/22",
]);

export type DaytonaNetworkOptions = {
  networkBlockAll?: boolean;
  networkAllowList?: string;
};

/**
 * Translate a platform network policy into Daytona SDK create parameters.
 * `default`/undefined leaves network options untouched (provider default
 * egress); `block-all` maps to `networkBlockAll`; `ingestion-github` maps to a
 * CIDR `networkAllowList` (see the drift TODO above).
 */
export function resolveDaytonaNetworkPolicyOptions(
  policy: SandboxNetworkPolicy | undefined,
): DaytonaNetworkOptions {
  switch (policy) {
    case "block-all":
      return { networkBlockAll: true };
    case "ingestion-github":
      return { networkAllowList: GITHUB_INGESTION_ALLOW_CIDRS.join(",") };
    case "default":
    case undefined:
      return {};
    default: {
      const exhaustive: never = policy;
      throw new Error(`Unknown sandbox network policy: ${String(exhaustive)}`);
    }
  }
}

export const DAYTONA_SANDBOX_PATH_POLICY: SandboxProviderPathPolicy =
  Object.freeze({
    workspaceRoot: "/workspace",
    defaultCwd: "/workspace",
    prepareTargetRoots: Object.freeze(["/workspace/input", "/workspace"]),
    collectSourceRoots: Object.freeze(["/workspace/output", "/workspace"]),
    readWriteRoots: Object.freeze(["/workspace"]),
  });

export type DaytonaProviderOperation =
  "create" | "get" | "delete" | "execute" | "upload" | "download" | "mkdir";

export type DaytonaSandboxInstance = {
  id: string;
  uploadFiles(files: Array<[string, Uint8Array]>): Promise<
    Array<{
      path: string;
      error: string | null;
    }>
  >;
  downloadFiles(paths: string[]): Promise<
    Array<{
      path: string;
      content: Uint8Array | null;
      error: string | null;
    }>
  >;
  instance: {
    process: {
      executeCommand(
        command: string,
        cwd?: string,
        env?: unknown,
        timeoutSeconds?: number,
      ): Promise<unknown>;
    };
    fs: {
      uploadFile(content: Buffer, path: string): Promise<unknown>;
      downloadFile(path: string): Promise<unknown>;
    };
  };
  close(): Promise<unknown>;
};

export type DaytonaSandboxClient = {
  create(options?: DaytonaSandboxOptions): Promise<DaytonaSandboxInstance>;
  fromId(
    id: string,
    options?: Pick<DaytonaSandboxOptions, "auth" | "target" | "timeout">,
  ): Promise<DaytonaSandboxInstance>;
};

const defaultDaytonaSandboxClient =
  LangChainDaytonaSandbox as unknown as DaytonaSandboxClient;

const DAYTONA_HEALTH_CHECK_TIMEOUT_MS = 30_000;
const DAYTONA_HEALTH_CHECK_INTERVAL_MS = 1_000;
const DAYTONA_HEALTH_CHECK_COMMAND_TIMEOUT_SECONDS = 5;

function providerErrorRecord(error: unknown) {
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)
    : {};
}

function providerErrorStatus(error: unknown) {
  const record = providerErrorRecord(error);
  const status = record.status ?? record.statusCode ?? record.code;
  return typeof status === "number" || typeof status === "string"
    ? String(status)
    : "";
}

function providerErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  const record = providerErrorRecord(error);
  return typeof record.message === "string" ? record.message : "";
}

function providerErrorCode(error: unknown) {
  if (DaytonaSandboxError.isInstance(error)) {
    return error.code.toLowerCase();
  }
  const record = providerErrorRecord(error);
  return typeof record.code === "string" ? record.code.toLowerCase() : "";
}

export function mapDaytonaProviderError(
  error: unknown,
  operation: DaytonaProviderOperation,
) {
  const code = providerErrorCode(error);
  const status = providerErrorStatus(error).toLowerCase();
  const message = providerErrorMessage(error).toLowerCase();

  if (error instanceof SandboxProviderError) return error;

  if (message.includes("sandbox_not_ready_or_unhealthy")) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.unavailable,
      "SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox provider container is temporarily unavailable. Retry when the provider is available.",
      operation,
      error,
    );
  }

  if (
    code === "authentication_failed" ||
    status === "401" ||
    status === "403" ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("invalid api key") ||
    message.includes("authentication")
  ) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.authentication,
      "SANDBOX_PROVIDER_AUTH_FAILED: sandbox provider authentication failed. Check sandbox provider credentials and API URL.",
      operation,
      error,
    );
  }

  if (
    message.includes("failed to resolve container ip") ||
    message.includes("no ip address found") ||
    message.includes("is the sandbox started") ||
    message.includes("sandbox not started") ||
    message.includes("container ip")
  ) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.unavailable,
      "SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox provider container is temporarily unavailable. Retry when the provider is available.",
      operation,
      error,
    );
  }

  if (
    operation === "download" &&
    code !== "sandbox_not_found" &&
    (message.includes("file not found") ||
      message.includes("no such file") ||
      message.includes("enoent") ||
      status === "404")
  ) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
      "SANDBOX_FILE_NOT_FOUND: requested sandbox file was not found.",
      operation,
      error,
    );
  }

  if (
    code === "sandbox_not_found" ||
    (status === "404" && (operation === "get" || operation === "delete")) ||
    message.includes("sandbox not found") ||
    message.includes("sandbox was not found")
  ) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
      "SANDBOX_NOT_FOUND_OR_EXPIRED: sandbox was not found or has expired. Retry the operation to create a fresh sandbox.",
      operation,
      error,
    );
  }

  if (
    code === "command_timeout" ||
    status === "408" ||
    status === "504" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("deadline")
  ) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.timeout,
      "SANDBOX_COMMAND_TIMEOUT: sandbox command exceeded the configured timeout.",
      operation,
      error,
    );
  }

  if (operation === "download" && message.includes("not found")) {
    return new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
      "SANDBOX_FILE_NOT_FOUND: requested sandbox file was not found.",
      operation,
      error,
    );
  }

  const diagnostic = redactSandboxText(providerErrorDiagnostic(error));
  return new SandboxProviderError(
    SANDBOX_PROVIDER_ERROR_CODES.unknown,
    `SANDBOX_PROVIDER_ERROR: sandbox provider ${operation} failed${
      diagnostic ? `: ${diagnostic}` : ""
    }. Check backend logs for provider diagnostics.`,
    operation,
    error,
  );
}

function normalizeExecutionOutput(
  result: unknown,
  maxChars: number,
): ExecuteResponse {
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const stdout =
    typeof record.output === "string"
      ? record.output
      : typeof record.result === "string"
        ? record.result
        : typeof (record.artifacts as { stdout?: unknown } | undefined)
              ?.stdout === "string"
          ? (record.artifacts as { stdout: string }).stdout
          : "";
  const stderr =
    typeof (record.artifacts as { stderr?: unknown } | undefined)?.stderr ===
    "string"
      ? (record.artifacts as { stderr: string }).stderr
      : "";
  const combined = [stdout, stderr].filter(Boolean).join(stderr ? "\n" : "");
  const truncated = record.truncated === true || combined.length > maxChars;
  return {
    output: truncated
      ? `${combined.slice(0, maxChars)}\n\n[output truncated]`
      : combined,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    truncated,
  };
}

export function assertDaytonaCommandSucceeded(
  result: unknown,
  input: { code: string; maxOutputChars: number },
) {
  const normalized = normalizeExecutionOutput(result, input.maxOutputChars);
  if (normalized.exitCode !== null && normalized.exitCode !== 0) {
    throw new Error(
      `${input.code}: sandbox command failed with exit code ${normalized.exitCode}${
        normalized.output ? `: ${normalized.output}` : ""
      }`,
    );
  }
  return normalized;
}

export function normalizeDaytonaDownloadResult(result: unknown): Buffer {
  if (Buffer.isBuffer(result)) {
    return result;
  }
  if (result instanceof Uint8Array) {
    return Buffer.from(result);
  }
  if (result instanceof ArrayBuffer) {
    return Buffer.from(result);
  }
  if (typeof result === "string") {
    return Buffer.from(result, "utf8");
  }
  throw new Error(
    `SANDBOX_DOWNLOAD_UNSUPPORTED_RESULT: unsupported download result type ${typeof result}`,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeProviderDiagnostic(message: string) {
  const signedUrlParamPattern =
    /(?:x-amz-|x-goog-|x-ms-|signature|token|credential|expires|policy|key-pair-id|response-content-disposition)/i;
  const redactSignedUrl = (value: string) => {
    try {
      const url = new URL(value);
      let changed = false;
      for (const key of Array.from(url.searchParams.keys())) {
        if (signedUrlParamPattern.test(key)) {
          url.searchParams.set(key, "[redacted]");
          changed = true;
        }
      }
      return changed ? url.toString() : value;
    } catch {
      return value;
    }
  };

  return message
    .replace(/https?:\/\/[^\s"'<>]+/giu, (value) => redactSignedUrl(value))
    .replace(
      /(^|[\s;])([A-Z0-9_]*(?:ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION)[A-Z0-9_]*)(\s*=\s*)([^"'\s,;&]+)/giu,
      "$1$2$3[redacted]",
    )
    .replace(
      /(^|[\s;])(api[-_ ]?key|authorization|bearer|token|secret)(["'\s:=]+)([^"'\s,;&]+)/giu,
      "$1$2$3[redacted]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu,
      "[redacted]",
    )
    .slice(0, 300);
}

function providerErrorDiagnostic(error: unknown) {
  const message = providerErrorMessage(error).trim();
  return message ? sanitizeProviderDiagnostic(message) : "";
}

export function isDaytonaImageReference(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("sha256:")) {
    return true;
  }

  const lastSlash = trimmed.lastIndexOf("/");
  const lastColon = trimmed.lastIndexOf(":");
  const hasRegistryOrNamespace = lastSlash > 0;
  const hasTagAfterRepository = lastColon > lastSlash + 1;
  const hasDigest = trimmed.includes("@sha256:");

  return hasDigest || hasTagAfterRepository || hasRegistryOrNamespace;
}

export type DaytonaSandboxTargetSource =
  "DAYTONA_SANDBOX_SNAPSHOT" | "DAYTONA_SANDBOX_IMAGE" | "request";

export type DaytonaSandboxTarget =
  | {
      kind: "snapshot";
      value: string;
      source: DaytonaSandboxTargetSource;
    }
  | {
      kind: "image";
      value: string;
      source: DaytonaSandboxTargetSource;
    };

export type DaytonaSandboxTargetResolution =
  | {
      configured: true;
      target: DaytonaSandboxTarget;
      missing: [];
      metadata: Record<string, unknown>;
    }
  | {
      configured: false;
      target: null;
      missing: string[];
      metadata: Record<string, unknown>;
    };

function normalizeOptionalString(value: string | null | undefined) {
  return value?.trim() || "";
}

export function resolveDaytonaSandboxTarget(input: {
  snapshot?: string | null;
  image?: string | null;
}): DaytonaSandboxTargetResolution {
  const snapshot = normalizeOptionalString(input.snapshot);
  const image = normalizeOptionalString(input.image);
  const metadata = {
    snapshotConfigured: Boolean(snapshot),
    imageConfigured: Boolean(image),
  };

  if (snapshot && image) {
    return {
      configured: false,
      target: null,
      missing: [
        "DAYTONA_SANDBOX_SNAPSHOT and DAYTONA_SANDBOX_IMAGE are mutually exclusive",
      ],
      metadata: {
        ...metadata,
        targetConfigured: false,
        configurationConflict: true,
      },
    };
  }

  if (snapshot) {
    return {
      configured: true,
      target: {
        kind: "snapshot",
        value: snapshot,
        source: "DAYTONA_SANDBOX_SNAPSHOT",
      },
      missing: [],
      metadata: {
        ...metadata,
        targetConfigured: true,
        targetKind: "snapshot",
        targetSource: "DAYTONA_SANDBOX_SNAPSHOT",
      },
    };
  }

  if (image) {
    return {
      configured: true,
      target: {
        kind: "image",
        value: image,
        source: "DAYTONA_SANDBOX_IMAGE",
      },
      missing: [],
      metadata: {
        ...metadata,
        targetConfigured: true,
        targetKind: "image",
        targetSource: "DAYTONA_SANDBOX_IMAGE",
      },
    };
  }

  return {
    configured: false,
    target: null,
    missing: ["DAYTONA_SANDBOX_SNAPSHOT or DAYTONA_SANDBOX_IMAGE"],
    metadata: {
      ...metadata,
      targetConfigured: false,
    },
  };
}

export type DaytonaSandboxProviderOptions = {
  apiKey: string;
  apiUrl?: string;
  snapshot?: string;
  image?: string;
  maxOutputChars: number;
  daytonaSandbox?: DaytonaSandboxClient;
};

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly id = "daytona";
  readonly pathPolicy = DAYTONA_SANDBOX_PATH_POLICY;
  readonly cancellationScope = "sandbox" as const;
  private readonly sandboxTarget: DaytonaSandboxTarget;
  private readonly daytonaSandbox: DaytonaSandboxClient;

  constructor(private readonly options: DaytonaSandboxProviderOptions) {
    if (!options.apiKey) {
      throw new Error("SANDBOX_NOT_CONFIGURED: DAYTONA_API_KEY is required.");
    }
    const targetResolution = resolveDaytonaSandboxTarget({
      snapshot: options.snapshot,
      image: options.image,
    });
    if (!targetResolution.configured) {
      throw new Error(
        `SANDBOX_NOT_CONFIGURED: ${targetResolution.missing.join(", ")}.`,
      );
    }
    this.sandboxTarget = targetResolution.target;
    this.daytonaSandbox = options.daytonaSandbox ?? defaultDaytonaSandboxClient;
  }

  async createSandbox(input: CreateSandboxInput) {
    return this.withProviderErrorMapping("create", async () => {
      const autoDeleteInterval = Math.max(1, Math.ceil(input.ttlSeconds / 60));
      const target = input.snapshot
        ? {
            kind: "snapshot" as const,
            value: input.snapshot,
            source: "request" as const,
          }
        : this.sandboxTarget;
      const networkOptions = resolveDaytonaNetworkPolicyOptions(
        input.networkPolicy,
      );
      // TODO(skill-registry R0 §6b/§7.0): `@langchain/daytona@0.2.2`'s
      // `DaytonaSandbox.initialize()` still only forwards a fixed field set
      // (image/snapshot, language, envVars, auto*Interval, labels, resources)
      // to the underlying `@daytona/sdk` `daytona.create()` and DROPS
      // `networkBlockAll`/`networkAllowList`. The SDK's `CreateSandboxBaseParams`
      // DOES accept both. We translate the policy into SDK params here (the
      // provider's job); end-to-end enforcement requires the wrapper to forward
      // them or a direct `@daytona/sdk` call. Tracked with the ingestion-
      // sandbox migration.
      const createOptions: DaytonaSandboxOptions & DaytonaNetworkOptions = {
        auth: this.authOptions(),
        language: "typescript",
        labels: input.labels,
        autoDeleteInterval,
        ...(target.kind === "image"
          ? { image: target.value }
          : { snapshot: target.value }),
        ...networkOptions,
      };
      const sandbox = await this.daytonaSandbox.create(createOptions);
      await this.waitForSandboxReady(sandbox.id);
      return sandbox;
    });
  }

  async getSandbox(providerSandboxId: string) {
    return this.withProviderErrorMapping("get", () =>
      this.connectSandbox(providerSandboxId),
    );
  }

  async checkSandboxHealth(providerSandboxId: string) {
    return this.withProviderErrorMapping("execute", () =>
      this.waitForSandboxReady(providerSandboxId),
    );
  }

  async deleteSandbox(providerSandboxId: string) {
    return this.withProviderErrorMapping("delete", async () => {
      const sandbox = await this.connectSandbox(providerSandboxId);
      await sandbox.close();
    });
  }

  /** Daytona's wrapper exposes sandbox close, but no stable command-kill handle. */
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
    return this.executeSystem(input);
  }

  async executeSystem(input: {
    providerSandboxId: string;
    executionId?: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal;
  }) {
    return this.withProviderErrorMapping("execute", async () => {
      const sandbox = await this.connectSandbox(
        input.providerSandboxId,
        input.timeoutMs,
      );
      const result = await sandbox.instance.process.executeCommand(
        input.command,
        input.cwd,
        undefined,
        Math.ceil(input.timeoutMs / 1000),
      );
      return normalizeExecutionOutput(result, input.maxOutputChars);
    });
  }

  async uploadFile(input: {
    providerSandboxId: string;
    sandboxPath: string;
    content: Uint8Array;
  }) {
    return this.withProviderErrorMapping("upload", async () => {
      const sandbox = await this.connectSandbox(input.providerSandboxId);
      const [result] = await sandbox.uploadFiles([
        [input.sandboxPath, input.content],
      ]);
      if (!result) {
        throw new Error(`upload returned no result for ${input.sandboxPath}`);
      }
      if (result?.error) {
        throw new Error(result.error);
      }
    });
  }

  async downloadFile(input: {
    providerSandboxId: string;
    executionId?: string;
    sandboxPath: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) {
    return this.withProviderErrorMapping("download", async () => {
      const sandbox = await this.connectSandbox(input.providerSandboxId);
      const [result] = await sandbox.downloadFiles([input.sandboxPath]);
      if (!result) {
        throw new Error(`download returned no result for ${input.sandboxPath}`);
      }
      if (result?.error) {
        throw new Error(result.error);
      }
      if (!result?.content) {
        throw new Error(`file not found: ${input.sandboxPath}`);
      }
      return normalizeDaytonaDownloadResult(result.content);
    });
  }

  async ensureDirectory(input: {
    providerSandboxId: string;
    directory: string;
  }) {
    return this.withProviderErrorMapping("mkdir", async () => {
      const sandbox = await this.connectSandbox(input.providerSandboxId);
      const escapedDirectory = input.directory.replace(/'/g, `'\\''`);
      const result = await sandbox.instance.process.executeCommand(
        `mkdir -p '${escapedDirectory}'`,
      );
      assertDaytonaCommandSucceeded(result, {
        code: "SANDBOX_DIRECTORY_CREATE_FAILED",
        maxOutputChars: this.options.maxOutputChars,
      });
    });
  }

  private authOptions(): NonNullable<DaytonaSandboxOptions["auth"]> {
    return {
      apiKey: this.options.apiKey,
      ...(this.options.apiUrl ? { apiUrl: this.options.apiUrl } : {}),
    };
  }

  private connectSandbox(providerSandboxId: string, timeoutMs?: number) {
    return this.withProviderErrorMapping("get", () =>
      this.daytonaSandbox.fromId(providerSandboxId, {
        auth: this.authOptions(),
        ...(timeoutMs ? { timeout: Math.ceil(timeoutMs / 1000) } : {}),
      }),
    );
  }

  private async waitForSandboxReady(providerSandboxId: string) {
    const startedAt = Date.now();
    let lastError: unknown = null;
    while (Date.now() - startedAt <= DAYTONA_HEALTH_CHECK_TIMEOUT_MS) {
      try {
        const sandbox = await this.connectSandbox(
          providerSandboxId,
          DAYTONA_HEALTH_CHECK_COMMAND_TIMEOUT_SECONDS * 1000,
        );
        const result = await sandbox.instance.process.executeCommand(
          "pwd",
          undefined,
          undefined,
          DAYTONA_HEALTH_CHECK_COMMAND_TIMEOUT_SECONDS,
        );
        return assertDaytonaCommandSucceeded(result, {
          code: "SANDBOX_HEALTH_CHECK_FAILED",
          maxOutputChars: this.options.maxOutputChars,
        });
      } catch (error) {
        lastError = error;
        const mapped = mapDaytonaProviderError(error, "execute");
        if (mapped.code !== SANDBOX_PROVIDER_ERROR_CODES.unavailable) {
          throw error;
        }
        await sleep(DAYTONA_HEALTH_CHECK_INTERVAL_MS);
      }
    }

    throw mapDaytonaProviderError(
      lastError ??
        new Error("failed to resolve container IP: no IP address found"),
      "execute",
    );
  }

  private async withProviderErrorMapping<T>(
    operation: DaytonaProviderOperation,
    fn: () => Promise<T>,
  ) {
    try {
      return await fn();
    } catch (error) {
      throw mapDaytonaProviderError(error, operation);
    }
  }
}

export type DaytonaSandbox = DaytonaSandboxInstance;
