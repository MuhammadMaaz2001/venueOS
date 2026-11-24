# syntax=docker/dockerfile:1
# venueOS API image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t venueos-api .
# Stages: prune (only what the API needs) -> build -> runtime (production dependencies and dist, non-root).

ARG NODE_IMAGE=node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS prune
RUN npm install --global turbo@2.11.13
COPY . .
RUN turbo prune @venueos/api --docker

FROM base AS build
# The Prisma CLI (client generation) wants OpenSSL; only this build stage needs it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates     && rm -rf /var/lib/apt/lists/*
# Dependencies first (cached until a package.json or the lockfile changes), then the sources.
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
# turbo prune keeps the package sources but not the root TypeScript configs they extend.
COPY tsconfig.base.json tsconfig.node.json ./
# `prisma generate` reads prisma.config.ts, which wants a URL; this one is a placeholder and is never used to connect.
ENV MIGRATE_DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm turbo run build --filter=@venueos/api...
RUN pnpm deploy --filter=@venueos/api --prod /deploy

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /deploy/ .
USER node
EXPOSE 4000
# Liveness only: /health/ready needs the database and is what the compose file waits on.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
