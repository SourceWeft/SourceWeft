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

## Capacity

The stock template ships `max_instances: 3`. Each chat thread that uses the
sandbox holds one container for up to an hour, so that is three such
conversations at once; the next is told the sandbox is unavailable (the bridge
answers `503 … instance limit reached (3/3)`).

`deploy.sh` sets `max_instances` — and the warm pool's
`WARM_POOL_MAX_INSTANCES`, which must match — from the `MAX_INSTANCES` constant
near its end (currently 50) on every run, so a fresh scaffold cannot fall back
to 3. To change capacity, edit that constant and run `bridge:deploy`. The
Cloudflare account ceiling is far above this (6 TiB memory / 1,500 vCPU
concurrently, i.e. 1,500+ `standard-1` instances), and billing is for container
running time, not for the configured maximum.

### When the image cannot be built

`bridge:deploy` builds the container image with the local Docker daemon, which
must reach Docker Hub. If it cannot (a proxy that covers the host but not the
Docker VM is the usual cause), the run fails at "Building image" — AFTER the
Worker script has already been uploaded, so the Worker is on the new SDK while
the container stays as it was. Fix the network and run it again.

Capacity alone does not need a build. Point `image` at the image that is
already live and deploy that config; only `max_instances` changes:

```sh
cd bridge/sandbox-bridge
npx wrangler containers list                 # application id
npx wrangler containers info <id>            # its "image": registry.cloudflare.com/…@sha256:…
# copy wrangler.jsonc, replace "image": "./Dockerfile" with that reference, then:
npx wrangler deploy --config <the copy>      # --dry-run first
```

A new ceiling took a few minutes to be honoured after such a deploy; until
then the bridge still answered "instance limit reached (3/3)".

## Rollback to Daytona

Set `SOURCEWEFT_SANDBOX_PROVIDER=daytona` and restart the backend. Sandbox DB
rows are provider-scoped, so switching never corrupts state — the other
provider's rows simply age out.
