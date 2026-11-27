# Build from the monorepo root:
#   docker build -f server/Dockerfile -t velodeck-server .

FROM node:22-alpine AS base
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_NPM_REGISTRY="$NPM_REGISTRY"
ENV npm_config_registry="$NPM_REGISTRY"
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY controller/package.json ./controller/package.json
COPY server/package.json ./server/package.json
RUN pnpm install --frozen-lockfile --registry="$NPM_REGISTRY" --config.strictDepBuilds=false && pnpm rebuild esbuild

COPY packages/protocol ./packages/protocol
COPY controller ./controller
COPY server ./server

RUN pnpm --filter @velodeck/protocol build \
  && pnpm --filter @velodeck/controller build \
  && pnpm --filter @velodeck/server build

FROM base AS prod-deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY controller/package.json ./controller/package.json
COPY server/package.json ./server/package.json
RUN pnpm install --prod --frozen-lockfile --filter @velodeck/server... --registry="$NPM_REGISTRY"

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV STATIC_DIR=/app/controller/dist
ENV DATA_DIR=/app/data
ENV APK_PATH=/app/downloads/velodeck-agent.apk

RUN mkdir -p /app/data /app/downloads && chown -R node:node /app/data /app/downloads

COPY --chown=node:node --from=prod-deps /app/package.json ./package.json
COPY --chown=node:node --from=prod-deps /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=prod-deps /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --chown=node:node --from=prod-deps /app/server/package.json ./server/package.json
COPY --chown=node:node --from=prod-deps /app/server/node_modules ./server/node_modules

COPY --chown=node:node --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --chown=node:node --from=builder /app/server/dist ./server/dist
COPY --chown=node:node --from=builder /app/controller/dist ./controller/dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1 || exit 1

CMD ["node", "/app/server/dist/index.js"]
