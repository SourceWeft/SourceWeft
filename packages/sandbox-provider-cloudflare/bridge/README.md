# Sandbox Bridge deployment (ops-only)

This directory holds the deployment tooling for the **stock** Cloudflare
Sandbox Bridge worker the `cloudflare` sandbox provider talks to. Nothing here
is imported by business code — `src/` never references this directory, and it
is excluded from the package's TypeScript project.

Design: docs/architecture/cloudflare-sandbox-provider.md (minimal-ops variant —
no fork, no custom worker code, no custom Dockerfile).

Prerequisites: Node.js + npm, Docker running, a Cloudflare account with
Workers Paid ($5/mo).

## The two commands

```sh
pnpm --filter @sourceweft/sandbox-provider-cloudflare bridge:deploy
pnpm --filter @sourceweft/sandbox-provider-cloudflare bridge:rotate-key
```

**`bridge:deploy` is idempotent — it is both the first deployment AND the
update command.**

- First run: scaffolds the unmodified `cloudflare/sandbox-sdk/bridge/worker`
  template into `./sandbox-bridge/` (git-ignored), opens Cloudflare auth if
  needed, generates the `SANDBOX_API_KEY` secret (printed once — save it), and
  deploys. It prints the backend env vars to set:

  ```sh
  CF_SANDBOX_BRIDGE_URL=https://cloudflare-sandbox-bridge.<subdomain>.workers.dev
  CF_SANDBOX_API_KEY=<generated key>
  SOURCEWEFT_SANDBOX_PROVIDER=cloudflare
  ```

- Later runs (= updating the bridge): updates `@cloudflare/sandbox` in the
  scaffold and redeploys. The API key and URL are untouched, so the backend
  needs no changes. Fold this into the regular dependency-upgrade cadence.

**`bridge:rotate-key`** sets a fresh `SANDBOX_API_KEY` and prints it once;
update `CF_SANDBOX_API_KEY` in the backend environment and restart.

Verify a deployment with `curl "$CF_SANDBOX_BRIDGE_URL/health"`.

## Rollback to Daytona

Set `SOURCEWEFT_SANDBOX_PROVIDER=daytona` and restart the backend. Sandbox DB
rows are provider-scoped, so switching never corrupts state — the other
provider's rows simply age out.
