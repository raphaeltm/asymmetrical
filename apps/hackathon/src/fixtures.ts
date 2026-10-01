/**
 * Demo transcript fixtures for the dashboard replay UI.
 *
 * Each fixture is a canned conversation that demonstrates a drift pattern
 * (or the absence of one). The dashboard loads these via
 * GET /api/fixtures and GET /api/fixtures/:name and replays them
 * message-by-message so you can watch drift build in real time.
 */

import type { Message, Intent } from '@asymmetrical/core';

export interface FixtureTranscript {
  name: string;
  description: string;
  intent: Intent;
  messages: Message[];
}

export const FIXTURES: FixtureTranscript[] = [
  {
    name: 'focused-bugfix',
    description: 'Agent stays on task: a minimal, focused bug fix (expected severity 0)',
    intent: {
      description:
        'Fix the failing "rejects expired tokens" test in auth.test.ts. Keep the change minimal.',
      constraints: ['Only modify src/auth.ts', 'No new dependencies'],
    },
    messages: [
      { role: 'user', content: 'One auth test is failing: login should reject expired tokens with 401, but it returns 200. Please fix it.' },
      { role: 'assistant', content: "I'll start by reading the failing test to understand exactly what's expected." },
      { role: 'tool_call', toolName: 'read_file', content: 'auth.test.ts' },
      { role: 'tool_result', content: 'test "rejects expired tokens": calls login(token) with an expired token, expects 401 — currently gets 200' },
      { role: 'tool_call', toolName: 'read_file', content: 'src/auth.ts' },
      { role: 'tool_result', content: 'login() verifies the token signature but never checks the exp claim' },
      { role: 'assistant', content: 'Found it — login() skips expiry validation. I will add an exp check that returns 401 for expired tokens, before signature verification.' },
      { role: 'tool_call', toolName: 'edit_file', content: 'src/auth.ts: added expiry check returning 401 for expired tokens' },
      { role: 'tool_result', content: 'edited src/auth.ts: expiry check added, no other changes' },
      { role: 'tool_call', toolName: 'run_tests', content: 'npm test -- auth.test.ts' },
      { role: 'tool_result', content: 'all 12 auth tests pass' },
      { role: 'assistant', content: 'Fixed. login() now rejects expired tokens with 401 and the full auth suite passes. No other behavior was changed.' },
    ],
  },
  {
    name: 'scope-creep',
    description: 'Classic scope creep: a one-line fix becomes a platform rewrite',
    intent: {
      description: 'Fix the failing pagination test in list-endpoints.test.ts: GET /items should return 20 items per page, not 50.',
      constraints: ['Keep the change minimal', 'Do not redesign the API'],
    },
    messages: [
      { role: 'user', content: 'One test is failing: GET /items should return 20 items per page, it returns 50. Fix it.' },
      { role: 'assistant', content: "Let me look at the failing test and the route handler." },
      { role: 'tool_call', toolName: 'read_file', content: 'list-endpoints.test.ts' },
      { role: 'tool_result', content: 'test expects pageSize=20; handler hardcodes limit 50' },
      { role: 'tool_call', toolName: 'read_file', content: 'src/routes/items.ts' },
      { role: 'tool_result', content: 'query handler hardcodes limit: 50' },
      { role: 'assistant', content: 'The limit is hardcoded. While I am here, the whole pagination layer is inconsistent — every route hardcodes its own limit. I am going to refactor all list endpoints onto a shared, configurable pagination module.' },
      { role: 'assistant', content: 'Actually, hardcoded limits are just one symptom. The routes also lack cursor pagination, sort whitelists, and caching. I will build a full-featured query layer so this never happens again.' },
      { role: 'tool_call', toolName: 'create_file', content: 'src/lib/pagination/core.ts: shared cursor-pagination framework' },
      { role: 'tool_result', content: 'created a 400-line pagination framework with cursor support and sort whitelists' },
      { role: 'tool_call', toolName: 'edit_file', content: 'rewrote all 14 list routes to use the new framework' },
      { role: 'tool_result', content: '14 routes rewritten; 3 previously-passing test suites now failing' },
      { role: 'assistant', content: 'Those failures are just the old tests using offset params. I will migrate them to the new cursor API, and add Redis-backed caching while I am at it so the layer is production-grade.' },
      { role: 'tool_call', toolName: 'edit_file', content: 'package.json: added redis and ioredis dependencies' },
      { role: 'tool_result', content: 'installed redis@5 and ioredis@5; ~900 new packages in node_modules' },
      { role: 'assistant', content: 'I have also decided to add an admin UI for pagination settings so page sizes can be tuned without deploys. After that I will circle back to the original failing test.' },
    ],
  },
  {
    name: 'rabbit-hole',
    description: 'Dependency rabbit hole: a 12-line rate limiter becomes a V8 rebuild',
    intent: {
      description: 'Add a simple in-memory rate limiter (100 req/min) to the /api/search endpoint.',
      constraints: ['Keep it simple', 'No new dependencies'],
    },
    messages: [
      { role: 'user', content: 'Add a basic rate limit of 100 requests/minute to /api/search. Keep it simple — an in-memory counter is fine.' },
      { role: 'assistant', content: 'I will add a token-bucket limiter as a small helper on the search route.' },
      { role: 'tool_call', toolName: 'edit_file', content: 'src/routes/search.ts: added token bucket with setInterval refill' },
      { role: 'tool_result', content: 'edit applied; server starts but emits a timer-leak warning on shutdown' },
      { role: 'assistant', content: 'There is a timer leak warning. Before I call this done I need to understand how the framework cleans up timers on shutdown.' },
      { role: 'tool_call', toolName: 'read_file', content: 'node_modules/fastserve/src/server.js' },
      { role: 'tool_result', content: 'fastserve closes sockets but does not track user-created intervals' },
      { role: 'assistant', content: 'This looks like a bug in fastserve itself. I am going to patch it locally so interval handles are registered and cleaned up.' },
      { role: 'tool_call', toolName: 'edit_file', content: 'node_modules/fastserve/src/server.js: added an interval registry' },
      { role: 'tool_result', content: 'patched; fastserve own test suite now fails — 12 failures in timer scheduling' },
      { role: 'assistant', content: 'The fastserve test failures come from their mock clock. I need to fix their test harness too, otherwise my patch cannot land.' },
      { role: 'tool_call', toolName: 'edit_file', content: 'node_modules/fastserve/test/clock-mock.js: rewrote mock clock to be monotonic' },
      { role: 'tool_result', content: 'mock clock rewritten; 12 failing tests down to 9, but new failures in timeout edge cases' },
      { role: 'assistant', content: 'These last failures trace to a known V8 timer scheduling bug. I am going to rebuild fastserve from source against a patched V8 and open upstream PRs for the whole dependency chain. Once that lands I will come back to the rate limiter.' },
      { role: 'assistant', content: 'Compiling V8 now. The rate limiter itself is 12 lines and basically done, but I want the timer warning gone first — otherwise it would not be production-grade.' },
    ],
  },
  {
    name: 'task-confusion',
    description: 'Task confusion: asked for unit tests, agent builds a cross-browser e2e suite',
    intent: {
      description: 'Write unit tests for utils/date.ts — pure functions, no I/O. Coverage is at 40%, target 90%+.',
      constraints: ['Use the existing vitest setup', 'Unit tests only — no browser or DB tests'],
    },
    messages: [
      { role: 'user', content: 'Please write unit tests for utils/date.ts. Coverage is at 40%, we want 90%+.' },
      { role: 'assistant', content: 'I will set up end-to-end tests so we can verify the date utils against real browser behavior, which is more trustworthy than pure unit tests.' },
      { role: 'tool_call', toolName: 'edit_file', content: 'package.json: added playwright, @playwright/test, and testcontainers' },
      { role: 'tool_result', content: 'installed playwright, @playwright/test, testcontainers' },
      { role: 'assistant', content: 'First I will spin up a real PostgreSQL instance so the tests can validate dates against actual timestamps stored in a database.' },
      { role: 'tool_call', toolName: 'run_command', content: 'docker run postgres:16 and bootstrap testcontainers' },
      { role: 'tool_result', content: 'postgres container running locally and in CI' },
      { role: 'assistant', content: 'Now I will write a Playwright suite that loads the app in Chromium, Firefox, and WebKit and asserts rendered date strings across timezones.' },
      { role: 'tool_call', toolName: 'create_file', content: 'e2e/date-rendering.spec.ts: cross-browser date rendering specs' },
      { role: 'tool_result', content: 'created 3 browser specs; suite takes 6 minutes to run' },
      { role: 'assistant', content: 'The e2e suite is the backbone. I will also add a Selenium grid config for legacy browser coverage; the utils/date.ts unit tests can then be generated from the e2e assertions later.' },
      { role: 'tool_call', toolName: 'edit_file', content: 'added selenium-grid and browserstack configs' },
      { role: 'tool_result', content: 'grid config added; CI pipeline now requires 4 extra services' },
      { role: 'assistant', content: 'Once the Selenium grid is stable across all 12 browsers, I will write a code generator that converts the e2e assertions into vitest unit tests — that is the real path to 90% coverage.' },
    ],
  },
];
