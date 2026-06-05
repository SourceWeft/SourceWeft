import { Daytona, type Sandbox } from "@daytona/sdk";
import type { ExecuteResponse } from "deepagents";
import { config } from "../../../../shared/config";

type CreateSandboxInput = {
  labels: Record<string, string>;
  snapshot?: string;
  ttlSeconds: number;
};

export type DaytonaProviderOperation =
  | "create"
  | "get"
  | "delete"
  | "execute"
  | "upload"
  | "download"
  | "mkdir";

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

export function mapDaytonaProviderError(
  error: unknown,
  operation: DaytonaProviderOperation,
) {
  const status = providerErrorStatus(error).toLowerCase();
  const message = providerErrorMessage(error).toLowerCase();

  if (
    status === "401" ||
    status === "403" ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("invalid api key") ||
    message.includes("authentication")
  ) {
    return new Error(
      "SANDBOX_PROVIDER_AUTH_FAILED: sandbox provider authentication failed. Check sandbox provider credentials and API URL.",
    );
  }

  if (
    operation === "download" &&
    (message.includes("file not found") ||
      message.includes("no such file") ||
      message.includes("enoent"))
  ) {
    return new Error(
      "SANDBOX_FILE_NOT_FOUND: requested sandbox file was not found.",
    );
  }

  if (
    status === "404" ||
    message.includes("sandbox not found") ||
    message.includes("does not exist")
  ) {
    return new Error(
      "SANDBOX_NOT_FOUND_OR_EXPIRED: sandbox was not found or has expired. Retry the operation to create a fresh sandbox.",
    );
  }

  if (
    status === "408" ||
    status === "504" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("deadline")
  ) {
    return new Error(
      "SANDBOX_COMMAND_TIMEOUT: sandbox command exceeded the configured timeout.",
    );
  }

  if (operation === "download" && message.includes("not found")) {
    return new Error(
      "SANDBOX_FILE_NOT_FOUND: requested sandbox file was not found.",
    );
  }

  return new Error(
    "SANDBOX_PROVIDER_ERROR: sandbox provider operation failed. Check backend logs for provider diagnostics.",
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
    typeof record.result === "string"
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
  const truncated = combined.length > maxChars;
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

export class DaytonaAdapter {
  private readonly client: Daytona;

  constructor() {
    if (!config.sandbox.daytona.apiKey) {
      throw new Error("SANDBOX_NOT_CONFIGURED: DAYTONA_API_KEY is required.");
    }
    this.client = new Daytona({
      apiKey: config.sandbox.daytona.apiKey,
      ...(config.sandbox.daytona.apiUrl
        ? { apiUrl: config.sandbox.daytona.apiUrl }
        : {}),
    });
  }

  async createSandbox(input: CreateSandboxInput) {
    return this.withProviderErrorMapping("create", async () => {
      const autoDeleteInterval = Math.max(1, Math.ceil(input.ttlSeconds / 60));
      const sandbox =
        input.snapshot && isDaytonaImageReference(input.snapshot)
          ? await this.client.create(
              {
                image: input.snapshot,
                labels: input.labels,
                autoDeleteInterval,
                public: false,
              },
              { timeout: 180 },
            )
          : await this.client.create({
              ...(input.snapshot ? { snapshot: input.snapshot } : {}),
              labels: input.labels,
              autoDeleteInterval,
              public: false,
            });
      return sandbox;
    });
  }

  async getSandbox(providerSandboxId: string) {
    return this.withProviderErrorMapping("get", () =>
      this.client.get(providerSandboxId),
    );
  }

  async deleteSandbox(providerSandboxId: string) {
    return this.withProviderErrorMapping("delete", async () => {
      const sandbox = await this.getSandbox(providerSandboxId);
      await this.client.delete(sandbox);
    });
  }

  async execute(input: {
    providerSandboxId: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
  }) {
    return this.withProviderErrorMapping("execute", async () => {
      const sandbox = await this.getSandbox(input.providerSandboxId);
      const result = await sandbox.process.executeCommand(
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
      const sandbox = await this.getSandbox(input.providerSandboxId);
      await sandbox.fs.uploadFile(
        Buffer.from(input.content),
        input.sandboxPath,
      );
    });
  }

  async downloadFile(input: {
    providerSandboxId: string;
    sandboxPath: string;
  }) {
    return this.withProviderErrorMapping("download", async () => {
      const sandbox = await this.getSandbox(input.providerSandboxId);
      const result = await sandbox.fs.downloadFile(input.sandboxPath);
      return normalizeDaytonaDownloadResult(result);
    });
  }

  async ensureDirectory(input: {
    providerSandboxId: string;
    directory: string;
  }) {
    return this.withProviderErrorMapping("mkdir", async () => {
      const sandbox = await this.getSandbox(input.providerSandboxId);
      const escapedDirectory = input.directory.replace(/'/g, `'\\''`);
      const result = await sandbox.process.executeCommand(
        `mkdir -p '${escapedDirectory}'`,
      );
      assertDaytonaCommandSucceeded(result, {
        code: "SANDBOX_DIRECTORY_CREATE_FAILED",
        maxOutputChars: config.sandbox.maxOutputChars,
      });
    });
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

export type DaytonaSandbox = Sandbox;
