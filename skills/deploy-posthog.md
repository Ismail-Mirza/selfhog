# Deploy PostHog (Self-Hosted)

Deploy a production-ready self-hosted PostHog stack with Docker Compose on a fresh VPS. Covers postgres, redis, clickhouse, kafka, plugin server, nginx with TLS, and pgbouncer.

## What you'll need from the user before starting

Ask for these if not already provided:
- SSH access: `root@<vps-ip-or-hostname>`
- Domain: e.g. `posthog.example.com` (DNS A record must already point to the VPS)
- Desired deploy directory (default: `/opt/posthog`)

## Architecture

```
nginx (443/80) → posthog_web:8000 (Django + Nginx Unit)
                  posthog_worker (Celery + beat scheduler)
                  posthog_plugins (posthog/posthog-node — CDP/plugin server)
                  posthog_clickhouse
                  posthog_kafka ← posthog_zookeeper
                  redis (authenticated, TLS on 6380)
                  redis_cdp (unauthenticated, internal only)
                  postgres (pgvector)
                  pgbouncer:6584
```

**Key split:** `posthog/posthog` image handles web + worker. `posthog/posthog-node` image handles the plugin/CDP server. They must NOT share the same image.

## Step 1 — SSH and prepare VPS

```bash
ssh root@<HOST>
apt-get update && apt-get install -y docker.io docker-compose-plugin curl python3
mkdir -p <DEPLOY_DIR> && cd <DEPLOY_DIR>
```

## Step 2 — Generate secrets and write .env

Generate strong secrets:
```bash
openssl rand -hex 32   # POSTGRES_SUPERUSER_PASSWORD
openssl rand -hex 32   # POSTHOG_SECRET_KEY
openssl rand -hex 32   # REDIS_PASSWORD
openssl rand -hex 16   # ENCRYPTION_SALT_KEYS  ← MUST be exactly 32 hex chars (32 UTF-8 bytes)
openssl rand -hex 16   # PGBOUNCER_AUTH_PASSWORD
```

**CRITICAL — ENCRYPTION_SALT_KEYS:** The plugin server does `Buffer.from(key, 'utf-8').toString('base64')` internally. Pass a raw 32-character string (e.g. 32 hex chars = 32 bytes). Do NOT base64-encode it yourself.

Write `.env`:
```
DOMAIN_POSTHOG=posthog.example.com
POSTGRES_SUPERUSER_PASSWORD=<generated>
POSTHOG_SECRET_KEY=<generated>
REDIS_PASSWORD=<generated>
ENCRYPTION_SALT_KEYS=<32-hex-chars>
PGBOUNCER_PORT=6584
PGBOUNCER_AUTH_PASSWORD=<generated>

PERISCALE_DB=app
PERISCALE_DB_USER=app_user
PERISCALE_DB_PASSWORD=<generated>

POSTHOG_DB_USER=posthog
POSTHOG_DB_PASSWORD=<generated>

ORCHESTRATOR_DB=orchestrator
ORCHESTRATOR_DB_USER=orchestrator_app
ORCHESTRATOR_DB_PASSWORD=<generated>
```

## Step 3 — TLS certificates (before starting nginx)

```bash
apt-get install -y certbot
certbot certonly --standalone -d posthog.example.com
mkdir -p certs/letsencrypt && ln -s /etc/letsencrypt certs/letsencrypt
```

## Step 4 — docker-compose.yml

Use this template (pin the PostHog image tag — find latest at hub.docker.com/r/posthog/posthog/tags):

```yaml
services:

  postgres:
    image: pgvector/pgvector:pg17
    container_name: periscale_postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_SUPERUSER_PASSWORD}
      POSTGRES_DB: postgres
      POSTHOG_DB_USER: ${POSTHOG_DB_USER}
      POSTHOG_DB_PASSWORD: ${POSTHOG_DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./postgres/init.sh:/docker-entrypoint-initdb.d/init.sh:ro
    expose: ["5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 10
    networks: [db_net]
    # NEVER assign a static ipv4_address — on reboot other containers grab it first

  pgbouncer:
    image: edoburu/pgbouncer:latest
    container_name: periscale_pgbouncer
    restart: unless-stopped
    entrypoint: ["/usr/bin/pgbouncer"]
    command: ["/etc/pgbouncer/pgbouncer.ini"]
    depends_on:
      postgres: {condition: service_healthy}
    volumes:
      - ./pgbouncer/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro
      - ./pgbouncer/userlist.txt:/etc/pgbouncer/userlist.txt:ro
      - ./certs:/etc/pgbouncer/certs:ro
    ports:
      - "0.0.0.0:${PGBOUNCER_PORT:-6584}:6584"
    networks: [db_net]
    # Use Docker DNS (postgres hostname) — no extra_hosts or static IPs

  redis:
    image: redis:7-alpine
    container_name: periscale_redis
    restart: unless-stopped
    command: >
      redis-server
      --port 6379
      --requirepass ${REDIS_PASSWORD}
      --maxmemory 512mb
      --maxmemory-policy allkeys-lru
    volumes: [redis_data:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "-p", "6379", "-a", "${REDIS_PASSWORD}", "--no-auth-warning", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks: [db_net]

  nginx:
    image: nginx:1.27-alpine
    container_name: periscale_nginx
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./certs/letsencrypt:/etc/letsencrypt:ro
    depends_on: [posthog_web]
    networks: [db_net]

  posthog_clickhouse:
    image: clickhouse/clickhouse-server:24.8
    container_name: posthog_clickhouse
    restart: unless-stopped
    ulimits:
      nofile: {soft: 262144, hard: 262144}
    environment:
      CLICKHOUSE_DB: posthog
      CLICKHOUSE_USER: posthog
      CLICKHOUSE_PASSWORD: ${POSTHOG_DB_PASSWORD}
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: 1
    volumes:
      - clickhouse_data:/var/lib/clickhouse
      - clickhouse_logs:/var/log/clickhouse-server
      - ./clickhouse/cluster.xml:/etc/clickhouse-server/config.d/cluster.xml:ro
    healthcheck:
      test: ["CMD", "clickhouse-client", "--query", "SELECT 1"]
      interval: 10s
      timeout: 5s
      retries: 15
    networks: [posthog_net]

  posthog_zookeeper:
    image: zookeeper:3.9
    container_name: posthog_zookeeper
    restart: unless-stopped
    volumes: [zookeeper_data:/data, zookeeper_logs:/datalog]
    networks: [posthog_net]

  posthog_kafka:
    image: confluentinc/cp-kafka:7.6.1
    container_name: posthog_kafka
    restart: unless-stopped
    depends_on: [posthog_zookeeper]
    environment:
      KAFKA_ZOOKEEPER_CONNECT: posthog_zookeeper:2181
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://posthog_kafka:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
    volumes: [kafka_data:/var/lib/kafka/data]
    networks:
      posthog_net:
        aliases: [kafka]

  posthog_web:
    image: posthog/posthog:<TAG>
    container_name: posthog_web
    restart: unless-stopped
    # Skip bin/docker-worker (nodejs crash loop + celery — both in posthog_worker/posthog_plugins)
    command: bash -c "./bin/migrate && ./bin/docker-server"
    depends_on:
      postgres: {condition: service_healthy}
      redis: {condition: service_healthy}
      posthog_clickhouse: {condition: service_healthy}
      posthog_kafka: {condition: service_started}
    environment:
      DATABASE_URL: postgres://${POSTHOG_DB_USER}:${POSTHOG_DB_PASSWORD}@postgres:5432/posthog
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/
      CLICKHOUSE_HOST: posthog_clickhouse
      CLICKHOUSE_DATABASE: posthog
      CLICKHOUSE_USER: posthog
      CLICKHOUSE_PASSWORD: ${POSTHOG_DB_PASSWORD}
      CLICKHOUSE_SECURE: "false"
      CLICKHOUSE_HTTP_PORT: "8123"
      CLICKHOUSE_REPLICATION: "false"
      CLICKHOUSE_SATELLITE_CLUSTERS: ""
      KAFKA_HOSTS: posthog_kafka:9092
      SECRET_KEY: ${POSTHOG_SECRET_KEY}
      SITE_URL: https://${DOMAIN_POSTHOG}
      IS_BEHIND_PROXY: "true"
      TRUST_ALL_PROXIES: "true"
      DISABLE_SECURE_SSL_REDIRECT: "true"
      NGINX_UNIT_PRELOAD_CONFIG: "true"
      POSTHOG_SKIP_MIGRATION_CHECKS: "1"
      # Critical: tells Django where the plugin server lives
      CDP_API_URL: http://posthog_plugins:6738
    expose: ["8000"]
    networks: [db_net, posthog_net]

  posthog_worker:
    image: posthog/posthog:<TAG>
    container_name: posthog_worker
    restart: unless-stopped
    command: ./bin/docker-worker-celery --without-gossip --without-mingle --without-heartbeat --with-scheduler
    depends_on:
      postgres: {condition: service_healthy}
      redis: {condition: service_healthy}
      posthog_clickhouse: {condition: service_healthy}
    environment:
      DATABASE_URL: postgres://${POSTHOG_DB_USER}:${POSTHOG_DB_PASSWORD}@postgres:5432/posthog
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/
      CLICKHOUSE_HOST: posthog_clickhouse
      CLICKHOUSE_DATABASE: posthog
      CLICKHOUSE_USER: posthog
      CLICKHOUSE_PASSWORD: ${POSTHOG_DB_PASSWORD}
      CLICKHOUSE_SECURE: "false"
      CLICKHOUSE_HTTP_PORT: "8123"
      CLICKHOUSE_REPLICATION: "false"
      CLICKHOUSE_SATELLITE_CLUSTERS: ""
      KAFKA_HOSTS: posthog_kafka:9092
      SECRET_KEY: ${POSTHOG_SECRET_KEY}
      POSTHOG_SKIP_MIGRATION_CHECKS: "1"
      CDP_API_URL: http://posthog_plugins:6738
    networks: [db_net, posthog_net]

  redis_cdp:
    image: redis:7-alpine
    container_name: posthog_redis_cdp
    restart: unless-stopped
    networks: [posthog_net]

  posthog_plugins:
    image: posthog/posthog-node:latest
    container_name: posthog_plugins
    restart: unless-stopped
    command: node nodejs/dist/index.js
    depends_on:
      postgres: {condition: service_healthy}
      redis: {condition: service_healthy}
      redis_cdp: {condition: service_started}
      posthog_clickhouse: {condition: service_healthy}
      posthog_kafka: {condition: service_started}
    environment:
      DATABASE_URL: postgres://${POSTHOG_DB_USER}:${POSTHOG_DB_PASSWORD}@postgres:5432/posthog
      PERSONS_DATABASE_URL: postgres://${POSTHOG_DB_USER}:${POSTHOG_DB_PASSWORD}@postgres:5432/posthog
      KAFKA_HOSTS: posthog_kafka:9092
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/
      CLICKHOUSE_HOST: posthog_clickhouse
      CLICKHOUSE_DATABASE: posthog
      CLICKHOUSE_USER: posthog
      CLICKHOUSE_PASSWORD: ${POSTHOG_DB_PASSWORD}
      CLICKHOUSE_SECURE: "false"
      CLICKHOUSE_VERIFY: "false"
      SECRET_KEY: ${POSTHOG_SECRET_KEY}
      SITE_URL: https://${DOMAIN_POSTHOG}
      OBJECT_STORAGE_ENABLED: "false"
      CDP_REDIS_HOST: redis
      CDP_REDIS_PORT: "6379"
      CDP_REDIS_PASSWORD: ${REDIS_PASSWORD}
      CDP_REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/
      ENCRYPTION_SALT_KEYS: ${ENCRYPTION_SALT_KEYS}
      # logs/traces-ingestion defaults to 127.0.0.1 — point at redis_cdp (no auth)
      LOGS_REDIS_HOST: redis_cdp
      LOGS_REDIS_PORT: "6379"
      LOGS_REDIS_PASSWORD: ""
      LOGS_REDIS_TLS: "false"
      TRACES_REDIS_HOST: redis_cdp
      TRACES_REDIS_PORT: "6379"
      TRACES_REDIS_PASSWORD: ""
      TRACES_REDIS_TLS: "false"
    networks: [db_net, posthog_net]

volumes:
  postgres_data:
  redis_data:
  clickhouse_data:
  clickhouse_logs:
  zookeeper_data:
  zookeeper_logs:
  kafka_data:

networks:
  db_net:
    driver: bridge
  posthog_net:
    driver: bridge
```

Replace `<TAG>` with the pinned image digest, e.g. `edb2bdd4a92b7b6104aa233c814bfd1b670b3811`.

## Step 5 — Deploy

```bash
cd <DEPLOY_DIR>
docker compose --env-file .env up -d
```

First startup takes **8-12 minutes** — Django imports ~4 workers × ~90s each, plus async migrations.

## Step 6 — Verify health

Run `/posthog-health` to check all services, or manually:

```bash
# All 7 checks should be true
curl -s https://<DOMAIN>/_preflight/ | python3 -m json.tool | grep -E 'django|redis|plugins|celery|clickhouse|kafka|db'

# Plugin server direct health
docker exec posthog_plugins curl -s http://localhost:6738/_health | python3 -m json.tool
```

Expected output:
```json
"django": true,
"redis": true,
"plugins": true,
"celery": true,
"clickhouse": true,
"kafka": true,
"db": true
```

## Known issues and fixes

### 1. Static IP conflict on reboot (postgres fails to start)
**Symptom:** postgres container exits immediately after reboot.
**Cause:** Another container grabbed the static `ipv4_address` assigned to postgres before postgres started.
**Fix:** Never assign `ipv4_address` to postgres. Use Docker DNS only.

### 2. `"plugins": false` in preflight
**Cause:** `CDP_API_URL` not set — Django defaults to Kubernetes service URL.
**Fix:** Set `CDP_API_URL: http://posthog_plugins:6738` in `posthog_web` and `posthog_worker`.

### 3. Plugin server logs-ingestion Redis error (`EAI_AGAIN redis`)
**Cause:** logs-ingestion and traces-ingestion default to `127.0.0.1:6379` (hardcoded).
**Fix:** Set `LOGS_REDIS_HOST: redis_cdp` and `TRACES_REDIS_HOST: redis_cdp` pointing at the unauthenticated `redis_cdp` service.

### 4. `ENCRYPTION_SALT_KEYS` Fernet error
**Cause:** Key must be exactly 32 UTF-8 characters — the plugin server base64-encodes it internally. Passing a base64 string doubles the encoding.
**Fix:** Use a raw 32-char string: `openssl rand -hex 16` (produces 32 hex chars).

### 5. PgBouncer "server login has been failing, cached error"
**Cause:** PgBouncer caches connection failures. `SIGHUP` does NOT clear it.
**Fix:** `docker compose --env-file .env up -d --force-recreate pgbouncer`

### 6. `"celery": false` — beat scheduler crashed
**Cause:** Redbeat distributed lock not released after container force-recreate; or beat OOM killed.
**Symptom:** `POSTHOG_HEARTBEAT` Redis key is >300s stale.
**Fix:**
```bash
docker exec -d posthog_worker /bin/bash -c \
  'cd /code && rm -f celerybeat.pid && celery -A posthog beat -S redbeat.RedBeatScheduler'
# Wait ~60s for redbeat::lock TTL to expire, then check:
docker exec periscale_redis redis-cli -a $REDIS_PASSWORD GET POSTHOG_HEARTBEAT
```

### 7. Nginx 502 after force-recreate of posthog_web
**Cause:** Nginx caches the old container IP. New container gets a different IP.
**Fix:** `docker exec periscale_nginx nginx -s reload`

### 8. posthog_web nodejs crash loop
**Cause:** `bin/docker` (default CMD) runs `bin/docker-worker` which starts `bin/posthog-node` — but `posthog/posthog` image does not contain the Node.js plugin server code.
**Fix:** Override command to `bash -c "./bin/migrate && ./bin/docker-server"` (skips the nodejs loop; celery is handled by posthog_worker).

## Startup time expectations

| Phase | Duration |
|-------|----------|
| postgres/redis/clickhouse healthy | ~30s |
| kafka ready | ~60s |
| `bin/migrate` (Django + ClickHouse migrations) | 3-5 min |
| `run_async_migrations --complete-noop-migrations` | 1-3 min |
| Nginx Unit worker spawn (4 workers × 90s) | 6-8 min |
| **Total first boot** | **~12 min** |

Subsequent restarts: ~4-6 min (no migrations to apply).
