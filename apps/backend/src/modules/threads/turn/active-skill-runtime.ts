import type { CapabilityCommandWorkflow } from "@sourceweft/capability-runtime";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type { ResolvedThreadCommand } from "./types";
import { ContentError } from "../../content/errors";

export type SelectedSkillRuntimeContract = {
  defaultTools: string[];
  permissionOverrides: Record<string, "allow" | "ask" | "deny">;
  toolPolicy?: {
    allow?: string[];
    deny: string[];
  };
  successCriteria?: CapabilityCommandWorkflow["successCriteria"];
};

function skillRuntimeTools(skill: EnabledSkillDescriptor) {
  return skill.tools ?? [];
}

export function resolveSelectedSkillRuntimeContract(input: {
  selectedSkills: readonly EnabledSkillDescriptor[];
  command: ResolvedThreadCommand | null;
  skillRuntimeWorkflows?: ReadonlyMap<string, CapabilityCommandWorkflow>;
}): SelectedSkillRuntimeContract {
  const defaultTools = new Set<string>();
  const permissionOverrides: Record<string, "allow" | "ask" | "deny"> = {};
  let allowedTools: Set<string> | null = null;
  const deniedTools = new Set<string>();
  const skillSuccessCriteria: CapabilityCommandWorkflow["successCriteria"][] =
    [];
  const mergeToolPolicy = (
    policy: CapabilityCommandWorkflow["toolPolicy"] | undefined,
  ) => {
    if (!policy) return;
    if (policy.allow) {
      allowedTools ??= new Set<string>();
      policy.allow.forEach((toolName) => allowedTools!.add(toolName));
    }
    policy.deny.forEach((toolName) => deniedTools.add(toolName));
  };

  for (const skill of input.selectedSkills) {
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
    // A default skill expands the ordinary chat surface. Only an explicitly
    // selected non-default skill may turn that surface into a strict workflow.
    if (skill.defaultEnabled !== true) {
      mergeToolPolicy(workflow.toolPolicy);
      skillSuccessCriteria.push(workflow.successCriteria);
    }
  }

  if (input.command?.workflow) {
    for (const toolName of input.command.workflow.defaultTools) {
      defaultTools.add(toolName);
    }
    Object.assign(
      permissionOverrides,
      input.command.workflow.permissionOverrides,
    );
    allowedTools = null;
    deniedTools.clear();
    if (input.command.workflow.toolPolicy) {
      allowedTools = input.command.workflow.toolPolicy.allow
        ? new Set(input.command.workflow.toolPolicy.allow)
        : null;
      input.command.workflow.toolPolicy.deny.forEach((toolName) =>
        deniedTools.add(toolName),
      );
    }
    skillSuccessCriteria.splice(
      0,
      skillSuccessCriteria.length,
      input.command.workflow.successCriteria,
    );
  }

  deniedTools.forEach((toolName) => allowedTools?.delete(toolName));

  if (skillSuccessCriteria.length > 1) {
    throw new ContentError(
      400,
      "MULTIPLE_STRICT_SKILL_WORKFLOWS",
      "Select only one strict artifact workflow skill for this turn.",
      { recoverable: true },
    );
  }

  return {
    defaultTools: Array.from(defaultTools),
    permissionOverrides,
    ...(allowedTools || deniedTools.size > 0
      ? {
          toolPolicy: {
            ...(allowedTools ? { allow: [...allowedTools] } : {}),
            deny: [...deniedTools],
          },
        }
      : {}),
    ...(skillSuccessCriteria.length === 1
      ? { successCriteria: skillSuccessCriteria[0] }
      : {}),
  };
}
