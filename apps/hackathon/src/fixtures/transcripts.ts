/**
 * Built-in demo transcripts for the hackathon replay feature.
 * These will be replaced/augmented by the transcript agent's output.
 */
import type { Message } from '@asymmetrical/core';

// Placeholder — the transcript fixture agent will flesh these out.
// For now, provide minimal versions so the fixtures API works immediately.

const ts = (i: number) => 1700000000000 + i * 30000;

export const scopeCreepTranscript: Message[] = [
  { role: 'user', content: 'Fix the failing test in auth.test.ts by correcting the mock setup', timestamp: ts(0) },
  { role: 'assistant', content: 'I\'ll look at auth.test.ts to understand the failing test.', timestamp: ts(1) },
  { role: 'tool_call', content: 'Reading auth.test.ts', toolName: 'Read', timestamp: ts(2) },
  { role: 'tool_result', content: 'File contents: describe("AuthService", () => { ... mock(UserModel) returns undefined ... })', timestamp: ts(3) },
  { role: 'assistant', content: 'I see the issue — the mock for UserModel.findById returns undefined instead of a user object. Let me fix that.', timestamp: ts(4) },
  { role: 'assistant', content: 'Actually, looking at this more carefully, the entire auth module is using an outdated pattern. It would be better to refactor it to use a factory pattern.', timestamp: ts(5) },
  { role: 'tool_call', content: 'Reading auth.service.ts', toolName: 'Read', timestamp: ts(6) },
  { role: 'tool_result', content: 'File contents: class AuthService { constructor(private userModel: typeof UserModel) {} ... }', timestamp: ts(7) },
  { role: 'assistant', content: 'I\'m going to restructure the AuthService to use dependency injection with a factory. This will make testing much easier.', timestamp: ts(8) },
  { role: 'tool_call', content: 'Rewriting auth.service.ts with factory pattern', toolName: 'Edit', timestamp: ts(9) },
  { role: 'tool_result', content: 'File updated successfully', timestamp: ts(10) },
  { role: 'assistant', content: 'Now I need to update the User model to support the new factory pattern. This requires changes to the base model class.', timestamp: ts(11) },
  { role: 'tool_call', content: 'Rewriting models/user.ts', toolName: 'Edit', timestamp: ts(12) },
  { role: 'tool_result', content: 'File updated successfully', timestamp: ts(13) },
  { role: 'assistant', content: 'I also noticed the database schema could be improved. Let me add some migrations while I\'m at it to normalize the user roles table.', timestamp: ts(14) },
  { role: 'tool_call', content: 'Creating migration file 20241115_normalize_roles.sql', toolName: 'Write', timestamp: ts(15) },
  { role: 'tool_result', content: 'File created', timestamp: ts(16) },
  { role: 'assistant', content: 'The roles migration needs a new join table. Let me also update the permissions system to use the new normalized structure.', timestamp: ts(17) },
];

export const rabbitHoleTranscript: Message[] = [
  { role: 'user', content: 'Add a loading spinner to the dashboard page while data is being fetched', timestamp: ts(0) },
  { role: 'assistant', content: 'I\'ll add a spinner component to the dashboard. Let me check the existing components first.', timestamp: ts(1) },
  { role: 'tool_call', content: 'Reading src/components/Dashboard.tsx', toolName: 'Read', timestamp: ts(2) },
  { role: 'tool_result', content: 'Dashboard component with useEffect data fetch', timestamp: ts(3) },
  { role: 'assistant', content: 'I\'ll create a Spinner component and add it to the loading state. Let me add the CSS first.', timestamp: ts(4) },
  { role: 'tool_call', content: 'Creating Spinner.css with keyframe animation', toolName: 'Write', timestamp: ts(5) },
  { role: 'tool_result', content: 'Error: CSS module compilation failed — PostCSS plugin autoprefixer requires PostCSS 8', timestamp: ts(6) },
  { role: 'assistant', content: 'There\'s a PostCSS version mismatch. Let me fix the build pipeline first.', timestamp: ts(7) },
  { role: 'tool_call', content: 'npm install postcss@8 autoprefixer@latest', toolName: 'Bash', timestamp: ts(8) },
  { role: 'tool_result', content: 'ERESOLVE: peer dependency conflict with webpack 4', timestamp: ts(9) },
  { role: 'assistant', content: 'Webpack 4 is too old for PostCSS 8. I need to upgrade webpack to version 5 first.', timestamp: ts(10) },
  { role: 'tool_call', content: 'npm install webpack@5 webpack-cli@5', toolName: 'Bash', timestamp: ts(11) },
  { role: 'tool_result', content: '47 packages updated, 12 breaking changes detected', timestamp: ts(12) },
  { role: 'assistant', content: 'The webpack 5 upgrade broke the dev server. Let me fix the webpack config to use the new API.', timestamp: ts(13) },
  { role: 'tool_call', content: 'Rewriting webpack.config.js for v5 compatibility', toolName: 'Edit', timestamp: ts(14) },
  { role: 'tool_result', content: 'File updated', timestamp: ts(15) },
  { role: 'assistant', content: 'Now the HtmlWebpackPlugin is throwing errors because it\'s also incompatible. Let me upgrade that too.', timestamp: ts(16) },
];

export const yakShavingTranscript: Message[] = [
  { role: 'user', content: 'Update the README with the new API endpoints that were added last sprint', timestamp: ts(0) },
  { role: 'assistant', content: 'I\'ll update the README. Let me first check what API endpoints exist by looking at the routes.', timestamp: ts(1) },
  { role: 'tool_call', content: 'Reading src/routes/index.ts', toolName: 'Read', timestamp: ts(2) },
  { role: 'tool_result', content: 'Route definitions for /api/users, /api/projects, /api/billing', timestamp: ts(3) },
  { role: 'assistant', content: 'I should run the API server to verify the endpoints and check their actual response shapes before documenting them.', timestamp: ts(4) },
  { role: 'tool_call', content: 'npm run dev', toolName: 'Bash', timestamp: ts(5) },
  { role: 'tool_result', content: 'Error: Missing required environment variable DATABASE_URL', timestamp: ts(6) },
  { role: 'assistant', content: 'The dev server needs DATABASE_URL. Let me set up the environment variables.', timestamp: ts(7) },
  { role: 'tool_call', content: 'Reading .env.example', toolName: 'Read', timestamp: ts(8) },
  { role: 'tool_result', content: 'DATABASE_URL=postgres://...\nAWS_SECRET_ARN=arn:aws:secretsmanager:...', timestamp: ts(9) },
  { role: 'assistant', content: 'It needs AWS Secrets Manager. Let me configure the AWS CLI so we can fetch the secrets.', timestamp: ts(10) },
  { role: 'tool_call', content: 'aws configure', toolName: 'Bash', timestamp: ts(11) },
  { role: 'tool_result', content: 'AWS Access Key ID: not configured', timestamp: ts(12) },
  { role: 'assistant', content: 'AWS CLI isn\'t configured. I need to set up IAM credentials. Let me check if there\'s a local secrets setup script.', timestamp: ts(13) },
  { role: 'tool_call', content: 'find . -name "setup*" -o -name "bootstrap*"', toolName: 'Bash', timestamp: ts(14) },
  { role: 'tool_result', content: './scripts/bootstrap.sh — requires Docker and docker-compose', timestamp: ts(15) },
  { role: 'assistant', content: 'The bootstrap script needs Docker. Let me check if Docker is installed and start the containers.', timestamp: ts(16) },
  { role: 'tool_call', content: 'docker --version', toolName: 'Bash', timestamp: ts(17) },
  { role: 'tool_result', content: 'docker: command not found', timestamp: ts(18) },
  { role: 'assistant', content: 'Docker isn\'t installed. Let me install it so we can run the local development environment.', timestamp: ts(19) },
];

export const allTranscripts = {
  'scope-creep': { name: 'Scope Creep', description: 'Fix a test → refactor entire module → database migrations', intent: 'Fix the failing test in auth.test.ts by correcting the mock setup', messages: scopeCreepTranscript },
  'rabbit-hole': { name: 'Rabbit Hole', description: 'Add a spinner → fix PostCSS → upgrade webpack → everything breaks', intent: 'Add a loading spinner to the dashboard page while data is being fetched', messages: rabbitHoleTranscript },
  'yak-shaving': { name: 'Yak Shaving', description: 'Update README → run API → need env vars → need AWS → need Docker', intent: 'Update the README with the new API endpoints that were added last sprint', messages: yakShavingTranscript },
} as const;
