# syntax=docker/dockerfile:1

# Node 22 LTS: puppeteer-core (server-side PDF documents) requires >= 22.12.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- deps: install all dependencies ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

# ---- setup: lean one-shot migration runner. Reuses `deps` (node_modules with
# the prisma CLI + tsx + the copied prisma/ dir incl. migrations) — NO Next
# build, so it is cheap to build and run. docker-compose runs
# `npm run db:deploy` (= prisma migrate deploy) and then the idempotent
# legacy-documents freeze (scripts/backfill-legacy-documents.ts: documents
# issued before 4_business_core are frozen under their old numbers). ----
FROM deps AS setup
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
CMD ["sh", "-c", "npm run db:deploy && npm run docs:backfill-legacy"]

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
# Chromium renders the proforma / invoice / credit-note PDFs ONCE at issue time
# (puppeteer-core drives it; no browser is downloaded at npm install); the PDF
# is stored in S3 and every download serves those stored bytes. Noto + DejaVu
# fonts cover Latin and Arabic-script (Persian) names/addresses on documents.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates chromium fonts-noto-core fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN groupadd -r nodejs && useradd -r -g nodejs nextjs
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
