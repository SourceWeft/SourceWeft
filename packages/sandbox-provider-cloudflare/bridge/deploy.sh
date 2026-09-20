#!/usr/bin/env bash
# Deploy (or update) the STOCK Cloudflare Sandbox Bridge worker that the
# `cloudflare` sandbox provider talks to.
#
# Ops-only: this script is not imported by any business code. It scaffolds the
# unmodified `cloudflare/sandbox-sdk/bridge/worker` template into a local
# working directory (default: ./sandbox-bridge, git-ignored), generates the
# API key on first run, and deploys to the Cloudflare account you are logged
# into with wrangler.
#
# Prerequisites: Node.js + npm, Docker running (the template builds a container
# image on deploy), a Cloudflare account with Workers Paid.
#
# Usage:
#   ./deploy.sh            # first run: scaffold + key + deploy; later runs: update + redeploy
#   BRIDGE_DIR=~/cf-bridge ./deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
BRIDGE_DIR="${BRIDGE_DIR:-$SCRIPT_DIR/sandbox-bridge}"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker must be installed and running (the bridge template builds its container image locally)." >&2
  exit 1
fi

if [ ! -d "$BRIDGE_DIR" ]; then
  echo "==> Scaffolding stock bridge template into $BRIDGE_DIR"
  npm create cloudflare@latest -- "$BRIDGE_DIR" \
    --template=cloudflare/sandbox-sdk/bridge/worker \
    --no-deploy --no-git
else
  echo "==> Existing bridge directory found; updating @cloudflare/sandbox"
  # create-cloudflare scaffolds with whatever package manager invoked it, so
  # match the scaffold's lockfile — npm crashes on a pnpm-shaped node_modules.
  if [ -f "$BRIDGE_DIR/pnpm-lock.yaml" ]; then
    (cd "$BRIDGE_DIR" && pnpm update @cloudflare/sandbox)
  elif [ -f "$BRIDGE_DIR/yarn.lock" ]; then
    (cd "$BRIDGE_DIR" && yarn upgrade @cloudflare/sandbox)
  else
    (cd "$BRIDGE_DIR" && npm update @cloudflare/sandbox)
  fi
fi

cd "$BRIDGE_DIR"

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "==> Not logged in to Cloudflare; opening browser auth"
  npx wrangler login
fi

if ! npx wrangler secret list 2>/dev/null | grep -q SANDBOX_API_KEY; then
  echo "==> Generating SANDBOX_API_KEY (shown ONCE below — store it in the backend env as CF_SANDBOX_API_KEY)"
  KEY="$(openssl rand -hex 32)"
  printf '%s' "$KEY" | npx wrangler secret put SANDBOX_API_KEY
  echo ""
  echo "    CF_SANDBOX_API_KEY=$KEY"
  echo ""
else
  echo "==> SANDBOX_API_KEY already set (rotate with: openssl rand -hex 32 | npx wrangler secret put SANDBOX_API_KEY)"
fi

# ── Inject the SourceWeft custom image over the stock scaffold ──────────────
# The scaffold is stock cloudflare/sandbox (bare Debian, no Node/pnpm/Python).
# Overwrite its Dockerfile with our version-controlled one and drop in the
# base-provisioning script it COPYs — the SAME script the Daytona image uses,
# so both providers build an identical base environment. wrangler.jsonc already
# points image: "./Dockerfile", so this is all that's needed.
echo "==> Injecting SourceWeft custom image (Dockerfile + install-base.sh)"
cp "$SCRIPT_DIR/Dockerfile" "$BRIDGE_DIR/Dockerfile"
# The Worker talks to the control plane inside the container, so the container
# base must be the SAME release as the @cloudflare/sandbox SDK the Worker is
# built with. This script updates the SDK above; a base tag fixed in the
# Dockerfile would fall behind it on every run. The tag in the repo's Dockerfile
# is only the default for building it by hand.
SDK_VERSION="$(node -p "require('$BRIDGE_DIR/node_modules/@cloudflare/sandbox/package.json').version")"
echo "==> Matching the container base to @cloudflare/sandbox $SDK_VERSION"
perl -pi -e 's#^(FROM docker\.io/cloudflare/sandbox:)\S+#${1}'"$SDK_VERSION"'#' "$BRIDGE_DIR/Dockerfile"
grep -q "^FROM docker.io/cloudflare/sandbox:$SDK_VERSION\$" "$BRIDGE_DIR/Dockerfile" \
  || { echo "ERROR: could not set the container base version in Dockerfile" >&2; exit 1; }
cp "$REPO_ROOT/docker/sourceweft-sandbox/install-base.sh" "$BRIDGE_DIR/install-base.sh"
cp -R "$REPO_ROOT/docker/sourceweft-sandbox/html-runtime" "$BRIDGE_DIR/"
# The stock template may ship a restrictive .dockerignore (e.g. `*` + !Dockerfile);
# make sure our COPYd script is not excluded from the build context.
if [ -f "$BRIDGE_DIR/.dockerignore" ]; then
  grep -qxF '!install-base.sh' "$BRIDGE_DIR/.dockerignore" \
    || printf '\n!install-base.sh\n' >> "$BRIDGE_DIR/.dockerignore"
  printf '\n!html-runtime/\n!html-runtime/**\n' >> "$BRIDGE_DIR/.dockerignore"
fi

# ── Capacity ────────────────────────────────────────────────────────────────
# The stock template ships max_instances: 3. Each chat thread that uses the
# sandbox holds one container for up to an hour, so 3 means the fourth such
# conversation is told the sandbox is unavailable. The account ceiling is far
# higher (1,500+ standard-1 instances) and billing is for running time, not for
# this number. The warm pool is told the same ceiling so it plans against it
# instead of learning it from capacity errors.
MAX_INSTANCES=50
echo "==> Setting container capacity (max_instances=$MAX_INSTANCES)"
perl -0pi -e 's/("max_instances"\s*:\s*)\d+/${1}'"$MAX_INSTANCES"'/; s/("WARM_POOL_MAX_INSTANCES"\s*:\s*")\d+(")/${1}'"$MAX_INSTANCES"'${2}/' wrangler.jsonc
grep -q "\"max_instances\"[[:space:]]*:[[:space:]]*$MAX_INSTANCES" wrangler.jsonc \
  || { echo "ERROR: could not set max_instances in wrangler.jsonc" >&2; exit 1; }

echo "==> Deploying"
npx wrangler deploy

echo ""
echo "Done. Backend env vars to set:"
echo "  CF_SANDBOX_BRIDGE_URL=<the workers.dev URL printed by the deploy above>"
echo "  CF_SANDBOX_API_KEY=<the key printed on first run>"
echo "  SOURCEWEFT_SANDBOX_PROVIDER=cloudflare"
echo ""
echo "Verify: curl \"\$CF_SANDBOX_BRIDGE_URL/health\""
