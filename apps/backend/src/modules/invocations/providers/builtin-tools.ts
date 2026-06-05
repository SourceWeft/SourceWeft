import type { SelectableInvocationDefinitionWithAlias, SelectableInvocationProvider } from "../registry";

export type BuiltinToolProjectionInput = {
  name: string;
  label: string;
  description?: string;
  slashAlias?: string;
};

export function createBuiltinToolInvocationProvider(input: {
  tools: BuiltinToolProjectionInput[];
}): SelectableInvocationProvider {
  return {
    id: "builtin_tools",
    list() {
      return input.tools.map(
        (tool): SelectableInvocationDefinitionWithAlias => ({
          id: `builtin_tool.${tool.name}`,
          label: tool.label,
          description: tool.description,
          slashAlias: tool.slashAlias,
          enabled: true,
          sourceRef: { kind: "builtin_tool", toolName: tool.name },
          semantics: {
            kind: "fixed_tool_choice",
            target: "builtin_tool",
            toolName: tool.name,
          },
        }),
      );
    },
  };
}
