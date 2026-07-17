export const INVOCATION_SOURCE_KINDS = [
  "capability_tool",
  "skill_command",
  "mcp_tool",
  "mcp_prompt",
  "mcp_resource",
] as const;

export type InvocationSourceKind = (typeof INVOCATION_SOURCE_KINDS)[number];

export type CapabilityToolSourceRef = {
  readonly kind: "capability_tool";
  readonly capabilityId: string;
  readonly contributionId: string;
  readonly sourcePackageName: string | null;
  readonly toolName: string;
};

export type SkillCommandSourceRef = {
  kind: "skill_command";
  skillSlug: string;
  commandName: string;
};

export type McpToolSourceRef = {
  kind: "mcp_tool";
  serverInstallId: string;
  serverToolName: string;
  normalizedToolName?: string;
  toolId?: string;
};

export type McpPromptSourceRef = {
  kind: "mcp_prompt";
  serverInstallId: string;
  promptName: string;
};

export type McpResourceSourceRef = {
  kind: "mcp_resource";
  serverInstallId: string;
  uri: string;
};

export type InvocationSourceRef =
  | CapabilityToolSourceRef
  | SkillCommandSourceRef
  | McpToolSourceRef
  | McpPromptSourceRef
  | McpResourceSourceRef;

export type InvocationSemantics =
  | {
      kind: "fixed_tool_choice";
      target: "capability_tool" | "mcp_tool";
      toolName: string;
    }
  | {
      kind: "context_injection";
      workflow: string;
    }
  | {
      kind: "direct_execute";
      requiresCompleteStructuredArgs: true;
      inputSchema: Record<string, unknown>;
    }
  | {
      kind: "mcp_prompt";
      promptName: string;
    }
  | {
      kind: "mcp_resource";
      uri: string;
    };

export type SelectableInvocationDefinition = {
  id: string;
  label: string;
  description?: string;
  sourceRef: InvocationSourceRef;
  semantics: InvocationSemantics;
  enabled: boolean;
  unavailableReason?: string;
  metadata?: Record<string, unknown>;
};

export type InvocationEnvelope = {
  selectableId: string;
  userInput: string;
  structuredArgs?: Record<string, unknown>;
};

export type InvocationPlan =
  | {
      kind: "bind_tool_choice";
      selectableId: string;
      sourceRef: InvocationSourceRef;
      semantics: Extract<InvocationSemantics, { kind: "fixed_tool_choice" }>;
      userInput: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "inject_context";
      selectableId: string;
      sourceRef: InvocationSourceRef;
      semantics: Extract<InvocationSemantics, { kind: "context_injection" }>;
      userInput: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "direct_execute";
      selectableId: string;
      sourceRef: InvocationSourceRef;
      semantics: Extract<InvocationSemantics, { kind: "direct_execute" }>;
      structuredArgs?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "mcp_prompt";
      selectableId: string;
      sourceRef: Extract<InvocationSourceRef, { kind: "mcp_prompt" }>;
      semantics: Extract<InvocationSemantics, { kind: "mcp_prompt" }>;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "mcp_resource";
      selectableId: string;
      sourceRef: Extract<InvocationSourceRef, { kind: "mcp_resource" }>;
      semantics: Extract<InvocationSemantics, { kind: "mcp_resource" }>;
      metadata?: Record<string, unknown>;
    };

export type NormalizedInvocationErrorCode =
  | "MCP_TRANSPORT_UNSUPPORTED"
  | "MCP_MANIFEST_STALE"
  | "SKILL_NOT_ENABLED"
  | "SCHEMA_MISMATCH"
  | "RUNTIME_HANDOFF_UNAVAILABLE"
  | "INVOCATION_NOT_FOUND"
  | "INVOCATION_UNAVAILABLE"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED";

export type NormalizedInvocationError = {
  code: NormalizedInvocationErrorCode;
  message: string;
  sourceRef?: InvocationSourceRef;
  recoverable: boolean;
  details?: Record<string, unknown>;
};

export type InvocationEventType =
  | "resolve"
  | "policy"
  | "approval_required"
  | "tool_choice_bound"
  | "context_injected"
  | "direct_execute"
  | "deepagents_handoff"
  | "result"
  | "error";

export type InvocationEventBase = {
  type: InvocationEventType;
  selectableId: string;
  sourceRef?: InvocationSourceRef;
  timestamp: string;
};

export type InvocationEvent =
  | (InvocationEventBase & { type: "resolve" })
  | (InvocationEventBase & {
      type: "policy";
      decision: "allow" | "deny" | "ask";
    })
  | (InvocationEventBase & {
      type: "approval_required";
      approvalRef: string;
      reason: string;
    })
  | (InvocationEventBase & { type: "tool_choice_bound"; toolName: string })
  | (InvocationEventBase & {
      type: "context_injected";
      instruction: string;
    })
  | (InvocationEventBase & { type: "direct_execute" })
  | (InvocationEventBase & { type: "deepagents_handoff"; boundary: "deepagents" })
  | (InvocationEventBase & { type: "result"; result: unknown })
  | (InvocationEventBase & {
      type: "error";
      error: NormalizedInvocationError;
    });
