# ADR 0001 — One monorepo for web, api and worker

- Status: Accepted · 2026-11-23

## Context
Frontend and backend change together for almost every feature. The team builds with Claude
Code, which works best when it can see and change both sides in one task. Separate repos
would need manual type syncing and paired PRs.

## Decision
One repository `venueOS` with pnpm workspaces + Turborepo: `apps/web`, `apps/api`,
`apps/worker`, and shared `packages/*`. Each app keeps its own dependencies, Dockerfile, env
file and deployment.

## Consequences
- Shared Zod schemas and types; API changes break the frontend build immediately.
- One `CLAUDE.md`, one PR per feature.
- CI must build/test only affected packages (`turbo --filter`), and Docker builds use
  `turbo prune` so images stay small.
- An app can be split out later with `git filter-repo` if ever needed.
