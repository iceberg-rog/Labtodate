# Backups (scripts/backup-v2.sh)

What it does, every night:

1. `pg_dump -Fc` of the database (inside the `db` container) and a read-back check (`pg_restore --list`).
2. A copy of **every uploaded file** in the MinIO bucket (`mc mirror`): payment proofs, seller receipts,
   support / quote attachments, product images, logo. (The old `scripts/backup.sh` skipped these.)
3. A manifest + SHA-256 of every file, packed into one tar and **encrypted** with GnuPG (AES-256, MDC
   integrity check) using a passphrase that is not stored in the database.
4. The archive is decrypted again and every checksum checked **before** it is shipped.
5. It is copied **off this server** (rclone remote or SSH/SCP) and the copy there is checksummed.
6. Retention at the destination: every archive of the last *N* days + the first archive of each of the
   last *M* months (defaults 30 + 12). Two encrypted copies stay on the server for fast restores.
7. The run is reported to the app (`BackupRun`): Admin → Overview and Admin → Settings → Security show
   "last good backup". A failed run e-mails every super-admin (and the addresses in
   *Send backup failure alerts to*); if the app itself is down, the script e-mails
   `BACKUP_ALERT_EMAIL` directly over SMTP. The security-sweep cron also alerts once a day when the last
   good backup is older than *Alert when the last good backup is older than* (default 26 h).

Destination, retention and alert addresses are set in **Admin → Settings → Security → Backups**; the
script reads them at every run. Secrets (encryption key, rclone / SSH credentials) live only on the
server.

## One-time set-up (Debian server)

```bash
apt-get install -y gnupg rclone curl          # rclone only for rclone targets
install -d -m 700 /opt/lab2date/backups

# 1. Encryption key: 48 random bytes. Store a copy in the company password manager NOW —
#    without it no backup can be restored (it is deliberately not in the database).
head -c 48 /dev/urandom | base64 > /opt/lab2date/backup.key
chmod 600 /opt/lab2date/backup.key

# 2. /opt/lab2date/backup.env (chmod 600):
cat > /opt/lab2date/backup.env <<'EOF'
BACKUP_ENCRYPTION_KEY_FILE=/opt/lab2date/backup.key
# Used only when Admin → Settings → Security leaves the destination empty:
BACKUP_TARGET=rclone:offsite:lab2date-backups/prod
# Where to send a failure e-mail when the app itself is down:
BACKUP_ALERT_EMAIL=ops@labtodate.com
EOF
chmod 600 /opt/lab2date/backup.env
```

### Destination A — rclone (Backblaze B2, Hetzner Storage Box, S3, …)

```bash
rclone config            # create a remote named "offsite" (e.g. type b2 with an application key
                         # limited to ONE bucket; enable object lock / lifecycle on the bucket if possible)
rclone mkdir offsite:lab2date-backups/prod
```
Admin → Settings → Security → *Off-site backup destination*: `rclone:offsite:lab2date-backups/prod`.

### Destination B — another server over SSH

```bash
ssh-keygen -t ed25519 -N '' -f /root/.ssh/lab2date-backup
# on the backup server: a user that may only write to /srv/backups/lab2date (append-only if possible)
ssh-copy-id -i /root/.ssh/lab2date-backup.pub backup@backup.example.nl
echo 'BACKUP_SSH_KEY=/root/.ssh/lab2date-backup' >> /opt/lab2date/backup.env
```
Destination: `scp:backup@backup.example.nl:/srv/backups/lab2date`.

### Schedule

```bash
chmod +x /opt/lab2date/scripts/backup-v2.sh
/opt/lab2date/scripts/backup-v2.sh --dry-run        # shows destination, retention, key present
/opt/lab2date/scripts/backup-v2.sh                  # first real run (watch the output)
( crontab -l 2>/dev/null | grep -v 'scripts/backup' ; \
  echo '15 3 * * * /opt/lab2date/scripts/backup-v2.sh >> /var/log/lab2date-backup.log 2>&1' ) | crontab -
```
Remove the old `scripts/backup.sh` cron line (it kept unencrypted dumps on the same server and never
backed up uploaded files). Delete its old dumps in `/opt/lab2date/backups/*.sql.gz` and the
`backups/` prefix in the MinIO bucket once the first v2 backup is verified off-site.

## Restore

```bash
# 1. fetch an archive (or use one of the two local copies in /opt/lab2date/backups)
rclone copyto offsite:lab2date-backups/prod/lab2date-20261003-031500.tar.gpg /root/restore.tar.gpg
# 2. check it: decrypts with the key and every checksum inside matches
/opt/lab2date/scripts/backup-v2.sh --verify /root/restore.tar.gpg
# 3. unpack
mkdir -p /root/restore && cd /root/restore
gpg --batch --pinentry-mode loopback --passphrase-file /opt/lab2date/backup.key -d /root/restore.tar.gpg | tar -xf -
sha256sum -c SHA256SUMS
# 4. database (into the running db container; the app must be stopped)
docker compose -f /opt/lab2date/docker-compose.yml stop web cron
docker compose -f /opt/lab2date/docker-compose.yml exec -T db \
  pg_restore -U lab2date -d lab2date --clean --if-exists --no-owner < db.dump
# 5. uploaded files
NET=$(docker inspect lab2date-minio-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
docker run --rm --network "$NET" -v /root/restore/media:/in --entrypoint sh minio/mc -c \
  "mc alias set m http://minio:9000 $S3_ACCESS_KEY $S3_SECRET_KEY && mc mirror --overwrite /in m/lab2date-media"
docker compose -f /opt/lab2date/docker-compose.yml up -d
```

## Quarterly restore drill (put it in the calendar)

1. Take the newest archive from the **off-site** destination (not the local copy).
2. Restore it on a scratch server / VM with the steps above (never over production).
3. Sign in as an admin, open an old order: its payment proof, the proforma / invoice PDF and a support
   attachment must open.
4. Write down how long it took (recovery time) and the archive date (recovery point) in the ops log.
5. Simulate a failure (e.g. wrong rclone credentials on the scratch copy of the script) and confirm the
   alert e-mail arrives.

## Notes

* `BACKUP_DB_DUMP_CMD`, `BACKUP_DB_VERIFY_CMD` and `BACKUP_MEDIA_SYNC_CMD` override the docker commands
  (e.g. for a non-docker install). `local:<dir>` is meant for tests or a mounted remote disk — a folder on
  the same disk is NOT an off-site backup.
* The archive contains the `Setting` table (mail / payment credentials) — another reason it is always
  encrypted and the key is kept outside the database.
