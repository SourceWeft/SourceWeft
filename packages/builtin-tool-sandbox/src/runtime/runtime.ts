import type { BackendProtocolV2 } from "deepagents";
import type {
  SandboxOperationStore,
  SandboxProvider,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStore,
} from "./types";
import { SandboxManager } from "./sandbox-manager";
import { SourceWeftSandboxBackend } from "./sourceweft-sandbox-backend";
import { createSandboxTools } from "./sandbox-tools";
import { createSandboxInterruptConfigs } from "./sandbox-interrupts";
import { assertSandboxReadPath } from "./paths";

export interface SandboxRuntimeForTurn {
  backend: SourceWeftSandboxBackend;
  downloadFile(input: {
    sandboxPath: string;
  }): Promise<Buffer>;
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
}): SandboxRuntimeForTurn {
  const manager = new SandboxManager({
    provider: input.provider,
    sandboxStore: input.sandboxStore,
    operationStore: input.operationStore,
    ttlSeconds: input.limits.ttlSeconds,
    commandTimeoutMs: input.limits.commandTimeoutMs,
    environment: input.environment,
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context: input.context,
    limits: input.limits,
    toolApprovalEnabled: input.toolApprovalEnabled,
  });
  return {
    backend,
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
    }),
    interruptOn: input.toolApprovalEnabled
      ? createSandboxInterruptConfigs()
      : {},
  };
}
