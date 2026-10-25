import { z } from "zod";
import { ContentError } from "../content/errors";

// Optional additive field: old hosts omit it and old backends ignore it.
export const localDeviceReplySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("accepted"), id: z.string().max(256) }),
  z.object({
    type: z.literal("result"),
    id: z.string().max(256),
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().max(4000).optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
      .optional(),
  }),
  // A running `command.execute` asks whether it may reach a host. `id` is the
  // call's invocation id; `askId` makes a re-sent ask idempotent. Only the
  // envelope is checked here: the host comes from whatever the sandboxed
  // program asked to connect to, so a malformed host or port is answered with a
  // deny by the handler instead of costing the device its connection.
  z.object({
    type: z.literal("network.ask"),
    id: z.string().max(256),
    askId: z.string().max(256),
    host: z.string(),
    port: z.number(),
  }),
]);

export function persistLocalFailureCode(input: {
  ok: boolean;
  result?: Record<string, unknown>;
  errorCode?: string;
}): Record<string, unknown> | null {
  if (input.ok) return input.result ?? null;
  // Never trust result payloads to supply the protocol's error classification.
  return input.errorCode ? { sourceweftLocalErrorCode: input.errorCode } : null;
}

export function localInvocationFailure(input: {
  action: string;
  status: string;
  result?: unknown;
  error?: string | null;
}): ContentError {
  const code =
    input.result &&
    typeof input.result === "object" &&
    "sourceweftLocalErrorCode" in input.result
      ? input.result.sourceweftLocalErrorCode
      : null;
  if (
    input.status === "failed" &&
    input.action === "file.binary.begin" &&
    code === "FILE_NOT_FOUND"
  ) {
    return new ContentError(
      404,
      "FILE_NOT_FOUND",
      input.error ?? "The requested local file was not found.",
    );
  }
  return new ContentError(
    409,
    `LOCAL_EXECUTION_${input.status.toUpperCase()}`,
    input.error ?? "Local execution did not complete.",
  );
}
