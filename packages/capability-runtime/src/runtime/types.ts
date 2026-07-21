import type {
  CapabilityCommandWorkflow,
  CapabilityDiagnostic,
  CapabilityManifest,
  CapabilityOption,
  ToolContribution,
} from "@sourceweft/capability-contracts";

export type DiscoveredCapabilityRecord = {
  readonly manifest: CapabilityManifest;
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly packageName: string | null;
};

export type CapabilityDiscoveryResult = {
  readonly records: readonly DiscoveredCapabilityRecord[];
  readonly diagnostics: readonly CapabilityDiagnostic[];
};

export type CapabilityContributionActionKind =
  | "skill"
  | "tool"
  | "vfs"
  | "retrieval"
  | "document_parser"
  | "connector";

export type CapabilityCommandAction = {
  readonly kind: CapabilityContributionActionKind;
  readonly targetId: string;
};

export type CapabilityCommandListItem = {
  readonly id: string;
  readonly capabilityId: string;
  readonly contributionId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly parentKind: CapabilityContributionActionKind | null;
  readonly parentTitle: string | null;
  readonly aliases: readonly string[];
  readonly category: string | null;
  readonly iconName?: string;
  readonly iconTone?: "brand" | "mono";
  readonly visible: boolean;
  readonly order: number;
  readonly action: CapabilityCommandAction;
  readonly workflow: CapabilityCommandWorkflow | null;
  readonly sourcePackageName: string | null;
};

export type CapabilityToolListItem = {
  readonly id: string;
  readonly capabilityId: string;
  readonly contributionId: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly options: readonly CapabilityOption[];
  readonly order: number;
  readonly outputSchema: Record<string, unknown>;
  readonly risk: ToolContribution["risk"];
  readonly sourcePackageName: string | null;
  readonly title: string;
  readonly toolName: string;
};

/**
 * Reserved scaffolding for workspace-level capability configuration —
 * per-workspace enable/disable, reorder, and alias of contributed commands.
 *
 * Nothing in production constructs one of these today: every call path forwards
 * an `undefined` config, so the branches that read it are exercised only by
 * tests. Kept deliberately as the shape that surface will use; treat a value
 * arriving here as new, not as an existing feature.
 */
export type CapabilityCommandContributionConfig = {
  readonly enabled?: boolean;
  readonly aliases?: readonly string[];
  readonly visibility?: "command-list" | "agent-only" | "hidden";
  readonly order?: number;
};

export type CapabilityPackageConfig = {
  readonly enabled?: boolean;
  readonly order?: number;
  readonly contributions?: Readonly<
    Record<string, CapabilityCommandContributionConfig>
  >;
};

export type CapabilityCommandListConfig = {
  readonly packages?: Readonly<Record<string, CapabilityPackageConfig>>;
};
