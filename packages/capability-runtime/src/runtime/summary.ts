import type { CapabilityDiagnostic } from "@sourceweft/capability-contracts";
import { getCapabilityContributions } from "./contributions";
import type { DiscoveredCapabilityRecord } from "./types";

export type CapabilityRegistrySummary = {
  readonly packageCount: number;
  readonly commandCount: number;
  readonly toolCount: number;
  readonly optionContributionCount: number;
  readonly vfsProviderCount: number;
  readonly retrievalProviderCount: number;
  readonly documentParserProviderCount: number;
  readonly connectorProviderCount: number;
  readonly diagnostics: {
    readonly errorCount: number;
    readonly warningCount: number;
  };
};

export function summarizeCapabilityRegistry(
  records: readonly DiscoveredCapabilityRecord[],
  diagnostics: readonly CapabilityDiagnostic[],
): CapabilityRegistrySummary {
  return {
    packageCount: records.length,
    commandCount: countCommands(records),
    toolCount: records.reduce(
      (count, record) =>
        count + getCapabilityContributions(record.manifest).tools.length,
      0,
    ),
    optionContributionCount: records.reduce(
      (count, record) => count + countContributionOptions(record),
      0,
    ),
    vfsProviderCount: records.reduce(
      (count, record) =>
        count + getCapabilityContributions(record.manifest).vfs.length,
      0,
    ),
    retrievalProviderCount: records.reduce(
      (count, record) =>
        count + getCapabilityContributions(record.manifest).retrieval.length,
      0,
    ),
    documentParserProviderCount: records.reduce(
      (count, record) =>
        count +
        getCapabilityContributions(record.manifest).documentParsers.length,
      0,
    ),
    connectorProviderCount: records.reduce(
      (count, record) =>
        count + getCapabilityContributions(record.manifest).connectors.length,
      0,
    ),
    diagnostics: {
      errorCount: diagnostics.filter(
        (diagnostic) => diagnostic.level === "error",
      ).length,
      warningCount: diagnostics.filter(
        (diagnostic) => diagnostic.level === "warning",
      ).length,
    },
  };
}

function countContributionOptions(record: DiscoveredCapabilityRecord) {
  return getCapabilityContributions(record.manifest).tools.reduce(
    (count, tool) => count + tool.options.length,
    0,
  );
}

function countCommands(records: readonly DiscoveredCapabilityRecord[]): number {
  return records.reduce((count, record) => {
    const contributes = getCapabilityContributions(record.manifest);
    return (
      count +
      contributes.skills.filter((skill) => skill.command).length +
      contributes.tools.filter((tool) => tool.command).length +
      contributes.vfs.filter((provider) => provider.command).length +
      contributes.retrieval.filter((provider) => provider.command).length +
      contributes.documentParsers.filter((parser) => parser.command).length +
      contributes.connectors.filter((connector) => connector.command).length
    );
  }, 0);
}
