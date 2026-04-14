# PostHog Health Check & Fix

Diagnose and repair a running self-hosted PostHog Docker Compose stack. Checks all 7 preflight services and fixes common failures automatically.

## Usage

Optionally accept from the user:
- SSH host (e.g. `root@db.example.com`) — if not provided, assume commands run locally
- Deploy directory (default: `/opt/posthog`)

## Step 1 — Preflight status

```bash
curl -s https://<DOMAIN>/_preflight/ | python3 -m json.tool | \
  grep -E '"django"|"redis"|"plugins"|"celery"|"clickhouse"|"kafka"|"db"'
```

Expected: all `true`. For each `false`, apply the matching fix below.

---

## Fix: `"plugins": false`

**Check 1** — Can posthog_web reach the plugin server?
```bash
docker exec posthog_web curl -s http://posthog_plugins:6738/_health
```
Should return `{"status":"ok",...}`.

**Check 2** — Is `CDP_API_URL` set in posthog_web?
```bash
docker exec posthog_web env | grep CDP_API_URL
```
Must be `CDP_API_URL=http://posthog_plugins:6738`.

**Fix if missing:** add to docker-compose.yml under posthog_web and posthog_worker environments:
```yaml
CDP_API_URL: http://posthog_plugins:6738
```
Then: `docker compose --env-file .env up -d --force-recreate posthog_web posthog_worker`

**Check 3** — Is posthog_plugins running?
```bash
docker ps --filter name=posthog_plugins
docker logs posthog_plugins --tail 10
```
Look for `"[MAIN] 🩺 HTTP server listening on port 6738"`.

**Check 4** — Plugin server Redis connectivity (`EAI_AGAIN redis`)?
```bash
docker logs posthog_plugins 2>&1 | grep -E 'EAI_AGAIN|Redis error'
```
Fix: add to posthog_plugins environment:
```yaml
LOGS_REDIS_HOST: redis_cdp
LOGS_REDIS_PORT: "6379"
LOGS_REDIS_PASSWORD: ""
TRACES_REDIS_HOST: redis_cdp
TRACES_REDIS_PORT: "6379"
TRACES_REDIS_PASSWORD: ""
```
Add `redis_cdp` service (unauthenticated Redis on posthog_net):
```yaml
redis_cdp:
  image: redis:7-alpine
  container_name: posthog_redis_cdp
  restart: unless-stopped
  networks: [posthog_net]
```

---

## Fix: `"celery": false`

**Check** — Is `POSTHOG_HEARTBEAT` Redis key recent (<300s)?
```bash
PASS=$(grep REDIS_PASSWORD /opt/posthog/.env | cut -d= -f2)
docker exec periscale_redis redis-cli -p 6379 -a $PASS --no-auth-warning GET POSTHOG_HEARTBEAT
date +%s
# Difference must be < 300
```

**Check** — Is the beat scheduler running?
```bash
docker exec posthog_worker ps aux | grep beat
```

**Fix if beat is dead:**
```bash
docker exec -d posthog_worker /bin/bash -c \
  'cd /code && rm -f celerybeat.pid && celery -A posthog beat -S redbeat.RedBeatScheduler'
# Wait ~60s for redbeat::lock TTL, then verify:
sleep 60
docker exec periscale_redis redis-cli -p 6379 -a $PASS --no-auth-warning GET POSTHOG_HEARTBEAT
```

**Fix if heartbeat updates but celery still false:** worker queues might be stuck. Force-recreate:
```bash
docker compose --env-file .env up -d --force-recreate posthog_worker
```

---

## Fix: `"redis": false`

```bash
docker ps --filter name=periscale_redis
docker exec periscale_redis redis-cli -p 6379 -a $PASS --no-auth-warning ping
```
If down: `docker compose --env-file .env up -d redis`

**DNS alias lost** (after manual network disconnect/reconnect):
```bash
docker network inspect posthog_net | python3 -c \
  "import sys,json; nets=json.load(sys.stdin)[0]['Containers']; \
   [print(v['Name'], v.get('IPv4Address')) for v in nets.values()]"
# If redis shows "Aliases": [] instead of ["redis"]
docker compose --env-file .env up -d --force-recreate redis
```

---

## Fix: `"db": false` (postgres/pgbouncer)

**PgBouncer "server login has been failing, cached error":**
```bash
docker compose --env-file .env up -d --force-recreate pgbouncer
```

**Postgres fails to start on reboot:**
Check for static IP conflict:
```bash
cat docker-compose.yml | grep ipv4_address
```
If found — remove all `ipv4_address` entries from postgres and any `extra_hosts` from pgbouncer that reference the IP. Use Docker DNS only.

---

## Fix: `"clickhouse": false`

```bash
docker ps --filter name=posthog_clickhouse
docker logs posthog_clickhouse --tail 20
docker exec posthog_clickhouse clickhouse-client --query "SELECT 1"
```

---

## Fix: `"kafka": false`

```bash
docker ps --filter name=posthog_kafka --filter name=posthog_zookeeper
docker logs posthog_kafka --tail 20
```
ZooKeeper must be healthy before Kafka starts.

---

## Fix: Nginx 502/504 after container recreation

**502** — Nginx has cached old container IP:
```bash
docker exec periscale_nginx nginx -s reload
```

**504** — posthog_web still initializing. Check progress:
```bash
docker logs posthog_web 2>&1 | grep -E 'unit 1\.|application started|Migration|AXES' | tail -10
```
Wait for all 4 `"posthog" application started` messages (~12 min total on first boot).

---

## Full health snapshot

Run this to get a complete picture:
```bash
HOST=<DOMAIN>
echo "=== Preflight ===" && curl -s https://$HOST/_preflight/ | python3 -m json.tool | grep -E 'django|redis|plugins|celery|clickhouse|kafka|"db"'
echo "=== Containers ===" && docker ps --format "{{.Names}}\t{{.Status}}" | sort
echo "=== Plugin server ===" && docker exec posthog_plugins curl -s http://localhost:6738/_health | python3 -m json.tool 2>/dev/null | head -5
echo "=== Heartbeat age ===" && PASS=$(grep REDIS_PASSWORD /opt/posthog/.env | cut -d= -f2) && HB=$(docker exec periscale_redis redis-cli -p 6379 -a $PASS --no-auth-warning GET POSTHOG_HEARTBEAT) && echo "$(($(date +%s) - ${HB:-0})) seconds ago"
```
