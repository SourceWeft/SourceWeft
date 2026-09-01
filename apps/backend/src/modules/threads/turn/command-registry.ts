import type { CapabilityCommandWorkflow } from "@sourceweft/capability-runtime";
import { getAgentToolSlashCommand } from "@sourceweft/agent-tool-registry";

export type ToolPermission = "allow" | "ask" | "deny";

export type CommandSuccessCriteria =
  | {
      kind: "none";
    }
  | {
      kind: "tool_call";
      toolName: string;
    }
  | {
      kind: "artifact";
      /**
       * Taken verbatim from the capability manifest's `runtime.output.artifactType`.
       * Deliberately not narrowed to a literal union: the set of artifact types is
       * declared by manifests, not by this module. Consumers that need per-type
       * behaviour (see `agent/turn/command-success.ts`) match on the specific types
       * they know and fall back to a generic "publisher tool completed" check.
       */
      artifactType: string;
      toolName: string;
    };

export type ResolvedCommandWorkflow = {
  name: string;
  arguments: string;
  kind: "workflow" | "skill_workflow" | "tool_workflow";
  renderedPrompt: string;
  defaultTools: string[];
  initialToolPolicy?: CapabilityCommandWorkflow["initialToolPolicy"];
  toolPolicy?: CapabilityCommandWorkflow["toolPolicy"];
  permissionOverrides: Record<string, ToolPermission>;
  successCriteria: CommandSuccessCriteria;
  execution: "agent" | "direct";
};

type ToolCommandDefinition = {
  workflow: CapabilityCommandWorkflow;
};

/**
 * The success criterion is whatever the manifest declared. A manifest that says
 * `runtime.output.kind: "artifact"` gets an `artifact` criterion regardless of the
 * artifact type it names — this module does not second-guess the declaration.
 */
function normalizeSuccessCriteria(
  criteria: CapabilityCommandWorkflow["successCriteria"],
): CommandSuccessCriteria {
  if (criteria.kind !== "artifact") {
    return criteria;
  }
  return {
    kind: "artifact",
    artifactType: criteria.artifactType,
    toolName: criteria.toolName,
  };
}

function resolvedToolPolicyFields(workflow: CapabilityCommandWorkflow) {
  return {
    ...(workflow.initialToolPolicy
      ? { initialToolPolicy: workflow.initialToolPolicy }
      : {}),
    ...(workflow.toolPolicy
      ? {
          toolPolicy: {
            ...(workflow.toolPolicy.allow
              ? { allow: [...workflow.toolPolicy.allow] }
              : {}),
            deny: [...workflow.toolPolicy.deny],
          },
        }
      : {}),
  };
}

export function resolveToolCommandDefinition(input: {
  toolName: string;
  workflow: CapabilityCommandWorkflow | null;
}) {
  const slash = getAgentToolSlashCommand(input.toolName);
  if (!slash?.supportsCommand || !input.workflow) {
    return null;
  }
  return { workflow: input.workflow };
}

export function renderToolCommandWorkflow(input: {
  arguments: string;
  canonicalName: string;
  displayName: string;
  toolName: string;
  workflow: CapabilityCommandWorkflow | null;
}): ResolvedCommandWorkflow | null {
  const definition = resolveToolCommandDefinition({
    toolName: input.toolName,
    workflow: input.workflow,
  });
  if (!definition) {
    return null;
  }
  const workflow = definition.workflow;
  const successCriteria = normalizeSuccessCriteria(workflow.successCriteria);
  const args = input.arguments.trim();
  if (!args && workflow.requiredArguments) {
    const renderedPrompt = [
      `<sourceweft_command name="${input.canonicalName}" kind="workflow" tool="${input.toolName}">`,
      workflow.requiredArguments.clarificationPrompt,
      `Required input: ${workflow.requiredArguments.description}.`,
      "This command is incomplete until the user provides the required input.",
      "</sourceweft_command>",
      "",
      "<user_request>",
      args,
      "</user_request>",
    ].join("\n");

    return {
      name: input.canonicalName,
      arguments: args,
      kind: "workflow",
      renderedPrompt,
      defaultTools: [],
      ...resolvedToolPolicyFields(workflow),
      permissionOverrides: {},
      successCriteria: { kind: "none" },
      execution: workflow.execution,
    };
  }

  const renderedPrompt = [
    `<sourceweft_command name="${input.canonicalName}" kind="tool_workflow" tool="${input.toolName}">`,
    workflow.promptIntro ??
      `Use ${input.toolName} to complete the user request.`,
    "This slash command is a task request, not a passive tool toggle. Use any relevant enabled support tools first if needed, but the command's success criteria must be satisfied.",
    ...workflow.additionalPromptLines,
    `Success criteria: ${describeSuccessCriteria(successCriteria)}.`,
    "</sourceweft_command>",
    "",
    "<user_request>",
    args,
    "</user_request>",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    name: input.canonicalName,
    arguments: args,
    kind: "tool_workflow",
    renderedPrompt,
    defaultTools:
      workflow.defaultTools.length > 0
        ? workflow.defaultTools
        : [input.toolName],
    ...resolvedToolPolicyFields(workflow),
    permissionOverrides: workflow.permissionOverrides,
    successCriteria,
    execution: workflow.execution,
  };
}

export function renderSkillCommandWorkflow(input: {
  arguments: string;
  canonicalName: string;
  displayName: string;
  skillSlug: string;
  workflow: CapabilityCommandWorkflow | null;
}): ResolvedCommandWorkflow | null {
  if (!input.workflow) {
    return null;
  }
  const workflow = input.workflow;
  const successCriteria = normalizeSuccessCriteria(workflow.successCriteria);
  const args = input.arguments.trim();
  if (!args && workflow.requiredArguments) {
    const renderedPrompt = [
      `<sourceweft_command name="${input.canonicalName}" kind="workflow" skill="${input.skillSlug}">`,
      workflow.requiredArguments.clarificationPrompt,
      `Required input: ${workflow.requiredArguments.description}.`,
      "This command is incomplete until the user provides the required input.",
      "</sourceweft_command>",
      "",
      "<user_request>",
      args,
      "</user_request>",
    ].join("\n");

    return {
      name: input.canonicalName,
      arguments: args,
      kind: "workflow",
      renderedPrompt,
      defaultTools: [],
      ...resolvedToolPolicyFields(workflow),
      permissionOverrides: {},
      successCriteria: { kind: "none" },
      execution: workflow.execution,
    };
  }

  const renderedPrompt = [
    `<sourceweft_command name="${input.canonicalName}" kind="skill_workflow" skill="${input.skillSlug}">`,
    workflow.promptIntro ?? null,
    "This slash command explicitly invokes the selected skill for the user request. Rely on the DeepAgents skills middleware for skill discovery, then follow the skill instructions and satisfy the command success criteria.",
    ...workflow.additionalPromptLines,
    `Success criteria: ${describeSuccessCriteria(successCriteria)}.`,
    "</sourceweft_command>",
    "",
    "<user_request>",
    args,
    "</user_request>",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    name: input.canonicalName,
    arguments: args,
    kind: "skill_workflow",
    renderedPrompt,
    defaultTools: workflow.defaultTools,
    ...resolvedToolPolicyFields(workflow),
    permissionOverrides: workflow.permissionOverrides,
    successCriteria,
    execution: workflow.execution,
  };
}

export function describeSuccessCriteria(criteria: CommandSuccessCriteria) {
  switch (criteria.kind) {
    case "artifact":
      return `create a ${criteria.artifactType} artifact using ${criteria.toolName}`;
    case "tool_call":
      return `call ${criteria.toolName}`;
    case "none":
      return "complete the requested workflow";
  }
}
