import {
  type CapabilityCommandWorkflow,
  buildCapabilityCommandList,
  buildCapabilityToolList,
  findCapabilityCommand,
  findCapabilityToolCommand,
  findCapabilityToolCommandWorkflow as findRuntimeCapabilityToolCommandWorkflow,
  type CapabilityCommandListItem,
  type CapabilityCommandListConfig,
  type CapabilityToolListItem,
  type DiscoveredCapabilityRecord,
} from "@sourceweft/capability-runtime";
import {
  createBackendCapabilityRuntimeAdapter,
  type BackendCapabilityRuntimeAdapter,
  resolveCapabilityPackagesRoot,
} from "./capability-runtime-adapter";

export type ResolvedCapabilityToolCommandWorkflow = {
  readonly toolName: string;
  readonly workflow: CapabilityCommandWorkflow;
};

let recordsPromise: Promise<readonly DiscoveredCapabilityRecord[]> | null =
  null;
let runtimeAdapter: BackendCapabilityRuntimeAdapter =
  createBackendCapabilityRuntimeAdapter();

async function capabilityRecords() {
  recordsPromise ??= runtimeAdapter.discoverRecords();
  return recordsPromise;
}

export async function listCapabilityRecords(): Promise<
  readonly DiscoveredCapabilityRecord[]
> {
  return capabilityRecords();
}

export async function findCapabilityToolCommandWorkflow(
  toolName: string,
  config?: CapabilityCommandListConfig,
): Promise<CapabilityCommandWorkflow | null> {
  const records = await capabilityRecords();
  return findRuntimeCapabilityToolCommandWorkflow(records, toolName, config);
}

export async function resolveCapabilityToolCommandWorkflow(
  name: string,
  config?: CapabilityCommandListConfig,
): Promise<ResolvedCapabilityToolCommandWorkflow | null> {
  const records = await capabilityRecords();
  const command = findCapabilityToolCommand(records, name, config);
  if (!command || command.action.kind !== "tool" || !command.workflow) {
    return null;
  }
  return {
    toolName: command.action.targetId,
    workflow: command.workflow,
  };
}

export async function resolveCapabilityCommand(
  name: string,
  config?: CapabilityCommandListConfig,
): Promise<CapabilityCommandListItem | null> {
  const records = await capabilityRecords();
  return findCapabilityCommand(records, name, config);
}

export async function resolveCapabilitySkillRuntimeWorkflow(
  skillSlug: string,
  config?: CapabilityCommandListConfig,
): Promise<CapabilityCommandWorkflow | null> {
  const records = await capabilityRecords();
  const command =
    buildCapabilityCommandList(records, config).find(
      (item) =>
        item.action.kind === "skill" &&
        item.action.targetId === skillSlug &&
        item.workflow,
    ) ?? null;
  return command?.workflow ?? null;
}

export async function listCapabilityCommands(
  config?: CapabilityCommandListConfig,
): Promise<readonly CapabilityCommandListItem[]> {
  const records = await capabilityRecords();
  return buildCapabilityCommandList(records, config);
}

export async function listCapabilityTools(
  config?: CapabilityCommandListConfig,
): Promise<readonly CapabilityToolListItem[]> {
  const records = await capabilityRecords();
  return buildCapabilityToolList(records, config);
}

export async function listCapabilityCatalog(
  config?: CapabilityCommandListConfig,
) {
  const records = await capabilityRecords();
  return {
    commands: buildCapabilityCommandList(records, config),
    tools: buildCapabilityToolList(records, config),
  };
}

export const testExports = {
  findCapabilityToolCommandWorkflow,
  listCapabilityCatalog,
  listCapabilityRecords,
  listCapabilityCommands,
  listCapabilityTools,
  resolveCapabilityCommand,
  resolveCapabilitySkillRuntimeWorkflow,
  resolveCapabilityToolCommandWorkflow,
  resetCapabilityRecordsCache() {
    recordsPromise = null;
  },
  resetCapabilityRuntimeAdapter() {
    runtimeAdapter = createBackendCapabilityRuntimeAdapter();
    recordsPromise = null;
  },
  resolveCapabilityPackagesDir: resolveCapabilityPackagesRoot,
  setCapabilityRuntimeAdapter(adapter: BackendCapabilityRuntimeAdapter) {
    runtimeAdapter = adapter;
    recordsPromise = null;
  },
};
