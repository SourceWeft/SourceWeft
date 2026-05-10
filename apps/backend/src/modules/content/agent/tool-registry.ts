export const AGENT_TOOL_REGISTRY = {
  edit_file: {
    configurable: false,
    defaultInjected: true,
  },
  generate_image: {
    configurable: true,
    defaultInjected: true,
  },
  glob: {
    configurable: false,
    defaultInjected: true,
  },
  grep: {
    configurable: false,
    defaultInjected: true,
  },
  ls: {
    configurable: false,
    defaultInjected: true,
  },
  read_file: {
    configurable: false,
    defaultInjected: true,
  },
  search_sources: {
    configurable: false,
    defaultInjected: true,
  },
  web_fetch: {
    configurable: false,
    defaultInjected: true,
  },
  web_search: {
    configurable: false,
    defaultInjected: false,
  },
  write_file: {
    configurable: false,
    defaultInjected: true,
  },
} as const;

export type AgentToolName = keyof typeof AGENT_TOOL_REGISTRY;

export function isAgentToolName(value: string): value is AgentToolName {
  return value in AGENT_TOOL_REGISTRY;
}

export function isConfigurableAgentTool(value: string) {
  return isAgentToolName(value) && AGENT_TOOL_REGISTRY[value].configurable;
}
