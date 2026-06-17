import type { ResolvedThreadCommandWithContext } from "./thread-command";

export function buildThreadCommandMetadata(
  command: ResolvedThreadCommandWithContext,
) {
  return {
    name: command.canonicalName,
    arguments: command.arguments,
    kind: command.kind,
    displayName: command.displayName,
    ...(command.skillSlug ? { skillSlug: command.skillSlug } : {}),
    ...(command.commandName ? { commandName: command.commandName } : {}),
    ...(command.path ? { path: command.path } : {}),
    ...(command.toolName ? { toolName: command.toolName } : {}),
    ...(command.workflow
      ? {
          workflow: {
            kind: command.workflow.kind,
            execution: command.workflow.execution,
            defaultTools: command.workflow.defaultTools,
            permissionOverrides: command.workflow.permissionOverrides,
            successCriteria: command.workflow.successCriteria,
          },
        }
      : {}),
  };
}

export function buildCommandAugmentedText(input: {
  readonly command: ResolvedThreadCommandWithContext | null;
  readonly text: string;
}) {
  const args = input.command ? input.command.arguments : input.text;
  if (input.command?.workflow) {
    return input.command.workflow.renderedPrompt;
  }
  if (input.command?.kind === "tool") {
    const toolName =
      input.command.toolName ?? input.command.canonicalName.replace(/^\//, "");
    return `<sourceweft_tool_command name="${toolName}">\nUse the ${toolName} tool for this request. Treat the user request below as the tool input; do not answer without using the selected tool unless the input is invalid or the tool is unavailable.\n</sourceweft_tool_command>\n\n<user_request>\n${args}\n</user_request>`;
  }
  return input.command ? args : input.text;
}
