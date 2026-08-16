/**
 * The real {@link RunExecutor}: compile the delegate graph for the run's
 * `graphId` and invoke it with the run's input under its `thread_id`.
 *
 * Everything the graph needs per run — the billed gateway `model`, the tenant
 * `backend`, the bound tools, and the delegated `input` — comes from an injected
 * {@link RunContextResolver}. That resolver is the billing / tenancy boundary
 * (it rebuilds the billed model and scopes the backend from the run config);
 * this module owns only the compile-and-invoke glue and is testable with a
 * scripted resolver.
 */
import type { AnyBackendProtocol } from "deepagents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { RunRecord } from "./types";
import type { RunExecutor } from "./run-processor";
import { createDelegateGraph, isDelegateGraphId } from "./delegate-graph";

export interface RunContext {
  model: BaseLanguageModel;
  backend: AnyBackendProtocol;
  checkpointer?: unknown;
  availableTools: readonly { readonly name: string }[];
  /** The delegated prompt, as an agent input. */
  input: { messages: Array<{ role: "user"; content: unknown }> };
}

export type RunContextResolver = (run: RunRecord) => Promise<RunContext>;

const DELEGATE_RECURSION_LIMIT = 24;

export function createDelegateRunExecutor(
  resolve: RunContextResolver,
): RunExecutor {
  return async (run, signal) => {
    if (!isDelegateGraphId(run.graphId)) {
      throw new Error(`Unknown delegate graph: ${run.graphId}`);
    }
    const context = await resolve(run);
    const graph = createDelegateGraph({
      graphId: run.graphId,
      model: context.model,
      backend: context.backend,
      checkpointer: context.checkpointer,
      availableTools: context.availableTools,
    });

    // The final graph state (with `messages`) is persisted by the processor and
    // surfaced to deepagents' check_async_task via getThreadState.
    return await (
      graph as never as {
        invoke: (input: unknown, config: unknown) => Promise<unknown>;
      }
    ).invoke(context.input, {
      configurable: { thread_id: run.threadId },
      recursionLimit: DELEGATE_RECURSION_LIMIT,
      ...(signal ? { signal } : {}),
    });
  };
}
