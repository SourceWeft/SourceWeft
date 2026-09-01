import type { BackendProtocolV2 } from "deepagents";
import type {
  SandboxOperationStore,
  SandboxOperationTimelineItem,
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
import type {
  SandboxRuntimeAssetStaging,
  SandboxSkillStaging,
} from "./sandbox-manager";
import { SourceWeftSandboxBackend } from "./sourceweft-sandbox-backend";
import { createSandboxTools } from "./sandbox-tools";
import { createSandboxInterruptConfigs } from "./sandbox-interrupts";
import { assertSandboxReadPath } from "./paths";
import {
  createTrustedSandboxHostAdapter,
  type TrustedSandboxHostAdapter,
} from "./trusted-host-adapter";

export interface SandboxRuntimeForTurn {
  backend: SourceWeftSandboxBackend;
  /** Trusted host-only operations; never exposed as model tools directly. */
  trustedHost: TrustedSandboxHostAdapter;
  downloadFile(input: { sandboxPath: string }): Promise<Buffer>;
  pathPolicy: SandboxProviderPathPolicy;
  getOperationTimeline(): Promise<SandboxOperationTimelineItem[]>;
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
   * Class of operation this runtime's backend commands belong to. Agent turns
   * must omit it and stay interactive; host-only runtimes may name `batch`.
   * Root-only work inside an agent turn uses `trustedHost` instead of widening
   * the model-visible backend.
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
  /** Required capability binaries; failure aborts sandbox acquisition. */
  runtimeAssets?: Pick<SandboxRuntimeAssetStaging, "plans" | "logger">;
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
    ...(input.runtimeAssets
      ? {
          requiredAssetStaging: {
            ...input.runtimeAssets,
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
  const trustedHost = createTrustedSandboxHostAdapter({
    manager,
    context: input.context,
    limits: input.limits,
    // The adapter is never exposed as a model tool. Resolve its timeout from
    // the deterministic host-work budget independently of the conversational
    // runtime's budget, which deliberately stays interactive by default.
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({
      limits: input.limits,
      budget: "batch",
    }),
  });
  return {
    backend,
    trustedHost,
    pathPolicy: input.provider.pathPolicy,
    async getOperationTimeline() {
      return input.operationStore.listMessageOperations({
        context: input.context,
        limit: 50,
      });
    },
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
      trustedHost,
      ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    }),
    interruptOn: input.toolApprovalEnabled
      ? createSandboxInterruptConfigs()
      : {},
  };
}
