#!/usr/bin/env bash
#
# Asymmetrical live drift monitoring hook for Claude Code (PostToolUse).
#
# Reads the Claude Code hook payload from stdin:
#   { hook_name, session_id, tool_name, tool_input, tool_output }
#
# Forwards each tool call + result to the Asymmetrical server as two
# messages ({ role: "tool_call", ... } and { role: "tool_result", ... }),
# auto-creating the monitoring session on first use.
#
# Non-blocking by design: short curl timeouts, always exits 0, never
# prints to stdout (which Claude Code may interpret as hook output).

set -u

ASYMMETRICAL_URL="${ASYMMETRICAL_URL:-http://localhost:3000}"
ASYMMETRICAL_SESSION_INTENT="${ASYMMETRICAL_SESSION_INTENT:-Claude Code agent session — live drift monitoring via PostToolUse hook}"
ASYMMETRICAL_HOOK_TIMEOUT="${ASYMMETRICAL_HOOK_TIMEOUT:-2}"   # seconds
MAX_CONTENT_LEN="${ASYMMETRICAL_HOOK_MAX_CONTENT:-4000}"       # chars per message

# Always exit cleanly — a monitoring hook must never break the agent.
trap 'exit 0' EXIT

# --- Read the hook payload from stdin ---

payload=$(cat)

# Cross-platform millisecond timestamp (date +%s%3N is GNU-only).
now_ms="$(date +%s)000"

if command -v jq >/dev/null 2>&1; then
  session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty')
  tool_name=$(printf '%s' "$payload" | jq -r '.tool_name // "unknown_tool"')
  tool_input=$(printf '%s' "$payload" | jq -cr '.tool_input // {}')
  tool_output=$(printf '%s' "$payload" | jq -cr '.tool_output // null')
else
  # Fallback parser (no jq): session_id/tool_name are plain strings.
  session_id=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  tool_name=$(printf '%s' "$payload" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  tool_input='{}'
  tool_output='null'
fi

# Without a session id there is nothing to attribute messages to.
[ -z "$session_id" ] && exit 0
[ -z "$tool_name" ] && tool_name="unknown_tool"

# --- Build message bodies ---

truncate() {
  local s="$1"
  if [ "${#s}" -gt "$MAX_CONTENT_LEN" ]; then
    printf '%s' "$s" | head -c "$MAX_CONTENT_LEN"
    printf '…[truncated]'
  else
    printf '%s' "$s"
  fi
}

if command -v jq >/dev/null 2>&1; then
  call_content=$(truncate "${tool_name} ${tool_input}")
  result_content=$(truncate "${tool_name} → ${tool_output}")
  call_body=$(jq -nc --arg c "$call_content" --arg t "$tool_name" --argjson ts "$now_ms" \
    '{role: "tool_call", content: $c, toolName: $t, timestamp: $ts}')
  result_body=$(jq -nc --arg c "$result_content" --arg t "$tool_name" --argjson ts "$now_ms" \
    '{role: "tool_result", content: $c, toolName: $t, timestamp: $ts}')
  create_body=$(jq -nc --arg id "$session_id" --arg d "$ASYMMETRICAL_SESSION_INTENT" \
    '{id: $id, intent: {description: $d}}')
else
  call_content=$(truncate "$payload")
  result_content=$(truncate "$payload")
  call_body="{\"role\":\"tool_call\",\"content\":\"$(printf '%s' "$call_content" | sed 's/\\/\\\\/g; s/"/\\"/g')\",\"toolName\":\"$tool_name\",\"timestamp\":$now_ms}"
  result_body="{\"role\":\"tool_result\",\"content\":\"$(printf '%s' "$result_content" | sed 's/\\/\\\\/g; s/"/\\"/g')\",\"toolName\":\"$tool_name\",\"timestamp\":$now_ms}"
  create_body="{\"id\":\"$session_id\",\"intent\":{\"description\":\"$ASYMMETRICAL_SESSION_INTENT\"}}"
fi

# --- HTTP helpers (silent, short timeout, status-code only) ---

post() {
  # $1 = path, $2 = JSON body; echoes the HTTP status code.
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "$ASYMMETRICAL_URL$1" \
    -H 'Content-Type: application/json' \
    --data "$2" \
    --connect-timeout "$ASYMMETRICAL_HOOK_TIMEOUT" \
    --max-time "$ASYMMETRICAL_HOOK_TIMEOUT" 2>/dev/null
}

ensure_session() {
  # Auto-create the monitoring session. 409 (already exists) and any
  # other failure are ignored — the message retry decides what to do.
  post '/api/sessions' "$create_body" >/dev/null
  true
}

# --- Ship it: tool_call first, then tool_result ---

status=$(post "/api/sessions/$session_id/messages" "$call_body")

# Session doesn't exist yet → create it and retry the tool_call message.
if [ "$status" = "404" ] || [ "$status" = "000" ]; then
  ensure_session
  post "/api/sessions/$session_id/messages" "$call_body" >/dev/null
fi

post "/api/sessions/$session_id/messages" "$result_body" >/dev/null

exit 0
