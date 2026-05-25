import { AGENT_TOOL_NAMES } from "../../agent/tool-names";
import { getAgentToolSlashCommand } from "../../agent/tool-registry";
import type { EnabledSkillDescriptor } from "../../skills/types";

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
      artifactType: "image";
      toolName: string;
    };

export type ResolvedCommandWorkflow = {
  name: string;
  arguments: string;
  kind: "workflow" | "tool_workflow";
  renderedPrompt: string;
  defaultTools: string[];
  permissionOverrides: Record<string, ToolPermission>;
  successCriteria: CommandSuccessCriteria;
  execution: "agent" | "direct";
};

export function renderSkillActivationWorkflow(input: {
  arguments: string;
  canonicalName: string;
  skill: EnabledSkillDescriptor;
}): ResolvedCommandWorkflow {
  const args = input.arguments.trim();
  const renderedPrompt = [
    `<sourceweft_command name="${input.canonicalName}" kind="workflow" skill="${input.skill.name}">`,
    "Run the selected skill workflow for the user's request.",
    "This slash command is a task request, not a passive tool toggle. Apply the loaded skill instructions and use relevant enabled tools when helpful.",
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
    defaultTools: input.skill.tools ?? [],
    permissionOverrides: {},
    successCriteria: { kind: "none" },
    execution: "agent",
  };
}

export function renderSkillCommandWorkflow(input: {
  arguments: string;
  canonicalName: string;
  command: NonNullable<EnabledSkillDescriptor["commands"]>[number];
  skill: EnabledSkillDescriptor;
}): ResolvedCommandWorkflow {
  const args = input.arguments.trim();
  const instruction = input.command.instruction?.includes("$ARGUMENTS")
    ? input.command.instruction.replaceAll("$ARGUMENTS", args)
    : `${input.command.instruction ?? ""}\n\nARGUMENTS:\n${args}`;
  const path = input.command.path
    ? ` path="/skills/${input.skill.name}/${input.command.path}"`
    : "";
  const renderedPrompt = [
    `<sourceweft_command name="${input.canonicalName}" kind="workflow" skill="${input.skill.name}"${path}>`,
    instruction,
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
    defaultTools: input.command.tools ?? [],
    permissionOverrides: {},
    successCriteria: { kind: "none" },
    execution: "agent",
  };
}

type ToolCommandDefinition = {
  execution: "agent" | "direct";
  promptIntro: string;
  successCriteria: CommandSuccessCriteria;
  permission?: ToolPermission;
};

const TOOL_COMMANDS: Record<string, ToolCommandDefinition> = {
  [AGENT_TOOL_NAMES.generateImage]: {
    execution: "direct",
    promptIntro:
      "Create an image artifact from the user's request. The command is complete only when an image artifact is created.",
    successCriteria: {
      kind: "artifact",
      artifactType: "image",
      toolName: AGENT_TOOL_NAMES.generateImage,
    },
    permission: "allow",
  },
  [AGENT_TOOL_NAMES.searchNotionPages]: {
    execution: "agent",
    promptIntro:
      "Find Notion pages for the user's request and return the relevant page IDs, titles, and URLs. Search is for discovery only; use page IDs for reading, updating, or deleting.",
    successCriteria: {
      kind: "tool_call",
      toolName: AGENT_TOOL_NAMES.searchNotionPages,
    },
    permission: "allow",
  },
  [AGENT_TOOL_NAMES.readNotionPage]: {
    execution: "agent",
    promptIntro:
      "Read the requested Notion page by pageId and summarize or use the returned markdown content. If the user provided only a title, search first to find the pageId.",
    successCriteria: {
      kind: "tool_call",
      toolName: AGENT_TOOL_NAMES.readNotionPage,
    },
    permission: "allow",
  },
  [AGENT_TOOL_NAMES.createNotionPage]: {
    execution: "agent",
    promptIntro:
      "Create or propose creating a Notion page that satisfies the user's request. By default, create it in the authorized Notion workspace selected by the active connector and do not pass parentPageId, pageId, or dataSourceId. Only pass parentPageId/pageId or dataSourceId when the user explicitly requested a specific parent page or data source and the ID is provided or confirmed. Use confirmations when required.",
    successCriteria: {
      kind: "tool_call",
      toolName: AGENT_TOOL_NAMES.createNotionPage,
    },
    permission: "ask",
  },
  [AGENT_TOOL_NAMES.appendNotionPage]: {
    execution: "agent",
    promptIntro:
      "Append or propose appending content to the requested Notion page. Use confirmations when required.",
    successCriteria: {
      kind: "tool_call",
      toolName: AGENT_TOOL_NAMES.appendNotionPage,
    },
    permission: "ask",
  },
  [AGENT_TOOL_NAMES.updateNotionPage]: {
    execution: "agent",
    promptIntro:
      "Update or propose updating the requested Notion page by pageId. If the user provided only a title, search first to find the pageId and read the page before editing existing content unless the request is clearly append-only. Use confirmations when required.",
    successCriteria: {
      kind: "tool_call",
      toolName: AGENT_TOOL_NAMES.updateNotionPage,
    },
    permission: "ask",
  },
  [AGENT_TOOL_NAMES.deleteNotionPage]: {
    execution: "agent",
    promptIntro:
      "Move or propose moving Notion pages to trash by pageId/pageIds. If the user provided only a title, search first and only proceed when the intended page IDs are clear.",
    successCriteria: {
      kind: "tool_call",
      toolName: AGENT_TOOL_NAMES.deleteNotionPage,
    },
    permission: "ask",
  },
  [AGENT_TOOL_NAMES.saveArtifactToNotion]: {
    execution: "agent",
    promptIntro:
      "Save or propose saving the relevant artifact reference as a new Notion page. By default, save it in the authorized Notion workspace selected by the active connector and do not pass a parent page or data source unless the user explicitly requested one and the ID is provided or confirmed. Use confirmations when required.",
    successCriteria: {
      kind: "tool_call",
      toolName: AGENT_TOOL_NAMES.saveArtifactToNotion,
    },
    permission: "ask",
  },
  [AGENT_TOOL_NAMES.saveFinalAnswerToNotion]: {
    execution: "agent",
    promptIntro:
      "Save or propose saving the final answer as a new Notion page. By default, save it in the authorized Notion workspace selected by the active connector and do not pass a parent page or data source unless the user explicitly requested one and the ID is provided or confirmed. Use confirmations when required.",
    successCriteria: {
      kind: "tool_call",
      toolName: AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
    },
    permission: "ask",
  },
};

export function resolveToolCommandDefinition(toolName: string) {
  const slash = getAgentToolSlashCommand(toolName);
  if (!slash?.supportsCommand) {
    return null;
  }
  return TOOL_COMMANDS[toolName] ?? null;
}

export function renderToolCommandWorkflow(input: {
  arguments: string;
  canonicalName: string;
  displayName: string;
  toolName: string;
}): ResolvedCommandWorkflow | null {
  const definition = resolveToolCommandDefinition(input.toolName);
  if (!definition) {
    return null;
  }
  const args = input.arguments.trim();
  const renderedPrompt = [
    `<sourceweft_command name="${input.canonicalName}" kind="tool_workflow" tool="${input.toolName}">`,
    definition.promptIntro,
    "This slash command is a task request, not a passive tool toggle. Use any relevant enabled support tools first if needed, but the command's success criteria must be satisfied.",
    `Success criteria: ${describeSuccessCriteria(definition.successCriteria)}.`,
    "</sourceweft_command>",
    "",
    "<user_request>",
    args,
    "</user_request>",
  ].join("\n");

  return {
    name: input.canonicalName,
    arguments: args,
    kind: "tool_workflow",
    renderedPrompt,
    defaultTools: [input.toolName],
    permissionOverrides: {
      [input.toolName]: definition.permission ?? "allow",
    },
    successCriteria: definition.successCriteria,
    execution: definition.execution,
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
