#!/bin/bash
set -e
cd /opt/lab2date
D=/opt/lab2date/backups
mkdir -p "$D"
TS=$(date +%Y%m%d-%H%M)
F="$D/lab2date-$TS.sql.gz"
docker compose exec -T db pg_dump -U lab2date lab2date | gzip > "$F"
ls -1t "$D"/lab2date-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
# Redundant copy into MinIO object storage (separate subsystem from PG volume)
AK=$(grep "^S3_ACCESS_KEY=" .env | cut -d= -f2-)
SK=$(grep "^S3_SECRET_KEY=" .env | cut -d= -f2-)
NET=$(docker inspect lab2date-minio-1 --format "{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}}{{end}}" 2>/dev/null)
if [ -n "$NET" ]; then
  docker run --rm --network "$NET" -v "$D":/b --entrypoint sh minio/mc -c \
    "mc alias set m http://minio:9000 $AK $SK >/dev/null 2>&1 && mc mb -p m/lab2date-media/backups >/dev/null 2>&1; mc cp /b/lab2date-$TS.sql.gz m/lab2date-media/backups/ >/dev/null 2>&1 && echo uploaded || echo upload-failed"
fi
echo "$(date -u) backup -> $F ($(du -h "$F" | cut -f1))"
