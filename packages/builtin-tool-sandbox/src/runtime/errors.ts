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

/** Issued only by an authenticated provider resource lookup, never a file/stamp probe. */
export type SandboxPhysicalAbsenceEvidence = {
  authority: "provider-resource-api";
  outcome: "not_found";
  provider: string;
  providerSandboxId: string;
  requestId: string;
  observedAtMs: number;
};

export function hasSandboxPhysicalAbsenceEvidence(
  error: unknown,
  input: {
    provider: string;
    providerSandboxId: string;
  },
): boolean {
  if (!error || typeof error !== "object" || !("physicalAbsence" in error))
    return false;
  const evidence =
    error.physicalAbsence as Partial<SandboxPhysicalAbsenceEvidence> | null;
  return (
    typeof evidence === "object" &&
    evidence !== null &&
    evidence.authority === "provider-resource-api" &&
    evidence.outcome === "not_found" &&
    evidence.provider === input.provider &&
    evidence.providerSandboxId === input.providerSandboxId &&
    typeof evidence.requestId === "string" &&
    evidence.requestId.length > 0 &&
    evidence.requestId.length <= 256 &&
    typeof evidence.observedAtMs === "number" &&
    Number.isFinite(evidence.observedAtMs) &&
    evidence.observedAtMs <= Date.now() &&
    evidence.observedAtMs >= Date.now() - 60_000
  );
}

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
    const cleanup =
      record.creationCleanup && typeof record.creationCleanup === "object"
        ? (record.creationCleanup as Record<string, unknown>)
        : undefined;
    return {
      name: record.name,
      code: record.code,
      phase: record.phase,
      status: record.status ?? record.statusCode,
      message: record.message,
      ...(cleanup &&
      typeof cleanup.providerSandboxId === "string" &&
      ["delete-requested", "already-missing", "unconfirmed"].includes(
        String(cleanup.status),
      )
        ? {
            creationCleanup: {
              providerSandboxId: cleanup.providerSandboxId,
              status: cleanup.status,
              ...(typeof cleanup.reason === "string"
                ? { reason: cleanup.reason }
                : {}),
            },
          }
        : {}),
      ...(record.cause === undefined
        ? {}
        : { cause: describe(record.cause, depth - 1) }),
    };
  };
  return redactSandboxSecrets(describe(error, 4));
}
