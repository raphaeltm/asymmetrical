import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { cors } from 'hono/cors';
import type { WSContext } from 'hono/ws';
import { OpenAIDriftProvider } from '@asymmetrical/provider-openai';
import type { Message, Intent, DriftResult } from '@asymmetrical/core';
import { SessionManager } from './sessions.js';
import { GradiumClient, driftAlertText } from './gradium.js';
import { allTranscripts } from './fixtures/index.js';

// --- Config from env ---

const NEBIUS_API_KEY = process.env.NEBIUS_TOKEN_FACTORY_API_KEY ?? '';
const NEBIUS_MODEL = process.env.NEBIUS_MODEL ?? 'Qwen/Qwen3-30B-A3B-Instruct-2507';
const GRADIUM_API_KEY = process.env.GRADIUM_API_KEY ?? '';
const SERVER_PORT = Number(process.env.PORT) || 3000;

if (!NEBIUS_API_KEY) {
  console.warn('⚠️  NEBIUS_TOKEN_FACTORY_API_KEY not set — drift checks will fail');
}

// --- Services ---

const provider = new OpenAIDriftProvider({
  baseURL: 'https://api.tokenfactory.nebius.com/v1',
  apiKey: NEBIUS_API_KEY,
  model: NEBIUS_MODEL,
});

const sessions = new SessionManager(provider, {
  checkInterval: 3,
  threshold: 0.5,
  windowSize: 30,
  maxTokenBudget: 24000,
});

const gradium = GRADIUM_API_KEY
  ? new GradiumClient({ apiKey: GRADIUM_API_KEY })
  : null;

// --- WebSocket broadcast ---

const wsClients = new Set<WSContext>();

function broadcast(event: string, data: unknown) {
  const payload = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of wsClients) {
    try {
      ws.send(payload);
    } catch {
      wsClients.delete(ws);
    }
  }
}

// Wire up session manager to broadcast results
sessions.onResult = async (sessionId, result) => {
  broadcast('drift:check', { sessionId, result });

  // Generate TTS alert for significant drift
  if (result.isDrifting && result.severity >= 2 && gradium) {
    try {
      const text = driftAlertText(result.severity, result.severityLabel, result.type, result.explanation);
      const tts = await gradium.synthesize(text);
      broadcast('drift:audio', { sessionId, audioBase64: tts.audioBase64, sampleRate: tts.sampleRate });
    } catch (err) {
      console.error('Gradium TTS error:', err);
    }
  }
};

// --- App ---

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use('/*', cors());

// Health
app.get('/', (c) => c.json({ status: 'ok', service: 'asymmetrical' }));
app.get('/health', (c) => c.json({ healthy: true }));

// --- Session endpoints ---

// Create a monitoring session
app.post('/api/sessions', async (c) => {
  const body = await c.req.json<{ id?: string; intent: Intent; config?: Record<string, number> }>();
  const id = body.id ?? crypto.randomUUID();
  const session = sessions.create(id, body.intent, body.config);
  broadcast('session:created', { id: session.id, intent: session.intent });
  return c.json({ id: session.id, intent: session.intent }, 201);
});

// List sessions
app.get('/api/sessions', (c) => {
  return c.json(sessions.list());
});

// Get session detail
app.get('/api/sessions/:id', (c) => {
  const session = sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);
  return c.json({
    id: session.id,
    intent: session.intent,
    messageCount: session.messages.length,
    history: session.detector.history(),
    messages: session.messages,
  });
});

// Delete session
app.delete('/api/sessions/:id', (c) => {
  const deleted = sessions.delete(c.req.param('id'));
  if (!deleted) return c.json({ error: 'Not found' }, 404);
  broadcast('session:deleted', { id: c.req.param('id') });
  return c.json({ deleted: true });
});

// --- Hook ingest (auto-creates sessions) ---

// Accepts Claude Code hook payloads or simple message posts.
// If the session doesn't exist, it's created with a default or provided intent.
app.post('/api/ingest', async (c) => {
  const body = await c.req.json<{
    session_id?: string;
    sessionId?: string;
    hook_name?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_output?: unknown;
    // Or a plain message
    role?: string;
    content?: string;
    // Intent for auto-creation
    intent?: string;
  }>();

  const sessionId = body.session_id ?? body.sessionId ?? 'default';
  const intentDescription = body.intent ?? `Live monitoring session ${sessionId}`;

  // Auto-create session if it doesn't exist
  if (!sessions.get(sessionId)) {
    sessions.create(sessionId, { description: intentDescription });
    broadcast('session:created', { id: sessionId, intent: { description: intentDescription } });
  }

  // Convert hook payload to messages
  const messages: Message[] = [];

  if (body.tool_name && body.tool_input !== undefined) {
    const inputStr = typeof body.tool_input === 'string' ? body.tool_input : JSON.stringify(body.tool_input);
    messages.push({
      role: 'tool_call',
      content: inputStr.slice(0, 2000),
      toolName: body.tool_name,
      timestamp: Date.now(),
    });
  }

  if (body.tool_name && body.tool_output !== undefined) {
    const outputStr = typeof body.tool_output === 'string' ? body.tool_output : JSON.stringify(body.tool_output);
    messages.push({
      role: 'tool_result',
      content: outputStr.slice(0, 2000),
      toolName: body.tool_name,
      timestamp: Date.now(),
    });
  }

  if (body.role && body.content) {
    messages.push({
      role: body.role as Message['role'],
      content: body.content,
      timestamp: Date.now(),
    });
  }

  let lastResult = null;
  for (const msg of messages) {
    const result = await sessions.pushMessage(sessionId, msg);
    broadcast('message:new', { sessionId, message: msg });
    if (result) lastResult = result;
  }

  return c.json({ sessionId, messagesIngested: messages.length, result: lastResult ?? undefined });
});

// --- Message ingest ---

// Push a single message
app.post('/api/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const message = await c.req.json<Message>();
  if (!message.timestamp) message.timestamp = Date.now();

  try {
    const result = await sessions.pushMessage(sessionId, message);
    broadcast('message:new', { sessionId, message });
    return c.json({ queued: true, result: result ?? undefined });
  } catch (err) {
    return c.json({ error: String(err) }, 404);
  }
});

// Push a batch of messages (for replay mode)
app.post('/api/sessions/:id/replay', async (c) => {
  const sessionId = c.req.param('id');
  const body = await c.req.json<{ messages: Message[] }>();
  const results: Array<{ index: number; result: DriftResult }> = [];

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (!msg.timestamp) msg.timestamp = Date.now() + i;
    const result = await sessions.pushMessage(sessionId, msg);
    broadcast('message:new', { sessionId, message: msg });
    if (result) {
      results.push({ index: i, result });
    }
  }

  return c.json({ messagesProcessed: body.messages.length, driftChecks: results });
});

// Force a drift check
app.post('/api/sessions/:id/check', async (c) => {
  try {
    const result = await sessions.forceCheck(c.req.param('id'));
    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 404);
  }
});

// --- Fixtures (demo transcripts) ---

app.get('/api/fixtures', (c) => {
  const list = Object.entries(allTranscripts).map(([key, t]) => ({
    id: key,
    name: t.name,
    description: t.description,
    messageCount: t.messages.length,
  }));
  return c.json(list);
});

app.get('/api/fixtures/:id', (c) => {
  const id = c.req.param('id') as keyof typeof allTranscripts;
  const transcript = allTranscripts[id];
  if (!transcript) return c.json({ error: 'Not found' }, 404);
  return c.json(transcript);
});

// Replay a fixture with streaming — creates a session, sends messages with delay,
// and broadcasts each step over WebSocket so the UI can animate it.
app.post('/api/replay/:fixtureId', async (c) => {
  const fixtureId = c.req.param('fixtureId') as keyof typeof allTranscripts;
  const transcript = allTranscripts[fixtureId];
  if (!transcript) return c.json({ error: 'Fixture not found' }, 404);

  const body = await c.req.json<{ sessionId?: string; delayMs?: number }>().catch(() => ({} as { sessionId?: string; delayMs?: number }));
  const sessionId = body.sessionId ?? `replay-${fixtureId}-${Date.now()}`;
  const delayMs = body.delayMs ?? 300;

  // Create session
  sessions.create(sessionId, { description: transcript.intent });
  broadcast('session:created', { id: sessionId, intent: { description: transcript.intent } });

  // Send the response immediately with the session ID — replay runs in background
  const replayPromise = (async () => {
    const results: Array<{ index: number; result: DriftResult }> = [];
    for (let i = 0; i < transcript.messages.length; i++) {
      const msg = { ...transcript.messages[i], timestamp: Date.now() };
      const result = await sessions.pushMessage(sessionId, msg);
      broadcast('message:new', { sessionId, message: msg });
      broadcast('replay:progress', { sessionId, index: i, total: transcript.messages.length });
      if (result) results.push({ index: i, result });
      if (i < transcript.messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    broadcast('replay:complete', { sessionId, totalMessages: transcript.messages.length, driftChecks: results.length });
  })();

  replayPromise.catch((err) => {
    console.error('Replay error:', err);
    broadcast('replay:error', { sessionId, error: String(err) });
  });

  return c.json({ sessionId, fixtureId, messageCount: transcript.messages.length, delayMs }, 202);
});

// --- WebSocket ---

app.get(
  '/ws',
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      wsClients.add(ws);
      ws.send(JSON.stringify({ event: 'connected', data: { sessions: sessions.list() }, ts: Date.now() }));
    },
    onClose(_event, ws) {
      wsClients.delete(ws);
    },
    onMessage(event, ws) {
      // Clients can send JSON commands over WS too
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ event: 'pong', ts: Date.now() }));
        }
      } catch {
        // Ignore malformed messages
      }
    },
  })),
);

// --- Static UI (served from /ui) ---
// We'll serve the UI as a static HTML page inline for simplicity
app.get('/ui', (c) => {
  return c.html(dashboardHTML());
});

// --- Start ---

const server = serve({ fetch: app.fetch, port: SERVER_PORT }, (info) => {
  console.log(`🔭 Asymmetrical hackathon server running on port ${info.port}`);
  console.log(`   Dashboard: http://localhost:${info.port}/ui`);
  console.log(`   API:       http://localhost:${info.port}/api/sessions`);
  console.log(`   WebSocket: ws://localhost:${info.port}/ws`);
  if (!gradium) console.log('   ⚠️  Gradium TTS disabled (no GRADIUM_API_KEY)');
});

injectWebSocket(server);

// --- Inline dashboard HTML ---

function dashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Asymmetrical — Agent Drift Monitor</title>
  <style>
    :root {
      --bg: #0a0a0f;
      --surface: #12121a;
      --border: #1e1e2e;
      --text: #e0e0e6;
      --text-muted: #6b6b7b;
      --green: #22c55e;
      --yellow: #eab308;
      --orange: #f97316;
      --red: #ef4444;
      --blue: #3b82f6;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    h1 span { color: var(--purple); }
    .subtitle { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 24px; }
    .status-dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      margin-right: 6px; background: var(--red);
    }
    .status-dot.connected { background: var(--green); }

    /* Layout */
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }

    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .panel h2 { font-size: 0.9rem; color: var(--text-muted); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; }

    /* Create session form */
    .form-row { display: flex; gap: 8px; margin-bottom: 12px; }
    input, textarea, button, select {
      font-family: inherit; font-size: 0.85rem;
      background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 4px;
      padding: 8px 12px;
    }
    input:focus, textarea:focus { outline: none; border-color: var(--purple); }
    textarea { width: 100%; min-height: 60px; resize: vertical; }
    button {
      background: var(--purple); border: none; cursor: pointer;
      font-weight: 600; white-space: nowrap;
    }
    button:hover { opacity: 0.9; }
    button.secondary { background: var(--border); }

    /* Messages */
    .messages {
      max-height: 350px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 6px;
    }
    .msg {
      font-size: 0.8rem; padding: 6px 10px; border-radius: 4px;
      border-left: 3px solid var(--border);
    }
    .msg.user { border-left-color: var(--blue); }
    .msg.assistant { border-left-color: var(--purple); }
    .msg.tool_call { border-left-color: var(--yellow); }
    .msg.tool_result { border-left-color: var(--orange); }
    .msg .role { font-weight: 600; font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); }

    /* Timeline */
    .timeline {
      display: flex; flex-direction: column; gap: 8px;
    }
    .check-result {
      padding: 10px; border-radius: 6px;
      border-left: 4px solid var(--green);
      background: rgba(34, 197, 94, 0.05);
      font-size: 0.8rem;
    }
    .check-result.drifting { border-left-color: var(--red); background: rgba(239, 68, 68, 0.05); }
    .check-result.warning { border-left-color: var(--yellow); background: rgba(234, 179, 8, 0.05); }
    .check-result .severity { font-weight: 700; font-size: 1rem; }
    .check-result .meta { color: var(--text-muted); font-size: 0.75rem; margin-top: 4px; }

    /* Severity bar */
    .severity-bar {
      height: 24px; display: flex; align-items: center; gap: 2px;
      margin: 12px 0;
    }
    .severity-bar .segment {
      flex: 1; height: 100%; border-radius: 3px;
      background: var(--border); transition: background 0.3s;
    }

    /* Audio indicator */
    .audio-playing {
      display: inline-flex; align-items: center; gap: 6px;
      color: var(--orange); font-size: 0.8rem;
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* Sessions list */
    .session-item {
      padding: 10px; border: 1px solid var(--border); border-radius: 6px;
      margin-bottom: 8px; cursor: pointer; transition: border-color 0.2s;
    }
    .session-item:hover { border-color: var(--purple); }
    .session-item.active { border-color: var(--purple); background: rgba(168, 85, 247, 0.05); }
    .session-item .name { font-weight: 600; }
    .session-item .info { font-size: 0.75rem; color: var(--text-muted); }

    .empty-state { color: var(--text-muted); text-align: center; padding: 40px 20px; font-size: 0.85rem; }

    /* Quick send */
    .quick-send { display: flex; gap: 8px; margin-top: 12px; }
    .quick-send input { flex: 1; }
    .quick-send select { width: 120px; }
  </style>
</head>
<body>
  <h1><span>⊿</span> Asymmetrical</h1>
  <p class="subtitle">
    <span class="status-dot" id="ws-status"></span>
    <span id="ws-label">Connecting…</span>
    &nbsp;|&nbsp; Agent Drift Monitor
    <span id="audio-indicator" style="display:none" class="audio-playing">🔊 Speaking…</span>
  </p>

  <div class="grid">
    <!-- Left: Sessions + Create -->
    <div>
      <div class="panel" style="margin-bottom: 20px;">
        <h2>New Session</h2>
        <textarea id="intent-input" placeholder="Describe the agent's task/intent…"></textarea>
        <div class="form-row" style="margin-top: 8px;">
          <input id="session-id-input" placeholder="Session ID (optional)" style="flex:1" />
          <button onclick="createSession()">Monitor</button>
        </div>
      </div>

      <div class="panel">
        <h2>Sessions</h2>
        <div id="sessions-list"><p class="empty-state">No active sessions</p></div>
      </div>
    </div>

    <!-- Right: Active session detail -->
    <div>
      <div class="panel" style="margin-bottom: 20px;">
        <h2>Current Status</h2>
        <div class="severity-bar" id="severity-bar">
          <div class="segment" id="seg-0"></div>
          <div class="segment" id="seg-1"></div>
          <div class="segment" id="seg-2"></div>
          <div class="segment" id="seg-3"></div>
        </div>
        <div id="current-status" class="empty-state" style="padding: 20px;">Select or create a session</div>
      </div>

      <div class="panel" style="margin-bottom: 20px;">
        <h2>Drift Timeline</h2>
        <div id="timeline" class="timeline">
          <p class="empty-state">No checks yet</p>
        </div>
      </div>

      <div class="panel">
        <h2>Messages</h2>
        <div id="messages" class="messages">
          <p class="empty-state">No messages</p>
        </div>
        <div class="quick-send">
          <select id="msg-role">
            <option value="user">user</option>
            <option value="assistant">assistant</option>
            <option value="tool_call">tool_call</option>
            <option value="tool_result">tool_result</option>
          </select>
          <input id="msg-content" placeholder="Type a message…" onkeydown="if(event.key==='Enter')sendMessage()" />
          <button onclick="sendMessage()">Send</button>
          <button class="secondary" onclick="forceCheck()">Check</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const BASE = location.origin;
    const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
    let ws;
    let activeSessionId = null;
    let sessionData = {};

    // --- WebSocket ---
    function connect() {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        document.getElementById('ws-status').classList.add('connected');
        document.getElementById('ws-label').textContent = 'Connected';
      };
      ws.onclose = () => {
        document.getElementById('ws-status').classList.remove('connected');
        document.getElementById('ws-label').textContent = 'Disconnected — reconnecting…';
        setTimeout(connect, 2000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        handleEvent(msg.event, msg.data);
      };
    }
    connect();

    function handleEvent(event, data) {
      if (event === 'connected') {
        // Initial session list
        if (data.sessions) {
          data.sessions.forEach(s => {
            sessionData[s.id] = sessionData[s.id] || { messages: [], checks: [] };
            if (s.lastResult) sessionData[s.id].checks.push(s.lastResult);
          });
          renderSessionList(data.sessions);
        }
      }
      if (event === 'session:created') {
        sessionData[data.id] = { messages: [], checks: [], intent: data.intent };
        refreshSessions();
      }
      if (event === 'message:new' && data.sessionId) {
        if (!sessionData[data.sessionId]) sessionData[data.sessionId] = { messages: [], checks: [] };
        sessionData[data.sessionId].messages.push(data.message);
        if (data.sessionId === activeSessionId) renderMessages();
      }
      if (event === 'drift:check' && data.sessionId) {
        if (!sessionData[data.sessionId]) sessionData[data.sessionId] = { messages: [], checks: [] };
        sessionData[data.sessionId].checks.push(data.result);
        if (data.sessionId === activeSessionId) {
          renderTimeline();
          renderStatus(data.result);
        }
        refreshSessions();
      }
      if (event === 'drift:audio') {
        playAudio(data.audioBase64, data.sampleRate);
      }
    }

    // --- API calls ---
    async function createSession() {
      const intent = document.getElementById('intent-input').value.trim();
      if (!intent) return;
      const id = document.getElementById('session-id-input').value.trim() || undefined;
      const res = await fetch(BASE + '/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, intent: { description: intent } }),
      });
      const session = await res.json();
      document.getElementById('intent-input').value = '';
      document.getElementById('session-id-input').value = '';
      selectSession(session.id);
    }

    async function sendMessage() {
      if (!activeSessionId) return;
      const content = document.getElementById('msg-content').value.trim();
      if (!content) return;
      const role = document.getElementById('msg-role').value;
      await fetch(BASE + '/api/sessions/' + activeSessionId + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, content, timestamp: Date.now() }),
      });
      document.getElementById('msg-content').value = '';
    }

    async function forceCheck() {
      if (!activeSessionId) return;
      await fetch(BASE + '/api/sessions/' + activeSessionId + '/check', { method: 'POST' });
    }

    async function refreshSessions() {
      const res = await fetch(BASE + '/api/sessions');
      const list = await res.json();
      renderSessionList(list);
    }

    function selectSession(id) {
      activeSessionId = id;
      renderMessages();
      renderTimeline();
      const checks = sessionData[id]?.checks || [];
      if (checks.length > 0) renderStatus(checks[checks.length - 1]);
      else document.getElementById('current-status').innerHTML = '<span style="color:var(--green)">✓ Monitoring — no checks yet</span>';
      refreshSessions();
    }

    // --- Rendering ---
    function renderSessionList(list) {
      const el = document.getElementById('sessions-list');
      if (!list || list.length === 0) { el.innerHTML = '<p class="empty-state">No active sessions</p>'; return; }
      el.innerHTML = list.map(s => {
        const active = s.id === activeSessionId ? ' active' : '';
        const last = s.lastResult;
        const badge = last ? (last.isDrifting ? '🔴' : '🟢') : '⚪';
        return '<div class="session-item' + active + '" onclick="selectSession(\\''+s.id+'\\')"><div class="name">' + badge + ' ' + s.id.slice(0,8) + '</div><div class="info">' + (s.intent?.description?.slice(0,80) || '—') + ' · ' + s.messageCount + ' msgs</div></div>';
      }).join('');
    }

    function renderMessages() {
      const el = document.getElementById('messages');
      const msgs = sessionData[activeSessionId]?.messages || [];
      if (msgs.length === 0) { el.innerHTML = '<p class="empty-state">No messages</p>'; return; }
      el.innerHTML = msgs.map(m =>
        '<div class="msg ' + m.role + '"><div class="role">' + m.role + (m.toolName ? ' · ' + m.toolName : '') + '</div>' + escapeHtml(m.content.slice(0, 500)) + '</div>'
      ).join('');
      el.scrollTop = el.scrollHeight;
    }

    function renderTimeline() {
      const el = document.getElementById('timeline');
      const checks = sessionData[activeSessionId]?.checks || [];
      if (checks.length === 0) { el.innerHTML = '<p class="empty-state">No checks yet</p>'; return; }
      el.innerHTML = checks.map(r => {
        const cls = r.isDrifting ? (r.severity >= 2 ? 'drifting' : 'warning') : '';
        return '<div class="check-result ' + cls + '"><div class="severity">' + r.severityLabel + ' <span style="font-weight:400;font-size:0.8rem;color:var(--text-muted)">(' + r.type + ')</span></div><div>' + escapeHtml(r.explanation) + '</div><div class="meta">msgs: ' + r.messageCount + ' · tokens: ~' + r.windowTokenEstimate + '</div></div>';
      }).join('');
    }

    function renderStatus(result) {
      const el = document.getElementById('current-status');
      const severityColors = ['var(--green)', 'var(--yellow)', 'var(--orange)', 'var(--red)'];
      const color = severityColors[Math.min(result.severity, 3)];
      el.innerHTML = '<div style="font-size:1.4rem;font-weight:700;color:'+color+'">' + result.severityLabel + '</div><div style="margin-top:6px;font-size:0.85rem">' + escapeHtml(result.explanation) + '</div><div style="margin-top:4px;font-size:0.75rem;color:var(--text-muted)">Type: ' + result.type + ' · Confidence: ' + Math.round((result.typeConfidence||0)*100) + '%</div>';

      // Update severity bar
      for (let i = 0; i <= 3; i++) {
        const seg = document.getElementById('seg-' + i);
        seg.style.background = i <= result.severity ? color : 'var(--border)';
      }
    }

    // --- Audio ---
    function playAudio(base64, sampleRate) {
      const indicator = document.getElementById('audio-indicator');
      indicator.style.display = 'inline-flex';
      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => { indicator.style.display = 'none'; URL.revokeObjectURL(url); };
        audio.onerror = () => { indicator.style.display = 'none'; };
        audio.play().catch(() => { indicator.style.display = 'none'; });
      } catch(e) {
        indicator.style.display = 'none';
        console.error('Audio error:', e);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
}
