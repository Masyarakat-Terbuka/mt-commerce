# Backup and restore

Postgres is the only stateful service that holds business data; Redis is a
cache and a job queue, and is rebuildable. Caddy data (certificates) is
recoverable too — losing it forces a re-issue from Let's Encrypt, but that
takes seconds. So the backup story is about Postgres.

## Strategy

- **Nightly logical dumps** with `pg_dump`, written to a host-mounted
  directory.
- **Retention**: 7 daily snapshots + 4 weekly snapshots, pruned automatically
  by the script.
- **Off-site copy**: `rclone sync` to S3-compatible object storage
  (Cloudflare R2, Wasabi, Biznet Gio, IDCloudHost storage).

A single `pg_dump` at this scale (one merchant, modest catalog) finishes in
a few seconds and produces a compact compressed file. Point-in-time recovery
(PITR) with WAL archiving is overkill for v0.1; if your transaction volume
ever justifies it, swap in pgBackRest or WAL-G.

## Setup

Create a host directory for backups:

```bash
sudo mkdir -p /var/backups/mt-commerce
sudo chown $USER:$USER /var/backups/mt-commerce
```

Copy the script (already in the repo at `scripts/backup-postgres.sh`) and
make it executable:

```bash
chmod +x ~/mt-commerce/scripts/backup-postgres.sh
```

## Run nightly

Add a host-side cron entry as the `deploy` user:

```bash
crontab -e
```

```cron
# mt-commerce postgres backup, every day at 02:30 local time.
30 2 * * * cd /home/deploy/mt-commerce && ./scripts/backup-postgres.sh >> /var/log/mt-commerce-backup.log 2>&1
```

Confirm the next run:

```bash
ls -lh /var/backups/mt-commerce/
```

## Off-site copy with rclone

Install rclone:

```bash
curl https://rclone.org/install.sh | sudo bash
```

Configure a remote (S3-compatible — works for R2, Wasabi, Biznet Gio,
IDCloudHost):

```bash
rclone config
# n) New remote
# name> mt-backup
# storage> s3
# provider> Other (or Cloudflare, Wasabi as appropriate)
# env_auth> false
# access_key_id> ...
# secret_access_key> ...
# endpoint> https://... (provider-specific)
# Leave the rest at defaults.
```

Test it:

```bash
rclone lsd mt-backup:
```

Then add a sync step to the cron job:

```cron
30 2 * * * cd /home/deploy/mt-commerce && ./scripts/backup-postgres.sh && rclone sync /var/backups/mt-commerce mt-backup:mt-commerce-backups >> /var/log/mt-commerce-backup.log 2>&1
```

## Restore

Stop the API so it can't write while you swap the database underneath it:

```bash
cd ~/mt-commerce
docker compose -f docker-compose.prod.yml stop api
```

Drop and recreate the database, then restore. From the host:

```bash
# Pick the dump to restore.
ls /var/backups/mt-commerce/
DUMP=/var/backups/mt-commerce/mt_commerce-2026-05-08.sql.gz

# Drop + recreate the database.
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS $POSTGRES_DB;" \
  -c "CREATE DATABASE $POSTGRES_DB OWNER $POSTGRES_USER;"

# Restore from the gzipped SQL dump.
gunzip -c "$DUMP" | docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# Bring the API back.
docker compose -f docker-compose.prod.yml start api
```

The `$POSTGRES_USER` and `$POSTGRES_DB` shell variables come from the
`.env.production` file — `source .env.production` first if your shell is
fresh.

## Verifying a backup

A backup that was never tested isn't a backup. At least once a quarter:

1. Spin up a fresh Postgres container locally.
2. Restore the latest dump into it.
3. Run a small read-only sanity check (count of `orders`, `products`, etc.).

```bash
docker run --rm -d --name mt-restore-test \
  -e POSTGRES_USER=mt -e POSTGRES_PASSWORD=mt -e POSTGRES_DB=mt_commerce \
  -p 5433:5432 postgres:16-alpine

# Wait for healthy, then:
gunzip -c /path/to/dump.sql.gz | \
  docker exec -i mt-restore-test psql -U mt -d mt_commerce

docker exec mt-restore-test psql -U mt -d mt_commerce \
  -c "SELECT count(*) FROM orders;"

docker stop mt-restore-test
```
