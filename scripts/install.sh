#!/usr/bin/env bash
# install.sh — one-line lab2date installer for a fresh Ubuntu/Debian VPS.
#
# THE EASY PATH — single curl|bash with bundle URL + password:
#
#   curl -fsSL https://raw.githubusercontent.com/iceberg-rog/Labtodate/main/scripts/install.sh \
#     | sudo BUNDLE_URL='https://.../lab2date-bundle.enc' BUNDLE_PASS='yourPassword' bash
#
#   Build the bundle once on your laptop with scripts/build-bundle.sh,
#   then host it anywhere (Drive, Dropbox, transfer.sh, S3/R2/B2).
#
# THE FALLBACK — drop 3 files into /tmp first, then run with no env vars:
#
#   pscp .env                          root@NEW:/tmp/lab2date.env
#   pscp .backups/lab2date-prod.sql.gz root@NEW:/tmp/
#   pscp .backups/minio-mirror.tar.gz  root@NEW:/tmp/
#   curl -fsSL https://raw.githubusercontent.com/iceberg-rog/Labtodate/main/scripts/install.sh \
#     | sudo bash
#
# Either path → ~6 min later you have a fully-restored lab2date on this
# server (sample products + uploads + everything). Then point your DNS at
# this server's IP and run certbot for TLS.

set -euo pipefail

REPO_URL="https://github.com/iceberg-rog/Labtodate.git"
DEST="/opt/lab2date"

[[ "$EUID" -eq 0 ]] || { echo "[err] run as root: sudo bash $0"; exit 1; }

echo "==> installing base tools (git, curl, openssl, ca-certificates)"
apt-get update -qq
apt-get install -y -qq git curl openssl ca-certificates

# ---------- pick a source for the bundle: URL+password OR /tmp files ----------

if [[ -n "${BUNDLE_URL:-}" && -n "${BUNDLE_PASS:-}" ]]; then
  echo "==> downloading bundle from BUNDLE_URL"
  curl -fsSL "$BUNDLE_URL" -o /tmp/lab2date-bundle.enc
  echo "    bundle: $(du -h /tmp/lab2date-bundle.enc | cut -f1)"

  echo "==> decrypting bundle"
  openssl enc -d -aes-256-cbc -salt -pbkdf2 -iter 200000 \
    -in /tmp/lab2date-bundle.enc -out /tmp/lab2date-bundle.tar.gz -pass env:BUNDLE_PASS \
    || { echo "[err] decrypt failed — wrong BUNDLE_PASS?"; exit 1; }
  rm -f /tmp/lab2date-bundle.enc

  echo "==> extracting bundle to /tmp"
  mkdir -p /tmp/l2d-extract
  tar xzf /tmp/lab2date-bundle.tar.gz -C /tmp/l2d-extract
  rm -f /tmp/lab2date-bundle.tar.gz
  cp /tmp/l2d-extract/.env                          /tmp/lab2date.env
  cp /tmp/l2d-extract/.backups/lab2date-prod.sql.gz /tmp/
  cp /tmp/l2d-extract/.backups/minio-mirror.tar.gz  /tmp/
  rm -rf /tmp/l2d-extract
elif [[ -f /tmp/lab2date.env && -f /tmp/lab2date-prod.sql.gz && -f /tmp/minio-mirror.tar.gz ]]; then
  echo "==> using bundle files already in /tmp/"
else
  cat <<MSG
[err] no bundle found. one of:
  A) set BUNDLE_URL + BUNDLE_PASS env vars:
     curl ... | sudo BUNDLE_URL='https://...' BUNDLE_PASS='...' bash
  B) upload these 3 files into /tmp/ first via pscp:
     /tmp/lab2date.env
     /tmp/lab2date-prod.sql.gz
     /tmp/minio-mirror.tar.gz
MSG
  exit 1
fi

# ---------- clone + place files ----------

echo "==> cloning repo to $DEST"
if [[ -d "$DEST/.git" ]]; then
  (cd "$DEST" && git pull --ff-only)
else
  git clone --depth=1 "$REPO_URL" "$DEST"
fi
cd "$DEST"

echo "==> placing bundle files inside repo"
mv /tmp/lab2date.env             "$DEST/.env"
mkdir -p "$DEST/.backups"
mv /tmp/lab2date-prod.sql.gz     "$DEST/.backups/"
mv /tmp/minio-mirror.tar.gz      "$DEST/.backups/"
chmod 600 "$DEST/.env"

echo "==> handing off to scripts/bootstrap-fresh-server.sh"
exec bash scripts/bootstrap-fresh-server.sh
