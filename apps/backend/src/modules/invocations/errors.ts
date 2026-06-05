import type {
  InvocationSourceRef,
  NormalizedInvocationError,
  NormalizedInvocationErrorCode,
} from "./types";

export const INVOCATION_ERROR_CODES: NormalizedInvocationErrorCode[] = [
  "MCP_TRANSPORT_UNSUPPORTED",
  "MCP_MANIFEST_STALE",
  "SKILL_NOT_ENABLED",
  "SCHEMA_MISMATCH",
  "RUNTIME_HANDOFF_UNAVAILABLE",
  "INVOCATION_NOT_FOUND",
  "INVOCATION_UNAVAILABLE",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
];

export function createNormalizedInvocationError(input: {
  code: NormalizedInvocationErrorCode;
  message: string;
  sourceRef?: InvocationSourceRef;
  recoverable?: boolean;
  details?: Record<string, unknown>;
}): NormalizedInvocationError {
  return {
    code: input.code,
    message: input.message,
    sourceRef: input.sourceRef,
    recoverable: input.recoverable ?? false,
    details: input.details,
  };
}
