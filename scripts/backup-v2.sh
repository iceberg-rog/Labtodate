#!/usr/bin/env bash
# lab2date backup v2: database + uploaded files (MinIO), encrypted, verified,
# kept on this server and off-site, with retention. Every failure is loud.
#
#   backup-v2.sh                       run a backup (cron: daily 03:00 UTC)
#   backup-v2.sh --verify FILE         decrypt FILE, check every checksum and the DB dump
#   backup-v2.sh --restore-test FILE [SAMPLE_DIR]
#                                      restore FILE into a throwaway database and compare the
#                                      files with production. Production is not changed.
#                                      SAMPLE_DIR receives the spot-checked photos.
#   backup-v2.sh --status              last result, local archives, off-site receipts
#   backup-v2.sh --dry-run             show the configuration, change nothing
#
# Set-up, restore and the restore drill: docs/BACKUPS.md.
#
# Configuration (environment, then $BACKUP_ENV_FILE, then the app .env):
#   BACKUP_ENCRYPTION_KEY_FILE / _KEY   passphrase (>= 32 chars). REQUIRED. Keep a copy OFF this
#                                       server (password manager): without it nothing can be restored.
#   BACKUP_TARGET     pull | scp:<user>@<host>:/<path> | rclone:<remote>:<path> | local:<dir>
#                     pull = an off-site machine fetches the archives (scripts/backup-pull.sh) and
#                     leaves a receipt in $BACKUP_LOCAL_DIR/offsite/. Admin -> Settings -> Security
#                     overrides it on app versions that have that page.
#   BACKUP_SSH_KEY / BACKUP_SSH_PORT    scp targets (default ~/.ssh/id_ed25519, port 22)
#   BACKUP_KEEP_DAILY / _MONTHLY        retention at a push destination (30 + 12)
#   BACKUP_LOCAL_DIR / _LOCAL_KEEP      encrypted copies on this server (/var/backups/lab2date, 7)
#   BACKUP_OFFSITE_MAX_AGE_HOURS        warn when the newest backup that exists off-site is older (50)
#   BACKUP_MAX_SHRINK_PCT               fail when the DB dump or the file count shrank more than this
#                                       against the last good backup (20); BACKUP_ALLOW_SHRINK=1
#                                       accepts it once
#   BACKUP_RESTORE_DRILL                1 = restore every new dump into a throwaway database (1)
#   BACKUP_PG_IMAGE / BACKUP_MC_IMAGE   local images (postgres:16-alpine, minio/mc), never pulled
#   BACKUP_ALERT_EMAIL + SMTP_*         failure e-mail when the app cannot record the failure
#   BACKUP_APP_URL                      http://127.0.0.1:${WEB_PORT:-3000}
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/lab2date}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
if [[ -z "${BACKUP_ENV_FILE:-}" ]]; then
  BACKUP_ENV_FILE=/etc/lab2date-backup/backup.env
  [[ -f "$BACKUP_ENV_FILE" ]] || BACKUP_ENV_FILE="$APP_DIR/backup.env"
fi

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
ARG1=""
ARG2=""
case "${1:-}" in
  --verify) MODE="verify"; ARG1="${2:-}";;
  --restore-test) MODE="restore-test"; ARG1="${2:-}"; ARG2="${3:-}";;
  --status) MODE="status";;
  --dry-run) MODE="dry-run";;
  "") ;;
  *) echo "usage: $0 [--verify FILE | --restore-test FILE [SAMPLE_DIR] | --status | --dry-run]" >&2; exit 2;;
esac

APP_URL="${BACKUP_APP_URL:-http://127.0.0.1:${WEB_PORT:-3000}}"
HOST_LABEL="${BACKUP_HOST_LABEL:-$(hostname 2>/dev/null || echo server)}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/lab2date}"
LOCAL_KEEP="${BACKUP_LOCAL_KEEP:-7}"
OFFSITE_MAX_AGE_H="${BACKUP_OFFSITE_MAX_AGE_HOURS:-50}"
MAX_SHRINK_PCT="${BACKUP_MAX_SHRINK_PCT:-20}"
PG_IMAGE="${BACKUP_PG_IMAGE:-postgres:16-alpine}"
MC_IMAGE="${BACKUP_MC_IMAGE:-minio/mc}"
COMPOSE=(docker compose)
PGUSER_="${POSTGRES_USER:-lab2date}"
PGDB_="${POSTGRES_DB:-lab2date}"
S3_BUCKET_="${S3_BUCKET:-lab2date-media}"
WORK=""
DRILL_CT=""
cd "$APP_DIR" 2>/dev/null || true

# ── encryption ──────────────────────────────────────────────────────────────
passphrase() {
  if [[ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]]; then
    [[ -r "$BACKUP_ENCRYPTION_KEY_FILE" ]] || { echo "BACKUP_ENCRYPTION_KEY_FILE $BACKUP_ENCRYPTION_KEY_FILE is not readable" >&2; return 1; }
    tr -d '\r\n' <"$BACKUP_ENCRYPTION_KEY_FILE"
  else
    printf '%s' "${BACKUP_ENCRYPTION_KEY:-}"
  fi
}
# The passphrase goes in on fd 3 so stdin/stdout stay free for the data stream.
# --no-symkey-cache: gpg-agent must not remember it (a later check with a wrong key must fail).
GPG=(gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-fd 3)
encrypt_to() { "${GPG[@]}" --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 --output "$1" 3< <(passphrase); }
decrypt_stdout() { "${GPG[@]}" --decrypt "$1" 3< <(passphrase); }

sha() { sha256sum "$1" | awk '{print $1}'; }
kv_get() { [[ -f "$1" ]] || return 0; sed -n "s/^$2=//p" "$1" | head -n 1; }
archive_epoch() { # lab2date-YYYYmmdd-HHMMSS.tar.gpg -> epoch seconds
  local s="${1##*/}"
  date -u -d "${s:9:8} ${s:18:2}:${s:20:2}:${s:22:2}" +%s 2>/dev/null || echo 0
}

# ── verify an archive: decrypt, unpack, check checksums, counts and the dump ─
verify_archive() { # file dir -> prints a one-line summary, non-zero on any problem
  local file="$1" dir="$2" listed present want got
  mkdir -p "$dir"
  decrypt_stdout "$file" | tar -xf - -C "$dir" || { echo "decryption or unpacking failed (wrong key or damaged file)"; return 1; }
  for f in SHA256SUMS manifest.txt counts.tsv db.dump; do
    [[ -f "$dir/$f" ]] || { echo "the archive has no $f"; return 1; }
  done
  (cd "$dir" && sha256sum -c --quiet --strict SHA256SUMS) || { echo "checksum mismatch inside the archive"; return 1; }
  listed="$(grep -c . "$dir/SHA256SUMS")"
  present="$(cd "$dir" && find . -type f ! -name SHA256SUMS | wc -l)"
  [[ "$listed" == "$present" ]] || { echo "the archive holds $present files but SHA256SUMS lists $listed"; return 1; }
  want="$(kv_get "$dir/manifest.txt" media_objects)"
  got="$(find "$dir/media" -type f 2>/dev/null | wc -l)"
  [[ "$want" == "$got" ]] || { echo "the manifest says $want media files, the archive holds $got"; return 1; }
  docker run --rm -i --pull never --network none --entrypoint pg_restore "$PG_IMAGE" --list <"$dir/db.dump" >/dev/null \
    || { echo "pg_restore --list cannot read the database dump"; return 1; }
  echo "$listed checksums match, $got media files, database dump readable (created $(kv_get "$dir/manifest.txt" created))"
}

# ── restore drill: the dump goes into a throwaway postgres (no network, RAM disk) ─
read -r -d '' COUNT_SQL <<'SQL' || true
select table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by 1
SQL

live_counts() { "${COMPOSE[@]}" exec -T db psql -U "$PGUSER_" -d "$PGDB_" -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "$COUNT_SQL" </dev/null; }
drill_sql() { docker exec "$DRILL_CT" psql -U "$PGUSER_" -d "$PGDB_" -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "$1" </dev/null; }
drill_stop() {
  if [[ -n "$DRILL_CT" ]]; then docker rm -f "$DRILL_CT" >/dev/null 2>&1 </dev/null || true; fi
  DRILL_CT=""
}
drill_start() { # needs DRILL_CT set by the caller's shell: restore_drill runs in $(...)
  local pw i
  pw="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  docker run -d --rm --pull never --name "$DRILL_CT" --network none \
    --tmpfs "/var/lib/postgresql/data:rw,size=${BACKUP_DRILL_TMPFS:-2g}" \
    -e POSTGRES_USER="$PGUSER_" -e POSTGRES_DB="$PGDB_" -e POSTGRES_PASSWORD="$pw" \
    "$PG_IMAGE" >/dev/null </dev/null || return 1
  # The image's init phase runs a socket-only server first; TCP answers only once the real one is up.
  for i in $(seq 1 90); do
    docker exec "$DRILL_CT" pg_isready -q -h 127.0.0.1 -U "$PGUSER_" -d "$PGDB_" </dev/null && return 0
    sleep 1
  done
  return 1
}

compare_counts() { # baseline.tsv restored.tsv -> prints "N tables, M rows" or the problems
  awk -F'\t' '
    NR == FNR { base[$1] = $2; next }
    { rest[$1] = $2 }
    END {
      bad = 0; tables = 0; rows = 0
      for (t in base) {
        tables++
        if (!(t in rest)) { printf "table %s is missing after the restore; ", t; bad = 1; continue }
        b = base[t] + 0; r = rest[t] + 0; rows += r
        d = b - r; if (d < 0) d = -d
        tol = b * 0.02; if (tol < 5) tol = 5
        if (d > tol) { printf "table %s had %d rows at backup time but %d after the restore; ", t, b, r; bad = 1 }
      }
      for (t in rest) if (!(t in base)) { printf "unexpected table %s after the restore; ", t; bad = 1 }
      if (tables == 0) { printf "no tables in the backup"; bad = 1 }
      if (!bad) printf "%d tables, %d rows, every table matches the counts taken at backup time", tables, rows
      exit bad
    }' "$1" "$2"
}

restore_drill() { # dir (with db.dump + counts.tsv) -> leaves $DRILL_CT running on success
  local dir="$1" out restored t0
  [[ -n "$DRILL_CT" ]] || { echo "internal: DRILL_CT is not set"; return 1; }
  t0="$(date +%s)"
  drill_start || { echo "the throwaway postgres container did not start"; drill_stop; return 1; }
  if ! out="$(docker exec -i "$DRILL_CT" pg_restore -U "$PGUSER_" -d "$PGDB_" --no-owner --exit-on-error <"$dir/db.dump" 2>&1)"; then
    echo "pg_restore into the throwaway database failed: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    drill_stop; return 1
  fi
  restored="$(drill_sql "$COUNT_SQL")" || { echo "cannot count rows in the restored database"; drill_stop; return 1; }
  out="$(compare_counts "$dir/counts.tsv" <(printf '%s\n' "$restored"))" || { echo "$out"; drill_stop; return 1; }
  echo "$out (restored in $(( $(date +%s) - t0 )) s)"
}

# ── MinIO access: runs a shell snippet in the mc image with alias "m" ───────
mc_run() { # script [extra docker args...]
  local script="$1" net envf rc=0
  shift
  net="${BACKUP_MINIO_NETWORK:-$(docker inspect lab2date-minio-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null </dev/null || true)}"
  [[ -n "$net" ]] || { echo "MinIO container network not found (set BACKUP_MINIO_NETWORK)" >&2; return 1; }
  [[ -n "${S3_ACCESS_KEY:-}" && -n "${S3_SECRET_KEY:-}" ]] || { echo "S3_ACCESS_KEY / S3_SECRET_KEY are missing from $ENV_FILE" >&2; return 1; }
  envf="$(mktemp)"
  printf 'AK=%s\nSK=%s\nB=%s\n' "$S3_ACCESS_KEY" "$S3_SECRET_KEY" "$S3_BUCKET_" >"$envf"
  docker run --rm -i --pull never --network "$net" --env-file "$envf" "$@" --entrypoint sh "$MC_IMAGE" -c \
    "mc alias set m http://minio:9000 \"\$AK\" \"\$SK\" >/dev/null && $script" || rc=$?
  rm -f "$envf"
  return "$rc"
}

# ── off-site receipts ($LOCAL_DIR/offsite/<archive>.<destination>.ok) ───────
OFFSITE_STATE="unknown"
OFFSITE_NEWEST=""
offsite_check() { # sets OFFSITE_STATE (OK | STALE | NONE) and OFFSITE_NEWEST
  local newest="" r a age
  for r in "$LOCAL_DIR"/offsite/lab2date-*.ok; do
    [[ -e "$r" ]] || continue
    a="$(basename "$r")"
    a="${a%%.tar.gpg.*}.tar.gpg"
    [[ "$a" > "$newest" ]] && newest="$a"
  done
  if [[ -z "$newest" ]]; then OFFSITE_STATE="NONE"; OFFSITE_NEWEST=""; return 1; fi
  age=$(( ($(date +%s) - $(archive_epoch "$newest")) / 3600 ))
  OFFSITE_NEWEST="$newest (${age} h old) at $(cd "$LOCAL_DIR/offsite" && ls -1 "$newest".*.ok | sed "s/^$newest\.//; s/\.ok$//" | paste -sd, -)"
  if (( age <= OFFSITE_MAX_AGE_H )); then OFFSITE_STATE="OK"; return 0; fi
  OFFSITE_STATE="STALE"
  return 1
}

write_status() { # result reason
  local tmp="$LOCAL_DIR/.STATUS.tmp"
  [[ -d "$LOCAL_DIR" ]] || return 0
  {
    echo "updated=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "result=$1"
    echo "reason=$2"
    echo "host=$HOST_LABEL"
    echo "target=${TARGET:-}"
    [[ -f "$LOCAL_DIR/LAST_OK" ]] && sed 's/^/last_ok_/' "$LOCAL_DIR/LAST_OK"
    echo "offsite=$OFFSITE_STATE"
    echo "offsite_newest=$OFFSITE_NEWEST"
  } >"$tmp" && mv -f "$tmp" "$LOCAL_DIR/STATUS"
}

# ── --verify ────────────────────────────────────────────────────────────────
if [[ "$MODE" == "verify" ]]; then
  [[ -f "$ARG1" ]] || { echo "usage: $0 --verify FILE" >&2; exit 2; }
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if out="$(verify_archive "$ARG1" "$tmp")"; then echo "OK: $out"; exit 0; fi
  echo "FAILED: $out"
  exit 1
fi

# ── --status ────────────────────────────────────────────────────────────────
if [[ "$MODE" == "status" ]]; then
  echo "== $LOCAL_DIR/STATUS"
  cat "$LOCAL_DIR/STATUS" 2>/dev/null || echo "(no run recorded yet)"
  echo "== local archives (keep $LOCAL_KEEP)"
  ls -l "$LOCAL_DIR"/lab2date-*.tar.gpg 2>/dev/null || echo "(none)"
  echo "== off-site receipts (newest 10)"
  ls -1 "$LOCAL_DIR"/offsite/ 2>/dev/null | sort | tail -n 10 || true
  offsite_check || true
  echo "off-site: $OFFSITE_STATE${OFFSITE_NEWEST:+ - newest $OFFSITE_NEWEST}"
  exit 0
fi

# ── settings from Admin -> Settings -> Security (falls back to env) ────────
TARGET="${BACKUP_TARGET:-}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-30}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-12}"
ALERT_EMAIL="${BACKUP_ALERT_EMAIL:-}"
CONFIG_SOURCE="env"
if [[ "$MODE" != "restore-test" && -n "${CRON_SECRET:-}" ]]; then
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
  echo "app:           $APP_URL (config from $CONFIG_SOURCE)"
  echo "destination:   ${TARGET:-<not set>}"
  echo "retention:     $KEEP_DAILY daily + $KEEP_MONTHLY monthly at the destination"
  echo "local copies:  $LOCAL_KEEP in $LOCAL_DIR"
  echo "encryption:    $( [[ "$(passphrase 2>/dev/null | wc -c)" -ge 32 ]] && echo 'key present' || echo 'NO KEY - backups would fail')"
  echo "restore drill: $( [[ "${BACKUP_RESTORE_DRILL:-1}" == 1 ]] && echo "every run ($PG_IMAGE)" || echo off)"
  echo "off-site age:  warn after $OFFSITE_MAX_AGE_H h"
  echo "alerts:        STATUS file + log${ALERT_EMAIL:+, e-mail to $ALERT_EMAIL}"
  exit 0
fi

# ── --restore-test ──────────────────────────────────────────────────────────
if [[ "$MODE" == "restore-test" ]]; then
  [[ -f "$ARG1" ]] || { echo "usage: $0 --restore-test FILE [SAMPLE_DIR]" >&2; exit 2; }
  mkdir -p "$LOCAL_DIR/.work" "$LOCAL_DIR/restore-tests"
  WORK="$(mktemp -d "$LOCAL_DIR/.work/restore-test.XXXXXX")"
  trap 'drill_stop; rm -rf "$WORK"' EXIT
  REPORT="$LOCAL_DIR/restore-tests/restore-test-$(date -u +%Y%m%d-%H%M%S).txt"
  exec > >(tee "$REPORT") 2>&1
  PROBLEMS=0
  problem() { log "PROBLEM: $*"; PROBLEMS=$((PROBLEMS + 1)); }
  D="$WORK/x"

  log "restore test of $ARG1"
  log "file: $(wc -c <"$ARG1" | tr -d ' ') bytes, sha256 $(sha "$ARG1")"
  out="$(verify_archive "$ARG1" "$D")" || die "the archive does not verify: $out"
  log "1. archive: $out"
  created="$(kv_get "$D/manifest.txt" created)"
  log "   manifest: $(tr '\n' ' ' <"$D/manifest.txt")"

  DRILL_CT="l2d-restore-test-$(date +%s)-$$"
  out="$(restore_drill "$D")" || die "2. database restore failed: $out"
  log "2. database restored into throwaway container $DRILL_CT: $out"
  facts="$(drill_sql "select 'products', count(*)::text from \"Product\"
    union all select 'products with photos', count(*)::text from \"Product\" where cardinality(images) > 0
    union all select 'users', count(*)::text from \"user\"
    union all select 'orders', count(*)::text from \"Order\"
    union all select 'newest product', coalesce(max(\"createdAt\")::text, '-') from \"Product\"
    union all select 'newest user', coalesce(max(\"createdAt\")::text, '-') from \"user\"
    union all select 'newest order', coalesce(max(\"createdAt\")::text, '-') from \"Order\"" 2>/dev/null || true)"
  printf '%s\n' "$facts" | while IFS=$'\t' read -r k v; do [[ -n "$k" ]] && log "   $k: $v"; done
  live="$("${COMPOSE[@]}" exec -T db psql -U "$PGUSER_" -d "$PGDB_" -X -q -At -c 'select count(*) from "Product"' </dev/null 2>/dev/null || echo '?')"
  log "   live production right now: $live products (the backup is from $created)"

  # 3. every product photo the restored database points to must be in the archive
  refs="$(drill_sql 'select u from "Product", unnest(images) as u')" || refs=""
  total=0; present=0; external=0; missing=0; : >"$WORK/present.txt"; : >"$WORK/missing.txt"
  while IFS= read -r url; do
    [[ -n "$url" ]] || continue
    total=$((total + 1))
    case "$url" in
      */media/"$S3_BUCKET_"/*) key="${url#*/media/"$S3_BUCKET_"/}"; key="${key%%\?*}";;
      *) external=$((external + 1)); continue;;
    esac
    if [[ -f "$D/media/$key" ]]; then present=$((present + 1)); printf '%s\t%s\n' "$key" "$url" >>"$WORK/present.txt"
    else missing=$((missing + 1)); echo "$key" >>"$WORK/missing.txt"; fi
  done <<<"$refs"
  log "3. product photo references in the restored database: $total ($present in the archive, $missing missing, $external on other hosts)"
  if (( missing > 0 )); then
    problem "$missing referenced photo(s) are not in the archive, e.g. $(head -n 3 "$WORK/missing.txt" | paste -sd' ' -)"
  fi
  drill_stop

  # 4. spot-check photos: the archived bytes must equal what the site serves right now
  n=0
  [[ -n "$ARG2" ]] && mkdir -p "$ARG2"
  while IFS=$'\t' read -r key url; do
    [[ -n "$key" ]] || continue
    n=$((n + 1))
    host="${url#https://}"; host="${host%%/*}"
    a_sum="$(sha "$D/media/$key")"
    l_sum="$(curl -fsS --max-time 30 --resolve "$host:443:127.0.0.1" "$url" 2>/dev/null | sha256sum | awk '{print $1}')"
    kind="$(file -b "$D/media/$key" 2>/dev/null | cut -d, -f1-3)"
    if [[ "$a_sum" == "$l_sum" ]]; then log "4.$n photo $key: identical to the live site ($kind, sha256 ${a_sum:0:16}...)"
    else problem "photo $key differs from the live site (archive ${a_sum:0:16}, live ${l_sum:0:16})"; fi
    [[ -n "$ARG2" ]] && cp "$D/media/$key" "$ARG2/$(echo "$key" | tr '/' '_')"
  done < <(shuf -n "${BACKUP_SPOTCHECK:-6}" "$WORK/present.txt" 2>/dev/null || true)
  (( n > 0 )) || problem "no photo could be spot-checked"

  # 5. private uploads (payment proofs etc.): compare with the live bucket
  priv_total=0; priv_ok=0
  while IFS= read -r f; do
    key="${f#"$D/media/"}"
    priv_total=$((priv_total + 1))
    l_sum="$(mc_run 'mc cat "m/$B/$K"' -e "K=$key" </dev/null 2>/dev/null | sha256sum | awk '{print $1}')"
    if [[ "$l_sum" == "$(sha "$f")" ]]; then priv_ok=$((priv_ok + 1))
    else problem "private file $key differs from the live bucket (or is gone there)"; fi
  done < <(find "$D/media" -type f ! -path "$D/media/products/*" | sort | head -n "${BACKUP_PRIVATE_CHECK:-50}")
  log "5. private uploads (payment proofs, attachments): $priv_ok of $priv_total identical to the live bucket"
  log "   files by folder: $(cd "$D/media" && find . -type f | cut -d/ -f2 | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')"
  if [[ -d "$D/config" ]]; then log "6. server config in the archive (for a rebuild): $(ls -1 "$D/config" | paste -sd' ' -)"
  else log "6. no server config in this archive (made before config/ was added)"; fi

  if (( PROBLEMS > 0 )); then log "RESTORE TEST FAILED: $PROBLEMS problem(s). Report: $REPORT"; exit 1; fi
  log "RESTORE TEST PASSED. Report: $REPORT"
  exit 0
fi

# ── run: reporting / alerting ───────────────────────────────────────────────
RUN_ID=""
FAIL_REASON=""
LOG_FILE="$(mktemp)"
exec > >(tee -a "$LOG_FILE") 2>&1

# stdin -> JSON string literal (pure bash: no python / node on the host needed).
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

report() { # json body -> prints runId (or nothing); only app versions with the backup page answer
  [[ -n "${CRON_SECRET:-}" ]] || return 1
  curl -fsS --max-time 20 -X POST -H "Content-Type: application/json" -H "X-Cron-Secret: $CRON_SECRET" \
    --data "$1" "$APP_URL/api/cron/backup-report" 2>/dev/null | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p'
}

direct_alert() { # subject text
  [[ -n "$ALERT_EMAIL" && -n "${SMTP_HOST:-}" ]] || { log "no e-mail alert channel (BACKUP_ALERT_EMAIL + SMTP_*); see $LOCAL_DIR/STATUS"; return 1; }
  local mail rcpt args=() proto="smtp"
  mail="$(mktemp)"
  printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
    "${EMAIL_FROM:-backup@localhost}" "$ALERT_EMAIL" "$1" "$2" >"$mail"
  [[ "${SMTP_PORT:-465}" == "465" ]] && proto="smtps"
  [[ -n "${SMTP_USER:-}" ]] && args+=(--user "$SMTP_USER:${SMTP_PASS:-}")
  [[ "$proto" == "smtp" && "${SMTP_PORT:-25}" != "25" && "${SMTP_PORT:-}" != "1025" ]] && args+=(--ssl-reqd)
  for rcpt in ${ALERT_EMAIL//,/ }; do args+=(--mail-rcpt "$rcpt"); done
  curl -fsS --max-time 30 "$proto://$SMTP_HOST:${SMTP_PORT:-465}" "${args[@]}" \
    --mail-from "$(printf '%s' "${EMAIL_FROM:-backup@localhost}" | sed 's/.*<\(.*\)>.*/\1/')" -T "$mail" && log "alert e-mailed to $ALERT_EMAIL"
  rm -f "$mail"
}

on_exit() {
  local code=$?
  set +e
  drill_stop
  [[ -n "${WORK:-}" && -d "${WORK:-}" ]] && rm -rf "$WORK"
  if [[ $code -ne 0 ]]; then
    local reason="${FAIL_REASON:-exit code $code at line ${LAST_LINE:-?}}"
    log "BACKUP FAILED: $reason"
    offsite_check >/dev/null 2>&1
    write_status FAILED "$reason"
    local tail_log body
    tail_log="$(tail -n 40 "$LOG_FILE" | json_escape)"
    body="{\"status\":\"FAILED\",${RUN_ID:+\"runId\":\"$RUN_ID\",}\"host\":\"$HOST_LABEL\",\"target\":\"${TARGET:-}\",\"error\":$(printf '%s' "$reason" | json_escape),\"log\":$tail_log}"
    if [[ -z "$(report "$body")" ]]; then
      direct_alert "[lab2date] BACKUP FAILED on $HOST_LABEL" "The backup failed: $reason

Last log lines:
$(tail -n 40 "$LOG_FILE")"
    fi
  fi
  rm -f "$LOG_FILE"
}
trap 'LAST_LINE=$LINENO' ERR
trap on_exit EXIT

mkdir -p "$LOCAL_DIR/.work" "$LOCAL_DIR/offsite"
chmod 700 "$LOCAL_DIR"
exec 9>"$LOCAL_DIR/.lock"
flock -n 9 || die "another backup is still running"

# ── preconditions ───────────────────────────────────────────────────────────
command -v gpg >/dev/null || die "gpg is not installed (apt install gnupg)"
command -v docker >/dev/null || die "docker is not installed"
key="$(passphrase)" || die "the encryption key cannot be read"
[[ ${#key} -ge 32 ]] || die "BACKUP_ENCRYPTION_KEY is missing or shorter than 32 characters - refusing to write an unencrypted or weakly encrypted backup"
unset key
[[ -n "$TARGET" ]] || die "no off-site destination: set BACKUP_TARGET (pull, scp:..., rclone:..., local:...)"
case "$TARGET" in
  pull) ;;
  rclone:*) command -v rclone >/dev/null || die "rclone is not installed (https://rclone.org/install/)";;
  scp:*) command -v scp >/dev/null || die "scp is not installed";;
  local:*) ;;
  *) die "unknown BACKUP_TARGET '$TARGET' (pull, scp:..., rclone:..., local:...)";;
esac
for img in "$PG_IMAGE" "$MC_IMAGE"; do
  docker image inspect "$img" >/dev/null 2>&1 </dev/null || die "docker image $img is not on this server (it is never pulled automatically)"
done
prev_bytes="$(kv_get "$LOCAL_DIR/LAST_OK" archive_bytes)"
need=$(( ${prev_bytes:-500000000} * 3 + 1000000000 ))
free="$(df -PB1 "$LOCAL_DIR" | awk 'NR == 2 {print $4}')"
(( free > need )) || die "not enough disk space in $LOCAL_DIR: $free bytes free, $need needed"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
NAME="lab2date-$STAMP.tar.gpg"
WORK="$(mktemp -d "$LOCAL_DIR/.work/run.XXXXXX")"
STAGE="$WORK/stage"
mkdir -p "$STAGE/media" "$WORK/meta"
RUN_ID="$(report "{\"status\":\"RUNNING\",\"host\":\"$HOST_LABEL\",\"target\":\"$TARGET\"}" || true)"
log "backup $NAME -> $TARGET (config: $CONFIG_SOURCE)"

# ── 1. database ─────────────────────────────────────────────────────────────
log "dumping database"
"${COMPOSE[@]}" exec -T db pg_dump -U "$PGUSER_" -d "$PGDB_" -Fc >"$STAGE/db.dump" </dev/null || die "pg_dump failed"
DB_BYTES="$(wc -c <"$STAGE/db.dump" | tr -d ' ')"
[[ "$DB_BYTES" -gt 1024 ]] || die "database dump is suspiciously small ($DB_BYTES bytes)"
live_counts >"$STAGE/counts.tsv" || die "cannot count the rows of the live database"
DB_TABLES="$(grep -c . "$STAGE/counts.tsv" || true)"
DB_ROWS="$(awk -F'\t' '{s += $2} END {print s + 0}' "$STAGE/counts.tsv")"
[[ "$DB_TABLES" -gt 0 ]] || die "the live database has no tables"
log "database: $DB_BYTES bytes, $DB_TABLES tables, $DB_ROWS rows"

# ── 2. uploaded files (product photos, payment proofs, attachments) ────────
log "copying uploaded files from bucket $S3_BUCKET_"
mc_run 'mc ls --recursive --json "m/$B" > /meta/bucket-list && mc mirror --quiet --overwrite --exclude "backups/*" "m/$B" /out > /meta/mirror.log' \
  -v "$STAGE/media:/out" -v "$WORK/meta:/meta" </dev/null || die "copying the media bucket failed"
LISTED="$(grep '"type":"file"' "$WORK/meta/bucket-list" | grep -vc '"key":"backups/' || true)"
MEDIA_OBJECTS="$(find "$STAGE/media" -type f | wc -l | tr -d ' ')"
MEDIA_BYTES="$(find "$STAGE/media" -type f -printf '%s\n' | awk '{s += $1} END {print s + 0}')"
[[ "$MEDIA_OBJECTS" -ge "$LISTED" ]] || die "the bucket lists $LISTED objects but only $MEDIA_OBJECTS were copied"
log "media: $MEDIA_OBJECTS files, $MEDIA_BYTES bytes (bucket lists $LISTED)"

# A sudden drop means something is wrong upstream: never let it rotate the good backups away.
if [[ -f "$LOCAL_DIR/LAST_OK" && "${BACKUP_ALLOW_SHRINK:-0}" != 1 ]]; then
  prev_db="$(kv_get "$LOCAL_DIR/LAST_OK" db_bytes)"
  prev_media="$(kv_get "$LOCAL_DIR/LAST_OK" media_objects)"
  if [[ -n "$prev_db" ]] && (( DB_BYTES * 100 < prev_db * (100 - MAX_SHRINK_PCT) )); then
    die "the database dump shrank from $prev_db to $DB_BYTES bytes (more than $MAX_SHRINK_PCT%). If that is expected, run once with BACKUP_ALLOW_SHRINK=1"
  fi
  if [[ -n "$prev_media" ]] && (( MEDIA_OBJECTS * 100 < prev_media * (100 - MAX_SHRINK_PCT) )); then
    die "the media bucket shrank from $prev_media to $MEDIA_OBJECTS files (more than $MAX_SHRINK_PCT%). If that is expected, run once with BACKUP_ALLOW_SHRINK=1"
  fi
fi

# ── 3. server config needed to rebuild a lost server (secrets: the archive is encrypted) ─
mkdir -p "$STAGE/config"
CONFIG_FILES="${BACKUP_CONFIG_FILES:-$ENV_FILE $APP_DIR/docker-compose.override.yml /etc/nginx/sites-available/lab2date}"
for f in $CONFIG_FILES; do
  if [[ -f "$f" ]]; then cp "$f" "$STAGE/config/$(echo "${f#/}" | tr '/' '_')"; else log "config: $f not found, skipped"; fi
done
crontab -l >"$STAGE/config/crontab-root.txt" 2>/dev/null || true
log "config: $(ls -1 "$STAGE/config" | paste -sd' ' -)"

# ── 4. manifest + checksums, pack and encrypt in one stream ─────────────────
{
  echo "created=$STAMP"
  echo "host=$HOST_LABEL"
  echo "app_commit=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "db_bytes=$DB_BYTES"
  echo "db_tables=$DB_TABLES"
  echo "db_rows=$DB_ROWS"
  echo "bucket=$S3_BUCKET_"
  echo "media_objects=$MEDIA_OBJECTS"
  echo "media_bytes=$MEDIA_BYTES"
} >"$STAGE/manifest.txt"
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS)
tar -cf - -C "$STAGE" . | encrypt_to "$WORK/$NAME" || die "packing or encryption failed"
rm -rf "$STAGE"
ARCHIVE_BYTES="$(wc -c <"$WORK/$NAME" | tr -d ' ')"
SUM="$(sha "$WORK/$NAME")"
printf '%s  %s\n' "$SUM" "$NAME" >"$WORK/$NAME.sha256"
log "encrypted archive: $ARCHIVE_BYTES bytes, sha256 $SUM"

# ── 5. the archive must decrypt, match every checksum and restore ───────────
vout="$(verify_archive "$WORK/$NAME" "$WORK/verify")" || die "the new archive does not verify: $vout"
log "verified: $vout"
DRILL="skipped"
if [[ "${BACKUP_RESTORE_DRILL:-1}" == 1 ]]; then
  DRILL_CT="l2d-restore-drill-$(date +%s)-$$"
  dout="$(restore_drill "$WORK/verify")" || die "restore drill failed: $dout"
  drill_stop
  DRILL="ok"
  log "restore drill: $dout"
fi
rm -rf "$WORK/verify"

# ── 6. keep it here (the pull destination fetches from this folder) ─────────
mv -f "$WORK/$NAME.sha256" "$LOCAL_DIR/"
mv -f "$WORK/$NAME" "$LOCAL_DIR/"
{
  echo "archive=$NAME"
  echo "time=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "archive_bytes=$ARCHIVE_BYTES"
  echo "sha256=$SUM"
  echo "db_bytes=$DB_BYTES"
  echo "db_rows=$DB_ROWS"
  echo "media_objects=$MEDIA_OBJECTS"
  echo "media_bytes=$MEDIA_BYTES"
  echo "restore_drill=$DRILL"
} >"$LOCAL_DIR/.LAST_OK.tmp" && mv -f "$LOCAL_DIR/.LAST_OK.tmp" "$LOCAL_DIR/LAST_OK"
ls -1 "$LOCAL_DIR"/lab2date-*.tar.gpg 2>/dev/null | sort | head -n -"$LOCAL_KEEP" | while read -r old; do
  rm -f "$old" "$old.sha256" && log "local retention: removed $(basename "$old")"
done

# ── 7. push off-site (pull destinations fetch it themselves) ───────────────
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=30 -i "${BACKUP_SSH_KEY:-$HOME/.ssh/id_ed25519}")
remote_put() {
  case "$TARGET" in
    rclone:*) rclone copyto "$1" "${TARGET#rclone:}/$2";;
    scp:*) scp -q -P "${BACKUP_SSH_PORT:-22}" "${SSH_OPTS[@]}" "$1" "${TARGET#scp:}/$2";;
    local:*) mkdir -p "${TARGET#local:}" && cp "$1" "${TARGET#local:}/$2";;
  esac
}
remote_sha() {
  case "$TARGET" in
    rclone:*) rclone cat "${TARGET#rclone:}/$1" | sha256sum | awk '{print $1}';;
    scp:*) local hp="${TARGET#scp:}"; ssh -p "${BACKUP_SSH_PORT:-22}" "${SSH_OPTS[@]}" "${hp%%:*}" "sha256sum '${hp#*:}/$1'" | awk '{print $1}';;
    local:*) sha "${TARGET#local:}/$1";;
  esac
}
remote_list() {
  case "$TARGET" in
    rclone:*) rclone lsf "${TARGET#rclone:}" --include 'lab2date-*.tar.gpg';;
    scp:*) local hp="${TARGET#scp:}"; ssh -p "${BACKUP_SSH_PORT:-22}" "${SSH_OPTS[@]}" "${hp%%:*}" "cd '${hp#*:}' && ls -1 lab2date-*.tar.gpg 2>/dev/null || true";;
    local:*) (cd "${TARGET#local:}" && ls -1 lab2date-*.tar.gpg 2>/dev/null || true);;
  esac
}
remote_delete() {
  case "$TARGET" in
    rclone:*) rclone deletefile "${TARGET#rclone:}/$1"; rclone deletefile "${TARGET#rclone:}/$1.sha256" 2>/dev/null || true;;
    scp:*) local hp="${TARGET#scp:}"; ssh -p "${BACKUP_SSH_PORT:-22}" "${SSH_OPTS[@]}" "${hp%%:*}" "rm -f '${hp#*:}/$1' '${hp#*:}/$1.sha256'";;
    local:*) rm -f "${TARGET#local:}/$1" "${TARGET#local:}/$1.sha256";;
  esac
}

if [[ "$TARGET" != "pull" ]]; then
  log "uploading to $TARGET"
  remote_put "$LOCAL_DIR/$NAME" "$NAME" </dev/null || die "upload to $TARGET failed"
  remote_put "$LOCAL_DIR/$NAME.sha256" "$NAME.sha256" </dev/null || die "upload of the checksum file failed"
  RSUM="$(remote_sha "$NAME" </dev/null || true)"
  [[ "$RSUM" == "$SUM" ]] || die "the off-site copy does not match (local $SUM, remote ${RSUM:-unreadable})"
  label="$(printf '%s' "$TARGET" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-60)"
  printf '%s %s %s\n' "$SUM" "$TARGET" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$LOCAL_DIR/offsite/$NAME.$label.ok"
  log "off-site copy verified (sha256 matches)"

  # Retention there: every archive of the last N days + the first archive of each of M months.
  mapfile -t ARCHIVES < <(remote_list </dev/null | sort)
  if [[ ${#ARCHIVES[@]} -gt 0 ]]; then
    cutoff_daily="$(date -u -d "-$KEEP_DAILY days" +%Y%m%d)"
    cutoff_month="$(date -u -d "-$KEEP_MONTHLY months" +%Y%m)"
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
      remote_delete "$a" </dev/null && deleted=$((deleted + 1)) && log "retention: deleted $a"
    done
    log "retention: kept $(( ${#ARCHIVES[@]} - deleted )) archive(s) at the destination ($KEEP_DAILY daily + $KEEP_MONTHLY monthly)"
  fi
fi
find "$LOCAL_DIR/offsite" -name '*.ok' -mtime +400 -delete 2>/dev/null || true

# ── 8. is a recent backup really off-site? ──────────────────────────────────
if offsite_check; then
  log "off-site: newest copy $OFFSITE_NEWEST"
  write_status OK ""
else
  if [[ "$OFFSITE_STATE" == "NONE" ]]; then msg="no backup has been confirmed off-site yet"
  else msg="the newest backup confirmed off-site is older than $OFFSITE_MAX_AGE_H h: $OFFSITE_NEWEST"; fi
  [[ "$TARGET" == "pull" ]] && msg="$msg (is the PC that runs backup-pull.sh switched on?)"
  log "WARNING: $msg"
  write_status OK "local backup OK, but $msg"
  direct_alert "[lab2date] backup is not off-site ($HOST_LABEL)" "$msg" || true
fi

body="{\"status\":\"OK\",${RUN_ID:+\"runId\":\"$RUN_ID\",}\"host\":\"$HOST_LABEL\",\"target\":\"$TARGET\",\"archiveName\":\"$NAME\",\"archiveBytes\":$ARCHIVE_BYTES,\"dbBytes\":$DB_BYTES,\"mediaBytes\":$MEDIA_BYTES,\"mediaObjects\":$MEDIA_OBJECTS,\"sha256\":\"$SUM\",\"verified\":true}"
if [[ -z "$(report "$body")" && "$CONFIG_SOURCE" == "admin settings" ]]; then
  log "WARNING: backup OK but the app did not record it (the admin tile will show it as missing)"
fi
log "backup OK: $NAME ($ARCHIVE_BYTES bytes) -> $LOCAL_DIR${TARGET:+ + $TARGET}"
