import type { CapabilityCommandWorkflow } from "@sourceweft/capability-runtime";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type { ResolvedThreadCommand } from "./types";

export type ActiveSkillRuntimeContract = {
  defaultTools: string[];
  permissionOverrides: Record<string, "allow" | "ask" | "deny">;
};

function skillRuntimeTools(skill: EnabledSkillDescriptor) {
  return skill.tools ?? [];
}

export function resolveActiveSkillRuntimeContract(input: {
  activeSkills: readonly EnabledSkillDescriptor[];
  command: ResolvedThreadCommand | null;
  skillRuntimeWorkflows?: ReadonlyMap<string, CapabilityCommandWorkflow>;
}): ActiveSkillRuntimeContract {
  const defaultTools = new Set<string>();
  const permissionOverrides: Record<string, "allow" | "ask" | "deny"> = {};

  for (const skill of input.activeSkills) {
    for (const toolName of skillRuntimeTools(skill)) {
      defaultTools.add(toolName);
    }

    const workflow = input.skillRuntimeWorkflows?.get(skill.name) ?? null;
    if (!workflow) {
      continue;
    }
    for (const toolName of workflow.defaultTools) {
      defaultTools.add(toolName);
    }
    Object.assign(permissionOverrides, workflow.permissionOverrides);
  }

  if (input.command?.workflow) {
    for (const toolName of input.command.workflow.defaultTools) {
      defaultTools.add(toolName);
    }
    Object.assign(
      permissionOverrides,
      input.command.workflow.permissionOverrides,
    );
  }

  return {
    defaultTools: Array.from(defaultTools),
    permissionOverrides,
  };
}
