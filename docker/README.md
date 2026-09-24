# Deploy the published image

[English](README.md) | [Simplified Chinese](README.zh-CN.md)

This is a Docker-only installation: no host Node.js, Rust, image rebuild or external
file-storage service is required. Use Docker Engine/Desktop with Compose v2.24+
and a POSIX shell (Linux/macOS or WSL). The single gateway exposes the Web and API
at one origin. PostgreSQL, Redis and the default SeaweedFS S3 service are private
Compose services with project-scoped persistent volumes.

## Fresh installation

Download the `sourceweft-selfhost-vX.Y.Z.tar.gz` asset from the chosen GitHub
Release and extract it. It contains this `docker/` directory. Alternatively,
checkout the same release tag in Git; do not mix main's Compose with an older image.
Run from the directory containing `docker/`:

```sh
VERSION=v0.3.0-rc.2 # replace with the release you downloaded
IMAGE=ghcr.io/sourceweft/sourceweft:$VERSION
docker run --rm --user "$(id -u):$(id -g)" --entrypoint node \
  -e SOURCEWEFT_IMAGE="$IMAGE" -v "$PWD/docker:/config" "$IMAGE" \
  /app/docker/init-config.mjs /config
docker compose --env-file docker/.env -f docker/docker-compose.yml up -d --wait --wait-timeout 300
```

The initializer writes `.env` with independent random database, storage, auth and
encryption secrets. It refuses to overwrite an existing `.env`. Do not run it on
an existing installation and do not rotate the model encryption secret casually.

Open **http://localhost:3000**, register and sign in. The migration and bucket
initialization must finish before the API/worker start. This starts the application
without mail/OAuth/payment/model accounts. To use chat and embedding-dependent
indexing, configure a model provider (for example OPENROUTER_ENABLED plus its key)
or an authorized BYOK model. Missing models are not silently substituted.
The private upload bucket is separate from the optional PUBLIC_S3_* bucket used
for public blog assets.

## Change address or port

Edit `docker/.env`, then repeat the same `up` command. No image rebuild is needed.

```dotenv
WEB_PORT=8080
# Blank means http://localhost:WEB_PORT. For access by hostname/IP, set its origin:
PUBLIC_WEB_BASE_URL=https://notes.example.com
# Leave blank to use the same origin; set only for an explicitly separate API.
PUBLIC_API_BASE_URL=
```

Only the gateway port is published. An external HTTPS proxy can forward to it;
keep the public URL consistent with the browser's origin. SSE buffering is disabled
and WebSocket Upgrade is forwarded by the bundled gateway. `INTERNAL_API_BASE_URL`
is `http://api:3001` inside the Web container, independently of public addresses.

## Optional services

- External S3: set `COMPOSE_PROFILES=` to disable bundled storage, set `S3_ENDPOINT`,
  `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and path-style
  policy. Set `S3_CREATE_BUCKET=false` for a pre-created bucket. Initialization
  verifies it and fails explicitly if missing or unauthorized.
- `SOURCE_UPLOAD_MODE=proxy` is the default: upload, source preview and download go
  through the API. Direct mode requires a browser-reachable S3 endpoint and bucket
  CORS. Both modes require a private bucket.
- External PostgreSQL: set a complete `DATABASE_URL` and stop/override the bundled
  Postgres service only after explicitly arranging that external dependency. In
  the default stack, leave DATABASE_URL blank: the entrypoint URL-encodes DB_*.
  DB_* initializes a fresh database; rotating an existing database password also
  requires changing the database role password, not only the environment file.
- OAuth, mail, public blog storage, OCR, sandbox and commercial billing are opt-in;
  their variables are documented in `.env.example`. Public Google One Tap settings
  use `PUBLIC_GOOGLE_ONE_TAP_*` and are injected at runtime.
- Web search/fetch uses `ANYCRAWL_API_KEY`. Without it, ordinary model chat remains
  available; explicit web-tool invocations report an unconfigured provider.

## Inspect, stop and restart

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yml ps -a
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail=100 migrate storage-init api worker
curl -f http://localhost:3000/v1/health
docker compose --env-file docker/.env -f docker/docker-compose.yml down
# Repeat up to restart; data volumes remain.
```

`down` keeps data. **`down -v` deletes this instance's data** and is only for an
explicit disposable reset. Health HTTP 200 is not a replacement for testing a
login, file upload and model response.

## Upgrade

1. Stop writes and back up PostgreSQL plus the S3 volume using your normal snapshot
   tooling; preserve `.env` and the encryption secret with the backup.
2. Download the matching new release's Compose files. Preserve the existing `.env`;
   compare new `.env.example` entries instead of regenerating it.
3. Change SOURCEWEFT_IMAGE to the exact new tag, run `docker compose ... pull`, then
   the same `up -d --wait` command. Migration failure blocks API startup; inspect its
   logs before proceeding.
4. Verify login, existing files and chats. If reverting after a schema migration,
   restore the compatible database/storage backup along with the previous image.
   Merely downgrading the image is not a database rollback.

## Existing fixed volumes

Older Compose used `sourceweft-postgres` and `sourceweft-redis`. To retain those
volumes explicitly during upgrade, add the supplied override to **every** command:

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yml \
  -f docker/compose.legacy-volumes.yml up -d --wait
```

That override declares the old volumes external and fails if they do not exist.
Do not use it for a fresh installation or a second instance. New instances can
use `-p another-instance`, a separate config directory and another WEB_PORT; their
volumes will remain independent.

## Automated contract

CI builds the universal image, initializes the shipped template, starts the real
Compose stack with fresh project volumes, and tests registration/login, private
file ingestion/download, chat streaming/cancellation and restart on another port.
The model is an explicitly declared test-only OpenAI-compatible fixture; auth,
PostgreSQL, Redis, S3, gateway and application services are real. This is not a
claim of testing an external model provider's quality.
