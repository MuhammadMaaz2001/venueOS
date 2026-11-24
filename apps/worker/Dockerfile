# syntax=docker/dockerfile:1
# venueOS worker image (pg-boss jobs, emails, PDFs). Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t venueos-worker .
# Same stages as the API image, plus Chromium and its system libraries for `pdf.render` (docs/08, "PDF rendering").

ARG NODE_IMAGE=node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS prune
RUN npm install --global turbo@2.11.13
COPY . .
RUN turbo prune @venueos/worker --docker

FROM base AS build
# The Prisma CLI (client generation) wants OpenSSL; only this build stage needs it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
# turbo prune keeps the package sources but not the root TypeScript configs they extend.
COPY tsconfig.base.json tsconfig.node.json ./
# `prisma generate` reads prisma.config.ts, which wants a URL; this one is a placeholder and is never used to connect.
ENV MIGRATE_DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm turbo run build --filter=@venueos/worker...
RUN pnpm deploy --filter=@venueos/worker --prod /deploy

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# Browsers live outside the home directory so the non-root user finds them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build --chown=node:node /deploy/ .
# Chromium (the headless shell is all `page.pdf()` needs) and the system libraries it links against.
RUN node node_modules/playwright/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache \
    && chmod -R a+rX /ms-playwright
USER node
# No HTTP port: the worker only talks to Postgres, S3 and the mail provider. 1 GB of headroom per PDF page
# (PDF_CONCURRENCY) when sizing the container.
CMD ["node", "dist/main.js"]
