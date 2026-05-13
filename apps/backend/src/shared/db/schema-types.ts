export interface ModelPricing {
  input_cost_per_token: number | null;
  output_cost_per_token: number | null;
  cache_read_input_token_cost: number | null;
  cache_creation_input_token_cost: number | null;
  output_cost_per_reasoning_token: number | null;
  input_cost_per_image_token?: number | null;
  output_cost_per_image_token?: number | null;
  input_cost_per_audio_token?: number | null;
  output_cost_per_audio_token?: number | null;
  input_cost_per_image?: number | null;
  output_cost_per_image?: number | null;
  price_source: "litellm" | "manual" | "openrouter" | "unknown";
  litellm_key: string | null;
  price_updated_at: string | null;
  litellm_provider?: string | null;
  litellm_mode?: string | null;
  supportsImageInput?: boolean;
  supports_function_calling?: boolean | null;
  supports_parallel_function_calling?: boolean | null;
  supports_response_schema?: boolean | null;
  supports_tool_choice?: boolean | null;
  supports_prompt_caching?: boolean | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  max_completion_tokens?: number | null;
}
