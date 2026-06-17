import type {
  ArtifactContribution,
  CapabilityManifest,
  ConnectorContribution,
  DocumentParserContribution,
  McpContribution,
  RetrievalContribution,
  SkillContribution,
  ToolContribution,
  VfsContribution,
} from "@sourceweft/capability-contracts";

export type CapabilityContributions = {
  readonly artifacts: readonly ArtifactContribution[];
  readonly connectors: readonly ConnectorContribution[];
  readonly documentParsers: readonly DocumentParserContribution[];
  readonly mcp: readonly McpContribution[];
  readonly retrieval: readonly RetrievalContribution[];
  readonly skills: readonly SkillContribution[];
  readonly tools: readonly ToolContribution[];
  readonly vfs: readonly VfsContribution[];
};

export function getCapabilityContributions(
  manifest: CapabilityManifest,
): CapabilityContributions {
  return {
    artifacts: manifest.artifacts ?? manifest.contributes.artifacts,
    connectors: manifest.connectors ?? manifest.contributes.connectors,
    documentParsers:
      manifest.documentParsers ?? manifest.contributes.documentParsers,
    mcp: manifest.mcp ?? manifest.contributes.mcp,
    retrieval: manifest.retrieval ?? manifest.contributes.retrieval,
    skills: manifest.skills ?? manifest.contributes.skills,
    tools: manifest.tools ?? manifest.contributes.tools,
    vfs: manifest.vfs ?? manifest.contributes.vfs,
  };
}

export function getContributionDisplayTitle(input: {
  readonly fallback: string;
  readonly title?: string;
}) {
  return input.title?.trim() || input.fallback;
}
