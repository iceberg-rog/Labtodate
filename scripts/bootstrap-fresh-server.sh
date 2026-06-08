#!/usr/bin/env bash
# bootstrap-fresh-server.sh
#
# One-command full-state restore of lab2date on a fresh Ubuntu/Debian VPS.
# Brings up Postgres, MinIO, Mailpit, the cron worker, and the web app —
# with the production DB + MinIO bucket contents restored from .backups/.
#
# Run as root from inside the repo root after:
#   1) git clone https://github.com/iceberg-rog/Labtodate.git /opt/lab2date
#   2) cd /opt/lab2date
#   3) Copy .env.docker (from your secure backup) into the repo root
#   4) Copy .backups/lab2date-prod.sql.gz + .backups/minio-mirror.tar.gz
#      into the repo root (they're gitignored — download from your off-machine
#      store, e.g. Google Drive)
#   5) sudo bash scripts/bootstrap-fresh-server.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---------- preflight ----------

[[ "$EUID" -eq 0 ]] || { echo "[err] run as root: sudo bash $0" ; exit 1; }
[[ -f .env.docker ]] || { echo "[err] .env.docker missing — copy from secure backup before running" ; exit 1; }
[[ -f .backups/lab2date-prod.sql.gz ]] || { echo "[err] .backups/lab2date-prod.sql.gz missing — fetch from off-machine backup" ; exit 1; }
[[ -f .backups/minio-mirror.tar.gz ]] || { echo "[err] .backups/minio-mirror.tar.gz missing — fetch from off-machine backup" ; exit 1; }

echo "[1/7] preflight ok — env.docker + DB dump + MinIO mirror all present"

# ---------- docker install (idempotent) ----------

if ! command -v docker >/dev/null 2>&1; then
  echo "[2/7] installing docker engine + compose plugin"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "[2/7] docker already installed, skipping"
fi

# ---------- start infra containers (db + minio + mailpit) first ----------

echo "[3/7] starting db, minio, mailpit (need them up before restore)"
docker compose up -d db minio mailpit

echo -n "[4/7] waiting for postgres to accept connections "
for _ in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U lab2date >/dev/null 2>&1; then
    echo "ok"
    break
  fi
  echo -n "."
  sleep 1
done

# ---------- restore postgres ----------

echo "[5/7] restoring postgres dump (lab2date-prod.sql.gz)"
gunzip -c .backups/lab2date-prod.sql.gz \
  | docker compose exec -T db psql -U lab2date -d lab2date >/dev/null
echo "[5/7] postgres restore complete"

# ---------- restore minio bucket ----------

echo "[6/7] restoring minio bucket (minio-mirror.tar.gz, ~400 MB)"
MINIO_VOL=$(docker volume inspect lab2date_minio_data --format '{{ .Mountpoint }}')
[[ -n "$MINIO_VOL" && -d "$MINIO_VOL" ]] || { echo "[err] minio volume not found"; exit 1; }
docker compose stop minio
tar xzf .backups/minio-mirror.tar.gz -C "$MINIO_VOL"
chown -R 1000:1000 "$MINIO_VOL" 2>/dev/null || true
docker compose start minio
echo "[6/7] minio restore complete"

# ---------- build + start web ----------

echo "[7/7] building + starting web (first build ~4 min on a fresh host)"
docker compose build web
docker compose up -d

# ---------- install ops cron + nginx (idempotent) ----------

if [[ -f "$REPO_ROOT/scripts/backup.sh" && -f "$REPO_ROOT/scripts/uptime.sh" ]]; then
  echo "[+] installing ops crons (daily db backup + 5-min healthcheck)"
  chmod +x "$REPO_ROOT/scripts/backup.sh" "$REPO_ROOT/scripts/uptime.sh"
  ( crontab -l 2>/dev/null | grep -v 'lab2date/scripts/' ; \
    echo "0 3 * * * $REPO_ROOT/scripts/backup.sh >> /var/log/lab2date-backup.log 2>&1" ; \
    echo "*/5 * * * * $REPO_ROOT/scripts/uptime.sh" \
  ) | crontab -
fi

if [[ -f "$REPO_ROOT/nginx/lab2date.conf" ]] && command -v nginx >/dev/null 2>&1; then
  echo "[+] installing nginx vhost (you still need to install TLS cert + run 'systemctl reload nginx')"
  cp "$REPO_ROOT/nginx/lab2date.conf" /etc/nginx/sites-available/lab2date 2>/dev/null \
    || cp "$REPO_ROOT/nginx/lab2date.conf" /etc/nginx/conf.d/lab2date.conf 2>/dev/null
  [[ -d /etc/nginx/sites-enabled ]] && ln -sf /etc/nginx/sites-available/lab2date /etc/nginx/sites-enabled/lab2date
  nginx -t 2>&1 | tail -2 || echo "  [warn] nginx config test failed — review vhost and TLS cert paths"
fi

# ---------- smoke check ----------

echo
echo "smoke check:"
sleep 6
HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/ || true)
if [[ "$HTTP" == "200" ]]; then
  echo "  ✓ web responds with HTTP 200"
else
  echo "  ✗ web returned HTTP $HTTP — check 'docker compose logs web | tail'"
fi
PRODUCT_COUNT=$(docker compose exec -T db psql -U lab2date -d lab2date -t -A -c 'SELECT count(*) FROM "Product"' 2>/dev/null || echo "?")
echo "  · products in db: $PRODUCT_COUNT"

cat <<MSG

================================================================
  bootstrap done.
  next steps:
    1. point your dns (e.g. labtodate.com) at this server's ip
    2. set up nginx (or caddy) terminating tls → proxy_pass to
       http://127.0.0.1:3100
    3. issue a let's encrypt cert (e.g. certbot --nginx -d labtodate.com)
    4. update .env.docker BETTER_AUTH_URL to the new https url and
       restart with: docker compose up -d --force-recreate web
================================================================
MSG
