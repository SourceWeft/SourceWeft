import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { ContentError } from "../../content/errors";
import type { EnabledSkillDescriptor } from "../../skills/types";
import {
  getAgentToolSlashCommand,
  isAgentToolName,
} from "@sourceweft/agent-tool-registry";
import {
  resolveCapabilityCommand,
  resolveCapabilityToolCommandWorkflow,
} from "./capability-command-workflows";
import {
  renderSkillCommandWorkflow,
  renderToolCommandWorkflow,
} from "./command-registry";
import type { ResolvedThreadCommand, StreamThreadEventInput } from "./types";

type ToolCommandSourceRef = {
  readonly kind: "capability_tool";
  readonly toolName: string;
};

const SKILL_ACTIVATION_NAME_PATTERN =
  /^\/?([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;

type CommandKind = NonNullable<StreamThreadEventInput["command"]>["kind"];

type RequestedCommand = {
  readonly arguments: string;
  readonly kind?: CommandKind;
  readonly name: string;
};

export type ResolvedThreadCommandWithContext = ResolvedThreadCommand & {
  readonly commandName?: string;
  readonly skillSlug?: string;
};

export function parseRequestedCommand(input: {
  readonly command?: StreamThreadEventInput["command"];
}): RequestedCommand | null {
  if (input.command?.name) {
    return {
      arguments: input.command.arguments?.trim() ?? "",
      ...(input.command.kind ? { kind: input.command.kind } : {}),
      name: input.command.name.trim(),
    };
  }

  return null;
}

export function resolveToolCommandName(name: string) {
  const raw = name.trim().replace(/^\//, "");
  if (isAgentToolName(raw) && getAgentToolSlashCommand(raw)) {
    return raw;
  }
  for (const candidate of Object.values(AGENT_TOOL_NAMES)) {
    const slash = getAgentToolSlashCommand(candidate);
    if (
      slash?.aliases?.some((alias) => alias.toLowerCase() === raw.toLowerCase())
    ) {
      return candidate;
    }
  }
  return null;
}

function normalizeSkillActivationName(name: string) {
  const raw = name.trim();
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const match = withSlash.match(SKILL_ACTIVATION_NAME_PATTERN);
  if (!match?.[1]) {
    throw new ContentError(
      400,
      "INVALID_COMMAND",
      "Skill command must use /skill-slug",
    );
  }
  return {
    canonicalName: `/${match[1]}`,
    skillSlug: match[1],
  };
}

function capabilityToolCommandSourceRef(
  toolName: string,
): ToolCommandSourceRef {
  return {
    kind: "capability_tool",
    toolName,
  };
}

function skillCommandSourceRef(skillSlug: string, commandName: string) {
  return {
    kind: "skill_command",
    skillSlug,
    commandName,
  };
}

function createSkillCommandNotFoundError(input: {
  readonly commandName: string;
  readonly message: string;
  readonly skillSlug: string;
}) {
  return new ContentError(404, "COMMAND_NOT_FOUND", input.message, {
    sourceRef: skillCommandSourceRef(input.skillSlug, input.commandName),
  });
}

export async function resolveThreadCommand(input: {
  readonly command: RequestedCommand | null;
  readonly enabledSkills: readonly EnabledSkillDescriptor[];
}): Promise<ResolvedThreadCommandWithContext | null> {
  if (!input.command) {
    return null;
  }

  const capabilityCommand = await resolveCapabilityCommand(input.command.name);
  const capabilityToolCommand = await resolveCapabilityToolCommandWorkflow(
    input.command.name,
  );
  const toolName =
    capabilityToolCommand?.toolName ??
    resolveToolCommandName(input.command.name);
  if (toolName && capabilityToolCommand) {
    if (capabilityCommand?.visible === false) {
      throw new ContentError(
        404,
        "COMMAND_NOT_FOUND",
        `Tool command ${input.command.name} is not available for slash invocation`,
        {
          sourceRef: capabilityToolCommandSourceRef(toolName),
        },
      );
    }
    const slashCommand = getAgentToolSlashCommand(toolName);
    const canonicalName = `/${toolName}`;
    const argumentsText = input.command.arguments;
    const displayName = slashCommand?.displayName ?? toolName;
    const workflow = renderToolCommandWorkflow({
      arguments: argumentsText,
      canonicalName,
      displayName,
      toolName,
      workflow: capabilityToolCommand.workflow,
    });
    if (!workflow) {
      throw new ContentError(
        404,
        "COMMAND_NOT_FOUND",
        `Tool command ${input.command.name} is not available for slash invocation`,
        {
          sourceRef: capabilityToolCommandSourceRef(toolName),
        },
      );
    }
    return {
      name: input.command.name,
      canonicalName,
      arguments: argumentsText,
      kind: "tool",
      displayName,
      toolName,
      description: slashCommand?.description ?? `Run ${toolName}`,
      workflow,
    };
  }
  if (
    capabilityCommand?.action.kind === "skill" &&
    input.command.kind !== "tool"
  ) {
    const skill = input.enabledSkills.find(
      (candidate) => candidate.name === capabilityCommand.action.targetId,
    );
    if (!skill) {
      throw createSkillCommandNotFoundError({
        commandName: input.command.name,
        message: `Skill command ${input.command.name} is not available for this turn`,
        skillSlug: capabilityCommand.action.targetId,
      });
    }
    if (skill.slashConfig?.enabled === false) {
      throw createSkillCommandNotFoundError({
        commandName: input.command.name,
        message: `Skill command ${input.command.name} does not support slash invocation`,
        skillSlug: capabilityCommand.action.targetId,
      });
    }
    const canonicalName = `/${skill.name}`;
    const displayName =
      capabilityCommand.title || skill.displayName || skill.name;
    const workflow = renderSkillCommandWorkflow({
      arguments: input.command.arguments,
      canonicalName,
      displayName,
      skillSlug: skill.name,
      workflow: capabilityCommand.workflow,
    });
    return {
      name: input.command.name,
      canonicalName,
      arguments: input.command.arguments,
      kind: "skill",
      displayName,
      skillSlug: skill.name,
      description: skill.description,
      ...(workflow ? { workflow } : {}),
    };
  }
  if (input.command.kind === "tool") {
    throw new ContentError(
      404,
      "COMMAND_NOT_FOUND",
      `Tool command ${input.command.name} is not available for slash invocation`,
      {
        sourceRef: capabilityToolCommandSourceRef(input.command.name),
      },
    );
  }

  const isSkillActivation =
    (input.command.kind === "skill" && !input.command.name.includes(":")) ||
    (!input.command.kind &&
      !input.command.name.includes(":") &&
      SKILL_ACTIVATION_NAME_PATTERN.test(input.command.name));
  if (isSkillActivation) {
    const normalized = normalizeSkillActivationName(input.command.name);
    const skill = input.enabledSkills.find(
      (candidate) => candidate.name === normalized.skillSlug,
    );
    if (!skill) {
      throw createSkillCommandNotFoundError({
        commandName: normalized.canonicalName,
        message: `Skill ${normalized.canonicalName} is not available for this turn`,
        skillSlug: normalized.skillSlug,
      });
    }
    if (skill.slash === false || skill.slashConfig?.enabled === false) {
      throw createSkillCommandNotFoundError({
        commandName: normalized.canonicalName,
        message: `Skill ${normalized.canonicalName} does not support slash invocation`,
        skillSlug: normalized.skillSlug,
      });
    }
    return {
      name: input.command.name,
      canonicalName: normalized.canonicalName,
      arguments: input.command.arguments,
      kind: "skill",
      displayName: skill.displayName ?? skill.name,
      skillSlug: normalized.skillSlug,
      description: skill.description,
    };
  }

  throw new ContentError(
    404,
    "COMMAND_NOT_FOUND",
    `Command ${input.command.name} is not available for slash invocation`,
  );
}
