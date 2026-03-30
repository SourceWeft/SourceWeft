import { createLiteLLMSDK } from "@polyer/litellm-sdk";
import { config } from "./config";

export const litellm = createLiteLLMSDK({
  baseUrl: config.litellm.baseUrl,
  apiKey: config.litellm.masterKey || undefined,
  timeoutMs: config.litellm.timeoutMs,
  maxRetries: config.litellm.maxRetries,
  allowNonDefaultAliases: false,
  allowedModelAliases: [
    config.litellm.chatModelAlias,
    config.litellm.embedModelAlias,
    config.litellm.rerankModelAlias,
  ],
});
