import { createLangChainMcpClient } from "../../mcp/langchain-client";
import { createDeepAgentsRuntimeHandoff, type DeepAgentsRuntimeTool } from "../deepagents-runtime";
import type { InvocationPlan, InvocationSourceRef } from "../types";

export type DeepAgentsHandoffAdapterOutput = {
  kind: "deepagents_handoff";
  selectableId: string;
  sourceRef: InvocationSourceRef;
  toolChoice: string;
  handoff: ReturnType<typeof createDeepAgentsRuntimeHandoff>;
};

type ToolChoicePlan = Extract<InvocationPlan, { kind: "bind_tool_choice" }>;
type ContextPlan = Extract<InvocationPlan, { kind: "inject_context" }>;
type DirectExecutePlan = Extract<InvocationPlan, { kind: "direct_execute" }>;

export function createBuiltinToolChoiceAdapter(input: {
  tools: DeepAgentsRuntimeTool[];
  model: string;
}) {
  return {
    async prepare(plan: ToolChoicePlan): Promise<DeepAgentsHandoffAdapterOutput> {
      if (plan.semantics.target !== "builtin_tool") {
        throw new Error("Built-in adapter requires builtin_tool semantics");
      }
      const handoff = createDeepAgentsRuntimeHandoff({
        model: input.model,
        tools: input.tools,
        systemPrompt: `Use the selected tool: ${plan.semantics.toolName}`,
      });
      return {
        kind: "deepagents_handoff",
        selectableId: plan.selectableId,
        sourceRef: plan.sourceRef,
        toolChoice: plan.semantics.toolName,
        handoff,
      };
    },
  };
}

export function createMcpToolChoiceAdapter(input: {
  install: { id: string; transport: string; endpointUrl: string | null };
  headers?: Record<string, string>;
  model: string;
}) {
  return {
    async prepare(plan: ToolChoicePlan): Promise<DeepAgentsHandoffAdapterOutput> {
      if (plan.sourceRef.kind !== "mcp_tool" || plan.semantics.target !== "mcp_tool") {
        throw new Error("MCP adapter requires mcp_tool semantics");
      }
      const client = createLangChainMcpClient({
        install: input.install as Parameters<typeof createLangChainMcpClient>[0]["install"],
        headers: input.headers,
      });
      const tools = (await client.getTools()) as DeepAgentsRuntimeTool[];
      const handoff = createDeepAgentsRuntimeHandoff({
        model: input.model,
        tools,
        systemPrompt: `Use the selected MCP tool: ${plan.semantics.toolName}`,
      });
      return {
        kind: "deepagents_handoff",
        selectableId: plan.selectableId,
        sourceRef: plan.sourceRef,
        toolChoice: plan.semantics.toolName,
        handoff,
      };
    },
  };
}

export function createSkillContextAdapter() {
  return {
    prepare(plan: ContextPlan) {
      return {
        kind: "context_payload" as const,
        selectableId: plan.selectableId,
        instruction: plan.semantics.workflow,
      };
    },
  };
}

export function createDirectExecuteAdapter() {
  return {
    prepare(plan: DirectExecutePlan) {
      if (!plan.structuredArgs || Object.keys(plan.structuredArgs).length === 0) {
        throw new Error("Direct execution requires complete structured args");
      }
      return {
        kind: "direct_execute_payload" as const,
        selectableId: plan.selectableId,
        sourceRef: plan.sourceRef,
        structuredArgs: plan.structuredArgs,
      };
    },
  };
}
