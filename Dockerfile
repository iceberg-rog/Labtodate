# syntax=docker/dockerfile:1

# ---- deps: install all dependencies ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

# ---- builder: prisma generate + next build (standalone) ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=1536
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ---- setup: one-shot database/schema/seed helper ----
FROM builder AS setup
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
CMD ["sh", "-c", "npm run db:deploy && npm run db:seed:all"]

# ---- runner: lean standalone runtime ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN groupadd -r nodejs && useradd -r -g nodejs nextjs
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# sharp = fast native image optimization for next/image in standalone mode
RUN npm install --no-save --prefix /app sharp \
  && mkdir -p /app/.next/cache \
  && chown -R nextjs:nodejs /app/node_modules /app/.next /app/public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
