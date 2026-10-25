import { z } from "zod";
import { ContentError } from "../content/errors";

export const SANDBOX_SETUP_CODES = [
  "bundleMissing",
  "bundleStale",
  "bundleNewer",
  "bundleInvalid",
  "bwrapMissing",
  "userNamespaceRestricted",
  "sandboxFailed",
  "installing",
] as const;
export type SandboxSetupCode = (typeof SANDBOX_SETUP_CODES)[number];

export const SANDBOX_REMEDIES = [
  "downloadRuntime",
  "updateApp",
  "reinstallPackage",
  "privilegedSetup",
  "none",
] as const;
export type SandboxRemedy = (typeof SANDBOX_REMEDIES)[number];

export const SANDBOX_STATES = ["ready", "needsSetup", "unsupported"] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

export const DEVICE_PLATFORMS = ["macos", "linux", "windows"] as const;
export const DEVICE_ARCHES = ["x64", "arm64"] as const;

/**
 * Capabilities the gateway announces in its `connected` message. A backend
 * that does not know the `status` message closes the socket with 1008 on it,
 * so a host MUST send `status` only when `connected.features` includes
 * "status"; hosts talking to an older backend simply never report.
 */
export const GATEWAY_FEATURES = ["status"] as const;

const sandboxStatusSchema = z
  .object({
    state: z.enum(SANDBOX_STATES),
    code: z.enum(SANDBOX_SETUP_CODES).optional(),
    reason: z.string().max(1000).optional(),
    remedy: z.enum(SANDBOX_REMEDIES).optional(),
  })
  .superRefine((sandbox, ctx) => {
    const issue = (key: "code" | "remedy" | "reason", message: string) =>
      ctx.addIssue({ code: "custom", path: [key], message });
    if (sandbox.state === "ready") {
      for (const key of ["code", "remedy", "reason"] as const)
        if (sandbox[key] !== undefined)
          issue(key, `${key} is not allowed when the sandbox is ready`);
    } else if (sandbox.state === "needsSetup") {
      for (const key of ["code", "remedy", "reason"] as const)
        if (sandbox[key] === undefined)
          issue(key, `${key} is required when the sandbox needs setup`);
    } else {
      for (const key of ["code", "remedy"] as const)
        if (sandbox[key] !== undefined)
          issue(key, `${key} is not allowed when the sandbox is unsupported`);
    }
  });

// Unknown keys are stripped, like every other message here, so a newer host
// adding a field never makes an older backend close the socket.
const deviceStatusSchema = z.object({
  type: z.literal("status"),
  platform: z.enum(DEVICE_PLATFORMS),
  arch: z.enum(DEVICE_ARCHES),
  shell: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  protocolVersion: z.number().int().optional(),
  sandbox: sandboxStatusSchema,
  capabilities: z.array(z.string().min(1).max(64)).max(32),
});
export type DeviceStatusMessage = z.infer<typeof deviceStatusSchema>;

// Optional additive field: old hosts omit it and old backends ignore it.
export const localDeviceReplySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("accepted"), id: z.string().max(256) }),
  deviceStatusSchema,
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
]);

/** The `local_devices` columns written for a host `status` report. */
export function deviceStatusColumns(message: DeviceStatusMessage, now: Date) {
  return {
    platform: message.platform,
    arch: message.arch,
    shell: message.shell,
    sandboxState: message.sandbox.state,
    sandboxCode: message.sandbox.code ?? null,
    sandboxReason: message.sandbox.reason ?? null,
    sandboxRemedy: message.sandbox.remedy ?? null,
    capabilities: message.capabilities,
    statusReportedAt: now,
  };
}

/** `sandbox` for GET /v1/local-devices: null until the host has reported. */
export function serializeDeviceSandbox(row: {
  sandboxState: string | null;
  sandboxCode: string | null;
  sandboxReason: string | null;
  sandboxRemedy: string | null;
}): {
  state: SandboxState;
  code?: SandboxSetupCode;
  reason?: string;
  remedy?: SandboxRemedy;
} | null {
  if (!row.sandboxState) return null;
  return {
    state: row.sandboxState as SandboxState,
    ...(row.sandboxCode ? { code: row.sandboxCode as SandboxSetupCode } : {}),
    ...(row.sandboxReason ? { reason: row.sandboxReason } : {}),
    ...(row.sandboxRemedy
      ? { remedy: row.sandboxRemedy as SandboxRemedy }
      : {}),
  };
}

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
