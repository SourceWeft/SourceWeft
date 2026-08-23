# Model Provider Observation and Cost Reconciliation Design

## Status

Approved in conversation on 2026-08-24. This document records the agreed design before implementation.

## Problem

SourceWeft already records model generations, normalized token usage, provider cost, routing identity, and billing ledger events. The current normalization boundary is too broad, however: protocol fields and provider-specific fields are parsed together, a dynamic router such as `orcarouter/auto` is priced through a static profile, and the requested model is not separated from the concrete model selected by the provider.

The result is incomplete cost attribution for dynamic routers, duplicate missing-price warnings, and provider-specific wire knowledge leaking into generic usage code.

## Goals

For every model call, record one canonical observation containing:

- normalized token usage and its breakdown;
- SourceWeft model alias;
- requested provider and provider model;
- concrete model resolved by the provider;
- provider request ID and routing metadata;
- inline provider cost;
- settled provider cost;
- effective cost used by SourceWeft;
- provenance and normalization diagnostics.

Use the same canonical observation for persistence, billing, and presentation.

## Non-goals

- Do not infer OrcaRouter's internal upstream backend or channel.
- Do not calculate OrcaRouter actual cost from the resolved model and a local price book.
- Do not introduce an `orcarouter` provider kind; it remains an `openai-compatible` protocol provider.
- Do not rewrite unrelated thread or chat behavior.
- Do not silently fall back to another provider, model, price source, or test strategy.

## Architectural Constraints

Generic code must not contain provider-specific conditionals such as `provider === "orcarouter"`.

Generic protocol normalizers must not recognize OrcaRouter fields or headers, including `cost_usd` and `X-Orca-*`.

Provider-specific behavior is registered once through the provider adapter registry. Generic infrastructure may transport raw response bodies, metadata, and headers, but only the provider adapter selects, interprets, and maps provider-specific values.

## Canonical Model Call Observation

The model gateway will expose a canonical observation with four sections:

```ts
interface ModelCallObservation {
  identity: ModelCallIdentity;
  usage?: ModelCallUsage;
  cost?: ModelCallCost;
  provenance: ModelCallProvenance;
  diagnostics?: ModelCallDiagnostic[];
}
```

Identity records the product alias, provider, requested provider model, resolved provider model, provider request ID, router name, and fallback metadata.

Usage records input, output, total, cache read/write, reasoning, image, and audio counts. Cost is separate from usage and records inline, settled, and effective USD values together with source and reconciliation status.

The existing `UsageInfo.providerCostUsd` remains temporarily as a compatibility bridge and is removed only after every consumer uses the canonical cost object.

## Normalization Pipeline

The response pipeline is:

```text
raw response / SDK metadata / response headers
                     |
                     v
           protocol normalizer
                     |
                     v
          provider response adapter
                     |
                     v
       validation and stream aggregation
                     |
                     v
          ModelCallObservation
```

Protocol normalizers handle common wire formats:

- OpenAI-compatible: prompt, completion, total, cache, reasoning, image, and audio token fields;
- Anthropic: input, output, cache read, and cache creation fields;
- Gemini: prompt, candidate, total, thoughts, and cached-content fields;
- LangChain: `usage_metadata` and `response_metadata` only as a fallback when raw usage is unavailable.

Raw provider usage wins over SDK-normalized metadata. Derived totals are used only when the provider omitted a total.

Provider adapters enrich the protocol result. They do not reimplement standard protocol token parsing.

## Provider Adapter Port

Provider adapters support four optional operations:

```ts
interface ProviderResponseAdapter {
  decorateRequest?(context: ProviderRequestContext): ProviderRequestPatch;
  selectResponseHeaders?(headers: Headers): Record<string, string>;
  normalizeResponse?(
    context: ProviderResponseContext,
    base: ModelCallObservation,
  ): ModelCallObservationPatch;
  reconcileCost?(context: ProviderReceiptContext): Promise<ProviderReceipt>;
}
```

The generic registry composes a protocol normalizer selected by `providerKind` with a provider adapter selected by provider name. The registry entry is the only generic registration point that contains the provider name.

## OrcaRouter Adapter

The OrcaRouter adapter owns all OrcaRouter behavior.

Request decoration adds `X-OrcaRouter-Include-Cost: true` and merges `stream_options.include_usage: true` for streaming calls.

The response module alone declares and reads:

- `usage.cost_usd`;
- `X-Orca-Request-Id`;
- `X-Orca-Resolved-Model`;
- `X-Orca-Router`;
- `X-Orca-Fallback-Level`;
- `X-Orca-Fallback-Model`;
- `response_metadata.model_name` as a fallback resolved-model field.

The resolved-model precedence is settled receipt model, response header, response metadata model name, and response body model.

`response_metadata.model_provider` is SDK identity and is not treated as the upstream provider.

The generic transport supplies successful HTTP response headers through a request-scoped response context. It does not select or interpret them. Header capture must remain isolated across concurrent invoke and stream calls.

## Other Provider Adapters

OpenRouter owns `usage.cost`, `usage.estimated_cost`, and `usage.cost_details` cost extensions.

DeepInfra owns `inference_status` token and cost extensions.

Provider token extensions fill missing protocol fields by default. An adapter must explicitly mark a provider field authoritative before it can replace a protocol value. Conflicts produce diagnostics rather than silent overwrites.

## Streaming Semantics

Normalized stream usage declares whether frames are final, cumulative, or delta.

Final and cumulative usage use last-wins aggregation. Delta usage is summed. OrcaRouter's OpenAI-compatible trailing usage frame is final/cumulative and must not be summed with earlier frames.

Concurrent streams must not share usage, headers, request IDs, resolved models, or costs.

## Validation

The finalizer enforces finite, non-negative integer token counts and finite, non-negative costs. It checks reasoning against output and cache counts against input. Conflicting totals or provider patches produce diagnostics while preserving the authoritative reported value.

An unregistered provider's `cost_usd` field is ignored.

## Persistence

`llm_generations` remains the model-call fact table. Existing fields keep their meanings:

- `model_alias`: SourceWeft product alias;
- `provider`: provider name;
- `provider_model`: requested provider model;
- existing token, usage JSON, provider cost, request ID, and raw metadata fields remain.

The migration adds nullable fields:

- `profile_alias`;
- `gateway_config_id`;
- `resolved_provider_model`;
- `reasoning_tokens`;
- `cache_read_tokens`;
- `cache_write_tokens`;
- `provider_cost_inline_usd`;
- `provider_cost_settled_usd`;
- `provider_cost_source`;
- `provider_cost_status`;
- `cost_currency`;
- `provider_receipt_json`;
- `cost_reconciled_at`;
- `normalization_json`.

Provider-cost columns in `llm_generations` and `messages` move from six to twelve decimal places using `numeric(18, 12)`.

Indexes support provider/resolved-model analytics, provider request lookup, and pending reconciliation scans. Check constraints enforce non-negative token and cost values and valid cost source/status values.

## Cost Resolution

Effective cost precedence is settled provider receipt, provider inline cost, allowed price-book cost, and missing.

OrcaRouter declares actual cost mode `inline_and_receipt` and disallows price-book fallback for actual billing. Price-book values may be used for admission estimates but never represented as OrcaRouter actual cost.

If inline cost is missing and a request ID exists, the generation is pending reconciliation. If both are missing, the generation is marked missing and emits a structured provider-cost error. No alternate price source is selected silently.

## Receipt Reconciliation

A generic `reconcile-provider-cost` worker resolves the provider adapter from the registry and invokes its receipt port. Generic worker code does not know OrcaRouter URLs or fields.

The OrcaRouter receipt adapter calls `GET /v1/generation?id=<request-id>` and maps the concrete model, token counts, settled cost, currency, and raw receipt into the canonical receipt type.

Reconciliation locks the generation, returns idempotently when already settled, persists the receipt, promotes settled cost to effective cost, and appends a billing adjustment or refund for the difference from the inline charge.

Early receipt `404` responses are retried with bounded backoff. Exhaustion records `reconcile_failed` and alerts; it does not change provider or price source.

## Billing

`usage_ledgers` remains append-only. Reconciliation never mutates the original consume entry. Positive differences append an adjustment/consume entry and negative differences append a refund entry using `provider-cost-reconcile:<generationId>:v1` as the idempotency key.

The original credit-unit and markup snapshot is persisted with the first charge so reconciliation does not use future billing rates.

Covered calls record provider cost without charging the user. BYOK calls retain their existing customer-charge semantics while still recording available provider observations.

## Migration and Rollout

1. Add characterization tests for every current protocol, modality, and provider extension.
2. Apply the additive nullable database migration and cost-precision change.
3. Introduce canonical observation types, protocol normalizers, provider registry, validation, and stream aggregation.
4. Move OpenRouter and DeepInfra extensions into provider modules.
5. Implement OrcaRouter request, response, successful-header capture, and receipt modules.
6. Dual-write old and new fields in shadow mode without changing billing.
7. Compare legacy cost, inline cost, and settled receipt cost.
8. Enable OrcaRouter inline billing and receipt reconciliation after shadow validation.
9. Backfill only fields supported by historical evidence.
10. Switch API and UI readers to canonical fields.
11. Remove generic provider-specific parsing, backend response re-parsing, duplicate cost lookup, and misleading dynamic-router price-book behavior.

Historical values without reliable provenance remain null or are marked `legacy`; they are never promoted to settled cost.

## Testing

Tests cover protocol normalization, raw-versus-SDK precedence, provider enrichment, conflict diagnostics, stream aggregation, concurrent response isolation, OrcaRouter header and cost parsing, unknown-provider cost rejection, receipt retry and idempotency, billing adjustment/refund, database precision, covered/BYOK behavior, and regressions for OpenRouter and DeepInfra.

Architecture guard tests prohibit OrcaRouter strings and headers in protocol normalizers and backend billing code. OrcaRouter-specific strings may appear only in the OrcaRouter provider module, its tests, configuration, and the provider registry entry.

Live verification covers non-streaming and streaming OrcaRouter auto and fixed-model calls, inline cost, resolved model, request ID, receipt lookup, and settled reconciliation. Missing network, credentials, permissions, or provider behavior is reported as the exact blocker; mock tests do not replace the required live verification.

## Acceptance Criteria

For the observed example call, the final `llm_generations` row records `chat-default`, `orcarouter`, `orcarouter/auto`, the provider-prefixed resolved model, 842 input tokens, 5,012 output tokens, 3,938 reasoning tokens, 5,854 total tokens, a provider request ID, inline and settled costs, effective settled cost, receipt source/status, and USD currency.

The system emits no missing static-price warning for an OrcaRouter call with provider-reported cost. Billing and observability consume the same canonical observation, receipt jobs are idempotent, dynamic model changes remain visible, and generic code contains no OrcaRouter response-field logic.
