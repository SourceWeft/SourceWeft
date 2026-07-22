import type { ModelCapabilityRule } from "@sourceweft/model-gateway";

/**
 * Shipped per-model capability rules — the code-level "model DB", in LiteLLM's
 * terms. Merged at runtime under any deployment-declared `modelCapabilities`
 * (which override), so these travel with the code and apply on redeploy
 * regardless of which gateway config file `MODEL_GATEWAY_GLOBAL_CONFIG_PATH`
 * points at. See docs/architecture/model-capabilities.md.
 *
 * `modelMatch` is a case-insensitive substring, catching the model through every
 * gateway that reaches it (`deepseek-v4-pro`, `deepseek/deepseek-v4-pro`).
 *
 * `deepseek-v4-pro` / `deepseek-v4-flash` are always in thinking mode and reject
 * any forced `tool_choice` (https://github.com/deepseek-ai/DeepSeek-V3/issues/1376);
 * `deepseek-reasoner` (V3.1) likewise. LiteLLM's `supports_tool_choice` is too
 * coarse to express this (it reports `true` — the param is accepted, just not
 * forced values), so it cannot be synced and is declared here.
 */
export const MODEL_CAPABILITY_DB: readonly ModelCapabilityRule[] = [
  { modelMatch: "deepseek-v4-pro", capabilities: { supportsForcedToolChoice: false } },
  { modelMatch: "deepseek-v4-flash", capabilities: { supportsForcedToolChoice: false } },
  { modelMatch: "deepseek-reasoner", capabilities: { supportsForcedToolChoice: false } },
];
