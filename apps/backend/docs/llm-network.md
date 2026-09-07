# LLM network access for private deployments

Local and internal model services can use the existing authenticated
OpenAI-compatible, Azure OpenAI, Anthropic and native Gemini adapters.
Deployment-owned OpenAI-compatible chat and embedding services can also operate
without authentication. Network permission, Provider activation and credentials
are separate controls.

## Local development

The backend's `dev:api`, `dev:worker` and `dev:scheduler` commands set
`NODE_ENV=development`. In that explicit mode, endpoint prechecks skip DNS and
address restrictions: local HTTP services, private addresses and proxy fake IPs
(including Clash's `198.18.*` answers) can use the existing transport without
changing the proxy configuration or adding internal origins. Connections still
use system DNS, and DNS/connection failures remain errors.

`production`, `test`, an omitted `NODE_ENV` and every other value retain the
strict address policy described below. There is no additional environment
switch. URL syntax, HTTP(S)-only protocols, credentialed-URL rejection, TLS
verification and cross-origin redirect protection remain active in both modes.
Provider activation, credentials and BYOK authorization are unchanged.

## Allow an endpoint

These origin restrictions apply when the strict address policy is enabled.

For a deployment-owned System Provider, its declared `baseUrl` / `baseUrlEnv`
already authorizes that exact origin. For example, a custom global gateway with
`baseUrl: "http://model-service:8000/v1"` needs no duplicate network allowlist
entry. Keep its `activation` and declared credential environment variables in
the gateway configuration. An API key alone never activates a Provider.

For user-entered BYOK endpoints, add extra permitted origins to the backend
environment, or to `docker/.env` when using Compose:

```dotenv
LLM_ALLOWED_INTERNAL_ORIGINS='["http://model-service:8000","https://llm.internal","http://127.0.0.1:11434"]'
```

The value is a JSON array of exact origins (scheme, host, port). Do not include
`/v1`, credentials, query strings or wildcards. Invalid values fail config
loading. The default is `[]`. MCP uses its own `MCP_ALLOWED_INTERNAL_ORIGINS`;
neither list authorizes the other subsystem. Restart API, worker and scheduler
after changing deployment environment variables; Compose passes the same value
to all three.

BYOK may reuse an active configuration version's System endpoint even when
that Provider is disabled for GLOBAL routing. It still requires an active,
authorized database BYOK credential/model and successful credential decryption.
System activation and global keys cannot satisfy BYOK. Overriding a BYOK
endpoint to a different origin requires that destination's own permission.

`localhost` and `127.0.0.1` refer to the backend process/container, not the
browser's computer. In Docker, use a service name on the backend's network or
a host address reachable from that container. Host aliases vary by platform.
For private HTTPS certificates, configure Node's deployment trust store (for
example `NODE_EXTRA_CA_CERTS`); certificate verification stays enabled.

## Request enforcement

Public HTTPS is allowed by default. Explicit origins also permit HTTP and
private service addresses. An exact loopback origin must explicitly name
localhost or a loopback IP. Metadata/link-local, unspecified, multicast and
other reserved addresses remain blocked, even when an origin is listed.

Validation applies when BYOK endpoints are saved and used, and again when
opening network connections for model calls, catalog discovery and supported
cost receipts. DNS addresses checked by the policy are passed to the socket's
lookup callback; a prior successful check cannot authorize later DNS rebinding.

Same-origin redirects are limited to three hops. Cross-origin redirects are
rejected even if both destinations are permitted, so credentials, custom headers
and request bodies cannot cross an origin through a redirect. Configure the
final API endpoint directly when a service redirects to another origin.

Transport policy errors retain their `POLICY` classification through SDK error
wrapping and do not trigger gateway Provider failover. The SDK caller stops
policy refusals and cancellation immediately, even when retries are enabled.
Ordinary errors retain the SDK's status/quota rules. Request timeout and retry
options now take precedence over Provider settings, then gateway defaults.
See [failure and request-option semantics](model-failure-semantics.md).

Each HTTP response owns its connection scope until EOF, cancellation or failure.
Bodies remain streaming and are not copied by this network wrapper. Connections
are not pooled across separate HTTP requests on this path, which can add TLS
handshake overhead. Embedding observation reads only the SDK's parsed usage and
request IDs; see [embedding usage observation](embedding-index-safety.md#usage-observation).

## A local System Provider without authentication

Add an entry to your custom global gateway configuration, for example:

```json
{
  "slug": "local-model",
  "providerName": "local-model",
  "providerKind": "openai-compatible",
  "baseUrl": "http://model-service:8000/v1",
  "activation": { "env": "LOCAL_LLM_ENABLED", "default": false },
  "supports": ["chat", "embeddings", "tool_calling"],
  "modelCatalog": { "enabled": false }
}
```

Set `LOCAL_LLM_ENABLED=true` in the backend environment (or `docker/.env` with
Compose), and configure your chat/embedding profiles to use this gateway and the
actual model IDs served by that endpoint. Declare only capabilities the service
supports. Point `MODEL_GATEWAY_GLOBAL_CONFIG_PATH` to the complete custom config
file; API, worker and scheduler need the same file and environment.

**Omit `apiKeyEnv` for a service that has no authentication.** There is no separate
no-auth env switch. A declared key that is absent still makes the Provider not
configured/not ready; it does not select this path. `apiKeyEnv: null`, blank
strings and invalid environment variable names fail config loading. Names use
uppercase letters, digits and underscores, and cannot start with a digit. Activation
continues to control whether GLOBAL traffic is enabled. Do not provide a dummy
key. Other Provider kinds retain their existing credential requirements.

The SDK receives explicit absent credentials, organization and project values.
The OpenAI SDK adapters ignore `OPENAI_CUSTOM_HEADERS`; configure non-secret
headers explicitly on the Provider instead. No-auth Providers reject explicit
credential headers. Use `apiKeyEnv` and, if needed, `apiKeyHeaderName` for an
authenticated service. BYOK still requires an authorized encrypted database
credential, even when its System definition is disabled or has no global key.
BYOK refuses a System definition with credential headers instead of forwarding
those headers over the user's key.

For models missing from the capability/pricing registry, configure explicit
profiles and appropriate manual pricing. The generic `/models` discovery path
does not invent capabilities or prices for unknown local model IDs. Static
profiles with manual pricing do not need remote catalog discovery. Local
deployment does not itself change the application's billing policy.

This path uses a fixed `openai@6.49.0` patch for explicit no-auth construction
and header validation, plus isolation from ambient custom headers. LangChain
continues to own request conversion, tools, streaming, retries and embeddings.
Keep the patch and version pin when deploying; see [patch maintenance](../../../patches/README.md).

## Current adapter limits

- OpenAI-compatible adapters (including OpenRouter, DeepInfra, DeepSeek,
  Cloudflare and SiliconFlow), Azure OpenAI and Anthropic use the supplied
  transport. Only capabilities already supported by each adapter are available.
- Native Gemini chat, streaming, tool calls and embeddings use the supplied
  transport through fixed patches to `@langchain/google-genai@2.2.0` and
  `@google/generative-ai@0.24.1`. The original protocol is retained, including
  cached-content transport settings. Embedding failures now throw instead of
  yielding empty vectors. Keep both patches when installing or deploying, and
  review them before changing either version. See [patch maintenance](../../../patches/README.md).
- Unauthenticated System chat/embedding is supported for the explicit
  `openai-compatible` kind. Vendor-specific adapters such as Azure, Anthropic
  and Gemini still require their supported authentication. Missing credentials
  cannot silently switch protocols or use another Provider.
- Azure adapters retain their existing API-version environment configuration.
  Endpoint and deployment/model names come from the selected target; embedding
  now uses the installed SDK's supported BasePath/ApiDeploymentName fields.

Changing a local embedding model also requires an explicit index rebuild when
vectors exist; see [embedding index safety](embedding-index-safety.md).
