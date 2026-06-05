import type { SelectableInvocationDefinitionWithAlias, SelectableInvocationProvider } from "../registry";

export type SkillCommandProjectionInput = {
  name: string;
  title: string;
  description?: string;
  workflow: string;
  slashAlias?: string;
};

export type SkillProjectionInput = {
  workspaceSkillId: string;
  skillSlug: string;
  displayName: string;
  commands: SkillCommandProjectionInput[];
  enabled: boolean;
};

export function createSkillCommandInvocationProvider(input: {
  skills: SkillProjectionInput[];
}): SelectableInvocationProvider {
  return {
    id: "skill_commands",
    list() {
      return input.skills.flatMap((skill) =>
        skill.commands.map(
          (command): SelectableInvocationDefinitionWithAlias => ({
            id: `skill_command.${skill.skillSlug}.${command.name}`,
            label: command.title,
            description: command.description,
            slashAlias: command.slashAlias,
            enabled: skill.enabled,
            unavailableReason: skill.enabled ? undefined : "Skill is not enabled",
            sourceRef: {
              kind: "skill_command",
              skillSlug: skill.skillSlug,
              commandName: command.name,
            },
            semantics: {
              kind: "context_injection",
              workflow: command.workflow,
            },
            metadata: {
              workspaceSkillId: skill.workspaceSkillId,
              skillDisplayName: skill.displayName,
            },
          }),
        ),
      );
    },
  };
}
