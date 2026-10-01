FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/provider-openai/package.json packages/provider-openai/
COPY apps/hackathon/package.json apps/hackathon/

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/ packages/
COPY apps/hackathon/ apps/hackathon/

RUN pnpm run build

# --- Runtime: the bundled output is self-contained (no node_modules needed) ---
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy only the bundled server — tsup bundles all deps into dist/
COPY --from=builder /app/apps/hackathon/dist/ ./dist/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
