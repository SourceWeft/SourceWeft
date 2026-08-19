# Auth first-load recovery design

## Context

On the first development-mode load of a cold dashboard route, Next.js may run a
Fast Refresh while client effects are mounting. Browser diagnostics showed the
first Google One Tap runtime-config request being aborted and the next request
succeeding. The dashboard session fallback currently treats a failed initial
session fetch like an anonymous session, then lets a transport exception from
`getSession()` escape as an unhandled rejection. A manual refresh remounts the
flow after compilation has settled.

## Decision

Keep the backend, Better Auth configuration, and cross-origin API topology
unchanged. Make dashboard session confirmation resilient to transient client
fetch interruption, and avoid starting Google One Tap configuration work on
routes where One Tap cannot be shown.

The dashboard confirmation flow will use a small, independently tested helper
with four outcomes:

- `authenticated`: a successful response contains a session or user.
- `anonymous`: the configured number of consecutive successful responses are
  all sessionless.
- `unavailable`: the attempt budget is exhausted by thrown transport errors or
  Better Auth response errors before anonymity is confirmed.
- `cancelled`: the owning effect was cleaned up while confirmation was running.

Thrown failures and returned `{ error }` values are equivalent transient
failures. They use bounded exponential backoff. A transient failure resets the
consecutive-anonymous counter, so an interrupted sequence cannot redirect a
possibly authenticated user. Only the `anonymous` outcome redirects to sign-in.
The `authenticated` outcome refetches the shared Better Auth session atom. The
`unavailable` outcome remains on the dashboard loading shell and schedules a
low-frequency new confirmation cycle; it never redirects. The component-level
promise also has a final rejection handler so no path can produce an unhandled
rejection.

## Alternatives considered

1. Configure retries globally on `authClient`. Rejected because the client also
   performs state-changing authentication operations whose retry safety differs,
   and it would not cover the raw One Tap config fetch.
2. Proxy all authentication through the Next.js origin or move dashboard auth
   confirmation to SSR. Rejected for this fix because it changes deployment and
   cookie topology while a request can still be interrupted during development
   remounts.
3. Delay web startup until backend health is ready. Rejected as the primary fix
   because the reported failure happens on first cold route compilation even
   when the API is already healthy.

## Google One Tap

The runtime-config effect will check the current pathname before fetching. It
will run only on `/` and `/auth/sign-in`, reset its local runtime state on other
paths, and include the pathname in its dependencies so navigation starts or
cancels the work correctly. Its existing AbortController remains responsible
for expected Strict Mode and navigation cleanup.

## Verification

Unit tests will cover:

- thrown transport failures followed by an authenticated response;
- returned Better Auth errors followed by recovery;
- consecutive successful empty responses producing `anonymous`;
- mixed empty responses and transport failures not prematurely producing
  `anonymous`;
- exhausted transient failures producing `unavailable` without rejection;
- cancellation during retry;
- pathname gating for Google One Tap runtime configuration.

Targeted Vitest, web type checking, and linting will run after implementation.
A browser cold-load check will verify that Dashboard emits no One Tap config
request and that no auth-related unhandled rejection is logged.

## Scope

This change does not alter backend startup ordering, authentication cookies,
trusted origins, sign-in behavior, or production deployment routing. It does not
add a global fetch fallback.
