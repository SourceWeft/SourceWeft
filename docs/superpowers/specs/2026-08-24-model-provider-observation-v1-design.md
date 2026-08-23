# Model Provider Observation V1 Design

## Status

Approved in conversation on 2026-08-24. This specification supersedes the V1 scope of `2026-08-24-model-provider-observation-design.md`; receipt settlement and credit reconciliation from that document are deferred.

## Objective

Fix OrcaRouter dynamic-model cost attribution without introducing a financial reconciliation subsystem. Each new model call records normalized token usage, the requested provider model, the concrete resolved model, and the provider-reported inline cost.

## Scope

V1 includes:

- protocol-default token normalization;
- provider-specific response enrichment;
- OrcaRouter request decoration with `X-OrcaRouter-Include-Cost`;
- OrcaRouter parsing of `usage.cost_usd` and selected `X-Orca-*` response headers;
- separate requested and resolved provider model fields;
- request-scoped success-response header capture;
- canonical observation shared by observability and billing;
- disabling price-book fallback when a provider requires actual cost;
- additive `llm_generations` fields required for queryable token/model/cost data;
- twelve-decimal provider-cost storage;
- characterization, provider-boundary, persistence, and live smoke tests.

V1 does not include:

- provider receipt lookup;
- settled-cost state;
- asynchronous reconciliation workers;
- credit supplement/refund logic;
- receipt retry or recovery scans;
- raw receipt persistence;
- historical generation backfill;
- persistent normalization provenance/diagnostics;
- broad UI exposure of internal routing identity;
- unrelated provider refactors that are not required to preserve behavior.

## Architecture

Generic code transports raw response bodies, SDK metadata, and response headers. It selects a protocol normalizer by `providerKind`, then invokes an optional provider adapter selected by provider name.

Generic code contains no OrcaRouter field names or provider conditionals. OrcaRouter-specific request headers, response-header allowlists, resolved-model precedence, and `cost_usd` parsing live only in the OrcaRouter provider module. The registry entry is the only generic location containing the provider name.

## Canonical Observation

The V1 observation contains:

```ts
interface ModelCallObservation {
  traceId?: string;
  spanId?: string;
  identity: {
    modelAlias: string;
    provider: string;
    requestedProviderModel: string;
    resolvedProviderModel?: string;
    providerRequestId?: string;
  };
  usage?: UsageInfo;
  cost?: {
    currency: "USD";
    effectiveUsd?: number;
    source: "provider_inline" | "provider_estimated" | "price_book" | "missing";
  };
}
```

The existing `UsageInfo.providerCostUsd` may remain temporarily as a compatibility mirror while billing consumers move to the observation cost.

## Persistence

`llm_generations` retains existing alias, provider, requested model, input/output/total tokens, usage JSON, provider request ID, response headers, and provider cost fields.

V1 adds only query-critical fields:

- `resolved_provider_model`;
- `reasoning_tokens`;
- `cache_read_tokens`;
- `cache_write_tokens`;
- `provider_cost_source`.

`llm_generations.provider_cost_usd` and `messages.provider_cost_usd` use `numeric(18, 12)`.

Provider request ID and selected response headers use the existing columns. Detailed token breakdowns remain in `usage_json`; no receipt or reconciliation columns are added.

## Cost Behavior

When OrcaRouter returns `usage.cost_usd`, V1 stores it as `provider_cost_usd` with source `provider_inline`. Billing uses that amount directly.

When an adapter declares `allowPriceBookFallback: false` and actual cost is absent, cost remains missing and the existing explicit minimum-credit policy may apply. The system does not silently use the alias price book for that provider.

Multi-target aliases retain an explicit fallback price for providers that do not report actual cost. A provider that reports actual cost bypasses it.

## Error Handling

- Missing or malformed provider extension fields do not corrupt protocol token usage.
- Unknown providers cannot turn arbitrary `cost_usd` fields into billable cost.
- Header-capture failures leave resolved model/request ID absent and emit structured diagnostics or logs.
- No asynchronous receipt state exists in V1, so there is no pending/settled state machine.

## Compatibility

Existing response/result shapes remain compatible. New observation and resolved-model fields are additive. Existing alias-routing privacy remains intact: internal requested/resolved provider models are persisted for authorized observability, not exposed through product-facing aliased model fields by default.

## Testing

Tests must cover:

- OpenAI-compatible token normalization;
- raw response precedence over SDK metadata;
- provider-specific OpenRouter and DeepInfra behavior retained without generic leakage;
- OrcaRouter request header, inline cost, resolved model, and request ID;
- unknown-provider rejection of `cost_usd`;
- complete and stream usage;
- concurrent request-scoped header isolation;
- DB persistence and twelve-decimal precision;
- price-book bypass for providers requiring actual cost;
- architecture guards preventing provider wire fields in generic layers;
- real OrcaRouter complete and stream smoke calls.

## Acceptance Criteria

For an OrcaRouter auto call, one generation records:

```text
model_alias               = chat-default
provider                  = orcarouter
provider_model            = orcarouter/auto
resolved_provider_model   = provider-prefixed concrete model
input/output/total tokens = provider-reported values
reasoning/cache tokens    = provider-reported breakdown
provider_request_id       = X-Orca-Request-Id when available
provider_cost_usd         = usage.cost_usd
provider_cost_source      = provider_inline
```

The call emits no missing-static-price warning when provider inline cost is present, and generic normalization/billing code contains no OrcaRouter response-field logic.
