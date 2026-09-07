import { sdkRetryOptions } from "./gateway-caller";
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
      ...sdkRetryOptions(options),
      timeout: options?.timeoutMs,
      azureOpenAIApiKey: target.apiKey,
      azureOpenAIEndpoint: target.baseUrl,
      configuration: {
        fetch: options?.fetch,
        adminAPIKey: null,
        ignoreEnvironmentHeaders: true,
      },
      deploymentName: target.providerModel,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
