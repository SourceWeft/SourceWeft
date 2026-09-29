import type { ModelCapabilityRule } from "@sourceweft/model-gateway";

/**
 * Shipped per-model capability rules — the code-level "model DB", in LiteLLM's
 * terms. Merged at runtime under any deployment-declared `modelCapabilities`
 * (which override), so these travel with the code and apply on redeploy
 * regardless of which gateway config file `MODEL_GATEWAY_GLOBAL_CONFIG_PATH`
 * points at. See docs/architecture/model-capabilities.md.
 *
 * `modelMatch` is a case-insensitive substring, catching the model through every
 * gateway that reaches it (`deepseek-v4-pro`, `deepseek/deepseek-v4-pro`), so a
 * rule applies whether the model is reached via OpenRouter (ChatOpenAI) or the
 * official gateway (ChatDeepSeek).
 *
 * These DeepSeek-family rules are the JS mirror of langchain-python's
 * `disabled_params`: @langchain/openai has no `disabled_params`, so we declare
 * the same disabled behaviour here (drop a forced `tool_choice`, pin structured
 * output to `function_calling`, repair broken tool-argument JSON) and the bridge
 * (`filterDisabledParams` / `planStructuredOutput`) enforces it — one general
 * mechanism, no DeepSeek-specific machinery.
 *
 * Structured output first checks the Provider: when the target's Provider
 * declares `json_schema_strict` in `supports` (OpenRouter), the schema is
 * strict-compatible and no method is pinned, the request uses a strict
 * `json_schema` response format and none of the structured-output rules below
 * apply. They govern the path taken everywhere else — a Provider without the
 * flag (DeepSeek's own API), an incompatible schema, and the automatic
 * fallback when a strict request is refused.
 *
 * `deepseek-v4-pro` / `deepseek-v4-flash` think by provider default and reject
 * a forced `tool_choice` *while thinking* with a hard 400
 * (https://github.com/deepseek-ai/DeepSeek-V3/issues/1376); `deepseek-reasoner`
 * (V3.1) cannot leave thinking mode at all. Rather than translate thinking off,
 * we mirror python and drop `tool_choice` unconditionally — the schema rides as
 * an available tool (API default `auto`), which every DeepSeek variant accepts.
 * LiteLLM's `supports_tool_choice` is too coarse to express this (it reports
 * `true` — the param is accepted, just not forced values), so it cannot be
 * synced and is declared here.
 */
export const MODEL_CAPABILITY_DB: readonly ModelCapabilityRule[] = [
  // The whole DeepSeek family rejects a forced `tool_choice` (V4 while thinking —
  // its provider default — with a hard 400, https://github.com/deepseek-ai/
  // DeepSeek-V3/issues/1376; reasoner cannot leave thinking at all). Declared as
  // langchain-python's `disabled_params` (drop `tool_choice` entirely → API
  // default `auto` = an available tool). Unconditional, mirroring python; it
  // still shapes every tool call and the non-strict structured-output path.
  { modelMatch: "deepseek", capabilities: { disabledParams: { tool_choice: null } } },
  // The whole family (any gateway prefix) emits unescaped ASCII quotes inside
  // Chinese tool-argument strings — invalid JSON that a strict parser drops
  // (verified live against deepseek-v4-pro, 2026-08-05; the storyboard-402
  // incident's true root cause). Still used on the tool-based paths, including
  // the fallback from a refused strict request.
  { modelMatch: "deepseek", capabilities: { toolCallArgumentJsonRepair: true } },
  // DeepSeek's own API rejects a `json_schema` response_format (hard 400).
  // langchain's first-party ChatDeepSeek pins structured output to
  // `function_calling` (and normalizes json_schema to it); declaring it here
  // gives the same model the same method when reached through a generic
  // openai-compatible gateway, where the ChatOpenAI default would otherwise be
  // json_schema. It now applies only where the Provider does not declare
  // `json_schema_strict`: OpenRouter routes DeepSeek to endpoints that enforce
  // strict json_schema (require_parameters), so there the strict plan wins.
  { modelMatch: "deepseek", capabilities: { structuredOutputMethod: "function_calling" } },
];
