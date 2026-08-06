# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=20.19.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /app
RUN apk add --no-cache libc6-compat libstdc++ \
  && corepack enable \
  && corepack prepare pnpm@10.19.0 --activate

# ── Prune ────────────────────────────────────────────────────────────
# turbo prune generates out/json/ (package.json manifests) and
# out/full/ (complete source tree for only the target packages and
# their workspace dependencies). No manual package list required.
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @sourceweft/backend web --docker

# ── Deps ─────────────────────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache make g++ python3
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml .
RUN pnpm install --frozen-lockfile

# ── Builder ──────────────────────────────────────────────────────────
# NOTE: NEXT_PUBLIC_* ARGs are inlined into the JS bundle at build time.
# Changing them at container runtime has no effect; rebuild the image instead.
# See https://nextjs.org/docs/app/building-your-application/configuring/environment-variables
FROM deps AS builder
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ARG NEXT_PUBLIC_WEB_BASE_URL=http://localhost:3000
ARG NEXT_PUBLIC_GOOGLE_ONE_TAP_ENABLED=false
ARG NEXT_PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID=
ARG NEXT_PUBLIC_GOOGLE_ONE_TAP_FEDCM_ENABLED=false
ARG NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID=
ARG NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED=false
ARG NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED=false
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_WEB_BASE_URL=${NEXT_PUBLIC_WEB_BASE_URL}
ENV NEXT_PUBLIC_GOOGLE_ONE_TAP_ENABLED=${NEXT_PUBLIC_GOOGLE_ONE_TAP_ENABLED}
ENV NEXT_PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID}
ENV NEXT_PUBLIC_GOOGLE_ONE_TAP_FEDCM_ENABLED=${NEXT_PUBLIC_GOOGLE_ONE_TAP_FEDCM_ENABLED}
ENV NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID}
ENV NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED=${NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED}
ENV NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED=${NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED}
COPY --from=pruner /app/out/full/ .
RUN pnpm --filter @sourceweft/market-contracts build
RUN pnpm --filter @sourceweft/ui-web build
RUN pnpm --filter web build
# The backend build runs tsc over the whole workspace graph; the default heap
# ceiling OOMs on CI runners (exit 134).
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @sourceweft/backend build
RUN find . -name ".turbo" -type d -prune -exec rm -rf '{}' + \
  && rm -rf apps/web/.next/cache

# ── Runner ───────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
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

# Overlay built artifacts from builder (supersedes source files where applicable)
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/web/.next/standalone web-standalone
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/web/.next/static web-standalone/apps/web/.next/static
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/web/public web-standalone/apps/web/public
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/backend/dist apps/backend/dist
COPY --chown=sourceweft:sourceweft --from=builder /app/packages/market-contracts/dist packages/market-contracts/dist

USER sourceweft
EXPOSE 3000 3001
CMD ["node", "/app/web-standalone/apps/web/server.js"]
