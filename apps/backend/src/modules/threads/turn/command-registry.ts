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

/**
 * The shared body behind {@link renderToolCommandWorkflow} and
 * {@link renderSkillCommandWorkflow}. The two flavours differ only in the XML
 * attribute that names the target (`tool=` vs `skill=`), the `kind` literal on
 * the main path, the standing instruction line, the `promptIntro` fallback, and
 * whether `defaultTools` falls back to the target. Everything else — the
 * missing-argument early return included — is identical, so it lives here once.
 * The rendered prompt is model input: keep it byte-identical when editing.
 */
function renderCommandWorkflow(input: {
  arguments: string;
  canonicalName: string;
  workflow: CapabilityCommandWorkflow;
  /** `tool` or `skill` — the XML attribute naming the command target. */
  targetAttribute: "tool" | "skill";
  /** The attribute's value: the tool name or the skill slug. */
  targetValue: string;
  /** The `kind` literal on the main (arguments-supplied) path. */
  kind: "tool_workflow" | "skill_workflow";
  /** Used when the workflow declares no `promptIntro`. */
  promptIntroFallback: string | null;
  /** The standing instruction line that follows the intro. */
  standingInstruction: string;
  defaultTools: string[];
}): ResolvedCommandWorkflow {
  const workflow = input.workflow;
  const target = `${input.targetAttribute}="${input.targetValue}"`;
  const successCriteria = normalizeSuccessCriteria(workflow.successCriteria);
  const args = input.arguments.trim();
  if (!args && workflow.requiredArguments) {
    const renderedPrompt = [
      `<sourceweft_command name="${input.canonicalName}" kind="workflow" ${target}>`,
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
    `<sourceweft_command name="${input.canonicalName}" kind="${input.kind}" ${target}>`,
    workflow.promptIntro ?? input.promptIntroFallback,
    input.standingInstruction,
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
    kind: input.kind,
    renderedPrompt,
    defaultTools: input.defaultTools,
    ...resolvedToolPolicyFields(workflow),
    permissionOverrides: workflow.permissionOverrides,
    successCriteria,
    execution: workflow.execution,
  };
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
  return renderCommandWorkflow({
    arguments: input.arguments,
    canonicalName: input.canonicalName,
    workflow,
    targetAttribute: "tool",
    targetValue: input.toolName,
    kind: "tool_workflow",
    promptIntroFallback: `Use ${input.toolName} to complete the user request.`,
    standingInstruction:
      "This slash command is a task request, not a passive tool toggle. Use any relevant enabled support tools first if needed, but the command's success criteria must be satisfied.",
    defaultTools:
      workflow.defaultTools.length > 0
        ? workflow.defaultTools
        : [input.toolName],
  });
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
  return renderCommandWorkflow({
    arguments: input.arguments,
    canonicalName: input.canonicalName,
    workflow,
    targetAttribute: "skill",
    targetValue: input.skillSlug,
    kind: "skill_workflow",
    promptIntroFallback: null,
    standingInstruction:
      "This slash command explicitly invokes the selected skill for the user request. Rely on the DeepAgents skills middleware for skill discovery, then follow the skill instructions and satisfy the command success criteria.",
    defaultTools: workflow.defaultTools,
  });
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
