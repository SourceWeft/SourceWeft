export interface ModelPricing {
  input_cost_per_token: number | null;
  output_cost_per_token: number | null;
  cache_read_input_token_cost: number | null;
  cache_creation_input_token_cost: number | null;
  output_cost_per_reasoning_token: number | null;
  price_source: "litellm" | "manual" | "openrouter" | "unknown";
  litellm_key: string | null;
  price_updated_at: string | null;
}
