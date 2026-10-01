#!/usr/bin/env npx tsx
/**
 * Asymmetrical live drift monitoring hook for Claude Code (PostToolUse).
 *
 * Node/TypeScript counterpart to `drift-monitor-hook.sh` with proper JSON
 * parsing and error handling. Run via:
 *
 *   npx tsx apps/hackathon/src/hooks/drift-monitor-hook.ts
 *
 * Reads the Claude Code hook payload from stdin:
 *   { hook_name, session_id, tool_name, tool_input, tool_output }
 *
 * Forwards each tool call + result to the Asymmetrical server as two
 * messages ({ role: "tool_call", ... } and { role: "tool_result", ... }),
 * auto-creating the monitoring session on first use. Non-blocking:
 * short fetch timeouts, always exits 0, quiet unless DEBUG=1.
 */

const ASYMMETRICAL_URL = process.env.ASYMMETRICAL_URL ?? 'http://localhost:3000';
const ASYMMETRICAL_SESSION_INTENT =
  process.env.ASYMMETRICAL_SESSION_INTENT ??
  'Claude Code agent session — live drift monitoring via PostToolUse hook';
const HOOK_TIMEOUT_MS = Number(process.env.ASYMMETRICAL_HOOK_TIMEOUT_MS ?? 2000);
const MAX_CONTENT_LEN = Number(process.env.ASYMMETRICAL_HOOK_MAX_CONTENT ?? 4000);

interface HookPayload {
  hook_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
}

function debug(...args: unknown[]): void {
  if (process.env.DEBUG === '1') console.error('[drift-monitor]', ...args);
}

function truncate(s: string): string {
  return s.length > MAX_CONTENT_LEN ? s.slice(0, MAX_CONTENT_LEN) + '…[truncated]' : s;
}

/** POST JSON; returns the HTTP status code, or 0 on network failure. */
async function post(path: string, body: unknown): Promise<number> {
  try {
    const res = await fetch(ASYMMETRICAL_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    });
    // Drain the body so the socket is released cleanly.
    await res.text().catch(() => {});
    return res.status;
  } catch (err) {
    debug('POST failed:', path, err);
    return 0;
  }
}

async function ensureSession(sessionId: string): Promise<void> {
  // Auto-create the monitoring session; 409 (already exists) and any
  // other failure are ignored — the message retry decides what to do.
  const status = await post('/api/sessions', {
    id: sessionId,
    intent: { description: ASYMMETRICAL_SESSION_INTENT },
  });
  debug('ensureSession status:', status);
}

async function pushMessage(sessionId: string, message: Record<string, unknown>): Promise<number> {
  return post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, message);
}

async function main(): Promise<void> {
  // Read the whole hook payload from stdin.
  const raw = await new Promise<string>((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });

  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch (err) {
    debug('invalid JSON payload:', err);
    return;
  }

  const sessionId = payload.session_id?.trim();
  if (!sessionId) {
    debug('no session_id in payload — nothing to do');
    return;
  }
  const toolName = payload.tool_name || 'unknown_tool';
  const now = Date.now();

  const toolCall = {
    role: 'tool_call',
    content: truncate(`${toolName} ${JSON.stringify(payload.tool_input ?? {})}`),
    toolName,
    timestamp: now,
  };
  const toolResult = {
    role: 'tool_result',
    content: truncate(`${toolName} → ${JSON.stringify(payload.tool_output ?? null)}`),
    toolName,
    timestamp: now,
  };

  // tool_call first; on 404 (unknown session) auto-create and retry once.
  let status = await pushMessage(sessionId, toolCall);
  if (status === 404 || status === 0) {
    await ensureSession(sessionId);
    status = await pushMessage(sessionId, toolCall);
  }
  debug('tool_call status:', status);

  // Then the tool_result.
  status = await pushMessage(sessionId, toolResult);
  debug('tool_result status:', status);
}

main()
  .catch((err) => debug('hook error:', err))
  // A monitoring hook must never block or fail the agent.
  .finally(() => process.exit(0));
