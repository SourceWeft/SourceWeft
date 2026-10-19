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

/**
 * The provider could not be reached or is momentarily overloaded — adapters
 * map connection resets, `fetch failed`, 429 and 5xx to this code. It says
 * nothing about the request itself, which is what makes it safe to retry an
 * operation that has no side effect yet (creating a sandbox).
 */
export function isSandboxProviderUnavailableError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === SANDBOX_PROVIDER_ERROR_CODES.unavailable,
  );
}

/**
 * The provider created the container but its readiness probe (run inside
 * createSandbox, budget 90 s) never saw it execute a command, and the provider
 * already deleted it. Detected by message because the provider exposes no
 * dedicated flag; a create-level retry of this failure would cost another
 * create + full probe budget, so the manager must not retry it.
 */
export function isSandboxReadinessProbeFailure(error: unknown): boolean {
  if (!isSandboxProviderUnavailableError(error)) return false;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /readiness probe|did not become ready/iu.test(message)
  );
}

/**
 * The generation the run was bound to has been terminated after it already
 * accepted at least one operation (a prepare, upload, or execute result the
 * model may now rely on). Replacing it silently would hand the model an empty
 * /workspace while it believes files exist there, so sandbox tools fail closed
 * for the rest of the turn. A generation that accepted nothing is replaced
 * instead (see SandboxManager.getOrCreateThreadSandbox).
 */
export class SandboxInstanceChangedError extends Error {
  readonly code = "SANDBOX_INSTANCE_CHANGED";
  constructor() {
    super(
      "SANDBOX_INSTANCE_CHANGED: The sandbox used earlier in this run was terminated after a timeout and had already accepted operations, so it cannot be replaced silently. Sandbox tools are unavailable for the rest of this turn; explain the situation to the user and continue in the next message.",
    );
    this.name = "SandboxInstanceChangedError";
  }
}

/**
 * One-line notice attached to the first model-visible tool result that runs on
 * a replacement generation. The manager replaces a terminated generation only
 * when it accepted no operation, so nothing the model wrote is lost — but
 * /workspace starts empty again and prepare must be repeated.
 */
export const SANDBOX_REPLACED_NOTICE =
  "The previous sandbox was terminated after a timeout before it accepted any operation. A fresh sandbox is ready but its /workspace is empty: run prepare_sandbox_workspace again before continuing.";

/**
 * Thrown by hosts that cannot render SANDBOX_REPLACED_NOTICE inside a tool
 * result. This package renders the notice in execute/prepare/collect results
 * instead of throwing, so the class exists for the fallback path only.
 */
export class SandboxReplacedError extends Error {
  readonly code = "SANDBOX_REPLACED";
  constructor() {
    super(`SANDBOX_REPLACED: ${SANDBOX_REPLACED_NOTICE}`);
    this.name = "SandboxReplacedError";
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
