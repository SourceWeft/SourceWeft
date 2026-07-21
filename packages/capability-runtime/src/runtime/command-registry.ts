import type {
  CapabilityCommandWorkflow,
  CapabilityManifest,
  CapabilityRuntimeOutput,
  SkillContribution,
} from "@sourceweft/capability-contracts";
import {
  getCapabilityContributions,
  getContributionDisplayTitle,
} from "./contributions";
import type {
  CapabilityCommandAction,
  CapabilityCommandContributionConfig,
  CapabilityCommandListConfig,
  CapabilityCommandListItem,
  CapabilityContributionActionKind,
  DiscoveredCapabilityRecord,
} from "./types";

type ManifestCommand = NonNullable<SkillContribution["command"]>;
type ManifestCommandWithTitle = ManifestCommand & { readonly title: string };
type ContributedCommand = {
  readonly contributionId: string;
  readonly contributionTitle: string | null;
  readonly command: ManifestCommandWithTitle;
  readonly action: CapabilityCommandAction;
  readonly workflow: CapabilityCommandWorkflow | null;
};

export function buildCapabilityCommandList(
  records: readonly DiscoveredCapabilityRecord[],
  config: CapabilityCommandListConfig = {},
): readonly CapabilityCommandListItem[] {
  const commands: CapabilityCommandListItem[] = [];

  for (const record of records) {
    const packageConfig = config.packages?.[record.manifest.id];
    if (packageConfig?.enabled === false) {
      continue;
    }

    for (const contributed of collectCommands(record.manifest)) {
      const contributionConfig =
        packageConfig?.contributions?.[contributed.contributionId];
      if (contributionConfig?.enabled === false) {
        continue;
      }
      commands.push(
        toCommandListItem({
          contributed,
          contributionConfig,
          packageOrder: packageConfig?.order ?? 0,
          record,
        }),
      );
    }
  }

  return commands.sort(compareCommands);
}

export function findCapabilityToolCommandWorkflow(
  records: readonly DiscoveredCapabilityRecord[],
  toolName: string,
  config: CapabilityCommandListConfig = {},
) {
  return findCapabilityToolCommand(records, toolName, config)?.workflow ?? null;
}

export function findCapabilityToolCommand(
  records: readonly DiscoveredCapabilityRecord[],
  name: string,
  config: CapabilityCommandListConfig = {},
) {
  const normalizedName = normalizeCommandLookupName(name);
  return (
    buildCapabilityCommandList(records, config).find(
      (command) =>
        command.action.kind === "tool" &&
        command.workflow &&
        matchesCommandLookupName(command, normalizedName),
    ) ?? null
  );
}

export function findCapabilityCommand(
  records: readonly DiscoveredCapabilityRecord[],
  name: string,
  config: CapabilityCommandListConfig = {},
) {
  const normalizedName = normalizeCommandLookupName(name);
  return (
    buildCapabilityCommandList(records, config).find((command) =>
      matchesCommandLookupName(command, normalizedName),
    ) ?? null
  );
}

function collectCommands(
  manifest: CapabilityManifest,
): readonly ContributedCommand[] {
  const contributions = getCapabilityContributions(manifest);
  // Commands are always contributed by a specific skill/tool/etc., never by the
  // package as a whole: every entry below is derived from a contribution's
  // `command` block.
  const commands: ContributedCommand[] = [];
  for (const skill of contributions.skills) {
    const contributionTitle = getContributionDisplayTitle({
      fallback: manifest.name,
      title: skill.title,
    });
    pushContributionCommand(
      commands,
      "skill",
      skill.id,
      contributionTitle,
      skill.command,
      manifest.name,
      skill.runtime
        ? runtimeToCommandWorkflow(
            skill.runtime.output,
            skill.runtime.tools,
            skill.runtime,
          )
        : null,
    );
  }
  for (const tool of contributions.tools) {
    pushContributionCommand(
      commands,
      "tool",
      tool.id,
      tool.title,
      tool.command,
      tool.title,
      tool.runtime
        ? runtimeToCommandWorkflow(
            tool.runtime.output,
            tool.runtime.tools,
            tool.runtime,
          )
        : null,
    );
  }
  return commands;
}

function pushContributionCommand(
  commands: ContributedCommand[],
  kind: CapabilityContributionActionKind,
  contributionId: string,
  contributionTitle: string | undefined,
  command: ManifestCommand | undefined,
  fallbackTitle: string,
  runtimeWorkflow: CapabilityCommandWorkflow | null,
) {
  if (!command) {
    return;
  }
  const commandWithDefaults = withDefaultCommandTitle(command, fallbackTitle);
  commands.push({
    contributionId,
    contributionTitle: contributionTitle ?? null,
    command: commandWithDefaults,
    action: { kind, targetId: contributionId },
    workflow: runtimeWorkflow ?? command.workflow ?? null,
  });
}

function withDefaultCommandTitle(
  command: ManifestCommand,
  fallbackTitle: string,
): ManifestCommandWithTitle {
  return {
    ...command,
    title: command.title ?? fallbackTitle,
  };
}

function runtimeToCommandWorkflow(
  output: CapabilityRuntimeOutput | undefined,
  tools: readonly string[],
  runtime?: {
    readonly additionalPromptLines?: readonly string[];
    readonly execution?: "agent";
    readonly permissionOverrides?: Readonly<
      Record<string, "allow" | "ask" | "deny">
    >;
    readonly promptIntro?: string;
    readonly requiredArguments?: {
      readonly clarificationPrompt: string;
      readonly description: string;
    };
  },
): CapabilityCommandWorkflow {
  const defaultTools = new Set(tools);
  if (output?.kind === "artifact") {
    defaultTools.add(output.publisherTool);
  }
  return {
    execution: runtime?.execution ?? "agent",
    ...(runtime?.promptIntro ? { promptIntro: runtime.promptIntro } : {}),
    defaultTools: Array.from(defaultTools),
    permissionOverrides: { ...(runtime?.permissionOverrides ?? {}) },
    ...(runtime?.requiredArguments
      ? { requiredArguments: runtime.requiredArguments }
      : {}),
    additionalPromptLines: [...(runtime?.additionalPromptLines ?? [])],
    successCriteria: runtimeOutputToSuccessCriteria(output),
  };
}

function runtimeOutputToSuccessCriteria(
  output: CapabilityRuntimeOutput | undefined,
): CapabilityCommandWorkflow["successCriteria"] {
  if (!output || output.kind === "none") {
    return { kind: "none" };
  }
  return {
    kind: "artifact",
    artifactType: output.artifactType,
    toolName: output.publisherTool,
  };
}

function toCommandListItem(input: {
  readonly contributed: ContributedCommand;
  readonly contributionConfig: CapabilityCommandContributionConfig | undefined;
  readonly packageOrder: number;
  readonly record: DiscoveredCapabilityRecord;
}): CapabilityCommandListItem {
  const configuredVisibility = input.contributionConfig?.visibility;
  const parentKind =
    input.contributed.action.kind === "skill"
      ? input.contributed.action.kind
      : null;
  const parentTitle =
    parentKind === "skill" ? input.contributed.contributionTitle : null;
  const displayTitle = formatCommandDisplayTitle({
    parentTitle,
    title: input.contributed.command.title,
  });
  return {
    id: `cap:${input.record.manifest.id}:${input.contributed.contributionId}`,
    capabilityId: input.record.manifest.id,
    contributionId: input.contributed.contributionId,
    title: input.contributed.command.title,
    displayTitle,
    parentKind,
    parentTitle,
    aliases:
      input.contributionConfig?.aliases ?? input.contributed.command.aliases,
    category: input.contributed.command.category ?? null,
    ...(input.contributed.command.iconName
      ? { iconName: input.contributed.command.iconName }
      : {}),
    ...(input.contributed.command.iconTone
      ? { iconTone: input.contributed.command.iconTone }
      : {}),
    visible:
      input.contributed.command.visibleWhen === "hidden"
        ? false
        : configuredVisibility === undefined
          ? input.contributed.command.visibleWhen !== "configured"
          : configuredVisibility === "command-list",
    order: input.contributionConfig?.order ?? input.packageOrder,
    action: input.contributed.action,
    workflow: input.contributed.workflow,
    sourcePackageName: input.record.packageName,
  };
}

function formatCommandDisplayTitle(input: {
  readonly parentTitle: string | null;
  readonly title: string;
}) {
  if (!input.parentTitle || input.parentTitle === input.title) {
    return input.title;
  }
  return `${input.parentTitle} / ${input.title}`;
}

function compareCommands(
  left: CapabilityCommandListItem,
  right: CapabilityCommandListItem,
) {
  return (
    left.order - right.order ||
    left.capabilityId.localeCompare(right.capabilityId) ||
    left.contributionId.localeCompare(right.contributionId) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeCommandLookupName(name: string) {
  return name.trim().replace(/^\//, "").toLowerCase();
}

function matchesCommandLookupName(
  command: CapabilityCommandListItem,
  normalizedName: string,
) {
  return (
    command.action.targetId.toLowerCase() === normalizedName ||
    command.aliases.some(
      (alias) => normalizeCommandLookupName(alias) === normalizedName,
    )
  );
}
