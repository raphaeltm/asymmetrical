import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Bundle everything into a single self-contained file.
  // Only keep Node builtins external.
  noExternal: [/.*/],
  banner: {
    // Polyfill for CJS modules that use require() (e.g. whatwg-url via node-fetch)
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
});
