import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type LangSmithParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import {
  ChatGenerationChunk,
  type ChatGeneration,
  type ChatResult,
} from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { Runnable } from "@langchain/core/runnables";
import {
  type InteropZodType,
  getSchemaDescription,
  isInteropZodSchema,
} from "@langchain/core/utils/types";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import {
  isSerializableSchema,
  SerializableSchema,
} from "@langchain/core/utils/standard_schema";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import {
  assembleStructuredOutputPipeline,
  createContentParser,
  createFunctionCallingParser,
} from "@langchain/core/language_models/structured_output";
import { createLiteLLMSDK } from "../client";
import { LiteLLMError } from "../errors";
import type {
  ChatCompleteInput,
  LiteLLMClientConfig,
  LiteLLMResponseFormat,
  LiteLLMStructuredOutputConfig,
  LiteLLMSDK,
  ModelAlias,
  RequestOptions,
} from "../types";
import {
  baseMessagesToLiteLLMMessages,
  liteLLMResultToAIMessage,
  streamEventToChunk,
} from "./shared";
import { isRecord } from "../utils/object";

type StructuredOutputMethod = "jsonSchema" | "jsonMode" | "functionCalling";

export interface ChatLiteLLMCallOptions extends BaseChatModelCallOptions {
  tools?: Array<BindToolsInput | Record<string, unknown>>;
  tool_choice?: BaseChatModelCallOptions["tool_choice"];
  strict?: boolean;
  response_format?: LiteLLMResponseFormat;
  structured_output?: LiteLLMStructuredOutputConfig;
  requestMetadata?: Record<string, unknown>;
  traceId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  extraBody?: Record<string, unknown>;
}

export interface ChatLiteLLMParams extends BaseChatModelParams {
  model?: ModelAlias;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  modelKwargs?: Record<string, unknown>;
  allowNonDefaultAliases?: boolean;
  allowedModelAliases?: readonly string[];
  requestMetadata?: Record<string, unknown>;
  client?: LiteLLMSDK;
}

function resolveStructuredOutputMethod(
  method: unknown,
): StructuredOutputMethod {
  if (
    method === "jsonSchema" ||
    method === "jsonMode" ||
    method === "functionCalling"
  ) {
    return method;
  }

  return "functionCalling";
}

function buildRequestOptions(options: ChatLiteLLMCallOptions): RequestOptions {
  return {
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    traceId: options.traceId,
    metadata: options.requestMetadata,
    signal: options.signal,
  };
}

function convertBindToolsInput(
  tools: Array<BindToolsInput | Record<string, unknown>>,
  strict: boolean | undefined,
): Record<string, unknown>[] {
  return tools.map((tool) => {
    if (
      isRecord(tool) &&
      typeof tool.type === "string" &&
      (tool.type === "function" || tool.type === "tool_search")
    ) {
      return tool;
    }

    return convertToOpenAITool(tool as BindToolsInput, {
      strict,
    }) as unknown as Record<string, unknown>;
  });
}

export class ChatLiteLLM<
  CallOptions extends ChatLiteLLMCallOptions = ChatLiteLLMCallOptions,
> extends BaseChatModel<CallOptions, AIMessageChunk> {
  static lc_name() {
    return "ChatLiteLLM";
  }

  lc_serializable = true;

  readonly model: ModelAlias;

  readonly temperature?: number;

  readonly topP?: number;

  readonly maxTokens?: number;

  readonly stop?: string[];

  readonly modelKwargs: Record<string, unknown>;

  protected client: LiteLLMSDK;

  protected defaultOptions: Partial<CallOptions> = {};

  constructor(model: ModelAlias, fields?: Omit<ChatLiteLLMParams, "model">);
  constructor(fields?: ChatLiteLLMParams);
  constructor(
    modelOrFields?: ModelAlias | ChatLiteLLMParams,
    fieldsArg?: Omit<ChatLiteLLMParams, "model">,
  ) {
    const fields =
      typeof modelOrFields === "string"
        ? {
            ...(fieldsArg ?? {}),
            model: modelOrFields,
          }
        : (modelOrFields ?? {});

    super(fields);

    this.model = fields.model ?? "chat-default";
    this.temperature = fields.temperature;
    this.topP = fields.topP;
    this.maxTokens = fields.maxTokens;
    this.stop = fields.stop;
    this.modelKwargs = fields.modelKwargs ?? {};

    this.client =
      fields.client ??
      createLiteLLMSDK({
        baseUrl: fields.baseUrl ?? "http://localhost:4000",
        apiKey: fields.apiKey,
        timeoutMs: fields.timeoutMs,
        maxRetries: fields.maxRetries,
        allowNonDefaultAliases: fields.allowNonDefaultAliases,
        allowedModelAliases: fields.allowedModelAliases,
        requestMetadata: fields.requestMetadata,
      } satisfies LiteLLMClientConfig);
  }

  _llmType(): string {
    return "litellm";
  }

  override get callKeys(): string[] {
    return [
      ...super.callKeys,
      "tools",
      "tool_choice",
      "strict",
      "response_format",
      "structured_output",
      "requestMetadata",
      "traceId",
      "timeoutMs",
      "maxRetries",
      "temperature",
      "topP",
      "maxTokens",
      "stop",
      "extraBody",
    ];
  }

  override getLsParams(options: this["ParsedCallOptions"]): LangSmithParams {
    return {
      ls_provider: "litellm",
      ls_model_name: this.model,
      ls_model_type: "chat",
      ls_temperature: options.temperature ?? this.temperature,
      ls_max_tokens: options.maxTokens ?? this.maxTokens,
      ls_stop: options.stop ?? this.stop,
    };
  }

  protected buildChatInput(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): ChatCompleteInput {
    return {
      model: this.model,
      messages: baseMessagesToLiteLLMMessages(messages),
      temperature: options.temperature ?? this.temperature,
      topP: options.topP ?? this.topP,
      maxTokens: options.maxTokens ?? this.maxTokens,
      stop: options.stop ?? this.stop,
      tools: options.tools
        ? convertBindToolsInput(options.tools, options.strict)
        : undefined,
      toolChoice: options.tool_choice,
      responseFormat: options.response_format,
      structuredOutput: options.structured_output,
      metadata: (options as ChatLiteLLMCallOptions).requestMetadata,
      extraBody: {
        ...this.modelKwargs,
        ...(options.extraBody ?? {}),
      },
    };
  }

  protected async completeWithClient(
    input: ChatCompleteInput,
    options: this["ParsedCallOptions"],
  ) {
    return this.client.chat.complete(input, buildRequestOptions(options));
  }

  protected streamWithClient(
    input: ChatCompleteInput,
    options: this["ParsedCallOptions"],
  ) {
    return this.client.chat.stream(input, buildRequestOptions(options));
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const input = this.buildChatInput(messages, options);
    const result = await this.completeWithClient(input, options);

    const message = liteLLMResultToAIMessage(result);

    const generation: ChatGeneration = {
      text: result.outputText,
      message,
      generationInfo: {
        finish_reason: result.finishReason,
      },
    };

    await runManager?.handleLLMNewToken(result.outputText);

    return {
      generations: [generation],
      llmOutput: {
        tokenUsage: result.usage,
      },
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const input = this.buildChatInput(messages, options);

    for await (const event of this.streamWithClient(input, options)) {
      if (event.type === "error") {
        throw new LiteLLMError({
          ...event.error,
          message: event.error.message,
        });
      }

      const chunk = streamEventToChunk(event);
      if (!chunk) {
        continue;
      }

      yield chunk;

      await runManager?.handleLLMNewToken(
        chunk.text ?? "",
        {
          prompt: 0,
          completion: 0,
        },
        undefined,
        undefined,
        undefined,
        {
          chunk,
        },
      );
    }
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<CallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CallOptions> {
    const strict = kwargs?.strict;
    const formattedTools = convertBindToolsInput(tools, strict);

    return this.withConfig({
      ...kwargs,
      tools: formattedTools,
    } as Partial<CallOptions>);
  }

  withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    outputSchema:
      | SerializableSchema<RunOutput>
      | InteropZodType<RunOutput>
      | Record<string, unknown>,
    config?: StructuredOutputMethodOptions<boolean>,
  ):
    | Runnable<BaseLanguageModelInput, RunOutput>
    | Runnable<
        BaseLanguageModelInput,
        { raw: BaseMessage; parsed: RunOutput }
      > {
    let llm: Runnable<BaseLanguageModelInput>;
    let outputParser: Runnable<AIMessageChunk, RunOutput>;

    const { schema, name, includeRaw } = {
      ...config,
      schema: outputSchema,
    };

    const method = resolveStructuredOutputMethod(config?.method);
    const asJsonSchema = toJsonSchema(schema);

    if (method === "jsonMode") {
      llm = this.withConfig({
        response_format: {
          type: "json_object",
        },
      } as Partial<CallOptions>);
      outputParser = createContentParser(schema);
    } else if (method === "jsonSchema") {
      llm = this.withConfig({
        structured_output: {
          method: "json_schema",
          name: name ?? "extract",
          description: getSchemaDescription(schema),
          schema: asJsonSchema,
          strict: config?.strict,
        },
      } as Partial<CallOptions>);

      outputParser = createContentParser(schema);
    } else {
      const functionName = name ?? "extract";

      llm = this.withConfig({
        tools: [
          {
            type: "function",
            function: {
              name: functionName,
              description: getSchemaDescription(schema) ?? "",
              parameters: asJsonSchema,
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: {
            name: functionName,
          },
        },
        ...(config?.strict !== undefined ? { strict: config.strict } : {}),
      } as unknown as Partial<CallOptions>);

      outputParser = createFunctionCallingParser(schema, functionName);
    }

    return assembleStructuredOutputPipeline(
      llm,
      outputParser,
      includeRaw,
      "ChatLiteLLMStructuredOutput",
    );
  }
}
