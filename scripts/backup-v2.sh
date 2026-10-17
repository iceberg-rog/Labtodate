#!/usr/bin/env bash
# lab2date backup v2 — database + uploaded files (MinIO), encrypted, shipped
# off this server, verified, with retention and an alert e-mail on failure.
#
#   scripts/backup-v2.sh                     run a backup (cron: daily 03:00)
#   scripts/backup-v2.sh --verify FILE       decrypt FILE and check every checksum
#   scripts/backup-v2.sh --dry-run           show the configuration, change nothing
#
# Set-up, restore and the quarterly restore drill: docs/BACKUPS.md.
#
# Configuration (environment, then $BACKUP_ENV_FILE, then the app .env):
#   BACKUP_ENCRYPTION_KEY / _FILE  passphrase (>= 32 chars). REQUIRED. Keep a copy
#                                  OFF this server (password manager) — without it
#                                  no backup can ever be restored.
#   BACKUP_TARGET                  rclone:<remote>:<path> | scp:<user>@<host>:/<path> | local:<dir>
#                                  (Admin → Settings → Security overrides it when set there)
#   BACKUP_KEEP_DAILY / _MONTHLY   retention at the destination (admin setting wins)
#   BACKUP_SSH_KEY                 private key for scp targets (default ~/.ssh/id_ed25519)
#   BACKUP_ALERT_EMAIL             fallback alert address when the app can't be reached
#   BACKUP_APP_URL                 http://127.0.0.1:${WEB_PORT:-3000}
#   BACKUP_DB_DUMP_CMD             default: docker compose exec -T db pg_dump -Fc …
#   BACKUP_DB_VERIFY_CMD           default: docker compose exec -T db pg_restore --list (dump on stdin)
#   BACKUP_MEDIA_SYNC_CMD          default: minio/mc mirror of $S3_BUCKET; '{dir}' = destination
#   BACKUP_LOCAL_DIR / _LOCAL_KEEP local encrypted copies kept on this server (default 2)
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/lab2date}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-$APP_DIR/backup.env}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; FAIL_REASON="$*"; exit 1; }

# KEY=VALUE files, without executing them; variables already set win.
load_env() {
  local file="$1" line key val
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    if [[ -z "${!key+x}" ]]; then export "$key=$val"; fi
  done <"$file"
}
load_env "$BACKUP_ENV_FILE"
load_env "$ENV_FILE"

MODE="run"
VERIFY_FILE=""
case "${1:-}" in
  --verify) MODE="verify"; VERIFY_FILE="${2:-}";;
  --dry-run) MODE="dry-run";;
  "") ;;
  *) echo "usage: $0 [--verify FILE | --dry-run]" >&2; exit 2;;
esac

APP_URL="${BACKUP_APP_URL:-http://127.0.0.1:${WEB_PORT:-3000}}"
HOST_LABEL="${BACKUP_HOST_LABEL:-$(hostname 2>/dev/null || echo server)}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-$APP_DIR/backups}"
LOCAL_KEEP="${BACKUP_LOCAL_KEEP:-2}"
COMPOSE=(docker compose -f "$APP_DIR/docker-compose.yml")
PGUSER_="${POSTGRES_USER:-lab2date}"
PGDB_="${POSTGRES_DB:-lab2date}"
S3_BUCKET_="${S3_BUCKET:-lab2date-media}"

passphrase() {
  if [[ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]]; then
    [[ -r "$BACKUP_ENCRYPTION_KEY_FILE" ]] || die "BACKUP_ENCRYPTION_KEY_FILE $BACKUP_ENCRYPTION_KEY_FILE is not readable"
    tr -d '\r\n' <"$BACKUP_ENCRYPTION_KEY_FILE"
  else
    printf '%s' "${BACKUP_ENCRYPTION_KEY:-}"
  fi
}

gpg_encrypt() { # in out
  passphrase | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
    --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
    --output "$2" "$1" 2>/dev/null || return 1
}
gpg_decrypt() { # in out
  passphrase | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
    --decrypt --output "$2" "$1" 2>/dev/null
}

sha() { sha256sum "$1" | awk '{print $1}'; }

# ── verify an archive: decrypt, untar, check the manifest checksums ─────────
verify_archive() {
  local file="$1" dir="$2"
  mkdir -p "$dir"
  gpg_decrypt "$file" "$dir/archive.tar" || { echo "decryption failed (wrong key or damaged file)"; return 1; }
  tar -xf "$dir/archive.tar" -C "$dir" || { echo "tar extraction failed"; return 1; }
  (cd "$dir" && sha256sum -c --quiet SHA256SUMS) || { echo "checksum mismatch inside the archive"; return 1; }
  if [[ -n "${BACKUP_DB_VERIFY_CMD:-}" ]]; then
    bash -c "$BACKUP_DB_VERIFY_CMD" <"$dir/db.dump" >/dev/null || { echo "database dump check failed"; return 1; }
  elif command -v docker >/dev/null 2>&1; then
    "${COMPOSE[@]}" exec -T db pg_restore --list <"$dir/db.dump" >/dev/null || { echo "pg_restore --list failed"; return 1; }
  fi
  return 0
}

if [[ "$MODE" == "verify" ]]; then
  [[ -f "$VERIFY_FILE" ]] || { echo "usage: $0 --verify FILE"; exit 2; }
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if out="$(verify_archive "$VERIFY_FILE" "$tmp")"; then
    echo "OK: $(wc -l <"$tmp/SHA256SUMS") files verified ($(cat "$tmp/manifest.txt" 2>/dev/null | tr '\n' ' '))"
    exit 0
  fi
  echo "FAILED: $out"
  exit 1
fi

# ── settings from Admin → Settings → Security (falls back to env) ──────────
TARGET="${BACKUP_TARGET:-}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-30}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-12}"
ALERT_EMAIL="${BACKUP_ALERT_EMAIL:-${COMPANY_EMAIL:-}}"
CONFIG_SOURCE="env"
if [[ -n "${CRON_SECRET:-}" ]]; then
  if cfg="$(curl -fsS --max-time 10 -H "X-Cron-Secret: $CRON_SECRET" "$APP_URL/api/cron/backup-report" 2>/dev/null)"; then
    t="$(printf '%s' "$cfg" | sed -n 's/.*"target":"\([^"]*\)".*/\1/p')"
    d="$(printf '%s' "$cfg" | sed -n 's/.*"keepDaily":\([0-9]*\).*/\1/p')"
    m="$(printf '%s' "$cfg" | sed -n 's/.*"keepMonthly":\([0-9]*\).*/\1/p')"
    a="$(printf '%s' "$cfg" | sed -n 's/.*"alertEmails":"\([^"]*\)".*/\1/p')"
    [[ -n "$t" ]] && TARGET="$t"
    [[ -n "$d" ]] && KEEP_DAILY="$d"
    [[ -n "$m" ]] && KEEP_MONTHLY="$m"
    [[ -n "$a" ]] && ALERT_EMAIL="$a"
    CONFIG_SOURCE="admin settings"
  fi
fi

if [[ "$MODE" == "dry-run" ]]; then
  echo "app:          $APP_URL (config from $CONFIG_SOURCE)"
  echo "destination:  ${TARGET:-<not set>}"
  echo "retention:    $KEEP_DAILY daily + $KEEP_MONTHLY monthly"
  echo "local copies: $LOCAL_KEEP in $LOCAL_DIR"
  echo "encryption:   $( [[ -n "$(passphrase)" ]] && echo 'key present' || echo 'NO KEY - backups would fail')"
  echo "alerts:       app e-mail to super-admins${ALERT_EMAIL:+, fallback $ALERT_EMAIL}"
  exit 0
fi

# ── reporting / alerting ────────────────────────────────────────────────────
RUN_ID=""
FAIL_REASON=""
LOG_FILE="$(mktemp)"
exec > >(tee -a "$LOG_FILE") 2>&1

# stdin → JSON string literal (pure bash: no python / node on the host needed).
json_escape() {
  local s
  s="$(LC_ALL=C tr -d '\000-\010\013\014\016-\037')"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/}"
  s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}

report() { # json body → prints runId (or nothing)
  [[ -n "${CRON_SECRET:-}" ]] || return 1
  curl -fsS --max-time 20 -X POST -H "Content-Type: application/json" -H "X-Cron-Secret: $CRON_SECRET" \
    --data "$1" "$APP_URL/api/cron/backup-report" 2>/dev/null | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p'
}

direct_alert() { # subject text - when the app itself can't be reached
  [[ -n "$ALERT_EMAIL" && -n "${SMTP_HOST:-}" ]] || { log "no fallback alert channel (BACKUP_ALERT_EMAIL / SMTP_HOST)"; return 1; }
  local mail rcpt args=() proto="smtp"
  mail="$(mktemp)"
  printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
    "${EMAIL_FROM:-backup@localhost}" "$ALERT_EMAIL" "$1" "$2" >"$mail"
  [[ "${SMTP_PORT:-465}" == "465" ]] && proto="smtps"
  [[ -n "${SMTP_USER:-}" ]] && args+=(--user "$SMTP_USER:${SMTP_PASS:-}")
  [[ "$proto" == "smtp" && "${SMTP_PORT:-25}" != "25" && "${SMTP_PORT:-}" != "1025" ]] && args+=(--ssl-reqd)
  for rcpt in ${ALERT_EMAIL//,/ }; do args+=(--mail-rcpt "$rcpt"); done
  curl -fsS --max-time 30 "$proto://$SMTP_HOST:${SMTP_PORT:-465}" "${args[@]}" \
    --mail-from "$(printf '%s' "${EMAIL_FROM:-backup@localhost}" | sed 's/.*<\(.*\)>.*/\1/')" -T "$mail" && log "fallback alert e-mailed to $ALERT_EMAIL"
  rm -f "$mail"
}

on_exit() {
  local code=$?
  set +e
  [[ -n "${WORK:-}" && -d "${WORK:-}" ]] && rm -rf "$WORK"
  if [[ $code -ne 0 ]]; then
    local reason="${FAIL_REASON:-exit code $code at line ${LAST_LINE:-?}}"
    log "BACKUP FAILED: $reason"
    local tail_log
    tail_log="$(tail -n 40 "$LOG_FILE" | json_escape)"
    local body
    body="{\"status\":\"FAILED\",${RUN_ID:+\"runId\":\"$RUN_ID\",}\"host\":\"$HOST_LABEL\",\"target\":\"${TARGET:-}\",\"error\":$(printf '%s' "$reason" | json_escape),\"log\":$tail_log}"
    if [[ -z "$(report "$body")" ]]; then
      direct_alert "[lab2date] BACKUP FAILED on $HOST_LABEL" "The backup failed: $reason

The app could not be reached to record this. Last log lines:
$(tail -n 40 "$LOG_FILE")"
    fi
  fi
  rm -f "$LOG_FILE"
}
trap 'LAST_LINE=$LINENO' ERR
trap on_exit EXIT

if command -v flock >/dev/null 2>&1; then
  exec 9>"${TMPDIR:-/tmp}/lab2date-backup.lock"
  flock -n 9 || die "another backup is still running"
fi

# ── preconditions ───────────────────────────────────────────────────────────
command -v gpg >/dev/null || die "gpg is not installed (apt install gnupg)"
if [[ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" && ! -r "$BACKUP_ENCRYPTION_KEY_FILE" ]]; then
  die "the encryption key file $BACKUP_ENCRYPTION_KEY_FILE is missing or not readable"
fi
key="$(passphrase)"
[[ ${#key} -ge 32 ]] || die "BACKUP_ENCRYPTION_KEY is missing or shorter than 32 characters - refusing to write an unencrypted or weakly encrypted backup"
unset key
[[ -n "$TARGET" ]] || die "no off-site destination: set Admin -> Settings -> Security -> Off-site backup destination (or BACKUP_TARGET)"
case "$TARGET" in
  rclone:*) command -v rclone >/dev/null || die "rclone is not installed (https://rclone.org/install/)";;
  scp:*) command -v scp >/dev/null || die "scp is not installed";;
  local:*) ;;
  *) die "unknown BACKUP_TARGET '$TARGET' (rclone:..., scp:..., local:...)";;
esac

STAMP="$(date -u +%Y%m%d-%H%M%S)"
NAME="lab2date-$STAMP.tar.gpg"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/l2d-backup.XXXXXX")"
STAGE="$WORK/stage"
mkdir -p "$STAGE/media" "$LOCAL_DIR"
RUN_ID="$(report "{\"status\":\"RUNNING\",\"host\":\"$HOST_LABEL\",\"target\":\"$TARGET\"}" || true)"
log "backup $NAME -> $TARGET (config: $CONFIG_SOURCE; run ${RUN_ID:-not recorded})"

# ── 1. database ─────────────────────────────────────────────────────────────
log "dumping database"
if [[ -n "${BACKUP_DB_DUMP_CMD:-}" ]]; then
  bash -c "$BACKUP_DB_DUMP_CMD" >"$STAGE/db.dump" || die "database dump failed"
else
  "${COMPOSE[@]}" exec -T db pg_dump -U "$PGUSER_" -d "$PGDB_" -Fc >"$STAGE/db.dump" || die "pg_dump failed"
fi
DB_BYTES="$(wc -c <"$STAGE/db.dump" | tr -d ' ')"
[[ "$DB_BYTES" -gt 1024 ]] || die "database dump is suspiciously small ($DB_BYTES bytes)"
if [[ -n "${BACKUP_DB_VERIFY_CMD:-}" ]]; then
  bash -c "$BACKUP_DB_VERIFY_CMD" <"$STAGE/db.dump" >/dev/null || die "the database dump does not read back"
else
  "${COMPOSE[@]}" exec -T db pg_restore --list <"$STAGE/db.dump" >/dev/null || die "pg_restore --list cannot read the dump"
fi
log "database: $DB_BYTES bytes, readable"

# ── 2. uploaded files (payment proofs, receipts, attachments, images) ──────
log "copying uploaded files from bucket $S3_BUCKET_"
if [[ -n "${BACKUP_MEDIA_SYNC_CMD:-}" ]]; then
  bash -c "${BACKUP_MEDIA_SYNC_CMD//\{dir\}/$STAGE/media}" || die "media copy failed"
else
  NET="${BACKUP_MINIO_NETWORK:-$(docker inspect lab2date-minio-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null || true)}"
  [[ -n "$NET" ]] || die "MinIO container network not found (set BACKUP_MINIO_NETWORK)"
  docker run --rm --network "$NET" -e "AK=$S3_ACCESS_KEY" -e "SK=$S3_SECRET_KEY" -v "$STAGE/media:/out" --entrypoint sh minio/mc -c \
    "mc alias set m http://minio:9000 \"\$AK\" \"\$SK\" >/dev/null && mc mirror --quiet --overwrite --exclude 'backups/*' m/$S3_BUCKET_ /out" \
    || die "mc mirror of the media bucket failed"
fi
MEDIA_OBJECTS="$(find "$STAGE/media" -type f | wc -l | tr -d ' ')"
MEDIA_BYTES="$(du -sb "$STAGE/media" 2>/dev/null | awk '{print $1}')"
log "media: $MEDIA_OBJECTS files, ${MEDIA_BYTES:-0} bytes"

# ── 3. manifest + checksums, archive, encrypt ───────────────────────────────
{
  echo "created=$STAMP"
  echo "host=$HOST_LABEL"
  echo "db_bytes=$DB_BYTES"
  echo "media_objects=$MEDIA_OBJECTS"
  echo "media_bytes=${MEDIA_BYTES:-0}"
} >"$STAGE/manifest.txt"
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS)
tar -cf "$WORK/archive.tar" -C "$STAGE" . || die "tar failed"
gpg_encrypt "$WORK/archive.tar" "$WORK/$NAME" || die "encryption failed"
rm -f "$WORK/archive.tar"
ARCHIVE_BYTES="$(wc -c <"$WORK/$NAME" | tr -d ' ')"
SUM="$(sha "$WORK/$NAME")"
printf '%s  %s\n' "$SUM" "$NAME" >"$WORK/$NAME.sha256"
log "encrypted archive: $ARCHIVE_BYTES bytes, sha256 $SUM"

# The archive must decrypt and every checksum inside must match BEFORE it is shipped.
vout="$(verify_archive "$WORK/$NAME" "$WORK/verify")" || die "the new archive does not verify: $vout"
rm -rf "$WORK/verify"
log "archive decrypts and all checksums match"

# ── 4. ship off-site + verify the copy there ────────────────────────────────
remote_put() {
  case "$TARGET" in
    rclone:*) rclone copyto "$1" "${TARGET#rclone:}/$2";;
    scp:*) scp -q -o BatchMode=yes -i "${BACKUP_SSH_KEY:-$HOME/.ssh/id_ed25519}" "$1" "${TARGET#scp:}/$2";;
    local:*) mkdir -p "${TARGET#local:}" && cp "$1" "${TARGET#local:}/$2";;
  esac
}
remote_sha() {
  case "$TARGET" in
    rclone:*) rclone cat "${TARGET#rclone:}/$1" | sha256sum | awk '{print $1}';;
    scp:*) local hp="${TARGET#scp:}"; ssh -o BatchMode=yes -i "${BACKUP_SSH_KEY:-$HOME/.ssh/id_ed25519}" "${hp%%:*}" "sha256sum '${hp#*:}/$1'" | awk '{print $1}';;
    local:*) sha "${TARGET#local:}/$1";;
  esac
}
remote_list() {
  case "$TARGET" in
    rclone:*) rclone lsf "${TARGET#rclone:}" --include 'lab2date-*.tar.gpg';;
    scp:*) local hp="${TARGET#scp:}"; ssh -o BatchMode=yes -i "${BACKUP_SSH_KEY:-$HOME/.ssh/id_ed25519}" "${hp%%:*}" "cd '${hp#*:}' && ls -1 lab2date-*.tar.gpg 2>/dev/null || true";;
    local:*) (cd "${TARGET#local:}" && ls -1 lab2date-*.tar.gpg 2>/dev/null || true);;
  esac
}
remote_delete() {
  case "$TARGET" in
    rclone:*) rclone deletefile "${TARGET#rclone:}/$1"; rclone deletefile "${TARGET#rclone:}/$1.sha256" 2>/dev/null || true;;
    scp:*) local hp="${TARGET#scp:}"; ssh -o BatchMode=yes -i "${BACKUP_SSH_KEY:-$HOME/.ssh/id_ed25519}" "${hp%%:*}" "rm -f '${hp#*:}/$1' '${hp#*:}/$1.sha256'";;
    local:*) rm -f "${TARGET#local:}/$1" "${TARGET#local:}/$1.sha256";;
  esac
}

log "uploading"
remote_put "$WORK/$NAME" "$NAME" || die "upload to $TARGET failed"
remote_put "$WORK/$NAME.sha256" "$NAME.sha256" || die "upload of the checksum file failed"
RSUM="$(remote_sha "$NAME" || true)"
[[ "$RSUM" == "$SUM" ]] || die "the off-site copy does not match (local $SUM, remote ${RSUM:-unreadable})"
log "off-site copy verified (sha256 matches)"

# ── 5. retention: N days of dailies + the first archive of each of M months ─
mapfile -t ARCHIVES < <(remote_list | sort)
if [[ ${#ARCHIVES[@]} -gt 0 ]]; then
  cutoff_daily="$(date -u -d "-$KEEP_DAILY days" +%Y%m%d 2>/dev/null || date -u -v-"$KEEP_DAILY"d +%Y%m%d)"
  cutoff_month="$(date -u -d "-$KEEP_MONTHLY months" +%Y%m 2>/dev/null || date -u -v-"$KEEP_MONTHLY"m +%Y%m)"
  declare -A first_of_month=()
  for a in "${ARCHIVES[@]}"; do
    ym="${a:9:6}"
    [[ -z "${first_of_month[$ym]:-}" ]] && first_of_month[$ym]="$a"
  done
  deleted=0
  for a in "${ARCHIVES[@]}"; do
    [[ "$a" == "$NAME" ]] && continue
    day="${a:9:8}"
    ym="${a:9:6}"
    [[ "$day" =~ ^[0-9]{8}$ ]] || continue
    if [[ "$day" -ge "$cutoff_daily" ]]; then continue; fi
    if [[ "$KEEP_MONTHLY" -gt 0 && "${first_of_month[$ym]}" == "$a" && "$ym" -gt "$cutoff_month" ]]; then continue; fi
    remote_delete "$a" && deleted=$((deleted + 1)) && log "retention: deleted $a"
  done
  log "retention: kept $(( ${#ARCHIVES[@]} - deleted )) archive(s) ($KEEP_DAILY daily + $KEEP_MONTHLY monthly)"
fi

# ── 6. local copies (fast restore) ──────────────────────────────────────────
cp "$WORK/$NAME" "$WORK/$NAME.sha256" "$LOCAL_DIR/"
ls -1t "$LOCAL_DIR"/lab2date-*.tar.gpg 2>/dev/null | tail -n +"$((LOCAL_KEEP + 1))" | while read -r old; do rm -f "$old" "$old.sha256"; done

# ── 7. report success ───────────────────────────────────────────────────────
body="{\"status\":\"OK\",${RUN_ID:+\"runId\":\"$RUN_ID\",}\"host\":\"$HOST_LABEL\",\"target\":\"$TARGET\",\"archiveName\":\"$NAME\",\"archiveBytes\":$ARCHIVE_BYTES,\"dbBytes\":$DB_BYTES,\"mediaBytes\":${MEDIA_BYTES:-0},\"mediaObjects\":$MEDIA_OBJECTS,\"sha256\":\"$SUM\",\"verified\":true}"
if [[ -z "$(report "$body")" ]]; then
  log "WARNING: backup OK but the app did not record it (admin tile will show it as missing)"
fi
log "backup OK: $NAME ($ARCHIVE_BYTES bytes) -> $TARGET"
