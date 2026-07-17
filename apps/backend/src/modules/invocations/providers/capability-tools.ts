import type { CapabilityCommandListItem } from "@sourceweft/capability-runtime";
import type {
  SelectableInvocationDefinitionWithAlias,
  SelectableInvocationProvider,
} from "../registry";

export function createCapabilityToolInvocationProvider(input: {
  readonly commands: readonly CapabilityCommandListItem[];
}): SelectableInvocationProvider {
  return {
    id: "capability_tools",
    list() {
      return projectCapabilityToolCommands(input.commands);
    },
  };
}

export function projectCapabilityToolCommands(
  commands: readonly CapabilityCommandListItem[],
): SelectableInvocationDefinitionWithAlias[] {
  return commands.flatMap((command) =>
    command.action.kind === "tool" && command.visible
      ? [projectCapabilityToolCommand(command)]
      : [],
  );
}

function projectCapabilityToolCommand(
  command: CapabilityCommandListItem,
): SelectableInvocationDefinitionWithAlias {
  const slashAliases = command.aliases.map(normalizeSlashAlias);
  const slashAlias = slashAliases[0];
  return {
    id: command.id,
    label: command.title,
    enabled: true,
    ...(slashAlias ? { slashAlias } : {}),
    alternateSlashAliases: slashAliases.slice(1),
    metadata: {
      capabilityId: command.capabilityId,
      contributionId: command.contributionId,
      sourcePackageName: command.sourcePackageName,
    },
    sourceRef: {
      kind: "capability_tool",
      capabilityId: command.capabilityId,
      contributionId: command.contributionId,
      sourcePackageName: command.sourcePackageName,
      toolName: command.action.targetId,
    },
    semantics: {
      kind: "fixed_tool_choice",
      target: "capability_tool",
      toolName: command.action.targetId,
    },
  };
}

function normalizeSlashAlias(alias: string) {
  return alias.startsWith("/") ? alias : `/${alias}`;
}
