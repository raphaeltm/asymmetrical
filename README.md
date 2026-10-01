# ⊿ Asymmetrical

**Watch your agents.** Detect when AI coding agents drift from their assigned tasks.

Asymmetrical is an intent-drift detection library and monitoring dashboard for AI coding agents. It classifies whether a conversation is staying on track, going down rabbit holes, creeping in scope, or yak-shaving — then alerts you with voice notifications.

## How it works

1. **You define an intent** — "Fix the failing test in auth.test.ts"
2. **Messages flow in** — from Claude Code hooks, API calls, or replayed transcripts
3. **A classifier checks for drift** — using an LLM via tool calling (Nebius Token Factory / any OpenAI-compatible API)
4. **You see results in real time** — via WebSocket-powered dashboard with severity timeline
5. **Voice alerts fire** — via Gradium TTS when drift is significant

## Packages

| Package | Description |
|---|---|
| `@asymmetrical/core` | Provider-agnostic drift detection library. Zero dependencies. |
| `@asymmetrical/provider-openai` | Drift classifier using any OpenAI-compatible API with tool calling. |
| `apps/hackathon` | Demo server with REST API, WebSocket, Gradium TTS, and inline dashboard. |

## Quick start

```bash
# Install
pnpm install

# Set env vars
export NEBIUS_TOKEN_FACTORY_API_KEY="..."   # Required — for drift classification
export GRADIUM_API_KEY="..."                 # Optional — for voice alerts

# Build and run
pnpm build
node apps/hackathon/dist/server.js
```

Open http://localhost:3000/ui for the dashboard.

## API

```bash
# Create a monitoring session
curl -X POST http://localhost:3000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"intent": {"description": "Fix the failing test in auth.test.ts"}}'

# Push a message
curl -X POST http://localhost:3000/api/sessions/<id>/messages \
  -H "Content-Type: application/json" \
  -d '{"role": "assistant", "content": "Actually let me refactor the whole module..."}'

# Replay a demo transcript
curl -X POST http://localhost:3000/api/replay/scope-creep

# List available demo transcripts
curl http://localhost:3000/api/fixtures

# Force a drift check
curl -X POST http://localhost:3000/api/sessions/<id>/check
```

## Using as a library

```typescript
import { DriftDetector } from '@asymmetrical/core';
import { OpenAIDriftProvider } from '@asymmetrical/provider-openai';

const detector = new DriftDetector(
  { checkInterval: 3, threshold: 0.5 },
  new OpenAIDriftProvider({
    baseURL: 'https://api.tokenfactory.nebius.com/v1',
    apiKey: process.env.NEBIUS_TOKEN_FACTORY_API_KEY!,
    model: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
  }),
  { description: 'Fix the failing test in auth.test.ts' },
);

detector.onDrift = (result) => {
  console.log(`⚠️ ${result.type}: ${result.explanation}`);
};

for (const msg of messages) {
  await detector.push(msg);
}
```

## Docker

```bash
docker build -t asymmetrical -f apps/hackathon/Dockerfile .
docker run -p 3000:3000 \
  -e NEBIUS_TOKEN_FACTORY_API_KEY="..." \
  -e GRADIUM_API_KEY="..." \
  asymmetrical
```

## Sponsors

Built at a hackathon sponsored by **Nebius** and **Gradium**.

- **Nebius Token Factory** — Powers drift classification via Qwen3-30B
- **Gradium** — Powers voice alerts via TTS API
