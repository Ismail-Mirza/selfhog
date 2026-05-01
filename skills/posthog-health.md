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

## Step 2 — Event ingestion is reachable (capture-rs)

`/_preflight/` does NOT cover the event ingestion path. Test it explicitly:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST 'https://<DOMAIN>/batch/' \
  -H 'Content-Type: application/json' \
  --data '{"api_key":"<phc_...>","batch":[{"event":"t","distinct_id":"d","properties":{}}]}'
```

| Result | Meaning | Action |
|---|---|---|
| `200` | capture-rs healthy, events flowing to Kafka | ✅ done |
| `403` (HTML body, "CSRF verification failed") | Request hit Django, not capture-rs | See *Fix: events return 403 CSRF* below |
| `502` | capture-rs container down | `docker compose --env-file .env up -d posthog_capture` |
| `401` / `400` | api_key invalid / payload malformed | Check the project key, not infra |

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

## Fix: events return `403 CSRF verification failed`

This means ingestion POSTs are reaching **Django**, not capture-rs. Three things to check:

**Check 1 — Is `posthog_capture` running?**
```bash
docker ps --filter name=posthog_capture --format "{{.Status}}"
docker logs posthog_capture --tail 20
```
You should see `listening on 0.0.0.0:3000` and `connected to Kafka brokers`.

**If missing:** the service isn't in `docker-compose.yml`. Add the `posthog_capture` block (see `/deploy-posthog` Step 4) and:
```bash
docker compose --env-file .env up -d posthog_capture
```

**Check 2 — Does nginx route `/batch/` to capture-rs?**
```bash
docker exec periscale_nginx grep -A2 'capture\|posthog_capture' /etc/nginx/conf.d/posthog.conf
```
Should show `proxy_pass http://posthog_capture:3000;` for the `/(e|batch|capture|track|engage)/` and `/i/` locations. **If it still says `posthog_web:8000`** for ingestion paths, replace the locations (see `/deploy-posthog` Step 4b) and:
```bash
docker exec periscale_nginx nginx -t && docker exec periscale_nginx nginx -s reload
```

**Check 3 — Image pull failed?**
```bash
docker images | grep capture
```
The image must be `ghcr.io/posthog/posthog/capture:master` (note the doubled `posthog/posthog`). If a previous compose used `ghcr.io/posthog/capture:latest`, the pull failed silently and the container is missing.

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
KEY=<phc_project_key>
echo "=== Preflight ===" && curl -s https://$HOST/_preflight/ | python3 -m json.tool | grep -E 'django|redis|plugins|celery|clickhouse|kafka|"db"'
echo "=== Containers ===" && docker ps --format "{{.Names}}\t{{.Status}}" | sort
echo "=== Plugin server ===" && docker exec posthog_plugins curl -s http://localhost:6738/_health | python3 -m json.tool 2>/dev/null | head -5
echo "=== capture-rs ===" && docker logs --tail 3 posthog_capture 2>&1 | tail -3
echo "=== Ingestion test (should be 200) ===" && curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://$HOST/batch/" -H 'Content-Type: application/json' --data "{\"api_key\":\"$KEY\",\"batch\":[{\"event\":\"_health\",\"distinct_id\":\"d\",\"properties\":{}}]}"
echo "=== Heartbeat age ===" && PASS=$(grep REDIS_PASSWORD /opt/posthog/.env | cut -d= -f2) && HB=$(docker exec periscale_redis redis-cli -p 6379 -a $PASS --no-auth-warning GET POSTHOG_HEARTBEAT) && echo "$(($(date +%s) - ${HB:-0})) seconds ago"
```
