# lab2date

B2B marketplace for laboratory and biotech equipment.

## Docker Install

Requirements: Docker Engine with Docker Compose. The image runs on Node.js 22.

```bash
cp .env.docker.example .env
# Edit .env before production: BETTER_AUTH_SECRET, CRON_SECRET, public URL,
# email, storage, Stripe, company and bank settings.
docker compose up -d --build
```

Open <http://localhost:3000>.

The compose stack starts:

| Service | URL / Port | Purpose |
| --- | --- | --- |
| web | <http://localhost:3000> | Next.js standalone app |
| db | `127.0.0.1:16543` | Postgres 16 |
| MinIO API | <http://localhost:19000> | S3-compatible object storage |
| MinIO Console | <http://localhost:19001> | Storage admin UI |
| Mailpit SMTP | `127.0.0.1:11025` | Local email sink |
| Mailpit UI | <http://localhost:18025> | View outgoing dev emails |

If a host port is already taken, edit the matching `*_PORT` value in `.env`.

## Full restore on a fresh server (production clone)

To stand up a new VPS with the **exact same state** as current production
(all 786 products, the Sam Pars Benelux company identity, every order/quote,
all uploaded images) on a fresh Ubuntu/Debian box:

```bash
# 1. as root on the new server
git clone https://github.com/iceberg-rog/Labtodate.git /opt/lab2date
cd /opt/lab2date

# 2. copy these 3 things into the repo root from your secure backup:
#    .env.docker          (from your password manager — has secrets)
#    .backups/lab2date-prod.sql.gz   (Postgres dump)
#    .backups/minio-mirror.tar.gz    (MinIO bucket: product images + logos)

# 3. one command does the rest (installs Docker if missing, restores db
#    and minio, builds the web image, brings everything up):
sudo bash scripts/bootstrap-fresh-server.sh
```

The script is idempotent for the Docker install step and prints a smoke-check
at the end (`HTTP 200 + products in db count`). Last steps you do manually:
DNS → server IP, nginx/Caddy in front for TLS, then update
`BETTER_AUTH_URL` in `.env.docker` and `docker compose up -d --force-recreate web`.

To **refresh the snapshot** on your laptop later (so the bundle stays
current with prod):

```bash
bash scripts/snapshot-prod.sh root@<server-ip>
```

This pulls a timestamped `lab2date-prod-YYYYMMDD-HHMMSS.sql.gz` and
`minio-mirror-YYYYMMDD-HHMMSS.tar.gz` into `.backups/` and updates the
`latest` symlinks the bootstrap script reads.

`.backups/` is gitignored (the MinIO mirror is ~400 MB — bigger than
GitHub's 100 MB file limit). Upload it to Google Drive / Dropbox /
Backblaze for off-machine safety. See `.backups/RESTORE.md` for the
manual restore steps if the script breaks.

On first boot, the `setup` service runs `prisma db push` and seeds the main catalogue plus content. Re-run it whenever you need to resync schema or reseed:

```bash
docker compose run --rm setup
```

Useful maintenance commands:

```bash
docker compose logs -f web
docker compose restart web
docker compose pull
docker compose up -d --build
docker compose down
```

To wipe local Docker data and start fresh:

```bash
docker compose down -v
docker compose up -d --build
```

## Local Development

```bash
npm install
cp .env.example .env.local
docker compose up -d db minio minio-init mailpit
npm run db:push
npm run db:seed:all
npm run dev
```

Open <http://localhost:3000>.

Use Node.js 22 for local development, or any Node.js version supported by Next.js 16.

Local development uses the same support services as Docker install, exposed on `127.0.0.1:16543` for Postgres, `127.0.0.1:19000` for MinIO, and `127.0.0.1:11025` for Mailpit SMTP. Those values are already set in `.env.example`.

Common scripts:

```bash
npm run typecheck
npm run build
npm run db:studio
```

## Environment

Use `.env.docker.example` for container installs and `.env.example` for local host development. The key difference is that Docker uses internal service names:

- `DATABASE_URL=postgresql://...@db:5432/...`
- `S3_ENDPOINT=http://minio:9000`
- `SMTP_HOST=mailpit`
- `S3_PUBLIC_URL=http://localhost:3000/media/lab2date-media`

For production, set:

- `BETTER_AUTH_SECRET` and `CRON_SECRET` to long random values.
- `BETTER_AUTH_URL` and `NEXT_PUBLIC_BETTER_AUTH_URL` to the public site URL.
- `S3_PUBLIC_URL` to the public site URL plus `/media/lab2date-media` when using the built-in MinIO rewrite.
- `RESEND_API_KEY` and `EMAIL_FROM` for real outbound email.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` for Stripe checkout.
- Company, bank, tax, shipping, and support inbox settings as needed.

## Production Notes

The Docker image is a Next.js standalone build. Put a reverse proxy such as nginx, Caddy, Traefik, or Cloudflare Tunnel in front of `web:3000` for HTTPS.

Stripe webhook endpoint:

```text
https://your-domain.example/api/stripe/webhook
```

If you keep MinIO private behind the app, leave object URLs on the `/media/<bucket>/<key>` route. The app rewrites those requests to the internal MinIO service.

## Stack

- Next.js 16 App Router, React 18, TypeScript, Tailwind CSS
- Postgres 16 and Prisma
- Better Auth
- MinIO or any S3-compatible object storage
- Mailpit for local email, Resend/SMTP for production email
- Stripe Checkout and webhook support
- Tiptap editor for blog/wiki content
- Docker Compose one-command install

## Seed Users

After `npm run db:seed:all` or Docker `setup`:

| Email | Role | Notes |
| --- | --- | --- |
| `admin@lab2date.com` | ADMIN | Magic-link sign-in |
| `sales@biolab-refurb.example` | SELLER | Demo seller |
| `sales@northeast-scientific.ex` | SELLER | Demo seller |
| any new sign-up | BUYER | Default role |

Seed users do not have passwords; sign in through the magic-link flow.
