import type { InterpreterErrorCode } from "./types";

const SAFE_MESSAGES: Record<InterpreterErrorCode, string> = {
  BUSY: "Interpreter capacity is busy. Retry later.",
  EVAL_LIMIT: "Interpreter evaluation limit reached for this turn.",
  PTC_LIMIT: "Interpreter tool-call limit reached for this turn.",
  PTC_TIMEOUT: "Interpreter tool call timed out.",
  PATH_DENIED: "Interpreter filesystem access denied.",
  TOOL_UNAVAILABLE: "Interpreter tool is unavailable.",
  RUNTIME_TIMEOUT: "Interpreter evaluation timed out.",
  RUNTIME_OOM: "Interpreter memory limit exceeded.",
};

export class InterpreterError extends Error {
  readonly code: InterpreterErrorCode;

  constructor(code: InterpreterErrorCode, message = SAFE_MESSAGES[code]) {
    super(`[${code}] ${message}`);
    this.name = "InterpreterError";
    this.code = code;
  }
}

export function interpreterErrorCode(error: unknown) {
  return error instanceof InterpreterError ? error.code : undefined;
}

export function normalizeRuntimeError(
  error: unknown,
): InterpreterError | Error {
  if (error instanceof InterpreterError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/out[ -]?of[ -]?memory|memory limit/i.test(message)) {
    return new InterpreterError("RUNTIME_OOM");
  }
  if (/timed?\s*out|timeout|interrupted/i.test(message)) {
    return new InterpreterError("RUNTIME_TIMEOUT");
  }
  return error instanceof Error ? error : new Error("Interpreter failed.");
}

export function classifyRuntimeOutput(value: string) {
  const errorLines = value
    .split("\n")
    .filter((line) => /^\w*Error:\s/.test(line));
  if (errorLines.some((line) => /PTC call budget exceeded/i.test(line))) {
    return "PTC_LIMIT" as const;
  }
  if (
    errorLines.some((line) => /out[ -]?of[ -]?memory|memory limit/i.test(line))
  ) {
    return "RUNTIME_OOM" as const;
  }
  if (
    errorLines.some((line) =>
      /Promise timed out|timed?\s*out|execution interrupted|InternalError: interrupted/i.test(
        line,
      ),
    )
  ) {
    return "RUNTIME_TIMEOUT" as const;
  }
  return undefined;
}

export function safeInterpreterErrorText(code: InterpreterErrorCode) {
  return `[${code}] ${SAFE_MESSAGES[code]}`;
}
