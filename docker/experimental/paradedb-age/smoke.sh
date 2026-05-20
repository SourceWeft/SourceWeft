#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

IMAGE_TAG="${IMAGE_TAG:-sourceweft/paradedb-age:poc-pg17-age1.7.0}"
CONTAINER_NAME="${CONTAINER_NAME:-sourceweft-paradedb-age-smoke}"
POSTGRES_PORT="${POSTGRES_PORT:-55432}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-sourceweft}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-postgres}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for the ParadeDB + AGE smoke test." >&2
  exit 127
fi

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}

trap cleanup EXIT

cleanup

docker build \
  -f "${SCRIPT_DIR}/Dockerfile" \
  -t "${IMAGE_TAG}" \
  "${REPO_ROOT}"

docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -e "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
  -e "POSTGRES_USER=${POSTGRES_USER}" \
  -e "POSTGRES_DB=${POSTGRES_DB}" \
  -p "127.0.0.1:${POSTGRES_PORT}:5432" \
  "${IMAGE_TAG}" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "${CONTAINER_NAME}" pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "${ready}" != "1" ]]; then
  echo "Postgres did not become ready in ${CONTAINER_NAME}." >&2
  exit 1
fi

docker exec -i "${CONTAINER_NAME}" \
  psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  < "${SCRIPT_DIR}/smoke.sql"
