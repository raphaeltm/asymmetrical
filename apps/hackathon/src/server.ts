import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { cors } from 'hono/cors';
import type { WSContext } from 'hono/ws';
import { OpenAIDriftProvider } from '@asymmetrical/provider-openai';
import type { Message, Intent, DriftResult, DriftConfig } from '@asymmetrical/core';
import { SessionManager } from './sessions.js';
import { GradiumClient, driftAlertText } from './gradium.js';
import { FIXTURES } from './fixtures.js';

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

const defaultSessionConfig: DriftConfig = {
  checkInterval: 3,
  threshold: 0.5,
  windowSize: 30,
  maxTokenBudget: 24000,
};

const sessions = new SessionManager(provider, defaultSessionConfig);

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

// --- WebSocket ---

app.get(
  '/ws',
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      wsClients.add(ws);
      ws.send(
        JSON.stringify({
          event: 'connected',
          data: {
            sessions: sessions.list(),
            config: {
              threshold: defaultSessionConfig.threshold ?? 0.5,
              checkInterval: defaultSessionConfig.checkInterval ?? 5,
              windowSize: defaultSessionConfig.windowSize ?? 30,
            },
          },
          ts: Date.now(),
        }),
      );
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

    /* Timeline (SVG drift chart) */
    .timeline {
      position: relative;
      display: flex; flex-direction: column; gap: 8px;
    }
    .timeline svg { width: 100%; height: auto; display: block; }
    .chart-tip {
      position: absolute; z-index: 5; pointer-events: none;
      background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
      padding: 8px 10px; max-width: 260px;
      font-size: 0.72rem; line-height: 1.4;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    }
    .chart-tip .tip-title { font-weight: 700; }
    .chart-tip .tip-meta { color: var(--text-muted); }
    .chart-legend {
      display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
      font-size: 0.7rem; color: var(--text-muted);
    }
    .chart-legend .key { display: inline-flex; align-items: center; gap: 5px; }
    .chart-legend .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .chart-legend .dash { width: 16px; height: 0; border-top: 2px dashed var(--red); display: inline-block; }

    /* Replay */
    .progress-track {
      height: 8px; background: var(--border); border-radius: 4px;
      overflow: hidden; margin-top: 10px;
    }
    .progress-fill {
      height: 100%; width: 0%;
      background: var(--purple); border-radius: 4px;
      transition: width 0.2s ease;
    }
    .replay-status { font-size: 0.72rem; color: var(--text-muted); align-self: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
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

      <div class="panel" style="margin-bottom: 20px;">
        <h2>Transcript Replay</h2>
        <div class="form-row">
          <select id="replay-demo" style="flex:1" onchange="loadFixture()">
            <option value="">— load demo transcript —</option>
          </select>
          <button class="secondary" onclick="loadFixture()">Load</button>
        </div>
        <input id="replay-intent" placeholder="Agent intent (what it was asked to do)…" style="width:100%; margin-bottom:8px" />
        <textarea id="replay-input" placeholder='Paste a JSON array of messages, e.g. [{"role":"user","content":"fix the bug"},{"role":"assistant","content":"reading the test file"}]'></textarea>
        <div class="form-row" style="margin-top: 8px;">
          <button id="replay-btn" onclick="replayTranscript()">Replay</button>
          <span id="replay-status" class="replay-status" style="flex:1"></span>
        </div>
        <div class="progress-track"><div id="replay-progress" class="progress-fill"></div></div>
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
    let serverThreshold = 0.5;
    let replaying = false;
    const SEV_COLORS = ['#22c55e', '#eab308', '#f97316', '#ef4444'];

// --- Demo transcript fixtures (for the dashboard replay UI) ---

// List available demo transcripts (names only)
app.get('/api/fixtures', (c) => {
  return c.json(
    FIXTURES.map((f) => ({
      name: f.name,
      description: f.description,
      messageCount: f.messages.length,
    })),
  );
});

// Get one demo transcript by name
app.get('/api/fixtures/:name', (c) => {
  const fixture = FIXTURES.find((f) => f.name === c.req.param('name'));
  if (!fixture) {
    return c.json({ error: `Fixture "${c.req.param('name')}" not found`, available: FIXTURES.map((f) => f.name) }, 404);
  }
  return c.json(fixture);
});

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
    loadFixtures();

    function handleEvent(event, data) {
      if (event === 'connected') {
        // Initial session list + server config (threshold for the chart)
        if (data.config && typeof data.config.threshold === 'number') {
          serverThreshold = data.config.threshold;
        }
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

    // --- Transcript replay ---

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async function loadFixtures() {
      try {
        const res = await fetch(BASE + '/api/fixtures');
        const list = await res.json();
        const sel = document.getElementById('replay-demo');
        sel.innerHTML = '<option value="">— load demo transcript —</option>' +
          list.map(f => '<option value="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + ' · ' + f.messageCount + ' msgs</option>').join('');
      } catch (e) {
        console.error('Failed to load fixtures:', e);
      }
    }

    async function loadFixture() {
      const sel = document.getElementById('replay-demo');
      const name = sel.value;
      if (!name) return;
      try {
        const res = await fetch(BASE + '/api/fixtures/' + encodeURIComponent(name));
        if (!res.ok) throw new Error('fixture not found');
        const fx = await res.json();
        document.getElementById('replay-intent').value = fx.intent.description;
        document.getElementById('replay-input').value = JSON.stringify(fx.messages, null, 2);
        setReplayStatus('Loaded "' + name + '" — ' + fx.messages.length + ' messages. Hit Replay to watch drift build.');
      } catch (e) {
        setReplayStatus('Failed to load demo: ' + e.message);
      }
    }

    function setReplayStatus(text) {
      document.getElementById('replay-status').textContent = text;
    }

    function setReplayProgress(frac) {
      document.getElementById('replay-progress').style.width = Math.round(frac * 100) + '%';
    }

    async function replayTranscript() {
      if (replaying) return;
      let messages;
      try {
        messages = JSON.parse(document.getElementById('replay-input').value);
      } catch (e) {
        setReplayStatus('Invalid JSON: ' + e.message);
        return;
      }
      if (!Array.isArray(messages) || messages.length === 0) {
        setReplayStatus('Paste a JSON array of messages to replay.');
        return;
      }

      const intent = document.getElementById('replay-intent').value.trim() ||
        'Replay of a pasted transcript — monitor the agent for drift.';

      replaying = true;
      const btn = document.getElementById('replay-btn');
      btn.disabled = true;
      setReplayProgress(0);

      try {
        // Create a dedicated session for the replay
        const res = await fetch(BASE + '/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intent: { description: intent } }),
        });
        const session = await res.json();
        if (!session.id) throw new Error(session.error || 'failed to create session');
        sessionData[session.id] = sessionData[session.id] || { messages: [], checks: [] };
        selectSession(session.id);

        // Send messages one-by-one with a visible delay so drift builds live
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i] || {};
          await fetch(BASE + '/api/sessions/' + session.id + '/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              role: m.role || 'user',
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              toolName: m.toolName,
              timestamp: m.timestamp || Date.now(),
            }),
          });
          setReplayProgress((i + 1) / messages.length);
          setReplayStatus('Replaying… ' + (i + 1) + '/' + messages.length + ' messages');
          await sleep(200);
        }

        // Evaluate whatever is left in the window
        await fetch(BASE + '/api/sessions/' + session.id + '/check', { method: 'POST' });
        setReplayProgress(1);
        setReplayStatus('Done — ' + messages.length + ' messages replayed.');
      } catch (e) {
        setReplayStatus('Replay failed: ' + e.message);
      } finally {
        replaying = false;
        btn.disabled = false;
      }
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

    // --- Drift timeline chart (vanilla SVG) ---

    function svgEl(tag, attrs) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    }

    function sevColor(severity) {
      return SEV_COLORS[Math.max(0, Math.min(3, Math.round(severity)))];
    }

    function renderTimeline() {
      const el = document.getElementById('timeline');
      const checks = sessionData[activeSessionId]?.checks || [];
      el.innerHTML = '';
      if (checks.length === 0) {
        el.innerHTML = '<p class="empty-state">No checks yet</p>';
        return;
      }

      const W = 640, H = 230;
      const PAD = { l: 38, r: 14, t: 18, b: 28 };
      const plotW = W - PAD.l - PAD.r;
      const plotH = H - PAD.t - PAD.b;
      const n = checks.length;
      const xAt = i => PAD.l + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
      const yAt = s => PAD.t + plotH - (Math.max(0, Math.min(3, s)) / 3) * plotH;

      const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Drift severity over check number' });

      // Horizontal gridlines + severity axis labels (0-3)
      for (let s = 0; s <= 3; s++) {
        const gy = yAt(s);
        svg.appendChild(svgEl('line', { x1: PAD.l, y1: gy, x2: W - PAD.r, y2: gy, stroke: '#1e1e2e', 'stroke-width': 1 }));
        const lbl = svgEl('text', { x: PAD.l - 8, y: gy + 4, fill: '#6b6b7b', 'font-size': 10, 'text-anchor': 'end' });
        lbl.textContent = String(s);
        svg.appendChild(lbl);
      }

      // X-axis labels (check numbers, thinned when crowded)
      const step = Math.max(1, Math.ceil(n / 12));
      for (let i = 0; i < n; i += step) {
        const t = svgEl('text', { x: xAt(i), y: H - 8, fill: '#6b6b7b', 'font-size': 10, 'text-anchor': 'middle' });
        t.textContent = '#' + (i + 1);
        svg.appendChild(t);
      }

      // Threshold line — configured drift threshold (a probability, 0-1)
      // mapped onto the 0-3 severity axis (e.g. 0.5 -> sev 1.5)
      const tSev = Math.max(0, Math.min(3, serverThreshold * 3));
      const ty = yAt(tSev);
      svg.appendChild(svgEl('line', { x1: PAD.l, y1: ty, x2: W - PAD.r, y2: ty, stroke: '#ef4444', 'stroke-width': 1.5, 'stroke-dasharray': '6 4', opacity: 0.8 }));
      const tLabel = svgEl('text', { x: W - PAD.r, y: ty - 6, fill: '#ef4444', 'font-size': 9, 'text-anchor': 'end' });
      tLabel.textContent = 'threshold ' + serverThreshold;
      svg.appendChild(tLabel);

      // Line connecting the points
      const points = checks.map((r, i) => xAt(i) + ',' + yAt(r.severity)).join(' ');
      svg.appendChild(svgEl('polyline', { points: points, fill: 'none', stroke: '#a855f7', 'stroke-width': 1.5, opacity: 0.85 }));

      // Points (colored by severity) with hover tooltips
      checks.forEach((r, i) => {
        const g = svgEl('g', {});
        const title = svgEl('title', {});
        title.textContent = 'Check #' + (i + 1) + ' — ' + r.type + ' (' + r.severityLabel + ')';
        g.appendChild(title);
        g.appendChild(svgEl('circle', { cx: xAt(i), cy: yAt(r.severity), r: 5, fill: sevColor(r.severity), stroke: '#0a0a0f', 'stroke-width': 1.5 }));
        g.addEventListener('mouseenter', evt => showChartTip(el, evt, r, i));
        g.addEventListener('mouseleave', () => hideChartTip());
        svg.appendChild(g);
      });

      el.appendChild(svg);

      // Legend
      const legend = document.createElement('div');
      legend.className = 'chart-legend';
      legend.innerHTML =
        '<span class="key"><span class="dot" style="background:#22c55e"></span>sev 0</span>' +
        '<span class="key"><span class="dot" style="background:#eab308"></span>sev 1</span>' +
        '<span class="key"><span class="dot" style="background:#f97316"></span>sev 2</span>' +
        '<span class="key"><span class="dot" style="background:#ef4444"></span>sev 3</span>' +
        '<span class="key"><span class="dash"></span>threshold</span>';
      el.appendChild(legend);
    }

    function showChartTip(container, evt, r, i) {
      hideChartTip();
      const tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.id = 'chart-tip';
      tip.innerHTML =
        '<div class="tip-title" style="color:' + sevColor(r.severity) + '">Check #' + (i + 1) + ' · ' + escapeHtml(String(r.type)) + '</div>' +
        '<div class="tip-meta">' + escapeHtml(String(r.severityLabel)) + ' · sev ' + r.severity + ' · prob ' + (typeof r.probability === 'number' ? r.probability.toFixed(2) : '—') + (typeof r.messageCount === 'number' ? ' · ' + r.messageCount + ' msgs' : '') + '</div>' +
        '<div style="margin-top:4px">' + escapeHtml(String(r.explanation || '')) + '</div>';
      container.appendChild(tip);
      const rect = container.getBoundingClientRect();
      let left = evt.clientX - rect.left + 12;
      let top = evt.clientY - rect.top + 12;
      if (left + 270 > rect.width) left = Math.max(0, left - 284);
      if (top + 120 > rect.height) top = Math.max(0, top - 130);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }

    function hideChartTip() {
      const old = document.getElementById('chart-tip');
      if (old) old.remove();
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
