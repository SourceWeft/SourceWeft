import type {
  CapabilityManifest,
  ConnectorContribution,
  DocumentParserContribution,
  RetrievalContribution,
  SkillContribution,
  ToolContribution,
  VfsContribution,
} from "@sourceweft/capability-contracts";

export type CapabilityContributions = {
  readonly connectors: readonly ConnectorContribution[];
  readonly documentParsers: readonly DocumentParserContribution[];
  readonly retrieval: readonly RetrievalContribution[];
  readonly skills: readonly SkillContribution[];
  readonly tools: readonly ToolContribution[];
  readonly vfs: readonly VfsContribution[];
};

export function getCapabilityContributions(
  manifest: CapabilityManifest,
): CapabilityContributions {
  return {
    connectors: manifest.contributes.connectors,
    documentParsers: manifest.contributes.documentParsers,
    retrieval: manifest.contributes.retrieval,
    skills: manifest.contributes.skills,
    tools: manifest.contributes.tools,
    vfs: manifest.contributes.vfs,
  };
}

export function getContributionDisplayTitle(input: {
  readonly fallback: string;
  readonly title?: string;
}) {
  return input.title?.trim() || input.fallback;
}
