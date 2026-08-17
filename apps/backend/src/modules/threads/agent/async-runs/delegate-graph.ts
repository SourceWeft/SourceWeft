/**
 * Compiles a delegate (`explore` / `plan`) as a STANDALONE root graph — the
 * thing an async run executes, addressed by `graphId`. It reuses the exact
 * delegate definitions (`createExploreSubagent` / `createPlanSubagent`): their
 * read-only tools, system prompt, and filesystem middleware become the root
 * agent's, so the async delegate behaves identically to the synchronous `task`
 * delegate.
 *
 * The delegate graph carries NO `responseFormat`: the agent investigates
 * read-only and returns free-text findings. The structured plan/report is
 * produced by a dedicated `model.withStructuredOutput(...).invoke(...)` call
 * AFTER the graph finishes (see `delegate-executor.ts`), which is DeepSeek-safe
 * where an inline auto-bound schema tool is not. {@link DELEGATE_STRUCTURED_SCHEMAS}
 * maps each graph to the zod schema and tool name that dedicated call uses.
 *
 * `model` / `backend` / `checkpointer` are supplied per run: production resolves
 * the billed gateway model + tenant backend from the run config (the billing /
 * tenancy propagation step); this module owns only the compilation.
 */
import { createDeepAgent, type AnyBackendProtocol, type SubAgent } from "deepagents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { AgentMiddleware } from "langchain";
import type { z } from "zod";
import { createExploreSubagent, exploreResponseSchema } from "../subagents/explore";
import { createPlanSubagent, planResponseSchema } from "../subagents/plan";

export const DELEGATE_GRAPH_IDS = ["explore", "plan"] as const;
export type DelegateGraphId = (typeof DELEGATE_GRAPH_IDS)[number];

export function isDelegateGraphId(id: string): id is DelegateGraphId {
  return (DELEGATE_GRAPH_IDS as readonly string[]).includes(id);
}

/**
 * The zod schema + tool name each delegate's dedicated structured call uses. The
 * `name` is the schema/tool name the model calls and the parser keys on. Kept
 * next to the factories so the executor's dedicated call and the delegate stay
 * in lockstep.
 */
export const DELEGATE_STRUCTURED_SCHEMAS: Record<
  DelegateGraphId,
  { schema: z.ZodType; name: string }
> = {
  explore: { schema: exploreResponseSchema, name: "explore_report" },
  plan: { schema: planResponseSchema, name: "plan" },
};

const DELEGATE_FACTORIES: Record<
  DelegateGraphId,
  (input: {
    availableTools: readonly { readonly name: string }[];
    backend: AnyBackendProtocol;
    middleware: readonly AgentMiddleware[];
  }) => SubAgent
> = {
  explore: createExploreSubagent,
  plan: createPlanSubagent,
};

/**
 * Build the compiled root graph for a delegate. Returns the deepagents agent the
 * run executor invokes with the delegate's prompt and the run's `thread_id`.
 */
export function createDelegateGraph(input: {
  graphId: DelegateGraphId;
  model: BaseLanguageModel;
  backend: AnyBackendProtocol;
  checkpointer?: unknown;
  availableTools: readonly { readonly name: string }[];
  middleware?: readonly AgentMiddleware[];
}): ReturnType<typeof createDeepAgent> {
  const delegate = DELEGATE_FACTORIES[input.graphId]({
    availableTools: input.availableTools,
    backend: input.backend,
    middleware: input.middleware ?? [],
  });

  // No `responseFormat`: the delegate investigates and returns free-text; the
  // structured result is produced by a dedicated call in `delegate-executor.ts`.
  return createDeepAgent({
    model: input.model as never,
    tools: (delegate.tools ?? []) as never,
    systemPrompt: delegate.systemPrompt,
    middleware: (delegate.middleware ?? []) as never,
    backend: input.backend as never,
    ...(input.checkpointer ? { checkpointer: input.checkpointer as never } : {}),
  } as never);
}
