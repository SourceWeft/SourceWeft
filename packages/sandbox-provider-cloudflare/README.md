# @sourceweft/sandbox-provider-cloudflare

Supplies the `cloudflare` sandbox provider to the host's sandbox runtime:
Cloudflare Sandboxes (Durable Object + container per thread sandbox) behind the
**stock** Sandbox Bridge worker. Fully open egress by default — the reason this
provider exists (Daytona Tier 1/2 enforces an allowlist that cannot be
overridden per sandbox).

Design doc: `docs/architecture/cloudflare-sandbox-provider.md` (minimal-ops
variant: no bridge fork, no custom worker code, no custom Dockerfile —
everything SourceWeft-specific lives client-side in this package).

## Enabling the provider

1. **Deploy the bridge** (once per environment, ~10 minutes; needs a Cloudflare
   account with Workers Paid, Node.js, and Docker running):

   ```sh
   pnpm --filter @sourceweft/sandbox-provider-cloudflare bridge:deploy
   ```

   Idempotent: the same command is also how you UPDATE the bridge later (it
   refreshes `@cloudflare/sandbox` in the scaffold and redeploys; URL and key
   stay stable). First run generates the API key (printed once — save it).
   Key rotation: `bridge:rotate-key`. Details: `bridge/README.md`.

2. **Point the backend at it** (`apps/backend/.env` or deployment secrets):

   ```sh
   CF_SANDBOX_BRIDGE_URL=https://cloudflare-sandbox-bridge.<subdomain>.workers.dev
   CF_SANDBOX_API_KEY=<key printed by deploy.sh>
   SOURCEWEFT_SANDBOX_PROVIDER=cloudflare
   ```

3. Restart the backend. Rollback is `SOURCEWEFT_SANDBOX_PROVIDER=daytona` —
   sandbox DB rows are provider-scoped, so switching never corrupts state.

## How it works

- **Registration.** `sourceweft.capability.json` declares the
  `sandbox_provider` host service; the backend's capability scan discovers it
  and `src/host-services.ts` returns the factory (reading only `CF_SANDBOX_*`
  names — the generic host never learns them). The factory is returned even
  when unconfigured; `getConfigurationStatus()` names what's missing.
- **Liveness is a stamp file, not an existence probe.** Cloudflare's
  `getSandbox(name)` is lazy get-or-create and never 404s, so `createSandbox`
  writes the sandbox id to `/workspace/.sourceweft-sandbox-id` and every
  get/health call reads it back. Missing or mismatched stamp (including a
  container that slept and lost its filesystem) surfaces as
  `SANDBOX_NOT_FOUND_OR_EXPIRED`, which makes the sandbox manager expire the
  DB row and recreate — the existing recovery path.
- **Execute streams SSE.** The bridge's exec endpoint emits
  `stdout`/`stderr`/`exit`/`error` events (stdout/stderr data is the raw
  base64 of the chunk); the provider accumulates output up to `maxOutputChars`
  (then keeps draining so the exit code still arrives), wraps `cwd` into the
  shell line, and aborts client-side if the stream outlives the command budget.
- **Silent-stream heartbeat.** Live-measured: an exec stream with no output
  dies between 3 and 5 minutes of silence (an intermediary drops idle
  streams); chatty streams survive the full 8-minute batch budget. Commands
  budgeted over 2 minutes are automatically wrapped with a background stderr
  heartbeat (control-marker lines the client strips), so silent long jobs
  complete instead of dying with "terminated".
- **TTL is DB-enforced.** The manager's 1h rolling `expiresAt` drives explicit
  `deleteSandbox`; Cloudflare's default ~10m idle sleep only reduces cost.

## Layout

- `src/` — the provider, factory, and host-service entry (business code).
- `bridge/` — ops-only deployment tooling for the stock bridge worker. Never
  imported by `src/`, excluded from the TypeScript project; the scaffolded
  worker directory is git-ignored.
- `tests/` — contract tests against a mock bridge (`pnpm test`).

## Verifying

```sh
pnpm --filter @sourceweft/sandbox-provider-cloudflare check-types
pnpm --filter @sourceweft/sandbox-provider-cloudflare test
curl "$CF_SANDBOX_BRIDGE_URL/health"   # after deploying
```

Live PoC gates before trusting an environment (see design doc): stamp behavior
across sleep/wake, and a 10-minute exec streaming without interruption.
