#!/usr/bin/env bash
# Rotate the bridge's SANDBOX_API_KEY. Prints the new key ONCE — update
# CF_SANDBOX_API_KEY in the backend environment and restart.
set -euo pipefail

BRIDGE_DIR="${BRIDGE_DIR:-$(dirname "$0")/sandbox-bridge}"

if [ ! -d "$BRIDGE_DIR" ]; then
  echo "ERROR: no bridge scaffold at $BRIDGE_DIR — run bridge:deploy first." >&2
  exit 1
fi

cd "$BRIDGE_DIR"
KEY="$(openssl rand -hex 32)"
printf '%s' "$KEY" | npx wrangler secret put SANDBOX_API_KEY
echo ""
echo "New key set. Update the backend env and restart:"
echo "  CF_SANDBOX_API_KEY=$KEY"
