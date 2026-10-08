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

export function volumeFailureResult(error: unknown): Record<string, unknown> {
  if (!(error instanceof SandboxVolumePersistenceError)) return {};
  return {
    commandExitCode: error.commandExitCode,
    output: error.commandOutput,
    durability: error.durability,
    commandMayHaveRun: true,
    automaticRetryAllowed: false,
  };
}
