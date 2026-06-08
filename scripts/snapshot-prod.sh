#!/usr/bin/env bash
# snapshot-prod.sh
#
# Take a fresh snapshot of the production server's DB + MinIO bucket
# and download both to .backups/ on the workstation that runs this.
#
# Usage (from the repo root on your laptop):
#   bash scripts/snapshot-prod.sh root@144.172.91.167
#
# Result:
#   .backups/lab2date-prod-YYYYMMDD-HHMMSS.sql.gz
#   .backups/minio-mirror-YYYYMMDD-HHMMSS.tar.gz
#
# .env.docker is NOT pulled by this script — credentials are operator-owned,
# back them up manually into a password manager.

set -euo pipefail
HOST="${1:?usage: $0 user@host}"
STAMP=$(date +%Y%m%d-%H%M%S)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/.backups"
mkdir -p "$OUT"

echo "[1/3] dumping postgres on $HOST"
ssh "$HOST" 'mkdir -p /tmp/l2d-snap && docker exec lab2date-db-1 pg_dump -U lab2date -d lab2date --clean --if-exists | gzip > /tmp/l2d-snap/lab2date-prod.sql.gz'

echo "[2/3] tar-ing minio bucket on $HOST"
ssh "$HOST" '
  MOUNT=$(docker inspect lab2date-minio-1 --format "{{ range .Mounts }}{{ if eq .Destination \"/data\" }}{{ .Source }}{{ end }}{{ end }}")
  tar czf /tmp/l2d-snap/minio-mirror.tar.gz -C "$MOUNT" .
'

echo "[3/3] downloading both to $OUT"
scp "$HOST":/tmp/l2d-snap/lab2date-prod.sql.gz   "$OUT/lab2date-prod-$STAMP.sql.gz"
scp "$HOST":/tmp/l2d-snap/minio-mirror.tar.gz    "$OUT/minio-mirror-$STAMP.tar.gz"

ssh "$HOST" 'rm -rf /tmp/l2d-snap'

# Update the "latest" symlinks used by bootstrap-fresh-server.sh
ln -sf "lab2date-prod-$STAMP.sql.gz"  "$OUT/lab2date-prod.sql.gz"
ln -sf "minio-mirror-$STAMP.tar.gz"   "$OUT/minio-mirror.tar.gz"

echo
echo "snapshot complete:"
ls -lh "$OUT"/lab2date-prod-"$STAMP".sql.gz "$OUT"/minio-mirror-"$STAMP".tar.gz
