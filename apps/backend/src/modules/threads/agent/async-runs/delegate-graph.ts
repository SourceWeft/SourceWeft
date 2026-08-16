/**
 * Compiles a delegate (`explore` / `plan`) as a STANDALONE root graph — the
 * thing an async run executes, addressed by `graphId`. It reuses the exact
 * delegate definitions (`createExploreSubagent` / `createPlanSubagent`): their
 * read-only tools, system prompt, filesystem middleware, and `responseFormat`
 * become the root agent's, so the async delegate behaves identically to the
 * synchronous `task` delegate.
 *
 * `model` / `backend` / `checkpointer` are supplied per run: production resolves
 * the billed gateway model + tenant backend from the run config (the billing /
 * tenancy propagation step); this module owns only the compilation.
 */
import { createDeepAgent, type AnyBackendProtocol, type SubAgent } from "deepagents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { AgentMiddleware } from "langchain";
import { createExploreSubagent } from "../subagents/explore";
import { createPlanSubagent } from "../subagents/plan";

export const DELEGATE_GRAPH_IDS = ["explore", "plan"] as const;
export type DelegateGraphId = (typeof DELEGATE_GRAPH_IDS)[number];

export function isDelegateGraphId(id: string): id is DelegateGraphId {
  return (DELEGATE_GRAPH_IDS as readonly string[]).includes(id);
}

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

  return createDeepAgent({
    model: input.model as never,
    tools: (delegate.tools ?? []) as never,
    systemPrompt: delegate.systemPrompt,
    middleware: (delegate.middleware ?? []) as never,
    backend: input.backend as never,
    ...(input.checkpointer ? { checkpointer: input.checkpointer as never } : {}),
    ...(delegate.responseFormat
      ? { responseFormat: delegate.responseFormat as never }
      : {}),
  } as never);
}
