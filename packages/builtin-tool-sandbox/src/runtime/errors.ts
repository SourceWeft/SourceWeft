import { redactSandboxSecrets } from "./redaction";

export const SANDBOX_PROVIDER_ERROR_CODES = {
  instanceMissing: "SANDBOX_NOT_FOUND_OR_EXPIRED",
  fileMissing: "SANDBOX_FILE_NOT_FOUND",
  unavailable: "SANDBOX_NOT_READY_OR_UNHEALTHY",
  authentication: "SANDBOX_PROVIDER_AUTH_FAILED",
  timeout: "SANDBOX_COMMAND_TIMEOUT",
  unknown: "SANDBOX_PROVIDER_ERROR",
} as const;

export type SandboxProviderErrorCode =
  (typeof SANDBOX_PROVIDER_ERROR_CODES)[keyof typeof SANDBOX_PROVIDER_ERROR_CODES];

/** Provider adapters own native error classification; callers use this code. */
export class SandboxProviderError extends Error {
  constructor(
    readonly code: SandboxProviderErrorCode,
    message: string,
    readonly phase: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SandboxProviderError";
  }
}

export function isSandboxInstanceMissingError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
  );
}

export class SandboxInstanceChangedError extends Error {
  readonly code = "SANDBOX_INSTANCE_CHANGED";
  constructor() {
    super(
      "Sandbox instance is no longer current. This operation cannot continue on a replacement instance.",
    );
    this.name = "SandboxInstanceChangedError";
  }
}

/** Preserve useful cause chains without serializing provider clients/headers. */
export function sandboxErrorDiagnostic(error: unknown): unknown {
  const seen = new Set<unknown>();
  const describe = (value: unknown, depth: number): unknown => {
    if (!value || typeof value !== "object") return String(value);
    if (seen.has(value) || depth === 0) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    return {
      name: record.name,
      code: record.code,
      phase: record.phase,
      status: record.status ?? record.statusCode,
      message: record.message,
      ...(record.cause === undefined
        ? {}
        : { cause: describe(record.cause, depth - 1) }),
    };
  };
  return redactSandboxSecrets(describe(error, 4));
}
