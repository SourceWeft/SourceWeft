import type { SandboxCommandDurability } from "./types";
import { redactSandboxText } from "./redaction";

/** Only explicit, validated acknowledgements survive operation replay. */
export function readSandboxDurability(
  value: unknown,
): SandboxCommandDurability | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    !["confirmed", "pending", "failed", "unknown"].includes(
      String(record.status),
    ) ||
    typeof record.attachmentId !== "string" ||
    !record.attachmentId
  )
    return undefined;
  return {
    status: record.status as SandboxCommandDurability["status"],
    attachmentId: record.attachmentId,
    ...(typeof record.confirmedSeq === "number" &&
    Number.isSafeInteger(record.confirmedSeq) &&
    record.confirmedSeq >= 0
      ? { confirmedSeq: record.confirmedSeq }
      : {}),
  };
}

/** Keeps the executed command's result available without turning failed persistence into success. */
export class SandboxVolumePersistenceError extends Error {
  readonly code = "SANDBOX_VOLUME_PERSISTENCE_UNCONFIRMED";
  readonly commandExitCode: number | null;
  readonly commandOutput: string;
  readonly durability: SandboxCommandDurability;

  constructor(input: {
    attachmentId: string;
    exitCode: number | null;
    output?: string;
    status?: "failed" | "unknown";
    cause: unknown;
  }) {
    const reason =
      input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(
      `SANDBOX_VOLUME_PERSISTENCE_UNCONFIRMED: command exit code ${input.exitCode ?? "unknown"}; persistence is unconfirmed. Do not execute the command again. ${redactSandboxText(reason)}`,
      { cause: input.cause },
    );
    this.name = "SandboxVolumePersistenceError";
    this.commandExitCode = input.exitCode;
    this.commandOutput = redactSandboxText(input.output ?? "");
    this.durability = {
      status: input.status ?? "unknown",
      attachmentId: input.attachmentId,
    };
  }
}

/** Data is already acknowledged; only reopening admission or releasing the permit remains uncertain. */
export class SandboxVolumeRecoveryPendingError extends Error {
  readonly code = "SANDBOX_VOLUME_RECOVERY_PENDING";
  readonly commandExitCode: number | null;
  readonly commandOutput: string;
  readonly durability: SandboxCommandDurability;

  constructor(input: {
    attachmentId: string;
    confirmedSeq: number;
    status: "confirmed" | "pending";
    exitCode: number | null;
    output?: string;
    cause: unknown;
  }) {
    const reason =
      input.cause instanceof Error ? input.cause.message : String(input.cause);
    const acknowledgement =
      input.status === "confirmed"
        ? `Changes were confirmed durable at sequence ${input.confirmedSeq}.`
        : "The shadow checkpoint completed; production persistence is not confirmed.";
    super(
      `SANDBOX_VOLUME_RECOVERY_PENDING: ${acknowledgement} Environment coordination is still pending. Do not execute the command again. ${redactSandboxText(reason)}`,
      { cause: input.cause },
    );
    this.name = "SandboxVolumeRecoveryPendingError";
    this.commandExitCode = input.exitCode;
    this.commandOutput = redactSandboxText(input.output ?? "");
    this.durability = {
      status: input.status,
      attachmentId: input.attachmentId,
      confirmedSeq: input.confirmedSeq,
    };
  }
}

export function volumeFailureResult(error: unknown): Record<string, unknown> {
  if (
    !(error instanceof SandboxVolumePersistenceError) &&
    !(error instanceof SandboxVolumeRecoveryPendingError)
  )
    return {};
  return {
    commandExitCode: error.commandExitCode,
    output: error.commandOutput,
    durability: error.durability,
    commandMayHaveRun: true,
    automaticRetryAllowed: false,
  };
}
