# Asymmetrical Drift Monitor Hook (Claude Code)

A Claude Code **PostToolUse** hook that streams every tool call and tool
result to an Asymmetrical drift-monitoring server in real time, so live
agent sessions show up in the Asymmetrical dashboard with continuous
drift checks.

## What it does

After each tool Claude Code runs, the hook:

1. Reads the hook payload from stdin
   (`{ hook_name, session_id, tool_name, tool_input, tool_output }`).
2. Uses the Claude Code `session_id` as the Asymmetrical session ID.
3. Auto-creates the Asymmetrical session on first use (POST `/api/sessions`
   with a default intent; `409`/conflict responses are ignored).
4. POSTs two messages to `/api/sessions/:id/messages`:
   - `{ role: "tool_call", content: "...", toolName: "...", timestamp }`
   - `{ role: "tool_result", content: "...", toolName: "...", timestamp }`
5. Never blocks the agent: short curl/fetch timeouts (default 2s), always
   exits `0`, silent unless `DEBUG=1`.

The Asymmetrical server periodically runs drift checks over the message
stream and flags scope creep, rabbit holes, wrong approaches, and other
drift types.

## Install

### 1. Make the bash hook executable

```bash
chmod +x apps/hackathon/src/hooks/drift-monitor-hook.sh
```

### 2. Register it as a PostToolUse hook

Add it to your user settings (`~/.claude/settings.json`) or project
settings (`.claude/settings.json`):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/asymmetrical/apps/hackathon/src/hooks/drift-monitor-hook.sh"
          }
        ]
      }
    ]
  }
}
```

For a repo-local hook, `$CLAUDE_PROJECT_DIR` works in the command:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/apps/hackathon/src/hooks/drift-monitor-hook.sh"
          }
        ]
      }
    ]
  }
}
```

### TypeScript version (better JSON parsing / error handling)

Use `npx tsx` in the command instead:

```json
{
  "type": "command",
  "command": "npx tsx $CLAUDE_PROJECT_DIR/apps/hackathon/src/hooks/drift-monitor-hook.ts"
}
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `ASYMMETRICAL_URL` | `http://localhost:3000` | Base URL of the Asymmetrical server. |
| `ASYMMETRICAL_SESSION_INTENT` | `"Claude Code agent session — live drift monitoring via PostToolUse hook"` | Intent description used when auto-creating a session. Set it to your actual task so drift checks are meaningful. |
| `ASYMMETRICAL_HOOK_TIMEOUT` (bash) / `ASYMMETRICAL_HOOK_TIMEOUT_MS` (ts) | `2` s / `2000` ms | HTTP timeout per request. |
| `ASYMMETRICAL_HOOK_MAX_CONTENT` (ts: `..._MAX_CONTENT`) | `4000` | Max characters per message before truncation. |
| `DEBUG` | — | Set to `1` to print diagnostics to stderr. |

Example with a custom intent:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "ASYMMETRICAL_SESSION_INTENT='Refactor the auth module without changing public API' $CLAUDE_PROJECT_DIR/apps/hackathon/src/hooks/drift-monitor-hook.sh"
          }
        ]
      }
    ]
  }
}
```

## See results in the dashboard

With the Asymmetrical server running:

```bash
pnpm --filter hackathon dev   # starts the server (default port 3000)
```

Open **http://localhost:3000/ui**:

- Your Claude Code session appears in the **Sessions** list (ID = Claude
  Code session ID) after the first tool call.
- The **Messages** panel shows each `tool_call` / `tool_result` as it lands.
- The **Drift Timeline** and **Current Status** panels update with drift
  check results (severity, drift type, explanation) every few messages.
- API access: `GET http://localhost:3000/api/sessions/<session_id>` returns
  the full message log and drift history.
