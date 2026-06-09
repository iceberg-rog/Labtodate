#!/usr/bin/env bash
# build-bundle.sh — pack .env + DB dump + MinIO mirror into ONE encrypted
# bundle ready to upload anywhere (Drive, Dropbox, Backblaze, transfer.sh).
#
# Run this on your laptop, from the repo root. Requires openssl.
#
#   PASS='mySecret' bash scripts/build-bundle.sh
#
# Result: lab2date-bundle.enc  (~375 MB, AES-256-CBC encrypted with PASS).
#
# Upload that one file somewhere reachable from the new server. Then on
# the new server:
#
#   curl -fsSL https://raw.githubusercontent.com/iceberg-rog/Labtodate/main/scripts/install.sh \
#     | sudo BUNDLE_URL='<your-download-url>' BUNDLE_PASS='mySecret' bash
#
# Bundle hosting tips:
#   - Google Drive: upload → right-click → Share → "Anyone with link" →
#     convert URL: https://drive.google.com/uc?export=download&id=<FILE_ID>
#   - Dropbox: upload → share → replace `dl=0` with `dl=1` at end of URL
#   - transfer.sh: `curl --upload-file lab2date-bundle.enc https://transfer.sh/lab2date-bundle.enc`
#     (anonymous, 14-day TTL, returns direct URL — fine for one-shot migration)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

[[ -n "${PASS:-}" ]] || { echo "[err] set PASS env var: PASS='mySecret' bash $0"; exit 1; }
[[ -f .env ]] || { echo "[err] .env missing in $REPO_ROOT — copy production .env here first"; exit 1; }
[[ -f .backups/lab2date-prod.sql.gz ]] || { echo "[err] .backups/lab2date-prod.sql.gz missing"; exit 1; }
[[ -f .backups/minio-mirror.tar.gz ]] || { echo "[err] .backups/minio-mirror.tar.gz missing"; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "[err] openssl not installed"; exit 1; }

OUT="$REPO_ROOT/lab2date-bundle.enc"
TMP="$(mktemp -t l2d-bundle.tar.gz.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

echo "==> packing .env + .backups/ into encrypted bundle"
tar czf "$TMP" .env .backups/lab2date-prod.sql.gz .backups/minio-mirror.tar.gz

# AES-256-CBC with PBKDF2 (modern openssl default).
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -in "$TMP" -out "$OUT" -pass env:PASS

echo
echo "==> bundle created:"
ls -lh "$OUT"
echo
cat <<MSG
next steps:
  1) upload $(basename "$OUT") to wherever the new server can reach
     (google drive, dropbox, transfer.sh, your own s3/r2 bucket)
  2) get a DIRECT download url (must serve the raw file, not an html page)
  3) on the new server run:

     curl -fsSL https://raw.githubusercontent.com/iceberg-rog/Labtodate/main/scripts/install.sh \\
       | sudo BUNDLE_URL='<your-url>' BUNDLE_PASS='$PASS' bash

reminder: keep PASS in a password manager. without it the bundle is unrecoverable.
MSG
