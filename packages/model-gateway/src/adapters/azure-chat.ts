import { AzureChatOpenAI } from "@langchain/openai";
import type { ChatAdapter } from "./types";

export class AzureChatAdapter implements ChatAdapter {
  readonly kind = "azure-openai" as const;

  createModel(
    target: Parameters<ChatAdapter["createModel"]>[0],
    input: Parameters<ChatAdapter["createModel"]>[1],
    options?: Parameters<ChatAdapter["createModel"]>[2],
  ) {
    return new AzureChatOpenAI({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      maxRetries: options?.maxRetries ?? 2,
      azureOpenAIApiKey: target.apiKey,
      azureOpenAIEndpoint: target.baseUrl,
      deploymentName: target.providerModel,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
