import type {
  InvocationSourceRef,
  NormalizedInvocationError,
  NormalizedInvocationErrorCode,
} from "./types";

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
