import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { getChatAdapter, getEmbeddingsAdapter } from "../adapters/registry";
import type {
  ChatCompleteInput,
  EmbedBatchInput,
  EmbedInput,
  GatewayMessage,
  LangChainChatModelLike,
  LangChainEmbeddingsLike,
  ModelGatewayConfig,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RequestOptions,
} from "../types";
import { resolveModelGatewayConfig, resolveRequestTarget } from "../config";

export function toLangChainMessages(messages: GatewayMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (message.role === "system") {
      return new SystemMessage(message.content);
    }
    if (message.role === "assistant") {
      return new AIMessage({
        content: message.content,
        tool_calls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args ?? {},
          type: "tool_call",
        })),
      });
    }
    if (message.role === "tool") {
      return new ToolMessage({
        content: message.content,
        tool_call_id: message.toolCallId ?? "tool_call",
      });
    }
    return new HumanMessage(message.content);
  });
}

export function createChatModel(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
  options?: RequestOptions;
}): LangChainChatModelLike {
  const injected = input.config.langchainFactories?.createChatModel?.({
    target: input.target,
    payload: input.payload,
    options: input.options,
    config: input.config,
  });
  const model =
    injected ??
    getChatAdapter(input.target.providerKind).createModel(
      input.target,
      input.payload,
      input.options,
    );

  if (!input.payload.tools?.length || !model.bindTools) {
    return model;
  }

  return model.bindTools(
    input.payload.tools,
    input.payload.toolChoice
      ? { tool_choice: input.payload.toolChoice }
      : undefined,
  ) as LangChainChatModelLike;
}

export function createEmbeddingsModel(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: EmbedInput | EmbedBatchInput;
  options?: RequestOptions;
}): LangChainEmbeddingsLike {
  return (
    input.config.langchainFactories?.createEmbeddingsModel?.({
      target: input.target,
      payload: input.payload,
      options: input.options,
      config: input.config,
    }) ??
    getEmbeddingsAdapter(input.target.providerKind).createModel(
      input.target,
      input.payload,
      input.options,
    )
  );
}

export type LangChainModelExecutionConfig = Pick<
  ChatCompleteInput,
  "executionMode" | "providerHint" | "byok" | "metadata" | "thinking"
>;

/**
 * Create a LangChain-compatible chat model resolved by gateway routing.
 *
 * This resolves alias + execution mode (GLOBAL/BYOK/providerHint) once and returns
 * a model instance compatible with frameworks expecting BaseLanguageModel.
 */
export async function createLangChainChatModel(input: {
  modelAlias: string;
  config: ModelGatewayConfig;
  execution?: LangChainModelExecutionConfig;
}): Promise<BaseLanguageModel> {
  const resolvedConfig = resolveModelGatewayConfig(input.config);
  const payload: ChatCompleteInput = {
    model: input.modelAlias,
    messages: [],
    stream: true,
    executionMode: input.execution?.executionMode,
    providerHint: input.execution?.providerHint,
    byok: input.execution?.byok,
    metadata: input.execution?.metadata,
    thinking: input.execution?.thinking,
  };

  const target = await resolveRequestTarget(resolvedConfig, payload);
  const model = createChatModel({
    config: resolvedConfig,
    target,
    payload,
  });

  return model as unknown as BaseLanguageModel;
}

/**
 * @deprecated Use createLangChainChatModel instead.
 */
export async function createChatModelForAgent(
  modelAlias: string,
  config: ModelGatewayConfig,
): Promise<BaseLanguageModel> {
  return createLangChainChatModel({ modelAlias, config });
}
