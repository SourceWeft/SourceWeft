import type { BackendProtocolV2 } from "deepagents";
import { config } from "../../../../shared/config";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type { SandboxRuntimeContext } from "./types";
import { DaytonaSandboxManager } from "./daytona-manager";
import { SourceWeftDaytonaBackend } from "./sourceweft-daytona-backend";
import { createSandboxTools } from "./sandbox-tools";
import { createSandboxInterruptConfigs } from "./sandbox-interrupts";

export interface SandboxRuntimeForTurn {
  backend: SourceWeftDaytonaBackend;
  tools: ReturnType<typeof createSandboxTools>;
  interruptOn: ReturnType<typeof createSandboxInterruptConfigs>;
}

export class SandboxRuntimeConfigurationError extends Error {
  code = "SANDBOX_RUNTIME_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "SandboxRuntimeConfigurationError";
  }
}

export function createSandboxRuntimeForTurn(input: {
  filesystem: BackendProtocolV2;
  context: SandboxRuntimeContext;
  enabledSkills?: EnabledSkillDescriptor[];
}): SandboxRuntimeForTurn | null {
  if (!config.sandbox.enabled || config.sandbox.provider !== "daytona") {
    throw new SandboxRuntimeConfigurationError(
      "Sandbox execution requires Daytona sandbox runtime configuration",
    );
  }
  if (
    !config.sandbox.daytona.apiKey ||
    !config.sandbox.daytona.apiUrl ||
    !config.sandbox.daytona.defaultSnapshot
  ) {
    throw new SandboxRuntimeConfigurationError(
      "Sandbox execution requires Daytona apiUrl, apiKey, and defaultSnapshot",
    );
  }
  const manager = new DaytonaSandboxManager();
  const backend = new SourceWeftDaytonaBackend({
    filesystem: input.filesystem,
    manager,
    context: input.context,
    enabledSkills: input.enabledSkills,
  });
  return {
    backend,
    tools: createSandboxTools({
      filesystem: input.filesystem,
      manager,
      context: input.context,
    }),
    interruptOn: createSandboxInterruptConfigs(),
  };
}
