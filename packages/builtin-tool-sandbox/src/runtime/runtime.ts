import type { BackendProtocolV2 } from "deepagents";
import type {
  SandboxOperationStore,
  SandboxProvider,
  SandboxProviderPathPolicy,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStore,
} from "./types";
import type { SandboxCommandBudget } from "./command-budgets";
import {
  maxSandboxCommandTimeoutMs,
  resolveSandboxCommandTimeoutMs,
} from "./command-budgets";
import { SandboxManager } from "./sandbox-manager";
import type { SandboxSkillStaging } from "./sandbox-manager";
import { SourceWeftSandboxBackend } from "./sourceweft-sandbox-backend";
import { createSandboxTools } from "./sandbox-tools";
import { createSandboxInterruptConfigs } from "./sandbox-interrupts";
import { assertSandboxReadPath } from "./paths";

export interface SandboxRuntimeForTurn {
  backend: SourceWeftSandboxBackend;
  downloadFile(input: {
    sandboxPath: string;
  }): Promise<Buffer>;
  pathPolicy: SandboxProviderPathPolicy;
  tools: ReturnType<typeof createSandboxTools>;
  interruptOn: ReturnType<typeof createSandboxInterruptConfigs>;
}

export function createSandboxRuntimeForTurn(input: {
  filesystem: BackendProtocolV2;
  context: SandboxRuntimeContext;
  limits: SandboxRuntimeLimits;
  provider: SandboxProvider;
  sandboxStore: SandboxStore;
  operationStore: SandboxOperationStore;
  toolApprovalEnabled: boolean;
  environment?: string;
  /**
   * Class of operation this runtime's commands belong to. Chosen once, here,
   * by whoever constructs the runtime — host code names `batch` as a literal;
   * the agent turn names nothing and gets the interactive default.
   *
   * SECURITY: this is the only place a command timeout is selected. It is
   * deliberately not a per-call argument, because the model reaches
   * `backend.execute` through a tool whose input is just a command string —
   * with no per-call knob there is nothing for tool input to set. Move this to
   * an `execute()` option and a longer timeout becomes self-serve for the
   * model, which defeats the point of having a ceiling at all.
   */
  commandBudget?: SandboxCommandBudget;
  /** Host-provided artifact byte reader for artifact staging in prepare. */
  artifacts?: import("./sandbox-tools").SandboxArtifactReader;
  /**
   * Skill-bundle staging plans (docs/architecture/sandbox-skill-staging.md).
   * When present, the manager stages the bundles into /skills at sandbox
   * acquisition and the execute path admits /skills-referencing commands
   * once staging resolved. Absent → exactly today's behavior.
   */
  skillAssets?: Pick<SandboxSkillStaging, "plans" | "logger">;
}): SandboxRuntimeForTurn {
  const commandTimeoutMs = resolveSandboxCommandTimeoutMs({
    limits: input.limits,
    budget: input.commandBudget,
  });
  const manager = new SandboxManager({
    provider: input.provider,
    sandboxStore: input.sandboxStore,
    operationStore: input.operationStore,
    ttlSeconds: input.limits.ttlSeconds,
    // Staleness is swept against the longest budget, not this runtime's — see
    // maxSandboxCommandTimeoutMs.
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(input.limits),
    environment: input.environment,
    ...(input.skillAssets
      ? {
          skillStaging: {
            ...input.skillAssets,
            commandTimeoutMs,
            maxOutputChars: input.limits.maxOutputChars,
          },
        }
      : {}),
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context: input.context,
    limits: input.limits,
    commandTimeoutMs,
    toolApprovalEnabled: input.toolApprovalEnabled,
  });
  return {
    backend,
    pathPolicy: input.provider.pathPolicy,
    async downloadFile(downloadInput) {
      const provider = manager.providerForSandbox();
      const sandboxPath = assertSandboxReadPath(
        downloadInput.sandboxPath,
        provider.pathPolicy,
      );
      const sandbox = await manager.getOrCreateThreadSandbox(input.context);
      return manager.providerForSandbox().downloadFile({
        providerSandboxId: sandbox.providerSandboxId,
        sandboxPath,
      });
    },
    tools: createSandboxTools({
      filesystem: input.filesystem,
      manager,
      context: input.context,
      limits: input.limits,
      ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    }),
    interruptOn: input.toolApprovalEnabled
      ? createSandboxInterruptConfigs()
      : {},
  };
}
