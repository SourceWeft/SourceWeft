import { buildSandboxRuntimePrompt } from "./runtime-prompt";
import { createSandboxRuntimeForTurn as createToolSandboxRuntimeForTurn } from "./runtime/runtime";
import {
  EXECUTE_TOOL_NAME,
  PREPARE_SANDBOX_TOOL_NAME,
  COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
} from "./agent-tool-defs";
import type { BackendProtocolV2 } from "deepagents";
import type { SandboxRuntimeForTurn } from "./runtime/runtime";
import type {
  SandboxOperationStore,
  SandboxProviderFactory,
  SandboxRuntimeContext,
  SandboxServiceConfig,
  SandboxStore,
} from "./runtime/types";

export type SandboxRuntimeName = "api" | "worker" | "scheduler";

export type SandboxRuntimeRequest = {
  filesystem: BackendProtocolV2;
  context: SandboxRuntimeContext;
};

export type AgentSandboxRuntimeForTurn = SandboxRuntimeForTurn & {
  buildRuntimePrompt(): string;
};

export class SandboxRuntimeConfigurationError extends Error {
  code = "SANDBOX_RUNTIME_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "SandboxRuntimeConfigurationError";
  }
}

export type AgentSandboxServiceDeps = {
  getConfig: () => SandboxServiceConfig;
  getProviderFactory: (providerId: string) => SandboxProviderFactory | null;
  logWarn: (message: string, meta: Record<string, unknown>) => void;
};

export class AgentSandboxService {
  private deps: AgentSandboxServiceDeps;

  constructor(deps: AgentSandboxServiceDeps) {
    this.deps = deps;
  }

  createRuntimeForTurn(
    input: SandboxRuntimeRequest,
    sandboxStore: SandboxStore,
    operationStore: SandboxOperationStore,
  ): AgentSandboxRuntimeForTurn | null {
    const { getConfig, getProviderFactory } = this.deps;
    const config = getConfig();
    if (!config.enabled) {
      return null;
    }

    const factory = getProviderFactory(config.provider);
    if (!factory) {
      throw new SandboxRuntimeConfigurationError(
        `Sandbox execution requires a registered provider for '${config.provider}'.`,
      );
    }

    const providerStatus = factory.getConfigurationStatus();
    if (!providerStatus.configured) {
      throw new SandboxRuntimeConfigurationError(
        `Sandbox execution requires complete '${factory.id}' provider configuration: ${providerStatus.missing.join(", ")}.`,
      );
    }

    const provider = factory.createProvider();
    const sandboxRuntime = createToolSandboxRuntimeForTurn({
      filesystem: input.filesystem,
      context: input.context,
      limits: config.limits,
      provider,
      sandboxStore,
      operationStore,
      toolApprovalEnabled: config.toolApprovalEnabled,
      environment: process.env.NODE_ENV || "development",
    });

    const agentRuntime: AgentSandboxRuntimeForTurn = {
      ...sandboxRuntime,
      buildRuntimePrompt() {
        return buildSandboxRuntimePrompt({
          prepareToolAvailable: agentRuntime.tools.some(
            (tool) => tool.name === PREPARE_SANDBOX_TOOL_NAME,
          ),
          executeAvailable: true,
          collectToolAvailable: agentRuntime.tools.some(
            (tool) => tool.name === COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
          ),
          defaultEnvironmentAvailable:
            providerStatus.metadata?.defaultSandboxEnvironmentAvailable ===
            true,
          pathPolicy: provider.pathPolicy,
        });
      },
    };
    return agentRuntime;
  }

  logStartupWarning(runtime: SandboxRuntimeName) {
    const { getConfig, getProviderFactory, logWarn } = this.deps;
    const config = getConfig();
    if (!config.enabled) {
      return;
    }

    const factory = getProviderFactory(config.provider);
    const providerStatus = factory?.getConfigurationStatus() ?? {
      configured: false,
      missing: [`provider:${config.provider}`],
      metadata: {},
    };

    logWarn(
      "Sandbox runtime is enabled; this alpha feature runs commands in an isolated execution environment",
      {
        runtime,
        provider: config.provider,
        ttlSeconds: config.limits.ttlSeconds,
        commandTimeoutMs: config.limits.commandTimeoutMs,
        maxOutputChars: config.limits.maxOutputChars,
        maxPrepareFileBytes: config.limits.maxPrepareFileBytes,
        maxPrepareTotalBytes: config.limits.maxPrepareTotalBytes,
        maxCollectFileBytes: config.limits.maxCollectFileBytes,
        maxCollectTotalBytes: config.limits.maxCollectTotalBytes,
        providerConfigured: providerStatus.configured,
        providerMissingConfig: providerStatus.missing,
        providerMetadata: providerStatus.metadata ?? {},
        toolApprovalEnabled: config.toolApprovalEnabled,
      },
    );

    if (!providerStatus.configured) {
      logWarn(
        "Sandbox runtime is enabled but provider configuration is incomplete",
        {
          runtime,
          provider: config.provider,
          missing: providerStatus.missing,
          providerMetadata: providerStatus.metadata ?? {},
        },
      );
    }
  }
}
