import type { CapabilityCatalogCommand } from "@sourceweft/sdk";
import type { ChatSkillItem } from "./types";

export type SkillSlashCommandFamilyItem =
  | {
      command: CapabilityCatalogCommand;
      kind: "capability-skill-command";
      skill: ChatSkillItem;
    }
  | {
      kind: "skill";
      skill: ChatSkillItem;
    };

export function isCapabilityCatalogSlashCommand(
  command: CapabilityCatalogCommand,
) {
  if (!command.visible) {
    return false;
  }

  if (command.action.kind === "tool") {
    return command.hasWorkflow;
  }

  return command.action.kind === "skill";
}

export function capabilityCommandDisplayLabel(
  command: CapabilityCatalogCommand,
) {
  return command.displayTitle || command.title;
}

export function buildSkillSlashCommandFamilies(input: {
  commands: readonly CapabilityCatalogCommand[];
  skills: readonly ChatSkillItem[];
}): SkillSlashCommandFamilyItem[] {
  const skillByTargetId = new Map<string, ChatSkillItem>();
  for (const skill of input.skills) {
    skillByTargetId.set(skill.name.toLowerCase(), skill);
    skillByTargetId.set(skill.slug.toLowerCase(), skill);
  }

  const capabilityCommandsBySkillId = new Map<
    string,
    CapabilityCatalogCommand[]
  >();
  for (const command of input.commands) {
    if (
      command.action.kind !== "skill" ||
      !isCapabilityCatalogSlashCommand(command)
    ) {
      continue;
    }
    const skill = skillByTargetId.get(command.action.targetId.toLowerCase());
    if (!skill) {
      continue;
    }
    const commands = capabilityCommandsBySkillId.get(skill.id) ?? [];
    commands.push(command);
    capabilityCommandsBySkillId.set(skill.id, commands);
  }

  const items: SkillSlashCommandFamilyItem[] = [];
  for (const skill of input.skills) {
    const slashConfigEnabled = skill.slashConfig?.enabled !== false;
    if (!slashConfigEnabled) {
      continue;
    }

    const capabilityCommands = capabilityCommandsBySkillId.get(skill.id) ?? [];
    for (const command of capabilityCommands) {
      items.push({
        command,
        kind: "capability-skill-command",
        skill,
      });
    }

    const legacySlashEnabled = skill.slash !== false;
    if (!legacySlashEnabled) {
      continue;
    }

    if (capabilityCommands.length === 0) {
      items.push({
        kind: "skill",
        skill,
      });
    }
  }
  return items;
}
