ALTER TABLE "model_gateway_provider_configs"
  DROP CONSTRAINT IF EXISTS "model_gateway_provider_configs_kind_check";

ALTER TABLE "model_gateway_provider_configs"
  ADD CONSTRAINT "model_gateway_provider_configs_kind_check"
  CHECK ("provider_kind" in ('openai-compatible', 'openrouter', 'deepinfra', 'siliconflow-cn', 'openai', 'anthropic', 'gemini', 'azure-openai'));
