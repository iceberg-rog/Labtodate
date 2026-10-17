#!/usr/bin/env bash
# Off-site copy of the lab2date backups, run on another machine (made for Git Bash on
# Windows; works on Linux/macOS too). It pulls new encrypted archives from the server,
# checks each one end to end (sha256 of the download, then decrypt + every checksum
# inside), keeps 30 daily + 12 monthly archives and leaves a receipt on the server, so
# the server's nightly backup knows a recent copy is off-site.
#
# Problems are loud: a Windows notification and LABTODATE-BACKUP-PROBLEM.txt on the
# desktop, which stays there until the next good run removes it.
#
#   backup-pull.sh                     pull + verify (Task Scheduler: twice a day + at logon)
#   backup-pull.sh --verify FILE       decrypt FILE and check every checksum
#   backup-pull.sh --extract FILE DIR [PATH...]
#                                      decrypt FILE into DIR (everything, or only PATHs such as
#                                      ./db.dump ./media/products/import/<name>.jpg)
#   backup-pull.sh --status            what is here and what the server reports
#   backup-pull.sh --import-key        read the passphrase from stdin and store it in L2D_KEY_FILE
#                                      (ssh root@server cat /etc/lab2date-backup/key | backup-pull.sh --import-key)
#
# Configuration: environment, then $L2D_DEST/pull.env (KEY=VALUE lines).
#   L2D_SERVER         root@87.107.206.76
#   L2D_REMOTE_DIR     /var/backups/lab2date
#   L2D_DEST           /d/Labtodate-Backups (archives go to $L2D_DEST/archives)
#   L2D_KEY_FILE       passphrase file. Default on Windows: $L2D_DEST/backup-key.dpapi, protected
#                      with DPAPI (only this Windows user on this PC can read it)
#   L2D_KEEP_DAILY / L2D_KEEP_MONTHLY   30 / 12
#   L2D_MAX_AGE_HOURS  alert when the newest verified copy here is older than this (30)
#   L2D_LABEL          name of this copy in the server's receipts (pc-<hostname>)
set -Eeuo pipefail
umask 077
export PATH="/usr/bin:/mingw64/bin:$PATH"

# Installed as <dest>/bin/backup-pull.sh (scripts/backup-pull-install.ps1): <dest> is the parent.
self_dir="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "${L2D_DEST:-}" && "${self_dir##*/}" == "bin" && -d "$self_dir/../archives" ]]; then L2D_DEST="$(cd "$self_dir/.." && pwd)"; fi
DEST="${L2D_DEST:-/d/Labtodate-Backups}"

load_env() { # KEY=VALUE file, not executed; variables already set win
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
load_env "$DEST/pull.env"

SERVER="${L2D_SERVER:-root@87.107.206.76}"
REMOTE_DIR="${L2D_REMOTE_DIR:-/var/backups/lab2date}"
ARCH="$DEST/archives"
INCOMING="$DEST/.incoming"
LOGF="$DEST/pull.log"
KEEP_DAILY="${L2D_KEEP_DAILY:-30}"
KEEP_MONTHLY="${L2D_KEEP_MONTHLY:-12}"
MAX_AGE_H="${L2D_MAX_AGE_HOURS:-30}"
host_="$(hostname 2>/dev/null || echo pc)"
LABEL="${L2D_LABEL:-pc-$(printf '%s' "$host_" | tr -c 'A-Za-z0-9_-' '_')}"
IS_WINDOWS=0
command -v powershell.exe >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1 && IS_WINDOWS=1
if [[ -z "${L2D_KEY_FILE:-}" ]]; then
  if [[ "$IS_WINDOWS" == 1 ]]; then L2D_KEY_FILE="$DEST/backup-key.dpapi"; else L2D_KEY_FILE="$DEST/backup.key"; fi
fi
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=8)
SCP=(scp -q -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=8)

mkdir -p "$DEST" "$ARCH" "$INCOMING"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOGF"; }

# ── the passphrase (DPAPI on Windows) ───────────────────────────────────────
passphrase() {
  [[ -f "$L2D_KEY_FILE" ]] || { echo "key file $L2D_KEY_FILE is missing" >&2; return 1; }
  if [[ "$L2D_KEY_FILE" == *.dpapi ]]; then
    L2D_KEYPATH="$(cygpath -w "$L2D_KEY_FILE")" powershell.exe -NoProfile -NonInteractive -Command '
      $s = (Get-Content -Raw -LiteralPath $env:L2D_KEYPATH).Trim() | ConvertTo-SecureString
      $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
      try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }' </dev/null | tr -d '\r\n'
  else
    tr -d '\r\n' <"$L2D_KEY_FILE"
  fi
}
GPG=(gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-fd 3)
decrypt_stdout() { "${GPG[@]}" --decrypt "$1" 3< <(passphrase); }
kv_get() { [[ -f "$1" ]] || return 0; sed -n "s/^$2=//p" "$1" | head -n 1 | tr -d '\r'; }
archive_epoch() { local s="${1##*/}"; date -u -d "${s:9:8} ${s:18:2}:${s:20:2}:${s:22:2}" +%s 2>/dev/null || echo 0; }

verify_archive() { # file -> one-line summary; non-zero on any problem
  local file="$1" dir listed present want got out
  dir="$(mktemp -d "$INCOMING/verify.XXXXXX")"
  if ! decrypt_stdout "$file" | tar -xf - -C "$dir"; then
    rm -rf "$dir"; echo "decryption or unpacking failed (wrong key or damaged file)"; return 1
  fi
  out=""
  for f in SHA256SUMS manifest.txt counts.tsv db.dump; do [[ -f "$dir/$f" ]] || out="the archive has no $f"; done
  if [[ -z "$out" ]] && ! (cd "$dir" && sha256sum -c --quiet --strict SHA256SUMS >/dev/null); then out="checksum mismatch inside the archive"; fi
  if [[ -z "$out" ]]; then
    listed="$(grep -c . "$dir/SHA256SUMS")"
    present="$(cd "$dir" && find . -type f ! -name SHA256SUMS | wc -l)"
    want="$(kv_get "$dir/manifest.txt" media_objects)"
    got="$(find "$dir/media" -type f 2>/dev/null | wc -l)"
    if [[ "$listed" != "$present" ]]; then out="the archive holds $present files but SHA256SUMS lists $listed"
    elif [[ "$want" != "$got" ]]; then out="the manifest says $want media files, the archive holds $got"; fi
  fi
  if [[ -n "$out" ]]; then rm -rf "$dir"; echo "$out"; return 1; fi
  echo "$listed checksums match; db $(kv_get "$dir/manifest.txt" db_bytes) bytes / $(kv_get "$dir/manifest.txt" db_rows) rows; $got media files (created $(kv_get "$dir/manifest.txt" created))"
  rm -rf "$dir"
}

# ── loud failures ───────────────────────────────────────────────────────────
notify() { # title message
  [[ "$IS_WINDOWS" == 1 ]] || return 0
  L2D_T="$1" L2D_M="$2" powershell.exe -NoProfile -NonInteractive -Command '
    try {
      [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
      $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $t = $x.GetElementsByTagName("text")
      [void]$t.Item(0).AppendChild($x.CreateTextNode($env:L2D_T))
      [void]$t.Item(1).AppendChild($x.CreateTextNode($env:L2D_M))
      $app = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
    } catch { exit 1 }' </dev/null >/dev/null 2>&1 || true
}
desktop_file() {
  local d=""
  if [[ "$IS_WINDOWS" == 1 ]]; then
    d="$(powershell.exe -NoProfile -NonInteractive -Command '[Environment]::GetFolderPath("Desktop")' </dev/null 2>/dev/null | tr -d '\r')"
    [[ -n "$d" ]] && d="$(cygpath -u "$d")"
  fi
  [[ -n "$d" && -d "$d" ]] || d="$HOME/Desktop"
  printf '%s/LABTODATE-BACKUP-PROBLEM.txt' "$d"
}

# ── --import-key / --verify / --extract / --status ──────────────────────────
case "${1:-}" in
  --import-key)
    IFS= read -r key || true
    key="${key%$'\r'}"
    [[ ${#key} -ge 32 ]] || { echo "refusing: the passphrase on stdin is shorter than 32 characters" >&2; exit 1; }
    if [[ "$L2D_KEY_FILE" == *.dpapi ]]; then
      printf '%s' "$key" | L2D_KEYPATH="$(cygpath -w "$L2D_KEY_FILE")" powershell.exe -NoProfile -NonInteractive -Command '
        $k = [Console]::In.ReadToEnd()
        $s = ConvertTo-SecureString -String $k -AsPlainText -Force
        Set-Content -LiteralPath $env:L2D_KEYPATH -Value (ConvertFrom-SecureString -SecureString $s) -Encoding ASCII'
    else
      printf '%s\n' "$key" >"$L2D_KEY_FILE"
    fi
    unset key
    [[ "$(passphrase | wc -c)" -ge 32 ]] || { echo "the stored key does not read back" >&2; exit 1; }
    echo "key stored in $L2D_KEY_FILE and reads back ($(passphrase | wc -c | tr -d ' ') characters)"
    exit 0;;
  --verify)
    [[ -f "${2:-}" ]] || { echo "usage: $0 --verify FILE" >&2; exit 2; }
    if out="$(verify_archive "$2")"; then echo "OK: $out"; exit 0; fi
    echo "FAILED: $out"; exit 1;;
  --extract)
    [[ -f "${2:-}" && -n "${3:-}" ]] || { echo "usage: $0 --extract FILE DIR [PATH...]" >&2; exit 2; }
    file="$2"; dir="$3"; shift 3
    mkdir -p "$dir"
    decrypt_stdout "$file" | tar -xf - -C "$dir" "$@"
    echo "extracted into $dir"
    exit 0;;
  --status)
    echo "== this copy ($LABEL): $ARCH"
    ls -l "$ARCH" 2>/dev/null | grep 'tar.gpg$' || echo "(no archives yet)"
    cat "$DEST/STATUS.txt" 2>/dev/null || true
    echo "== server $SERVER"
    "${SSH[@]}" "$SERVER" "cat '$REMOTE_DIR/STATUS'" </dev/null || echo "(server not reachable)"
    exit 0;;
  "") ;;
  *) echo "usage: $0 [--verify FILE | --extract FILE DIR [PATH...] | --status | --import-key]" >&2; exit 2;;
esac

# ── pull ────────────────────────────────────────────────────────────────────
LOCK="$DEST/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [[ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]]; then rm -rf "$LOCK"; mkdir "$LOCK"
  else echo "another pull is running ($LOCK)"; exit 0; fi
fi
trap 'rm -rf "$LOCK" "$INCOMING"/verify.* 2>/dev/null || true' EXIT

PROBLEMS=()
problem() { PROBLEMS+=("$*"); log "PROBLEM: $*"; }
log "pull from $SERVER:$REMOTE_DIR to $ARCH ($LABEL)"
[[ -f "$L2D_KEY_FILE" ]] || problem "the backup key is missing ($L2D_KEY_FILE): archives cannot be checked. See docs/BACKUPS.md"

# 1. what the server says about its last nightly run
if st="$("${SSH[@]}" "$SERVER" "cat '$REMOTE_DIR/STATUS'" </dev/null 2>&1)"; then
  s_result="$(sed -n 's/^result=//p' <<<"$st" | head -n 1)"
  s_reason="$(sed -n 's/^reason=//p' <<<"$st" | head -n 1)"
  s_updated="$(sed -n 's/^updated=//p' <<<"$st" | head -n 1)"
  log "server: last run $s_updated, result $s_result${s_reason:+ ($s_reason)}"
  [[ "$s_result" == "FAILED" ]] && problem "the server's last nightly backup FAILED: $s_reason"
  s_age=$(( ($(date +%s) - $(date -u -d "$s_updated" +%s 2>/dev/null || echo 0)) / 3600 ))
  (( s_age <= MAX_AGE_H )) || problem "the server has not run a backup for $s_age hours (last run $s_updated)"
else
  problem "cannot reach the server $SERVER: $(tail -n 1 <<<"$st")"
fi

# 2. fetch every archive newer than what is here (only the newest on the first run)
if remote="$("${SSH[@]}" "$SERVER" "cd '$REMOTE_DIR' && ls -1 lab2date-*.tar.gpg 2>/dev/null || true" </dev/null 2>/dev/null)"; then
  mapfile -t R < <(grep -E '^lab2date-[0-9]{8}-[0-9]{6}\.tar\.gpg$' <<<"$remote" | sort || true)
  newest_here="$(ls -1 "$ARCH" 2>/dev/null | grep -E '^lab2date-[0-9]{8}-[0-9]{6}\.tar\.gpg$' | sort | tail -n 1 || true)"
  todo=()
  for a in "${R[@]}"; do
    [[ -f "$ARCH/$a" ]] && continue
    [[ -n "$newest_here" && ! "$a" > "$newest_here" ]] && continue
    todo+=("$a")
  done
  if [[ -z "$newest_here" && ${#todo[@]} -gt 1 ]]; then todo=("${todo[-1]}"); fi
  (( ${#R[@]} > 0 )) || problem "the server has no backup archive in $REMOTE_DIR"
  for a in "${todo[@]}"; do
    want="$("${SSH[@]}" "$SERVER" "cat '$REMOTE_DIR/$a.sha256'" </dev/null 2>/dev/null | awk '{print $1}')"
    if [[ ! "$want" =~ ^[0-9a-f]{64}$ ]]; then problem "$a has no checksum file on the server"; continue; fi
    part="$INCOMING/$a.part"
    ok=0
    for try in 1 2 3; do
      t0="$(date +%s)"
      if "${SCP[@]}" "$SERVER:$REMOTE_DIR/$a" "$part" </dev/null && [[ "$(sha256sum "$part" | awk '{print $1}')" == "$want" ]]; then ok=1; break; fi
      log "download of $a failed or was damaged (try $try of 3)"
      rm -f "$part"
    done
    if [[ "$ok" != 1 ]]; then problem "could not download $a intact"; continue; fi
    size="$(wc -c <"$part" | tr -d ' ')"
    log "downloaded $a ($size bytes in $(( $(date +%s) - t0 )) s), sha256 matches the server"
    if ! v="$(verify_archive "$part")"; then rm -f "$part"; problem "$a does not verify: $v"; continue; fi
    mv -f "$part" "$ARCH/$a"
    printf '%s  %s\n' "$want" "$a" >"$ARCH/$a.sha256"
    log "verified $a: $v"
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    "${SSH[@]}" "$SERVER" "mkdir -p '$REMOTE_DIR/offsite' && printf '%s %s %s\n' '$want' '$LABEL' '$now' > '$REMOTE_DIR/offsite/$a.$LABEL.ok'" </dev/null \
      || problem "$a is safe here, but the receipt could not be written on the server"
  done
else
  [[ ${#PROBLEMS[@]} -gt 0 ]] || problem "cannot list the archives on the server"
fi
rm -f "$INCOMING"/*.part 2>/dev/null || true

# 3. retention here: every archive of the last N days + the first of each of M months
mapfile -t A < <(ls -1 "$ARCH" 2>/dev/null | grep -E '^lab2date-[0-9]{8}-[0-9]{6}\.tar\.gpg$' | sort || true)
if (( ${#A[@]} > 1 )); then
  newest="${A[-1]}"
  cutoff_daily="$(date -u -d "-$KEEP_DAILY days" +%Y%m%d)"
  cutoff_month="$(date -u -d "-$KEEP_MONTHLY months" +%Y%m)"
  declare -A first=()
  for a in "${A[@]}"; do ym="${a:9:6}"; [[ -z "${first[$ym]:-}" ]] && first[$ym]="$a"; done
  for a in "${A[@]}"; do
    [[ "$a" == "$newest" ]] && continue
    day="${a:9:8}"; ym="${a:9:6}"
    [[ "$day" -ge "$cutoff_daily" ]] && continue
    [[ "$KEEP_MONTHLY" -gt 0 && "${first[$ym]}" == "$a" && "$ym" -gt "$cutoff_month" ]] && continue
    rm -f "$ARCH/$a" "$ARCH/$a.sha256"
    log "retention: removed $a"
  done
fi

# 4. is the newest copy here recent?
newest="$(ls -1 "$ARCH" 2>/dev/null | grep -E '^lab2date-[0-9]{8}-[0-9]{6}\.tar\.gpg$' | sort | tail -n 1 || true)"
if [[ -z "$newest" ]]; then
  problem "there is no verified backup on this PC yet"
else
  age=$(( ($(date +%s) - $(archive_epoch "$newest")) / 3600 ))
  (( age <= MAX_AGE_H )) || problem "the newest verified backup on this PC is $age hours old ($newest)"
fi
count="$(ls -1 "$ARCH" 2>/dev/null | grep -c '\.tar\.gpg$' || true)"
bytes="$(find "$ARCH" -name '*.tar.gpg' -printf '%s\n' 2>/dev/null | awk '{s += $1} END {print s + 0}')"

# 5. report
alert="$(desktop_file)"
{
  echo "updated=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "result=$([[ ${#PROBLEMS[@]} -eq 0 ]] && echo OK || echo PROBLEM)"
  echo "newest=$newest"
  echo "archives=$count"
  echo "bytes=$bytes"
  for p in "${PROBLEMS[@]}"; do echo "problem=$p"; done
} >"$DEST/STATUS.txt"
if (( ${#PROBLEMS[@]} > 0 )); then
  {
    echo "LABTODATE BACKUP PROBLEM - $(date '+%Y-%m-%d %H:%M')"
    echo
    for p in "${PROBLEMS[@]}"; do echo "- $p"; done
    echo
    echo "مشکل در بکاپ سایت Labtodate. جزئیات بالا و در فایل گزارش آمده است."
    echo "این فایل را برنامهٔ بکاپ ساخته و بعد از اولین اجرای موفق، خودش پاکش می‌کند."
    echo
    echo "Log:   $( [[ "$IS_WINDOWS" == 1 ]] && cygpath -w "$LOGF" || echo "$LOGF")"
    echo "Help:  docs/BACKUPS.md in the Labtodate repository (section: When an alert appears)"
  } >"$alert"
  notify "Labtodate backup: PROBLEM" "${PROBLEMS[0]}"
  log "RESULT: ${#PROBLEMS[@]} problem(s); alert on the desktop"
  exit 1
fi
rm -f "$alert"
log "RESULT: OK - newest $newest, $count archive(s), $bytes bytes"
tail -n 3000 "$LOGF" >"$LOGF.tmp" 2>/dev/null && mv -f "$LOGF.tmp" "$LOGF" || true
