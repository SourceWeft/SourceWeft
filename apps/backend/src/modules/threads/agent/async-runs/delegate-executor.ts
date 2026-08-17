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
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import type { RunRecord } from "./types";
import type { RunExecutor } from "./run-processor";
import {
  createDelegateGraph,
  DELEGATE_STRUCTURED_SCHEMAS,
  isDelegateGraphId,
  type DelegateGraphId,
} from "./delegate-graph";

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

/**
 * Instruction appended to the investigation transcript for the dedicated
 * structured call. The agent has already gathered evidence as free text; this
 * turns that transcript into the schema-shaped report/plan in one shot.
 */
const STRUCTURED_HANDOFF_INSTRUCTION =
  "Investigation complete. Now return your final answer as the structured " +
  "response defined by the schema, grounded only in what you found above.";

/** Minimal structural view of a graph's final state — what we merge into. */
type DelegateFinalState = {
  messages?: BaseMessage[];
  [key: string]: unknown;
};

/** The billed gateway model exposes langchain's structured-output composer. */
type StructuredCapableModel = BaseLanguageModel & {
  withStructuredOutput: (
    schema: unknown,
    config?: unknown,
  ) => { invoke: (messages: unknown, config?: unknown) => Promise<unknown> };
};

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

    const finalState = (await (
      graph as never as {
        invoke: (input: unknown, config: unknown) => Promise<unknown>;
      }
    ).invoke(context.input, {
      configurable: { thread_id: run.threadId },
      recursionLimit: DELEGATE_RECURSION_LIMIT,
      ...(signal ? { signal } : {}),
    })) as DelegateFinalState;

    // After the read-only investigation finishes, produce the structured result
    // with ONE dedicated `withStructuredOutput` call on the SAME billed gateway
    // model. On DeepSeek the bridge (post-Core) binds the schema as an available
    // tool with salvage instead of a forced tool_choice / json_schema, so this
    // single call is reliable where an inline auto-bound response tool is not.
    const { schema, name } = DELEGATE_STRUCTURED_SCHEMAS[run.graphId as DelegateGraphId];
    const investigation: BaseMessage[] = Array.isArray(finalState?.messages)
      ? finalState.messages
      : [];
    const structuredMessages: BaseMessage[] = [
      ...investigation,
      new HumanMessage(STRUCTURED_HANDOFF_INSTRUCTION),
    ];

    const structured = await (context.model as StructuredCapableModel)
      .withStructuredOutput(z.toJSONSchema(schema), { name })
      .invoke(structuredMessages, {
        configurable: { thread_id: run.threadId },
        ...(signal ? { signal } : {}),
      });

    // Match the shape deepagents' `responseFormat` produced so downstream
    // (getThreadState → check_async_task, async-runs surfacing, DelegateToolCard)
    // keeps working: the parsed object on `structuredResponse`, and the same JSON
    // stringified into the last message so the check_async_task text path also
    // sees it. The final state (with `messages`) is persisted by the processor.
    return {
      ...finalState,
      messages: [
        ...investigation,
        new AIMessage({ content: JSON.stringify(structured) }),
      ],
      structuredResponse: structured,
    };
  };
}
