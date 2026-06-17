import { ContentError } from "../../content/errors";

export const SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED =
  "SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED";

function errorMessageChain(error: unknown) {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.message === "string") {
      messages.push(record.message);
    }
    current = record.cause;
  }
  if (typeof current === "string") {
    messages.push(current);
  }
  return messages;
}

export function isSandboxExecuteToolCallIdRequiredError(error: unknown) {
  return errorMessageChain(error).some((message) =>
    message.includes(SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED),
  );
}

export function sandboxExecuteToolCallIdRequiredContentError() {
  return new ContentError(
    403,
    SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED,
    "Sandbox execute requires a stable tool call id before running.",
  );
}
