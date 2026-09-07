# MCP in private deployments

`MCP_ALLOWED_INTERNAL_ORIGINS` controls access to internal MCP and OAuth services in production, test and every mode except explicit `NODE_ENV=development`.

## Local development

The backend dev commands set `NODE_ENV=development`. In this mode, endpoint prechecks skip DNS and address restrictions, allowing local HTTP services, private addresses and proxy fake IPs without an origin allowlist or changes to Clash. Actual connections still use system DNS and report connection failures. Saving, testing and invoking MCP installations, OAuth discovery/registration/token requests and HTTP/SSE transports all use this same mode.

URL syntax, HTTP(S)-only protocols, credentialed-URL rejection, TLS verification, cross-origin redirect protection and user/workspace authorization remain active. Production, test, an omitted NODE_ENV and other values use the strict rules below.

## Strict address policy

Set a JSON array of exact origins in the backend environment, or in `docker/.env` when using the shipped Compose file:

```dotenv
MCP_ALLOWED_INTERNAL_ORIGINS='["http://mcp-service:8080","https://sso.internal"]'
```

Each entry contains a scheme, hostname and optional port. Do not include `/mcp`, `/v1`, query strings, credentials or wildcard hosts. An empty array permits public HTTPS only. Invalid configuration fails startup without printing the raw value.

An explicitly listed origin can resolve to RFC1918, carrier-grade private IPv4 or unique-local IPv6 addresses. HTTP is allowed only for a listed origin. For a loopback service, list its localhost or literal loopback origin directly; allowing an unrelated hostname does not let it resolve to loopback. Link-local, cloud metadata, multicast and unspecified addresses remain blocked. This is an endpoint permission, not an unrestricted private-network switch.

`localhost` means the backend process or container, not the browser's computer. With Docker, use the MCP service name or a host address reachable from the backend container. Use deployment-level CA trust for private HTTPS certificates; do not disable TLS verification.

## Authentication

Network permission does not enable an installation or configure its credentials. MCP installations still use their enabled state and workspace permissions. Bearer tokens, API keys/custom headers and OAuth credentials belong to the invoking user and remain encrypted at rest.

OAuth discovery, registration, token exchange, callback completion and runtime refresh use the same network policy as tool requests. If internal MCP and authorization services use different origins, list both. Existing pre-registered OAuth clients can be configured using `MCP_OAUTH_CLIENTS`; `MCP_OAUTH_REDIRECT_URL` defaults to the API base URL plus `/v1/mcp/oauth/callback` and must be registered with the authorization service. The user's browser must be able to reach the authorization page and callback.

Requests bind approved DNS answers to their sockets. Same-origin redirects are checked and limited to three; cross-origin redirects are rejected so custom headers or request bodies cannot carry credentials to a different host. Configure the final endpoint URL instead. Separate OAuth requests to an allowed issuer are supported.

`http_sse_compat` retains its explicit legacy compatibility behavior: an HTTP 4xx can try SSE at the original URL and then the existing `/mcp` → `/sse` path. `streamable_http` never automatically selects SSE. A network-policy rejection stops the operation and cannot trigger compatibility fallback.

## Upgrade note

Local dev commands now relax address restrictions automatically. Production and test deployments still need explicit origins for internal MCP/OAuth services. Invalid origin configuration is rejected in every mode. MCP origins do not authorize BYOK/LLM endpoints under strict policy; see [LLM network access](llm-network.md) for that separate origin list. Neither list changes GLOBAL Provider activation or supplies credentials.
