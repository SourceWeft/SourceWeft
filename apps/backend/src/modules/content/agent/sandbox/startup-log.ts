import { config } from "../../../../shared/config";
import { logger } from "../../../../shared/logger";
import { AGENT_TOOL_NAMES } from "../tool-names";
import { isDaytonaImageReference } from "./daytona-adapter";

function daytonaDefaultSnapshotKind() {
  const snapshot = config.sandbox.daytona.defaultSnapshot;
  if (!snapshot) {
    return "missing";
  }
  return isDaytonaImageReference(snapshot) ? "image" : "snapshot";
}

export function logSandboxStartupWarning(
  runtime: "api" | "worker" | "scheduler",
) {
  if (!config.sandbox.enabled) {
    return;
  }

  logger.warn(
    "Sandbox runtime is enabled; this alpha feature runs user-approved commands in an isolated execution environment",
    {
      runtime,
      provider: config.sandbox.provider,
      ttlSeconds: config.sandbox.ttlSeconds,
      commandTimeoutMs: config.sandbox.commandTimeoutMs,
      maxOutputChars: config.sandbox.maxOutputChars,
      maxPrepareFileBytes: config.sandbox.maxPrepareFileBytes,
      maxPrepareTotalBytes: config.sandbox.maxPrepareTotalBytes,
      maxCollectFileBytes: config.sandbox.maxCollectFileBytes,
      maxCollectTotalBytes: config.sandbox.maxCollectTotalBytes,
      daytonaApiUrlConfigured: Boolean(config.sandbox.daytona.apiUrl),
      daytonaApiKeyConfigured: Boolean(config.sandbox.daytona.apiKey),
      daytonaDefaultSnapshotConfigured: Boolean(
        config.sandbox.daytona.defaultSnapshot,
      ),
      daytonaDefaultSnapshotKind: daytonaDefaultSnapshotKind(),
      hitlRequired: true,
    },
  );

  if (
    config.sandbox.provider === "daytona" &&
    (!config.sandbox.daytona.apiUrl ||
      !config.sandbox.daytona.apiKey ||
      !config.sandbox.daytona.defaultSnapshot)
  ) {
    logger.warn(
      "Sandbox runtime is enabled but Daytona provider configuration is incomplete",
      {
        runtime,
        daytonaApiUrlConfigured: Boolean(config.sandbox.daytona.apiUrl),
        daytonaApiKeyConfigured: Boolean(config.sandbox.daytona.apiKey),
        daytonaDefaultSnapshotConfigured: Boolean(
          config.sandbox.daytona.defaultSnapshot,
        ),
      },
    );
  }
}

export function warnIfSandboxHitlBypassed(input: {
  interruptOn: Record<string, unknown>;
  boundSandboxToolNames: string[];
}) {
  const missingRequiredTools: string[] = [AGENT_TOOL_NAMES.execute];
  for (const toolName of input.boundSandboxToolNames) {
    if (
      toolName === AGENT_TOOL_NAMES.prepareSandboxWorkspace ||
      toolName === AGENT_TOOL_NAMES.collectSandboxOutputs
    ) {
      missingRequiredTools.push(toolName);
    }
  }

  const missingInterrupts = Array.from(new Set(missingRequiredTools)).filter(
    (toolName) => !input.interruptOn[toolName],
  );
  if (missingInterrupts.length === 0) {
    return;
  }

  logger.warn(
    "Sandbox runtime is active but HITL confirmation is missing for one or more sandbox operations",
    {
      missingInterrupts,
      boundSandboxToolNames: input.boundSandboxToolNames,
    },
  );
}
