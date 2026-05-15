# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=20.19.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /app
RUN apk add --no-cache libc6-compat libstdc++ \
  && corepack enable \
  && corepack prepare pnpm@10.19.0 --activate

FROM base AS deps
RUN apk add --no-cache make g++ python3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/credits-core/package.json packages/credits-core/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/model-gateway/package.json packages/model-gateway/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/tailwind-config/package.json packages/tailwind-config/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS builder
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ARG NEXT_PUBLIC_WEB_BASE_URL=http://localhost:3000
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_WEB_BASE_URL=${NEXT_PUBLIC_WEB_BASE_URL}
COPY . .
RUN pnpm --filter @sourceweft/ui-web build
RUN pnpm --filter web build
RUN find . -name ".turbo" -type d -prune -exec rm -rf '{}' + \
  && rm -rf apps/web/.next/cache

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV BACKEND_API_PORT=3001
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/credits-core/package.json packages/credits-core/package.json
COPY packages/model-gateway/package.json packages/model-gateway/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
RUN --mount=type=cache,id=pnpm-runtime-store,target=/pnpm/store \
  apk add --no-cache --virtual .runtime-build-deps make g++ python3 \
  && pnpm install --filter @sourceweft/backend... --frozen-lockfile \
  && apk del .runtime-build-deps
RUN addgroup -S sourceweft \
  && adduser -S sourceweft -G sourceweft
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/web/.next/standalone web-standalone
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/web/.next/static web-standalone/apps/web/.next/static
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/web/public web-standalone/apps/web/public
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/backend/config apps/backend/config
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/backend/drizzle apps/backend/drizzle
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/backend/drizzle.config.ts apps/backend/drizzle.config.ts
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/backend/src apps/backend/src
COPY --chown=sourceweft:sourceweft --from=builder /app/apps/backend/tsconfig.json apps/backend/tsconfig.json
COPY --chown=sourceweft:sourceweft --from=builder /app/packages/contracts/src packages/contracts/src
COPY --chown=sourceweft:sourceweft --from=builder /app/packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY --chown=sourceweft:sourceweft --from=builder /app/packages/credits-core/src packages/credits-core/src
COPY --chown=sourceweft:sourceweft --from=builder /app/packages/credits-core/tsconfig.json packages/credits-core/tsconfig.json
COPY --chown=sourceweft:sourceweft --from=builder /app/packages/model-gateway/src packages/model-gateway/src
COPY --chown=sourceweft:sourceweft --from=builder /app/packages/model-gateway/tsconfig.json packages/model-gateway/tsconfig.json
COPY --chown=sourceweft:sourceweft --from=builder /app/packages/typescript-config packages/typescript-config
USER sourceweft
EXPOSE 3000 3001
CMD ["node", "/app/web-standalone/apps/web/server.js"]
