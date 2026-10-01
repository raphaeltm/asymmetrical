# Asymmetrical — Development Guide

## What this is

Agent drift detection library and monitoring dashboard. Detects when AI coding agents go off-task (scope creep, rabbit holes, yak shaving, etc.) using LLM classification.

## Repo structure

- `packages/core` — Provider-agnostic drift detection library. Zero deps. `@asymmetrical/core`
- `packages/provider-openai` — OpenAI-compatible classifier (works with Nebius Token Factory). `@asymmetrical/provider-openai`
- `packages/provider-jev` — TypeSafe Jev classifier (for production use). `@asymmetrical/provider-jev`
- `apps/hackathon` — Demo server with REST API, WebSocket, Gradium TTS, inline dashboard

## Commands

```bash
pnpm install          # Install deps
pnpm build            # Build all packages (uses turbo)
pnpm typecheck        # Type-check all packages
pnpm dev              # Dev mode with watch
./scripts/smoke-test.sh  # Run smoke tests (needs server running)
```

## Key patterns

- **ESM throughout** — `"type": "module"` everywhere, `.js` extensions in imports
- **pnpm workspaces** — internal deps use `workspace:*`
- **tsup builds** — hackathon app bundles everything (noExternal) with a `createRequire` banner for CJS compat
- **Inline UI** — the dashboard is a template literal in `dashboardHTML()` in server.ts. All vanilla JS, no React, no frontend build step.

## Environment variables

- `NEBIUS_TOKEN_FACTORY_API_KEY` — Required. Powers drift classification via Qwen3-30B.
- `GRADIUM_API_KEY` — Optional. Powers voice alerts via Gradium TTS.
- `NEBIUS_MODEL` — Optional. Override the classifier model (default: `Qwen/Qwen3-30B-A3B-Instruct-2507`)
- `PORT` — Optional. Server port (default: 3000)

## Testing drift detection

```bash
# Start server
node apps/hackathon/dist/server.js

# Replay a demo transcript
curl -X POST http://localhost:3000/api/replay/scope-creep
```

## Docker

```bash
docker compose up --build
# or
docker build -t asymmetrical -f apps/hackathon/Dockerfile .
docker run -p 3000:3000 -e NEBIUS_TOKEN_FACTORY_API_KEY="..." asymmetrical
```
