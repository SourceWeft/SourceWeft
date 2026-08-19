import { ModelGatewayError } from "../errors";
import type { ProviderKind } from "../types";
import { AnthropicChatAdapter } from "./anthropic-chat";
import { AzureEmbeddingsAdapter } from "./azure-embeddings";
import { AzureChatAdapter } from "./azure-chat";
import { CloudflareAIGChatAdapter } from "./cloudflare-aig-chat";
import { DeepInfraAsrTransport } from "./deepinfra-asr";
import { DeepInfraChatAdapter } from "./deepinfra-chat";
import { DeepInfraEmbeddingsAdapter } from "./deepinfra-embeddings";
import { DeepInfraImagesGenerationTransport } from "./deepinfra-images";
import { DeepInfraRerankTransport } from "./deepinfra-rerank";
import { DeepInfraTtsTransport } from "./deepinfra-tts";
import { DeepSeekChatAdapter } from "./deepseek-chat";
import { GeminiEmbeddingsAdapter } from "./gemini-embeddings";
import { GeminiChatAdapter } from "./gemini-chat";
import { OpenAICompatibleEmbeddingsAdapter } from "./openai-compatible-embeddings";
import { OpenAICompatibleAsrTransport } from "./openai-compatible-asr";
import { OpenAICompatibleChatAdapter } from "./openai-compatible-chat";
import { OpenAICompatibleImageGenerationTransport } from "./openai-compatible-images";
import { OpenAICompatibleRerankTransport } from "./openai-compatible-rerank";
import { OpenAICompatibleTtsTransport } from "./openai-compatible-tts";
import { OpenRouterChatAdapter } from "./openrouter-chat";
import { OpenRouterImageGenerationTransport } from "./openrouter-images";
import { OpenRouterTtsTransport } from "./openrouter-tts";
import { SiliconflowCNAsrTransport } from "./siliconflow-cn-asr";
import { SiliconflowCNChatAdapter } from "./siliconflow-cn-chat";
import { SiliconflowCNEmbeddingsAdapter } from "./siliconflow-cn-embeddings";
import { SiliconflowCNImageGenerationTransport } from "./siliconflow-cn-images";
import { SiliconflowCNRerankTransport } from "./siliconflow-cn-rerank";
import type {
  AsrTransport,
  ChatAdapter,
  EmbeddingsAdapter,
  ImageGenerationTransport,
  RerankTransport,
  TtsTransport,
} from "./types";

const openAICompatibleChat = new OpenAICompatibleChatAdapter();
const cloudflareAIGChat = new CloudflareAIGChatAdapter();
const openRouterChat = new OpenRouterChatAdapter();
const openAICompatibleEmbeddings = new OpenAICompatibleEmbeddingsAdapter();
const openAICompatibleRerank = new OpenAICompatibleRerankTransport();
const openAICompatibleAsr = new OpenAICompatibleAsrTransport();
const openAICompatibleImages = new OpenAICompatibleImageGenerationTransport();
const openAICompatibleTts = new OpenAICompatibleTtsTransport();
const deepInfraImages = new DeepInfraImagesGenerationTransport();
const openRouterImages = new OpenRouterImageGenerationTransport();
const openRouterTts = new OpenRouterTtsTransport();
const deepInfraChat = new DeepInfraChatAdapter();
const deepSeekChat = new DeepSeekChatAdapter();
const deepInfraEmbeddings = new DeepInfraEmbeddingsAdapter();
const deepInfraRerank = new DeepInfraRerankTransport();
const deepInfraAsr = new DeepInfraAsrTransport();
const deepInfraTts = new DeepInfraTtsTransport();
const siliconflowCNChat = new SiliconflowCNChatAdapter();
const siliconflowCNEmbeddings = new SiliconflowCNEmbeddingsAdapter();
const siliconflowCNRerank = new SiliconflowCNRerankTransport();
const siliconflowCNAsr = new SiliconflowCNAsrTransport();
const siliconflowCNImages = new SiliconflowCNImageGenerationTransport();

const chatAdapters = new Map<ProviderKind, ChatAdapter>([
  ["openai-compatible", openAICompatibleChat],
  ["cloudflare-aig", cloudflareAIGChat],
  ["openrouter", openRouterChat],
  ["deepinfra", deepInfraChat],
  ["deepseek", deepSeekChat],
  ["siliconflow-cn", siliconflowCNChat],
  ["openai", openAICompatibleChat],
  ["azure-openai", new AzureChatAdapter()],
  ["anthropic", new AnthropicChatAdapter()],
  ["gemini", new GeminiChatAdapter()],
]);

const embeddingsAdapters = new Map<ProviderKind, EmbeddingsAdapter>([
  ["openai-compatible", openAICompatibleEmbeddings],
  ["openrouter", openAICompatibleEmbeddings],
  ["deepinfra", deepInfraEmbeddings],
  ["siliconflow-cn", siliconflowCNEmbeddings],
  ["openai", openAICompatibleEmbeddings],
  ["azure-openai", new AzureEmbeddingsAdapter()],
  ["gemini", new GeminiEmbeddingsAdapter()],
]);

const rerankTransports = new Map<ProviderKind, RerankTransport>([
  ["openai-compatible", openAICompatibleRerank],
  ["openrouter", openAICompatibleRerank],
  ["deepinfra", deepInfraRerank],
  ["siliconflow-cn", siliconflowCNRerank],
  ["openai", openAICompatibleRerank],
]);

const asrTransports = new Map<ProviderKind, AsrTransport>([
  ["openai-compatible", openAICompatibleAsr],
  ["deepinfra", deepInfraAsr],
  ["siliconflow-cn", siliconflowCNAsr],
  ["openai", openAICompatibleAsr],
]);

const ttsTransports = new Map<ProviderKind, TtsTransport>([
  ["openai-compatible", openAICompatibleTts],
  ["openai", openAICompatibleTts],
  ["openrouter", openRouterTts],
  ["deepinfra", deepInfraTts],
]);

const imageGenerationTransports = new Map<
  ProviderKind,
  ImageGenerationTransport
>([
  ["openai-compatible", openAICompatibleImages],
  ["openai", openAICompatibleImages],
  ["azure-openai", openAICompatibleImages],
  ["openrouter", openRouterImages],
  ["deepinfra", deepInfraImages],
  ["siliconflow-cn", siliconflowCNImages],
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

export function getAsrTransport(kind: ProviderKind): AsrTransport {
  const transport = asrTransports.get(kind);
  if (!transport) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Provider '${kind}' does not support ASR in this gateway`,
      retryable: false,
    });
  }
  return transport;
}

export function getTtsTransport(kind: ProviderKind): TtsTransport {
  const transport = ttsTransports.get(kind);
  if (!transport) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Provider '${kind}' does not support TTS in this gateway`,
      retryable: false,
    });
  }
  return transport;
}

export function getImageGenerationTransport(kind: ProviderKind): ImageGenerationTransport {
  const transport = imageGenerationTransports.get(kind);
  if (!transport) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Provider '${kind}' does not support image generation in this gateway`,
      retryable: false,
    });
  }
  return transport;
}
