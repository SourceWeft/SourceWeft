import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import {
  AGENT_TOOLS,
  getAgentToolDefinition,
} from "@sourceweft/agent-tool-registry";
import type { ResolvedThreadCommand, StreamThreadEventInput } from "./types";
import type { CapabilityToolListItem } from "@sourceweft/capability-runtime";
import type { ResolvedThreadInvocation } from "./types";
import type { ToolPermission } from "./command-registry";
import type { ParsedPromptMarker } from "./thread-command-markers";
import { resolveToolCommandName } from "./thread-command";
import type { SelectedSkillRuntimeContract } from "./active-skill-runtime";

type ToolSelectionOptions = {
  readonly forceGenerateImage?: boolean;
};

function selectedToolRecord(
  tools: StreamThreadEventInput["tools"],
  toolName: string,
): Record<string, unknown> | null {
  const selection = (tools as Record<string, unknown> | undefined)?.[toolName];
  return selection && typeof selection === "object" && !Array.isArray(selection)
    ? (selection as Record<string, unknown>)
    : null;
}

function isToolDenied(
  tools: StreamThreadEventInput["tools"],
  toolName: string,
) {
  return selectedToolRecord(tools, toolName)?.enabled === false;
}

export function resolveMarkerToolSelection(
  markers: readonly ParsedPromptMarker[],
  tools: StreamThreadEventInput["tools"],
): StreamThreadEventInput["tools"] {
  let next = tools;
  for (const marker of markers) {
    if (marker.type !== "command" || marker.kind !== "tool") {
      continue;
    }
    next = enableToolSelection(next, resolveToolCommandName(marker.value), {
      forceGenerateImage: true,
    });
  }
  return next;
}

export function mergeCommandTools(
  tools: StreamThreadEventInput["tools"],
  command: ResolvedThreadCommand | null,
): StreamThreadEventInput["tools"] {
  let next = tools;
  const isToolCommand = command?.kind === "tool";
  for (const toolName of command?.workflow?.defaultTools ?? []) {
    if (!isToolDenied(tools, toolName)) {
      next = enableToolSelection(next, toolName, {
        forceGenerateImage: isToolCommand,
      });
    }
  }
  if (command?.kind !== "tool" || !command.toolName) {
    return next;
  }
  return isToolDenied(tools, command.toolName)
    ? next
    : enableToolSelection(next, command.toolName, {
        forceGenerateImage: true,
      });
}

export function mergeSelectedSkillRuntimeTools(
  tools: StreamThreadEventInput["tools"],
  runtime: SelectedSkillRuntimeContract,
): StreamThreadEventInput["tools"] {
  let next = tools;
  for (const toolName of runtime.defaultTools) {
    if (!isToolDenied(tools, toolName)) {
      next = enableToolSelection(next, toolName);
    }
  }
  return next;
}

export function mergeInvocationTools(
  tools: StreamThreadEventInput["tools"],
  invocation: ResolvedThreadInvocation | null,
): StreamThreadEventInput["tools"] {
  if (
    invocation?.kind !== "fixed_tool_choice" ||
    invocation.target !== "capability_tool"
  ) {
    return tools;
  }
  return isToolDenied(tools, invocation.toolName)
    ? tools
    : enableToolSelection(tools, invocation.toolName);
}

export function enableToolSelection(
  tools: StreamThreadEventInput["tools"],
  toolName: string | null,
  options: ToolSelectionOptions = {},
): StreamThreadEventInput["tools"] {
  if (!toolName) {
    return tools;
  }
  if (toolName === AGENT_TOOL_NAMES.generateImage) {
    return {
      ...(tools ?? {}),
      [AGENT_TOOL_NAMES.generateImage]: {
        ...((tools ?? {})[AGENT_TOOL_NAMES.generateImage] ?? {}),
        enabled: true,
        ...(options.forceGenerateImage ? { mode: "generate" as const } : {}),
      },
    };
  }
  if (toolName === AGENT_TOOL_NAMES.webSearch) {
    return {
      ...(tools ?? {}),
      [AGENT_TOOL_NAMES.webSearch]: {
        enabled: true,
      },
    };
  }
  if (getAgentToolDefinition(toolName)) {
    return {
      ...(tools ?? {}),
      [toolName]: {
        ...(selectedToolRecord(tools, toolName) ?? {}),
        enabled: true,
      },
    };
  }
  return tools;
}

export function applyCapabilityToolOptionDefaults(
  tools: StreamThreadEventInput["tools"],
  catalogTools: readonly CapabilityToolListItem[],
): StreamThreadEventInput["tools"] {
  let next = tools;
  for (const tool of catalogTools) {
    const current = selectedToolRecord(next, tool.toolName);
    if (current?.enabled !== true) {
      continue;
    }
    const withDefaults = cloneRecord(current);
    let changed = false;
    for (const option of tool.options) {
      if (!option.target?.path || option.defaultValue === undefined) {
        continue;
      }
      if (
        setDefaultAtPath(withDefaults, option.target.path, option.defaultValue)
      ) {
        changed = true;
      }
    }
    if (changed) {
      next = {
        ...(next ?? {}),
        [tool.toolName]: withDefaults,
      };
    }
  }
  return next;
}

function cloneRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record));
}

function isSafePathSegment(segment: string) {
  return (
    segment.length > 0 &&
    segment !== "__proto__" &&
    segment !== "constructor" &&
    segment !== "prototype"
  );
}

function setDefaultAtPath(
  target: Record<string, unknown>,
  path: string,
  value: string | number | boolean,
) {
  const segments = path.split(".");
  if (
    segments.length === 0 ||
    segments.some((segment) => !isSafePathSegment(segment))
  ) {
    return false;
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === undefined) {
      const nextChild: Record<string, unknown> = {};
      current[segment] = nextChild;
      current = nextChild;
      continue;
    }
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      return false;
    }
    current = child as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (!leaf || current[leaf] !== undefined) {
    return false;
  }
  current[leaf] = value;
  return true;
}

function defaultToolPermission(toolName: string): ToolPermission {
  for (const definition of AGENT_TOOLS) {
    if (definition.name !== toolName) {
      continue;
    }
    const activationDefault = definition.activation.default;
    const configuredPermission =
      "defaultPermission" in definition
        ? definition.defaultPermission
        : undefined;
    return (
      configuredPermission ??
      (activationDefault === "always" ? "allow" : "deny")
    );
  }
  return "deny";
}

function selectedToolEnabled(
  tools: StreamThreadEventInput["tools"],
  toolName: string,
) {
  const enabled = selectedToolRecord(tools, toolName)?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

export function resolveToolPermissions(input: {
  readonly command: ResolvedThreadCommand | null;
  readonly selectedSkillRuntime?: SelectedSkillRuntimeContract;
  readonly tools: StreamThreadEventInput["tools"];
}): Record<string, ToolPermission> {
  const permissions: Record<string, ToolPermission> = {};
  const setPermission = (
    toolName: string,
    enabled: boolean | undefined,
    source: "default" | "selection",
  ) => {
    if (!toolName) {
      return;
    }
    const fallback = defaultToolPermission(toolName);
    permissions[toolName] =
      enabled === false
        ? "deny"
        : enabled === true
          ? fallback === "deny"
            ? "allow"
            : fallback
          : source === "default"
            ? fallback
            : "allow";
  };

  for (const toolName of Object.values(AGENT_TOOL_NAMES)) {
    const definition = getAgentToolDefinition(toolName);
    if (definition?.activation.default === "always") {
      setPermission(toolName, undefined, "default");
    }
  }
  const explicitWebAccessEnabled =
    input.tools?.[AGENT_TOOL_NAMES.webSearch]?.enabled ??
    input.tools?.webSearchEnabled ??
    input.tools?.[AGENT_TOOL_NAMES.webFetch]?.enabled;
  if (typeof explicitWebAccessEnabled === "boolean") {
    setPermission(
      AGENT_TOOL_NAMES.webSearch,
      explicitWebAccessEnabled,
      "selection",
    );
    setPermission(
      AGENT_TOOL_NAMES.webFetch,
      explicitWebAccessEnabled,
      "selection",
    );
  }
  for (const toolName of Object.values(AGENT_TOOL_NAMES)) {
    if (
      explicitWebAccessEnabled !== undefined &&
      (toolName === AGENT_TOOL_NAMES.webSearch ||
        toolName === AGENT_TOOL_NAMES.webFetch)
    ) {
      continue;
    }
    const enabled = selectedToolEnabled(input.tools, toolName);
    if (enabled !== undefined) {
      setPermission(toolName, enabled, "selection");
    }
  }

  return {
    ...permissions,
    ...Object.fromEntries(
      Object.entries(
        input.selectedSkillRuntime?.permissionOverrides ?? {},
      ).filter(([toolName]) => !isToolDenied(input.tools, toolName)),
    ),
    ...Object.fromEntries(
      Object.entries(input.command?.workflow?.permissionOverrides ?? {}).filter(
        ([toolName]) => !isToolDenied(input.tools, toolName),
      ),
    ),
  };
}
