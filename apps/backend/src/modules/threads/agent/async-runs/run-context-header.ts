/**
 * Tenancy / billing context propagation for async delegate runs.
 *
 * deepagents' async middleware forwards NO metadata in `runs.create` — only the
 * delegated `input.messages`. But it does forward an `AsyncSubAgent.headers`
 * value on every request to the endpoint (see `ClientCache.resolveHeaders`). So
 * the parent turn, which owns the billing/tenancy context, encodes it into this
 * header when it builds the async delegates; the endpoint decodes it and stores
 * it on the run, and the worker replays it to rebuild the billed gateway model +
 * tenant backend.
 *
 * The endpoint is internal (loopback / guarded), so the value is a plain
 * base64url JSON blob — NOT a trust boundary on its own. Signing it (HMAC) is a
 * hardening follow-up if the endpoint ever leaves the internal network.
 */
import type { RunContextConfig } from "./types";

export const RUN_CONTEXT_HEADER = "x-sourceweft-run-context";

/**
 * Shared-secret header guarding the internal runs endpoint. The parent turn
 * sends it; the endpoint rejects any request whose value doesn't match the
 * configured token (fail-closed when unset).
 */
export const RUN_INTERNAL_TOKEN_HEADER = "x-sourceweft-internal-token";

const REQUIRED_STRING_KEYS = [
  "teamId",
  "workspaceId",
  "userId",
  "modelAlias",
  "providerModel",
  "profileAlias",
  "gatewayConfigId",
  "parentThreadId",
] as const;

/** Encode the per-turn context into a header value. */
export function encodeRunContextHeader(context: RunContextConfig): string {
  return Buffer.from(JSON.stringify(context), "utf8").toString("base64url");
}

/**
 * Decode + validate a context header value. Returns null for a missing or
 * malformed header so the caller can reject the run rather than execute it
 * unscoped (which would settle billing against no one).
 */
export function decodeRunContextHeader(
  value: string | null | undefined,
): RunContextConfig | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of REQUIRED_STRING_KEYS) {
    if (typeof record[key] !== "string" || record[key] === "") {
      return null;
    }
  }
  const context: RunContextConfig = {
    teamId: record.teamId as string,
    workspaceId: record.workspaceId as string,
    userId: record.userId as string,
    modelAlias: record.modelAlias as string,
    providerModel: record.providerModel as string,
    profileAlias: record.profileAlias as string,
    gatewayConfigId: record.gatewayConfigId as string,
    parentThreadId: record.parentThreadId as string,
  };
  if (
    Array.isArray(record.sourceIds) &&
    record.sourceIds.every((id) => typeof id === "string")
  ) {
    context.sourceIds = record.sourceIds as string[];
  }
  return context;
}
