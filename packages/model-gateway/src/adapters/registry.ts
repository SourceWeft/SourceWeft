import { ModelGatewayError } from "../errors";
import type { ProviderKind } from "../types";
import { AnthropicChatAdapter } from "./anthropic-chat";
import { AzureEmbeddingsAdapter } from "./azure-embeddings";
import { AzureChatAdapter } from "./azure-chat";
import { DeepInfraChatAdapter } from "./deepinfra-chat";
import { DeepInfraEmbeddingsAdapter } from "./deepinfra-embeddings";
import { DeepInfraRerankTransport } from "./deepinfra-rerank";
import { GeminiEmbeddingsAdapter } from "./gemini-embeddings";
import { GeminiChatAdapter } from "./gemini-chat";
import { OpenAICompatibleEmbeddingsAdapter } from "./openai-compatible-embeddings";
import { OpenAICompatibleChatAdapter } from "./openai-compatible-chat";
import { OpenAICompatibleRerankTransport } from "./openai-compatible-rerank";
import { OpenRouterChatAdapter } from "./openrouter-chat";
import type { ChatAdapter, EmbeddingsAdapter, RerankTransport } from "./types";

const openAICompatibleChat = new OpenAICompatibleChatAdapter();
const openRouterChat = new OpenRouterChatAdapter();
const openAICompatibleEmbeddings = new OpenAICompatibleEmbeddingsAdapter();
const openAICompatibleRerank = new OpenAICompatibleRerankTransport();
const deepInfraChat = new DeepInfraChatAdapter();
const deepInfraEmbeddings = new DeepInfraEmbeddingsAdapter();
const deepInfraRerank = new DeepInfraRerankTransport();

const chatAdapters = new Map<ProviderKind, ChatAdapter>([
  ["openai-compatible", openAICompatibleChat],
  ["openrouter", openRouterChat],
  ["deepinfra", deepInfraChat],
  ["openai", openAICompatibleChat],
  ["azure-openai", new AzureChatAdapter()],
  ["anthropic", new AnthropicChatAdapter()],
  ["gemini", new GeminiChatAdapter()],
]);

const embeddingsAdapters = new Map<ProviderKind, EmbeddingsAdapter>([
  ["openai-compatible", openAICompatibleEmbeddings],
  ["openrouter", openAICompatibleEmbeddings],
  ["deepinfra", deepInfraEmbeddings],
  ["openai", openAICompatibleEmbeddings],
  ["azure-openai", new AzureEmbeddingsAdapter()],
  ["gemini", new GeminiEmbeddingsAdapter()],
]);

const rerankTransports = new Map<ProviderKind, RerankTransport>([
  ["openai-compatible", openAICompatibleRerank],
  ["openrouter", openAICompatibleRerank],
  ["deepinfra", deepInfraRerank],
  ["openai", openAICompatibleRerank],
]);

export function getChatAdapter(kind: ProviderKind): ChatAdapter {
  const adapter = chatAdapters.get(kind);
  if (!adapter) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Unsupported chat provider kind '${kind}'`,
      retryable: false,
    });
  }
  return adapter;
}

export function getEmbeddingsAdapter(kind: ProviderKind): EmbeddingsAdapter {
  const adapter = embeddingsAdapters.get(kind);
  if (!adapter) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Unsupported embeddings provider kind '${kind}'`,
      retryable: false,
    });
  }
  return adapter;
}

export function getRerankTransport(kind: ProviderKind): RerankTransport {
  const transport = rerankTransports.get(kind);
  if (!transport) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Provider '${kind}' does not support rerank in this gateway`,
      retryable: false,
    });
  }
  return transport;
}
