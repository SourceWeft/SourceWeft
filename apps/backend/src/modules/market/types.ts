import type {
  MarketItemStatus,
  MarketItemVisibility,
  MarketMcpManifest,
  MarketMcpToolManifest,
  McpRiskLevel,
  McpTransport,
} from "@sourceweft/market-contracts";

export type McpIngestMode = "static" | "mixed";
export type McpClassificationMode = "deepseek" | "rules";

export type McpClassificationResult = {
  categories: string[];
  confidence?: number;
  fallbackReason?: string;
  inputHash: string;
  llmResult?: {
    confidence: number;
    primaryCategory: string;
    reason: string;
    reviewRequired: boolean;
    secondaryCategories: string[];
  };
  method: "deepseek" | "rules-fallback";
  model?: string;
  provider?: string;
  reviewRequired: boolean;
  ruleCandidates: string[];
  taxonomyVersion: string;
};

export type NormalizedGitHubSource = {
  owner: string;
  repo: string;
  ref?: string;
  subpath: string;
  repoUrl: string;
  sourceUrl: string;
};

export type PreparedGitHubRepository = NormalizedGitHubSource & {
  commitSha?: string;
  requestedRef: string;
  resolvedRef: string;
  rootDir: string;
  workDir: string;
  /**
   * Root temp directory holding the downloaded tarball and extracted repo.
   * Callers MUST delete this once parsing finishes — the extracted third-party
   * source is a transient analysis copy and must not linger in os.tmpdir().
   */
  tempRoot: string;
};

export type RegistryInput = {
  choices?: string[];
  default?: string;
  description?: string;
  format?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  name?: string;
  placeholder?: string;
  value?: string;
  valueHint?: string;
  variables?: Record<string, RegistryInput>;
};

export type RegistryTransport = {
  headers?: RegistryInput[];
  type?: string;
  url?: string;
  variables?: Record<string, RegistryInput>;
};

export type RegistryPackage = {
  environmentVariables?: RegistryInput[];
  identifier?: string;
  packageArguments?: RegistryInput[];
  registryBaseUrl?: string;
  registryType?: string;
  runtimeArguments?: RegistryInput[];
  runtimeHint?: string;
  transport?: RegistryTransport;
  version?: string;
};

export type RegistryRemote = RegistryTransport;

export type RegistryServerJson = {
  $schema?: string;
  description?: string;
  icons?: unknown[];
  name?: string;
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
  repository?: {
    id?: string;
    source?: string;
    subfolder?: string;
    url?: string;
  };
  title?: string;
  version?: string;
  websiteUrl?: string;
  _meta?: Record<string, unknown>;
};

export type ParserEvidence = {
  detail?: Record<string, unknown>;
  path?: string;
  source: "server-json" | "readme" | "source" | "package" | "runtime";
  summary: string;
};

export type ParsedTool = MarketMcpToolManifest & {
  confidence: number;
  source: ParserEvidence["source"];
  sourcePath?: string;
};

export type ConnectionCandidate = {
  args?: string[];
  authRequired?: boolean;
  command?: string;
  confidence: number;
  dockerImage?: string;
  endpointUrl?: string;
  environmentVariables?: RegistryInput[];
  headerNames?: string[];
  identifier?: string;
  packageArguments?: RegistryInput[];
  registryType?: string;
  requiredSecrets?: string[];
  runtimeArguments?: RegistryInput[];
  runtimeHint?: string;
  source: ParserEvidence["source"];
  sourcePath?: string;
  transport: McpTransport;
};

export type ReadmeParseResult = {
  content: string;
  installCommands: string[];
  mcpName?: string;
  path: string;
  summary?: string;
  tools: ParsedTool[];
};

export type StaticParseResult = {
  connections: ConnectionCandidate[];
  evidence: ParserEvidence[];
  mcpAssessment: McpRepositoryAssessment;
  packageHints: Record<string, unknown>[];
  readme?: ReadmeParseResult;
  serverJson?: {
    content: RegistryServerJson;
    path: string;
  };
  source: PreparedGitHubRepository;
  sourceTools: ParsedTool[];
  warnings: string[];
};

export type McpRepositoryAssessment = {
  confidence: number;
  isMcp: boolean;
  reasons: string[];
  signals: Array<{
    confidence: number;
    kind:
      | "mcp-entrypoint"
      | "mcp-config"
      | "mcp-name"
      | "mcp-package"
      | "mcp-readme"
      | "mcp-source"
      | "server-json"
      | "tool-registration";
    detail?: Record<string, unknown>;
    path?: string;
    summary: string;
  }>;
};

export type RuntimeIntrospectionResult = {
  evidence: ParserEvidence[];
  prompts?: unknown[];
  resources?: unknown[];
  skippedReason?: string;
  tools: ParsedTool[];
  warnings: string[];
};

export type McpParserReport = {
  connections: ConnectionCandidate[];
  evidence: ParserEvidence[];
  generatedAt: string;
  github: {
    commitSha?: string;
    owner: string;
    ref: string;
    repo: string;
    repoUrl: string;
    sourceUrl: string;
    subpath: string;
  };
  installCommands: string[];
  classification?: McpClassificationResult;
  market?: {
    confidence?: number;
    marketPageUrl?: string;
    rule?: string;
    sourceMarket?: string;
  };
  mode: McpIngestMode;
  packageHints: Record<string, unknown>[];
  runtime: {
    promptsCount?: number;
    resourcesCount?: number;
    skippedReason?: string;
    toolsCount: number;
    warnings: string[];
  };
  schemaVersion: 1;
  serverJson?: Record<string, unknown>;
  static: {
    mcpAssessment?: McpRepositoryAssessment;
    readmePath?: string;
    sourceToolCount: number;
    warnings: string[];
  };
};

export type McpIngestResult = {
  manifest: MarketMcpManifest;
  report: McpParserReport;
};

export type McpRepositoryParseOptions = {
  categories?: string[];
  classificationMode?: McpClassificationMode;
  refreshClassification?: boolean;
  discovery?: {
    confidence?: number;
    marketPageUrl?: string;
    rule?: string;
    sourceMarket?: string;
  };
  mode: McpIngestMode;
};

export type McpRepositoryIngestOptions = {
  status: MarketItemStatus;
  visibility: MarketItemVisibility;
};

export type DryRunIngestResult = {
  item: {
    id: string;
    identifier: string;
    status: MarketItemStatus;
    visibility: MarketItemVisibility;
  };
  manifest: MarketMcpManifest;
  provenanceJson: McpParserReport;
  version: {
    id: string;
    status: MarketItemStatus;
    version: string;
  };
};

export type RiskClassifier = (tool: Pick<MarketMcpToolManifest, "name">) => McpRiskLevel;
