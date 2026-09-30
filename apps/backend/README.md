# Backend

This directory contains the backend runtime for SourceWeft.

The default development and Docker runtime is Node **22.23.2**; Node **24** is
also supported. Root/backend engines accept `^22.13.0 || ^24.0.0`, and CI tests
22.23.2 and 24.18.0. See [Node runtime policy](docs/node-runtime.md).

The backend is one codebase with three runtime entry points (API, worker, and
scheduler). Its main directories are:

- `src/api`: HTTP API process
- `src/worker`: async job consumer process
- `src/scheduler`: timed job dispatcher process
- `src/modules`: business modules
- `src/shared`: shared backend utilities

Use `pnpm run dev` in this directory to start all three processes.

BullMQ + Redis power background jobs on three queues. The primary queue runs
jobs including source parsing, connector sync, model pricing sync, and durable
chat runs. Durable chat runs manage queueing, heartbeats, cancellation, approval
pauses, and buffered events that clients can re-attach to over SSE. See the
[threads module](src/modules/threads/README.md) for the run lifecycle and the
distinction between durable and direct streaming. Deliverable pipelines run on
their own queue through the worker's deliverable host (see the
[worker guide](src/worker/README.md)), and skill registry imports run on the
third.

Commercial billing is optional and disabled by default
(`SOURCEWEFT_COMMERCIAL_ENABLED=false`); without it, credits and pages are
neither metered nor enforced. Payment checkout additionally needs
`SOURCEWEFT_SAAS_ENABLED=true` and a payment provider. The
[billing module guide](../../enterprise/billing/README.md) covers what core
retains without the module, activation, usage accounting, checkout, and
subscription configuration.

Ops alerts from the scheduler, billing, and provider cost reconciliation are
recorded in `ops_alerts` by the [ops module](src/modules/ops/README.md) and
emailed to `OPS_ALERT_EMAILS` through the configured mail provider.
`BACKEND_ALERTS_ENABLED=false` turns them off. The backend env template sets
it to `false`; when it is unset, as in the Docker template, alerts are on.

Auth and workspace MVP notes:

- Better Auth is mounted at `/api/auth/*`.
- Google sign-in mirrors GitHub's Better Auth callback pattern. Configure
  `AUTH_GOOGLE_SIGNIN_WEB_CLIENT_ID` and
  `AUTH_GOOGLE_SIGNIN_WEB_CLIENT_SECRET`; the Google Cloud OAuth client must
  allow `<NEXT_PUBLIC_API_BASE_URL>/api/auth/callback/google`.
- Google One Tap and native mobile sign-in use ID tokens. Configure
  `AUTH_GOOGLE_ONE_TAP_CLIENT_ID` and `AUTH_GOOGLE_MOBILE_CLIENT_ID` for those
  audiences; they do not choose the browser OAuth redirect client.
- Workspace APIs are exposed at `/v1/teams/:teamId/workspaces` and `/v1/context/*`.
- Run `pnpm migrate` to apply Better Auth migrations followed by Drizzle business migrations.
- Run `pnpm db:generate` after schema changes to generate new Drizzle migration files.

Environment template: `apps/backend/.env.example`.

For production/test access to internal MCP/OAuth services, configure
`MCP_ALLOWED_INTERNAL_ORIGINS`. See [MCP network and authentication setup](docs/mcp-network.md).
Backend dev commands use `NODE_ENV=development` and skip endpoint address
restrictions, including proxy fake-IP checks. TLS and credential protections remain active.

Under strict address policy, System Provider endpoint declarations
grant network permission; extra BYOK origins use `LLM_ALLOWED_INTERNAL_ORIGINS`.
See [LLM network setup and adapter limits](docs/llm-network.md), including the
native Gemini patches and unauthenticated local System OpenAI-compatible models.
Embedding configuration changes follow [index identity protection](docs/embedding-index-safety.md).
Embedding usage observation retains known batch usage without changing billing.
Artifact reuse, conflicts and object cleanup follow
[publication safety](docs/artifact-write-safety.md).
Catalog refresh, retrieval failures and model request limits follow
[failure and request-option semantics](docs/model-failure-semantics.md).

The Agent runtime lives in [src/modules/threads/agent/](src/modules/threads/agent/).
Sandbox orchestration is implemented in
[sandbox-service/service.ts](src/modules/threads/agent/sandbox-service/service.ts),
with capability-contributed providers discovered by the
[provider registry](src/modules/threads/agent/sandbox-service/provider-registry.ts).
See [Sandbox Execution (Alpha)](../../docker/sandbox-execution.md) for deployment
requirements, command approval, and the boundary between temporary sandbox files
and durable working files.

Model gateway catalog sync:

- Global provider keys remain optional environment variables.
- Global Provider activation is separate from credentials. Each gateway declares
  `activation.env` plus a boolean default; the named `*_ENABLED` variable controls
  deployment intent while `apiKeyEnv` supplies only credentials. A gateway is
  globally ready only when it is enabled and its declared credential is present.
- The shipped config references `OPENROUTER_ENABLED` (default `true`) and
  `ORCAROUTER_ENABLED` (default `false`). Setting either API key never changes the
  corresponding activation state.
- DeepInfra, DeepSeek, SiliconFlow, and other custom Providers require a custom
  gateway entry. Their environment variables have no effect until that entry
  references them. Example:

  ```json
  {
    "slug": "deepinfra-default",
    "providerName": "deepinfra",
    "providerKind": "deepinfra",
    "baseUrl": "https://api.deepinfra.com/v1",
    "baseUrlEnv": "DEEPINFRA_API_BASE",
    "apiKeyEnv": "DEEPINFRA_API_KEY",
    "activation": {
      "env": "DEEPINFRA_ENABLED",
      "default": false
    }
  }
  ```

- A gateway's `supports` lists what its Provider serves. The accepted values
  are `chat`, `tool_calling`, `json_schema`, `json_schema_strict`,
  `embeddings`, `rerank`, `asr`, `tts`, `image` and `video`. Any other value
  has no effect and is logged as a warning when the configuration loads (it
  is not refused, so existing configs keep starting). Chat and vision catalog
  discovery need `chat`
  and `tool_calling`, and the system model needs `chat` and `json_schema`.
- Declare `json_schema_strict` only for a Provider that enforces a strict
  `response_format: { type: "json_schema", json_schema: { strict: true } }`.
  Structured calls that pin no method then send a strict JSON schema whenever
  the schema allows it: every object closed with `additionalProperties: false`
  and every property listed in `required`, with no `oneOf`, `allOf`, `not`,
  conditionals, pattern-keyed properties or `$ref`/`$defs`. On OpenRouter such
  a request also sends `provider.require_parameters: true`, merged with the
  route's `only`/`sort`, so only endpoints that honour the schema serve it; a
  non-strict `json_schema` request keeps OpenRouter's normal routing.
  Per-model exceptions are handled automatically: when the Provider refuses
  the request (OpenRouter's 404 "No endpoints found that can handle the
  requested parameters", a 400 saying the response format is unavailable or
  not supported, or a 400 "Invalid schema for response_format"), the call is
  retried once the way it would run without the flag (for DeepSeek, the schema
  as an available tool), the warning `model-gateway.structured-output-fallback`
  records the reason, and that Provider and model skip strict output for an
  hour in that process. Other errors are not retried. The shipped OpenRouter
  gateway declares it; OrcaRouter does not until it is verified. BYOK requests
  that reuse a Provider definition inherit it with the rest of `supports`.
- For Docker, bind-mount the complete custom JSON into the container and set
  `MODEL_GATEWAY_GLOBAL_CONFIG_PATH` to that container path. Changing the path
  variable alone does not mount a host file.
- Dynamic provider model discovery is configured per gateway in
  `apps/backend/config/model-gateway.global.json` with
  `modelCatalog.enabled`; the removed `MODEL_GATEWAY_SYNC_OPENROUTER_CATALOG`
  environment variable is no longer used.
- A gateway's optional `displayName` sets its catalog label without changing
  `providerName`. Set `modelCatalog.displayNameOverrides` to map exact
  provider model IDs to catalog labels, for example
  `{"openai/gpt-6-luna":"GPT 6 Luna"}`. Unlisted models retain their
  discovered names. Hand-written chat, image, and vision profiles may also
  declare `displayName`; removing a configured name restores the catalog or
  alias fallback on the next sync.
- If `modelCatalog.kinds` is omitted, the scheduler imports every model kind
  that the catalog adapter can classify and the gateway transport supports.
- Hand-written profiles in the JSON remain available when catalog sync is
  disabled. Global dynamic catalog import skips models that cannot be matched
  to LiteLLM pricing/capabilities; BYOK still allows manual unknown models.

System model:

The platform makes some model calls on its own behalf, for no team: the AI
overviews of public market entries (skills and MCP servers), with the
categories that come with them. These go through the system model (`withSystemModel` in
`src/shared/model-gateway/system-client.ts`), never through a tenant's billing.
Model calls a user triggers (titles, ingestion, retrieval) stay billed to that
user's team.

| Variable | Meaning |
|---|---|
| `SYSTEM_MODEL_ENABLED` | Strict boolean, default `false`. Only `true`, `false`, `1` or `0` (any case, surrounding whitespace ignored); any other value fails configuration loading. |
| `SYSTEM_MODEL_PROVIDER` | The `providerName` of a gateway in the global gateway config whose definition is borrowed, e.g. `openrouter`. |
| `SYSTEM_MODEL_API_KEY` | The dedicated key for these calls. |
| `SYSTEM_MODEL_NAME` | The model id at that Provider, e.g. `deepseek/deepseek-v4.1-flash`. |

- The system model is `configured` when the named Provider exists in the active
  gateway configuration, declares `chat` and `json_schema` in `supports` and
  carries no credential headers in its definition, and the key and model are
  set. It is `ready` only when it is also enabled.
- It borrows only the Provider's non-secret definition (kind, base URL, headers,
  `supports`). It never uses that Provider's `*_API_KEY` or its `*_ENABLED`
  state: a Provider disabled for GLOBAL traffic can still lend its definition,
  and an empty `SYSTEM_MODEL_API_KEY` is never replaced by the global key.
- Calls run through the same builder as tenant calls, so the endpoint policy,
  model capability rules, adapters and retries are the same. The timeout is 120
  seconds and a call is retried twice.
- A call's thinking intent (overviews ask for thinking off) is carried out with
  the model's facts from the normalized model catalog: models.dev and LiteLLM,
  plus `config/model-overrides.json` and the file at `MODEL_OVERRIDES_PATH`.
  BYOK models take their facts from the same catalog, so this works whether or
  not the Provider is ready for GLOBAL traffic. A model the catalog does not
  list fails the call before any request; declare it in the overrides. On
  OpenRouter, "off" is sent as `reasoning: { effort: "none", exclude: true }`.
- While it is not ready, overview jobs are not queued and the market admin page
  shows exactly what is missing. Nothing falls back to another key or model.
  MCP servers are filed by keyword rules when they enter the catalog, whether
  the system model is ready or not; their AI overview brings AI categories
  later, except where a market admin chose the categories.
- Structured calls use strict JSON-schema output when the borrowed Provider
  declares `json_schema_strict` (the shipped OpenRouter definition does), with
  the automatic fallback described above.
- Nothing is billed or stored: no usage ledger, no generation records. Each
  call writes one `system_model.call` log line with the purpose, subject,
  Provider, model, status, duration, input, output and reasoning token counts,
  `costUsd` and `costSource`, but never the prompt, the output or the key.
  The cost follows the same per-call rule as tenant billing: the total the
  Provider reports (`provider_actual`; an OpenRouter BYOK call counts
  OpenRouter's fee plus the upstream charge on our own key), otherwise the
  model catalog's price for the token counts plus anything already charged
  (`price_book`); a missing price leaves `costUsd` out and says so in
  `costSource`. A structured call adds `structuredOutputMechanism`
  (`json_schema_strict`, `available_tool` or `native:<method>`) and, after a
  fallback, `structuredOutputFallbackReason`. Set a
  spending limit on the dedicated key at the Provider (for OpenRouter, on the
  key itself) and read its usage there.
- Changing the key takes an environment change and a restart. A synchronized
  gateway configuration change is picked up on the next call.
- `pnpm exec tsx src/scripts/smoke-system-model.ts` makes one real
  structured-output call with the current settings and prints the readiness,
  token usage and cost, never the key.
- `pnpm exec tsx src/scripts/smoke-mcp-overview.ts <identifier> [--dry-run]`
  generates one MCP server's AI overview through the overview engine and
  prints the three locales and the classification. Without `--dry-run` it
  publishes, as a forced regeneration would.

To use another site, declare it as a custom gateway in the global gateway
config and point `SYSTEM_MODEL_PROVIDER` at it. Keep it disabled for GLOBAL
traffic and out of catalog discovery so it serves only the system model, for
example AtlasCloud:

```json
{
  "slug": "atlascloud-system",
  "providerName": "atlascloud",
  "providerKind": "openai-compatible",
  "baseUrl": "https://api.atlascloud.ai/v1",
  "apiKeyEnv": "ATLASCLOUD_API_KEY",
  "activation": {
    "env": "ATLASCLOUD_ENABLED",
    "default": false
  },
  "supports": ["chat", "json_schema"],
  "modelCatalog": {
    "enabled": false
  }
}
```

Add `json_schema_strict` to its `supports` only if the site enforces strict
JSON schemas. Then set `SYSTEM_MODEL_PROVIDER=atlascloud`, the site's model id in
`SYSTEM_MODEL_NAME` and the site's key in `SYSTEM_MODEL_API_KEY`. Leave
`ATLASCLOUD_ENABLED` unset: `ATLASCLOUD_API_KEY` and `ATLASCLOUD_ENABLED` belong
to the gateway entry and take effect only if you also want the site for tenant
traffic; the system model never reads them.
