import type { ToolContribution } from "@sourceweft/capability-contracts";
import { getCapabilityContributions } from "./contributions";
import type {
  CapabilityCommandListConfig,
  CapabilityToolListItem,
  DiscoveredCapabilityRecord,
} from "./types";

export function buildCapabilityToolList(
  records: readonly DiscoveredCapabilityRecord[],
  config: CapabilityCommandListConfig = {},
): readonly CapabilityToolListItem[] {
  const tools: CapabilityToolListItem[] = [];

  for (const record of records) {
    const packageConfig = config.packages?.[record.manifest.id];
    if (packageConfig?.enabled === false) {
      continue;
    }

    for (const tool of getCapabilityContributions(record.manifest).tools) {
      const contributionConfig = packageConfig?.contributions?.[tool.id];
      if (contributionConfig?.enabled === false) {
        continue;
      }

      tools.push(
        toToolListItem({
          packageOrder: packageConfig?.order ?? 0,
          record,
          tool,
        }),
      );
    }
  }

  return tools.sort(compareTools);
}

function toToolListItem(input: {
  readonly packageOrder: number;
  readonly record: DiscoveredCapabilityRecord;
  readonly tool: ToolContribution;
}): CapabilityToolListItem {
  return {
    id: `cap:${input.record.manifest.id}:${input.tool.id}`,
    capabilityId: input.record.manifest.id,
    contributionId: input.tool.id,
    description: input.tool.description,
    inputSchema: input.tool.inputSchema,
    options: input.tool.options,
    order: input.packageOrder,
    outputSchema: input.tool.outputSchema,
    risk: input.tool.risk,
    sourcePackageName: input.record.packageName,
    title: input.tool.title,
    toolName: input.tool.id,
  };
}

function compareTools(
  left: CapabilityToolListItem,
  right: CapabilityToolListItem,
) {
  return (
    left.order - right.order ||
    left.capabilityId.localeCompare(right.capabilityId) ||
    left.contributionId.localeCompare(right.contributionId) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}
