# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.23.2
# Commit this image was built from. The Web build inlines it into the client
# bundle; the backend reads it at runtime from its health endpoint.
ARG BUILD_SHA=""
ARG BUILD_TIME=""

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
# Compose starts pnpm as sourceweft. Share the package-manager cache prepared
# during the root build so startup does not download pnpm again.
ENV COREPACK_HOME=/pnpm/corepack
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /app
RUN apk add --no-cache libc6-compat libstdc++ \
  && corepack enable \
  && corepack prepare pnpm@10.19.0 --activate \
  && chmod -R a+rX "${COREPACK_HOME}"

# Build the maintained AnyDoc binding for the actual container architecture.
# Rust is confined to this build stage; runtime never downloads or compiles it.
FROM rust:1.94.1-alpine AS rust-toolchain
FROM base AS anydoc-native
ENV RUSTUP_HOME=/usr/local/rustup \
  CARGO_HOME=/usr/local/cargo \
  RUSTUP_TOOLCHAIN=1.94.1
# Node loads a shared NAPI module; musl must not use Rust default static CRT.
ENV RUSTFLAGS="-C target-feature=-crt-static"
ENV PATH="/usr/local/cargo/bin:${PATH}"
RUN apk add --no-cache build-base
COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
COPY packages/anydoc /app/packages/anydoc
ARG TARGETARCH
RUN --mount=type=cache,id=sourceweft-anydoc-registry,target=/usr/local/cargo/registry,sharing=locked \
  --mount=type=cache,id=sourceweft-anydoc-git,target=/usr/local/cargo/git,sharing=locked \
  --mount=type=cache,id=sourceweft-anydoc-target-${TARGETARCH},target=/app/anydoc-target,sharing=locked \
  CARGO_TARGET_DIR=/app/anydoc-target node /app/packages/anydoc/scripts/build-native.cjs

# ── Prune ────────────────────────────────────────────────────────────
# turbo prune generates out/json/ (package.json manifests) and
# out/full/ (complete source tree for only the target packages and
# their workspace dependencies). No manual package list required.
FROM base AS pruner
COPY . .
# Exclude the test-only pristine oracle before source reaches runtime COPY layers.
RUN pnpm dlx turbo@2.10.9 prune @sourceweft/backend web --docker \
  && rm -rf out/full/packages/security-braces/tests out/full/packages/security-braces/upstream-test \
    out/full/packages/anydoc/upstream out/full/packages/anydoc/tests out/full/packages/anydoc/scripts \
  && node scripts/editions/copy-licenses.mjs /app/out/full

# ── Deps ─────────────────────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache make g++ python3
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml .
RUN pnpm install --frozen-lockfile

# ── Builder ──────────────────────────────────────────────────────────
# Public deployment settings are injected by the Web server at runtime.
# This image deliberately has no publisher-specific NEXT_PUBLIC_* build args;
# the build-provenance args below describe the image itself, not its publisher.
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=pruner /app/out/full/ .
COPY --from=anydoc-native /app/packages/anydoc/native /app/packages/anydoc/native
RUN pnpm --filter @sourceweft/market-contracts build
RUN pnpm --filter @sourceweft/ui-web build
# Declared after the package builds so a new commit does not invalidate their cache.
ARG BUILD_SHA
ARG BUILD_TIME
ENV NEXT_PUBLIC_BUILD_SHA=${BUILD_SHA} \
  NEXT_PUBLIC_BUILD_TIME=${BUILD_TIME}
RUN --mount=type=cache,id=sourceweft-next-cache,target=/app/apps/web/.next/cache,sharing=locked \
  pnpm --filter web build
# The backend build runs tsc over the whole workspace graph; the default heap
# ceiling OOMs on CI runners (exit 134).
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @sourceweft/backend build
RUN find . -name ".turbo" -type d -prune -exec rm -rf '{}' + \
  && rm -rf apps/web/.next/cache

# ── Runner ───────────────────────────────────────────────────────────
FROM base AS runner
ARG BUILD_SHA
ENV BUILD_SHA=${BUILD_SHA}
ENV NODE_ENV=production
ENV SOURCEWEFT_COMMERCIAL_ENABLED=false
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV BACKEND_API_PORT=3001
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml .
RUN apk add --no-cache --virtual .runtime-build-deps make g++ python3 \
  && pnpm install --filter @sourceweft/backend... --frozen-lockfile --prod=false \
  && apk del .runtime-build-deps
RUN addgroup -S sourceweft \
  && adduser -S sourceweft -G sourceweft

# Pruned workspace source tree (packages needed at runtime for pnpm workspace resolution).
# turbo prune already limits this to @sourceweft/backend, web, and their dependencies.
COPY --chown=sourceweft:sourceweft --from=pruner /app/out/full/ .
COPY --chown=sourceweft:sourceweft --from=anydoc-native /app/packages/anydoc/native packages/anydoc/native
# The pristine upstream oracle is test-only and must not ship as runtime code.
RUN rm -rf packages/security-braces/tests packages/security-braces/upstream-test

# Overlay built artifacts from builder (supersedes source files where applicable)
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/web/.next/standalone web-standalone
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/web/.next/static web-standalone/apps/web/.next/static
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/web/public web-standalone/apps/web/public
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/backend/dist apps/backend/dist
COPY --chown=sourceweft:sourceweft --from=builder /app/packages/market-contracts/dist packages/market-contracts/dist

COPY docker/runtime-entrypoint.mjs docker/init-config.mjs /app/docker/
ENTRYPOINT ["node", "/app/docker/runtime-entrypoint.mjs"]

USER sourceweft
EXPOSE 3000 3001
CMD ["node", "/app/web-standalone/apps/web/server.js"]
