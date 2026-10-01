FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/provider-openai/package.json packages/provider-openai/
COPY apps/hackathon/package.json apps/hackathon/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/hackathon/ apps/hackathon/

RUN pnpm run build

FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/provider-openai/package.json packages/provider-openai/
COPY apps/hackathon/package.json apps/hackathon/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/provider-openai/dist packages/provider-openai/dist
COPY --from=builder /app/apps/hackathon/dist apps/hackathon/dist

EXPOSE 3000

CMD ["node", "apps/hackathon/dist/server.js"]
