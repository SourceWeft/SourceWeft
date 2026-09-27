# Backend

This directory contains the backend runtime for SourceWeft.

The default development and Docker runtime is Node **22.23.2**; Node **24** is
also supported. Root/backend engines accept `^22.13.0 || ^24.0.0`, and CI tests
22.23.2 and 24.18.0. See [Node runtime policy](docs/node-runtime.md).

Queue backend: BullMQ + Redis (skeleton only, minimal implementation).

Billing MVP (`pages + credits`) is backed by PostgreSQL tables managed by Drizzle.
OSS defaults enforce the configured free quota while keeping payment checkout
disabled unless `SOURCEWEFT_SAAS_ENABLED=true` and a billing provider are set.

Team subscription notes (current phase):

- Creem-backed `team_standard` subscription flow with webhook sync.
- Webhook audit trail stored in `billing_webhook_events`.
- Reconcile task auto-realigns team plans from subscription state.
- Ops alerts stored in `ops_alerts` and optionally delivered by email.

- `src/api`: HTTP API process
- `src/worker`: async job consumer process
- `src/scheduler`: timed job dispatcher process
- `src/modules`: business modules
- `src/shared`: shared backend utilities

The backend is one codebase with three runtime entry points.

Use `pnpm run dev` in this directory to start all three processes.

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

Sandbox developer notes live in
`src/modules/content/agent/sandbox/README.md`. They describe the provider-neutral
runtime model, Daytona adapter boundary, backend-provided `execute`, prepare and
collect bridge semantics, audit states, and current idempotency limitations.

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
- While it is not ready, overview jobs are not queued and the market admin page
  shows exactly what is missing. Nothing falls back to another key or model.
  MCP servers are filed by keyword rules when they enter the catalog, whether
  the system model is ready or not; their AI overview brings AI categories
  later, except where a market admin chose the categories.
- Nothing is billed or stored: no usage ledger, no generation records. Each
  call writes one `system_model.call` log line with the purpose, subject,
  Provider, model, status, duration, token counts and, when the Provider
  reports it, `costUsd`, but never the prompt, the output or the key. Set a
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

Then set `SYSTEM_MODEL_PROVIDER=atlascloud`, the site's model id in
`SYSTEM_MODEL_NAME` and the site's key in `SYSTEM_MODEL_API_KEY`. Leave
`ATLASCLOUD_ENABLED` unset: `ATLASCLOUD_API_KEY` and `ATLASCLOUD_ENABLED` belong
to the gateway entry and take effect only if you also want the site for tenant
traffic; the system model never reads them.
