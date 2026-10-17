# Backups

Production (labtodate.com, one VPS) is backed up every night, encrypted, and copied off the server.
Every step is checked; when anything goes wrong it says so loudly instead of reporting success.

| What | Where | When | Kept |
|---|---|---|---|
| Database + every uploaded file (product photos, payment proofs, attachments) + server config | `/var/backups/lab2date/` on the server | 03:00 UTC (cron, `scripts/backup-v2.sh`) | newest 7 |
| The same encrypted archives, off-site | the owner's PC, `D:\Labtodate-Backups\archives` | 08:30, 20:30 and 10 min after logon (Task Scheduler, `scripts/backup-pull.sh`) | 30 daily + first of each month for 12 months |

Set up on 2026-10-18. It replaces `scripts/backup.sh` in cron, which kept unencrypted database dumps on the
same disk only, never backed up the uploaded files, and could report success after a failed dump and then
rotate the good dumps away. `scripts/backup.sh` still exists because the deploy scripts call it for a quick
pre-deploy dump.

## What happens every night on the server (`backup-v2.sh`)

1. `pg_dump -Fc` of the database, then an exact row count of every table (`counts.tsv`).
2. `mc mirror` of the whole MinIO bucket except the old `backups/` prefix; the copy must hold at least as
   many files as the bucket lists.
3. A copy of the server config needed to rebuild a lost server: the app `.env`, `docker-compose.override.yml`,
   the nginx site and root's crontab (`config/` in the archive).
4. A manifest and a SHA-256 of every file, packed and **encrypted** in one stream with GnuPG (AES-256,
   integrity-protected). Nothing unencrypted is written outside the temporary work folder.
5. The archive is decrypted again, every checksum is checked and `pg_restore --list` reads the dump.
6. **Restore drill**: the dump is restored into a throwaway PostgreSQL container (no network, data in RAM)
   and every table must have the same number of rows as at backup time. The container is removed afterwards.
7. Only then does the archive go into `/var/backups/lab2date/` (plus a `.sha256` file), and the oldest
   local copies beyond 7 are removed.
8. It checks the receipts the PC leaves in `/var/backups/lab2date/offsite/`: if no backup younger than
   50 hours is confirmed off-site, the run logs a WARNING and `STATUS` says so.

Failures that stop the run (exit 1, `result=FAILED` in `STATUS`, nothing old is rotated away):
pg_dump fails or the dump is under 1 KB; the live database cannot be counted; the media copy fails or is
incomplete; **the dump or the file count shrank more than 20%** against the last good backup (a sign that
something upstream is wrong; run once with `BACKUP_ALLOW_SHRINK=1` if it is expected); the key is missing
or shorter than 32 characters; not enough disk space; encryption, verification or the restore drill fails;
another run is still busy.

## What happens on the PC (`backup-pull.sh`)

1. Reads the server's `STATUS`: if the last nightly run FAILED, or no run happened for 30 hours, that is a problem.
2. Downloads every archive newer than the newest one already on the PC (with up to 3 tries), and checks
   the download's SHA-256 against the server's.
3. Decrypts it with the key and checks every checksum and file count inside, so the copy is proven to be
   restorable without the server.
4. Moves it into `archives\`, then writes a receipt on the server (`offsite/<archive>.pc-<name>.ok`).
5. Retention: every archive of the last 30 days plus the first archive of each of the last 12 months.
6. If anything went wrong, or the newest verified copy is older than 30 hours, it shows a **Windows
   notification** and writes **`LABTODATE-BACKUP-PROBLEM.txt` on the desktop** (English + Persian). The next
   good run deletes that file. `D:\Labtodate-Backups\STATUS.txt` and `pull.log` hold the details.

The server cannot reach the PC: the PC pulls. Ransomware or an intruder on the server can therefore not
delete or encrypt the off-site copies.

## Where things are

Server (root@87.107.206.76):

| Path | What |
|---|---|
| `/opt/lab2date-backup/backup-v2.sh` | installed copy of `scripts/backup-v2.sh` |
| `/etc/lab2date-backup/backup.env` | settings (`BACKUP_TARGET=pull`, local dir, keep 7, 50 h) |
| `/etc/lab2date-backup/key` | the encryption passphrase (64 characters, root-only) |
| `/var/backups/lab2date/` | archives, `STATUS`, `LAST_OK`, `offsite/` receipts, `restore-tests/` reports |
| `/var/log/lab2date-backup.log` | log of every run |

PC (`D:\Labtodate-Backups`, readable only by the owner's Windows account):

| Path | What |
|---|---|
| `archives\` | verified encrypted archives + `.sha256` |
| `backup-key.dpapi` | the passphrase, protected with Windows DPAPI (only this Windows user on this PC can read it) |
| `bin\backup-pull.sh` | installed copy of `scripts/backup-pull.sh` |
| `STATUS.txt`, `pull.log`, `task-run.log` | last result, log, and anything the task printed to stderr |

Commands:

```bash
ssh root@87.107.206.76 /opt/lab2date-backup/backup-v2.sh --status     # server: last run, archives, receipts
ssh root@87.107.206.76 /opt/lab2date-backup/backup-v2.sh --dry-run    # server: settings
ssh root@87.107.206.76 /opt/lab2date-backup/backup-v2.sh              # server: run a backup now
"C:\Program Files\Git\bin\bash.exe" /d/Labtodate-Backups/bin/backup-pull.sh            # PC: pull now
"C:\Program Files\Git\bin\bash.exe" /d/Labtodate-Backups/bin/backup-pull.sh --status   # PC: what is here
```

## The encryption key

Without the key no archive can be opened, not even by us. It exists in exactly two places: the server
(`/etc/lab2date-backup/key`) and the PC (`backup-key.dpapi`). **Put a third copy in a password manager**
so that losing both the server and the PC does not also lose every backup. To see it (in your own
terminal, it is printed once):

```bash
ssh root@87.107.206.76 cat /etc/lab2date-backup/key
```

Never change the key file on the server without importing the new key on the PC
(`ssh root@87.107.206.76 cat /etc/lab2date-backup/key | "C:\Program Files\Git\bin\bash.exe" /d/Labtodate-Backups/bin/backup-pull.sh --import-key`)
and keeping the old key for the old archives.

The archives contain customer data, password hashes, the `Setting` table (mail credentials) and the app
`.env`. They are always encrypted; keep the key away from the archives' storage when you add destinations.

## When an alert appears

`LABTODATE-BACKUP-PROBLEM.txt` on the desktop lists the problem. Common ones:

| Problem | What to do |
|---|---|
| "the server's last nightly backup FAILED: …" | read the reason; `ssh root@87.107.206.76 tail -n 40 /var/log/lab2date-backup.log`; fix, then run a backup on the server and pull on the PC |
| "… shrank from X to Y …" | find out why products or files disappeared. If it was intended, run once: `ssh root@87.107.206.76 BACKUP_ALLOW_SHRINK=1 /opt/lab2date-backup/backup-v2.sh` |
| "cannot reach the server" | internet or server down; if the server is gone, see "Restore on a new server" |
| "could not download … intact" / "does not verify" | run the pull again; if it repeats, run `--verify` on the server's copy |
| "the backup key is missing" | import it (command above) |
| "the newest verified backup on this PC is N hours old" | the PC was off or the task did not run; run the pull by hand |

## Restore

Always start with a restore test: it changes nothing in production.

### Restore test (safe, any time)

```bash
# on the server, with a local archive or one copied up from the PC:
/opt/lab2date-backup/backup-v2.sh --restore-test /var/backups/lab2date/lab2date-YYYYMMDD-HHMMSS.tar.gpg [SAMPLE_DIR]
```

It decrypts and checks the archive, restores the database into a throwaway container and compares every
table with the counts from backup time, checks that every product photo the database points to is in the
archive, compares 6 random photos byte for byte with what the live site serves, compares the private files
(payment proofs) with the live bucket, and lists the config files. Report: `/var/backups/lab2date/restore-tests/`.

To test the off-site copy, send it up first:
`scp D:/Labtodate-Backups/archives/<archive> root@87.107.206.76:/var/backups/lab2date/restore-input/`.

### Restore production on the same server

```bash
F=/var/backups/lab2date/lab2date-YYYYMMDD-HHMMSS.tar.gpg       # or a copy from the PC
/opt/lab2date-backup/backup-v2.sh --restore-test "$F"           # must say RESTORE TEST PASSED
install -d -m 700 /root/restore && cd /root/restore
gpg --batch --pinentry-mode loopback --passphrase-file /etc/lab2date-backup/key -d "$F" | tar -xf -
sha256sum -c --quiet SHA256SUMS && echo checksums OK

cd /opt/lab2date
docker compose exec -T db pg_dump -U lab2date -d lab2date -Fc > /root/restore/before-restore.dump </dev/null   # safety copy
docker compose stop web cron
docker compose exec -T db pg_restore -U lab2date -d lab2date --clean --if-exists --no-owner < /root/restore/db.dump

# uploaded files (adds and overwrites; nothing is deleted)
NET=$(docker inspect lab2date-minio-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
AK=$(grep '^S3_ACCESS_KEY=' .env | cut -d= -f2- | tr -d "\"'")
SK=$(grep '^S3_SECRET_KEY=' .env | cut -d= -f2- | tr -d "\"'")
docker run --rm --network "$NET" -e AK="$AK" -e SK="$SK" -v /root/restore/media:/in --entrypoint sh minio/mc -c \
  'mc alias set m http://minio:9000 "$AK" "$SK" >/dev/null && mc mirror --overwrite /in m/lab2date-media'
docker compose up -d
```

A single file (one photo, one payment proof): extract only that path, e.g. on the PC
`backup-pull.sh --extract <archive> <dir> ./media/order-proofs/<name>.pdf`.

### Restore on a new server (this server is lost)

1. New Ubuntu server with Docker. `git clone https://github.com/iceberg-rog/Labtodate.git /opt/lab2date`,
   check out the commit in the archive's `manifest.txt` (`app_commit`).
2. Copy the newest archive from `D:\Labtodate-Backups\archives` to the server and unpack it with the key
   from the password manager (or the PC: `backup-pull.sh --extract <archive> <dir>` on the PC, then copy).
3. From `config/`: `opt_lab2date_.env` → `/opt/lab2date/.env`,
   `opt_lab2date_docker-compose.override.yml` → `/opt/lab2date/docker-compose.override.yml`,
   `etc_nginx_sites-available_lab2date` → `/etc/nginx/sites-available/lab2date` (TLS certificates are not in
   the archive: issue new ones), `crontab-root.txt` shows the cron jobs to re-create.
4. `docker compose up -d db minio`, then restore the database and the files as above, then
   `docker compose up -d` and point DNS at the new server.
5. Install `backup-v2.sh` again (set-up below) and update `L2D_SERVER` on the PC (`D:\Labtodate-Backups\pull.env`).

## Restore drill (every month)

The nightly run already restores every dump into a throwaway database. Once a month also run
`--restore-test` on an archive **copied up from the PC** and keep the report. Note how long it took and the
archive's date.

## Set-up from scratch

Server:

```bash
install -d -m 755 /opt/lab2date-backup && install -d -m 700 /etc/lab2date-backup /var/backups/lab2date
install -m 750 scripts/backup-v2.sh /opt/lab2date-backup/backup-v2.sh
(umask 077; openssl rand -base64 48 | tr -d '\n' > /etc/lab2date-backup/key); chmod 400 /etc/lab2date-backup/key
cat > /etc/lab2date-backup/backup.env <<'EOF'
BACKUP_ENCRYPTION_KEY_FILE=/etc/lab2date-backup/key
BACKUP_TARGET=pull
BACKUP_LOCAL_DIR=/var/backups/lab2date
BACKUP_LOCAL_KEEP=7
BACKUP_OFFSITE_MAX_AGE_HOURS=50
EOF
chmod 600 /etc/lab2date-backup/backup.env
/opt/lab2date-backup/backup-v2.sh --dry-run && /opt/lab2date-backup/backup-v2.sh
# cron (root): 0 3 * * * /opt/lab2date-backup/backup-v2.sh >> /var/log/lab2date-backup.log 2>&1
```

The script needs `gnupg`, Docker and the images `postgres:16-alpine` and `minio/mc` on the server
(it never pulls images: Docker Hub answers 403 from this server).

PC (Windows with Git for Windows, as the user whose SSH key logs in to the server):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup-pull-install.ps1     # copies the script, registers the task
ssh root@87.107.206.76 cat /etc/lab2date-backup/key | & "C:\Program Files\Git\bin\bash.exe" /d/Labtodate-Backups/bin/backup-pull.sh --import-key
Start-ScheduledTask 'Labtodate backup pull'
```

Restrict the folder to the owner:
`icacls D:\Labtodate-Backups /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"`
(on an existing folder, follow with `icacls D:\Labtodate-Backups\* /reset /T`).

## A second off-site destination (optional)

A copy that does not depend on the PC being switched on: a Hetzner Storage Box. On 2026-10-18 Hetzner's
web and object-storage endpoints answered from the server (AWS, DigitalOcean, Scaleway and Liara did not);
a box's SSH port 23 can only be tested once the box exists. Create the box, enable its automatic snapshots
(the server cannot delete those), then:

```bash
ssh-keygen -t ed25519 -N '' -f /root/.ssh/lab2date-backup        # add the .pub in the Hetzner panel
# /etc/lab2date-backup/backup.env:
#   BACKUP_TARGET=scp:uXXXXX@uXXXXX.your-storagebox.de:lab2date
#   BACKUP_SSH_PORT=23
#   BACKUP_SSH_KEY=/root/.ssh/lab2date-backup
```

With a push target the server uploads, compares the SHA-256 there, applies 30 daily + 12 monthly there and
writes its own receipt; the PC can keep pulling from `/var/backups/lab2date` as before.
`BACKUP_TARGET` holds one push destination; `rclone:<remote>:<path>` works too once rclone is configured.

## Undo

```bash
crontab /root/sec-rollback/crontab-root.before-backup-v2-20261017-2250   # old backup.sh line back
rm -rf /opt/lab2date-backup                                               # the script (archives and key stay)
```

On the PC: `Unregister-ScheduledTask 'Labtodate backup pull'`. Details: `/root/sec-rollback/README.txt`, section 7.

## Notes

* App versions that have Admin → Settings → Security → Backups (the staging branch) read the destination
  and retention from there and record every run in `BackupRun`; this script keeps that interface. The
  current production app has no such page, so `backup.env` is the only configuration.
* Old unencrypted dumps remain in `/opt/lab2date/backups/*.sql.gz` and in the bucket prefix `backups/`
  (not public: `/media/lab2date-media/backups/...` answers 403). They can be deleted once the owner is happy
  with the new backups.
* `BACKUP_ALERT_EMAIL` + `SMTP_HOST/PORT/USER/PASS` in `backup.env` add a failure e-mail from the server.
  Production sends mail through the SMTP settings stored in the app, so this is not set up.
