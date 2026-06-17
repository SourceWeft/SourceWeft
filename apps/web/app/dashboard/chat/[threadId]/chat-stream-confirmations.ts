import {
  isPendingToolConfirmation,
  toolConfirmationRequestSchema,
} from "@sourceweft/contracts";
import type {
  LiveToolConfirmation,
  ToolCallRecord,
} from "../_components/chat-canvas/types";

function getObjectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isToolCallStatus(value: unknown): value is ToolCallRecord["status"] {
  return (
    value === "running" ||
    value === "approval_requested" ||
    value === "completed" ||
    value === "error"
  );
}

function isToolCallApprovalState(
  value: unknown,
): value is NonNullable<ToolCallRecord["approvalState"]> {
  return value === "approved" || value === "rejected";
}

function invalidToolConfirmationFinishPayload(): Error {
  return new Error("Tool confirmation finish contains invalid payload.");
}

function missingToolConfirmationFinishPayload(): Error {
  return new Error("Tool confirmation finish is missing confirmation payload.");
}

function parseFinishToolCall(value: unknown): ToolCallRecord {
  const record = getObjectRecord(value);
  const id = getNonEmptyString(record?.id);
  const tool = getNonEmptyString(record?.tool);
  const input = getObjectRecord(record?.input);
  const status = record?.status;
  if (!record || !id || !tool || !input || !isToolCallStatus(status)) {
    throw invalidToolConfirmationFinishPayload();
  }

  const latencyMs =
    typeof record.latencyMs === "number" ? record.latencyMs : null;
  const error =
    typeof record.error === "string" || record.error === null
      ? record.error
      : null;
  const sequence =
    typeof record.sequence === "number" ? record.sequence : undefined;
  const approvalState = isToolCallApprovalState(record.approvalState)
    ? record.approvalState
    : undefined;
  const approvalConfirmationId =
    getNonEmptyString(record.approvalConfirmationId) ?? undefined;

  return {
    id,
    tool,
    input,
    output: record.output,
    latencyMs,
    status,
    error,
    ...(sequence === undefined ? {} : { sequence }),
    ...(approvalState === undefined ? {} : { approvalState }),
    ...(approvalConfirmationId === undefined ? {} : { approvalConfirmationId }),
  };
}

export function parseFinishLiveConfirmations(
  value: unknown,
): LiveToolConfirmation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw missingToolConfirmationFinishPayload();
  }

  return value.map((item) => {
    const record = getObjectRecord(item);
    if (!record) {
      throw invalidToolConfirmationFinishPayload();
    }

    const confirmation = toolConfirmationRequestSchema.safeParse(
      record.confirmation,
    );
    if (
      !confirmation.success ||
      !isPendingToolConfirmation(confirmation.data)
    ) {
      throw invalidToolConfirmationFinishPayload();
    }

    return {
      confirmation: confirmation.data,
      toolCall: parseFinishToolCall(record.toolCall),
    };
  });
}
