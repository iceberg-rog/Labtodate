#!/usr/bin/env bash
# install.sh — one-shot lab2date installer for a fresh Ubuntu/Debian VPS.
#
# WORKFLOW (3 lines total):
#
#   1)  on your laptop, upload the 3 secret/data files to the new server's /tmp:
#         pscp .env                          root@NEW_IP:/tmp/lab2date.env
#         pscp .backups/lab2date-prod.sql.gz root@NEW_IP:/tmp/
#         pscp .backups/minio-mirror.tar.gz  root@NEW_IP:/tmp/
#
#   2)  ssh root@NEW_IP
#
#   3)  on the new server, run THIS:
#         curl -fsSL https://raw.githubusercontent.com/iceberg-rog/Labtodate/main/scripts/install.sh | sudo bash
#
# That's it. ~6 min total (build is the slow part).

set -euo pipefail

REPO_URL="https://github.com/iceberg-rog/Labtodate.git"
DEST="/opt/lab2date"

[[ "$EUID" -eq 0 ]] || { echo "[err] run as root: sudo bash $0" ; exit 1; }

echo "==> preflight: looking for uploaded bundle files in /tmp/"
for label in "lab2date.env"   "lab2date-prod.sql.gz"   "minio-mirror.tar.gz"; do
  if [[ -f "/tmp/$label" ]]; then
    echo "    ✓ /tmp/$label ($(du -h "/tmp/$label" | cut -f1))"
  else
    echo "    ✗ /tmp/$label MISSING"
    MISSING=1
  fi
done
[[ -z "${MISSING:-}" ]] || {
  cat <<MSG

[err] one or more bundle files are missing from /tmp/.
upload them from your laptop first:

  pscp .env                          root@<this-server-ip>:/tmp/lab2date.env
  pscp .backups/lab2date-prod.sql.gz root@<this-server-ip>:/tmp/
  pscp .backups/minio-mirror.tar.gz  root@<this-server-ip>:/tmp/

then re-run this script.
MSG
  exit 1
}

echo "==> installing git + ca-certificates"
apt-get update -qq
apt-get install -y -qq git ca-certificates curl

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
