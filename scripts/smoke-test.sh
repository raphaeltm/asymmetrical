#!/usr/bin/env bash
# Smoke test for the Asymmetrical hackathon server.
# Usage: ./scripts/smoke-test.sh [base_url]
# Requires: NEBIUS_TOKEN_FACTORY_API_KEY in env (or the server already has it)

set -euo pipefail

BASE="${1:-http://localhost:3000}"
PASS=0
FAIL=0

check() {
  local desc="$1"
  local result="$2"
  if [ "$result" = "true" ] || [ "$result" = "True" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "🔭 Asymmetrical smoke test against $BASE"
echo ""

# Health
echo "--- Health ---"
health=$(curl -sf "$BASE/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('healthy', False))" 2>/dev/null || echo "false")
check "GET /health" "$health"

# UI loads
echo "--- UI ---"
ui=$(curl -sf "$BASE/ui" | grep -q "Asymmetrical" && echo "true" || echo "false")
check "GET /ui returns HTML" "$ui"

# Fixtures
echo "--- Fixtures ---"
fixtures=$(curl -sf "$BASE/api/fixtures" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d) >= 3)" 2>/dev/null || echo "false")
check "GET /api/fixtures returns ≥3 transcripts" "$fixtures"

fixture=$(curl -sf "$BASE/api/fixtures/scope-creep" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('messages',[])) > 0)" 2>/dev/null || echo "false")
check "GET /api/fixtures/scope-creep has messages" "$fixture"

# Session CRUD
echo "--- Sessions ---"
session=$(curl -sf -X POST "$BASE/api/sessions" \
  -H "Content-Type: application/json" \
  -d '{"id":"smoke-test","intent":{"description":"Smoke test session"}}' | \
  python3 -c "import json,sys; print(json.load(sys.stdin).get('id')=='smoke-test')" 2>/dev/null || echo "false")
check "POST /api/sessions creates session" "$session"

# Push message
echo "--- Messages ---"
msg=$(curl -sf -X POST "$BASE/api/sessions/smoke-test/messages" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","content":"Test message"}' | \
  python3 -c "import json,sys; print(json.load(sys.stdin).get('queued', False))" 2>/dev/null || echo "false")
check "POST message queued" "$msg"

# Ingest (auto-create)
echo "--- Ingest ---"
ingest=$(curl -sf -X POST "$BASE/api/ingest" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"ingest-test","tool_name":"Read","tool_input":"file.ts","intent":"Test via ingest"}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('messagesIngested', 0) > 0)" 2>/dev/null || echo "false")
check "POST /api/ingest auto-creates and ingests" "$ingest"

# Force check (requires Nebius API key)
if [ -n "${NEBIUS_TOKEN_FACTORY_API_KEY:-}" ]; then
  echo "--- Drift Check ---"
  # Add a few more messages first
  for i in 1 2 3; do
    curl -sf -X POST "$BASE/api/sessions/smoke-test/messages" \
      -H "Content-Type: application/json" \
      -d "{\"role\":\"assistant\",\"content\":\"Message $i\"}" > /dev/null
  done
  drift=$(curl -sf -X POST "$BASE/api/sessions/smoke-test/check" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print('severity' in d)" 2>/dev/null || echo "false")
  check "POST /api/sessions/:id/check returns drift result" "$drift"
else
  echo "--- Drift Check (skipped — no NEBIUS_TOKEN_FACTORY_API_KEY) ---"
fi

# Replay
echo "--- Replay ---"
replay=$(curl -sf -X POST "$BASE/api/replay/scope-creep" \
  -H "Content-Type: application/json" \
  -d '{"delayMs":50}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('messageCount', 0) > 0)" 2>/dev/null || echo "false")
check "POST /api/replay/scope-creep starts replay" "$replay"

# Cleanup
curl -sf -X DELETE "$BASE/api/sessions/smoke-test" > /dev/null 2>&1 || true
curl -sf -X DELETE "$BASE/api/sessions/ingest-test" > /dev/null 2>&1 || true

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "🎉 All tests passed!" || echo "💥 Some tests failed"
exit "$FAIL"
