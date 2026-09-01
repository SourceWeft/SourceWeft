import type {
  CapabilityCatalogCommand,
  ListCapabilityCatalogResponse,
} from "@sourceweft/sdk";

export type HubSkillItem = {
  id: string;
  workspaceSkillId?: string;
  catalogId: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  sourceType:
    "builtin" | "workspace_custom" | "team_custom" | "registry_github";
  version: string;
  enabled?: boolean;
  hasReadme: boolean;
  tools?: string[];
};

export type SkillIconSpec = Pick<
  CapabilityCatalogCommand,
  "iconName" | "iconTone"
>;

export function skillSourceLabel(sourceType: HubSkillItem["sourceType"]) {
  if (sourceType === "builtin") return "Official";
  if (sourceType === "team_custom") return "Team";
  if (sourceType === "registry_github") return "Community";
  return "Workspace";
}

export function countFilteredSkills(
  items: HubSkillItem[],
  searchQuery: string,
) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    return items.length;
  }
  return items.filter(
    (skill) =>
      skill.displayName.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q) ||
      skill.name.toLowerCase().includes(q) ||
      skill.slug.toLowerCase().includes(q) ||
      skillSourceLabel(skill.sourceType).toLowerCase().includes(q),
  ).length;
}

export function buildHubSkillIconsById(
  skills: readonly HubSkillItem[],
  capabilityCatalog: ListCapabilityCatalogResponse | null | undefined,
) {
  const commands = capabilityCatalog?.commands ?? [];
  if (commands.length === 0) {
    return new Map<string, SkillIconSpec>();
  }

  const skillByTargetId = new Map<string, HubSkillItem>();
  for (const skill of skills) {
    skillByTargetId.set(skill.name.toLowerCase(), skill);
    skillByTargetId.set(skill.slug.toLowerCase(), skill);
  }

  const iconsById = new Map<string, SkillIconSpec>();
  for (const command of commands) {
    if (command.action.kind !== "skill" || !command.iconName) {
      continue;
    }

    const skill = skillByTargetId.get(command.action.targetId.toLowerCase());
    if (!skill || iconsById.has(skill.id)) {
      continue;
    }

    iconsById.set(skill.id, {
      iconName: command.iconName,
      ...(command.iconTone ? { iconTone: command.iconTone } : {}),
    });
  }

  return iconsById;
}
