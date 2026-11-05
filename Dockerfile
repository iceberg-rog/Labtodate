# syntax=docker/dockerfile:1

# Node 22 LTS: puppeteer-core (server-side PDF documents) needs >= 22.12, and
# Node 20 is end-of-life.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- deps: install all dependencies ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

# ---- setup: lean one-shot migration runner. Reuses `deps` (node_modules with
# the prisma CLI + the copied prisma/ dir incl. migrations) — NO Next build, so
# it is cheap to build and run. docker-compose runs `npm run db:deploy`
# (= prisma migrate deploy). ----
FROM deps AS setup
WORKDIR /app
CMD ["npm", "run", "db:deploy"]

# ---- builder: prisma generate + next build (standalone) ----
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=1536
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ---- runner: lean standalone runtime ----
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
# Chromium makes the quote / invoice / receipt PDFs (puppeteer-core drives it;
# no browser download at npm install). It starts only when a PDF is made and
# stops after 60 s idle. Liberation + DejaVu + Noto fonts cover the documents'
# Arial-metric layout and non-Latin customer names.
RUN apt-get update   && apt-get install -y --no-install-recommends openssl ca-certificates chromium fonts-liberation fonts-dejavu-core fonts-noto-core   && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# A real home folder: Chromium (PDF documents) needs a writable HOME.
RUN groupadd -r nodejs && useradd -r -g nodejs -m -d /home/nextjs nextjs
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# sharp removed: npm registry was unreachable from this host, hanging
# builds. next/image falls back to its built-in optimizer without it.
RUN mkdir -p /app/.next/cache \
  && chown -R nextjs:nodejs /app/node_modules /app/.next /app/public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
