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
 * `deepseek-v4-pro` / `deepseek-v4-flash` think by provider default and reject
 * a forced `tool_choice` *while thinking* with a hard 400
 * (https://github.com/deepseek-ai/DeepSeek-V3/issues/1376); with thinking
 * explicitly disabled they accept it, so the restriction is declared as the
 * conditional `forcedToolChoiceBlockedByThinking`. `deepseek-reasoner` (V3.1)
 * cannot leave thinking mode at all, so it keeps the unconditional flag.
 * LiteLLM's `supports_tool_choice` is too coarse to express either (it reports
 * `true` — the param is accepted, just not forced values), so it cannot be
 * synced and is declared here.
 */
export const MODEL_CAPABILITY_DB: readonly ModelCapabilityRule[] = [
  { modelMatch: "deepseek-v4-pro", capabilities: { forcedToolChoiceBlockedByThinking: true } },
  { modelMatch: "deepseek-v4-flash", capabilities: { forcedToolChoiceBlockedByThinking: true } },
  { modelMatch: "deepseek-reasoner", capabilities: { supportsForcedToolChoice: false } },
  // The whole family (any gateway prefix) emits unescaped ASCII quotes inside
  // Chinese tool-argument strings — invalid JSON that a strict parser drops
  // (verified live against deepseek-v4-pro, 2026-08-05; the storyboard-402
  // incident's true root cause).
  { modelMatch: "deepseek", capabilities: { toolCallArgumentJsonRepair: true } },
];
