# 🦔 posthog-deploy-skill

> Claude Code slash commands for self-hosting PostHog with Docker Compose — battle-tested deployment knowledge packed into two commands.

[![npm version](https://img.shields.io/npm/v/selfhog.svg)](https://www.npmjs.com/package/selfhog)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Skill-blueviolet)](https://claude.ai/code)
[![GitHub](https://img.shields.io/badge/GitHub-Ismail--Mirza%2Fselfhog-181717?logo=github)](https://github.com/Ismail-Mirza/selfhog)

---

## What is this?

Self-hosting PostHog is powerful but full of hidden gotchas — wrong Redis configs, broken DNS aliases, Fernet key format traps, nginx IP caching, beat scheduler crashes. This package encodes all of that hard-won knowledge as two Claude Code slash commands you can use from any terminal.

```bash
npx selfhog
```

That's it. Two commands are now available in Claude Code:

| Command | What it does |
|---|---|
| `/deploy-posthog` | Full guided deployment on a fresh VPS — generates secrets, writes compose file (incl. capture-rs), handles TLS, explains every gotcha |
| `/posthog-health` | Diagnoses and fixes a running stack — checks all 7 preflight services + event ingestion (capture-rs) and gives exact fix commands |

---

## Install

```bash
# Run once to install the skills
npx selfhog

# Or install globally
npm install -g selfhog
```

Skills are copied to `~/.claude/commands/` and immediately available in any Claude Code session.

---

## Usage

### Deploy a fresh PostHog instance

Open Claude Code in your terminal and run:

```
/deploy-posthog
```

Claude will guide you through:

1. **Secrets generation** — including the tricky `ENCRYPTION_SALT_KEYS` format (32 raw UTF-8 chars, not base64)
2. **TLS setup** — certbot standalone certificate before nginx starts
3. **Full `docker-compose.yml`** — all 10 services wired up correctly
4. **Deployment** — `docker compose up -d` with correct startup order
5. **Health verification** — confirms all 7 preflight checks pass

---

### Diagnose a broken stack

```
/posthog-health
```

Checks every preflight service and provides exact fix commands:

```
=== Preflight ===
"django": true,
"redis": true,
"plugins": true,   ← was false without CDP_API_URL
"celery": true,    ← was false after beat scheduler crash
"clickhouse": true,
"kafka": true,
"db": true
```

```mermaid
flowchart TD
    Start(["/posthog-health"]) --> Preflight["curl /_preflight/"]

    Preflight --> P{plugins?}
    Preflight --> C{celery?}
    Preflight --> R{redis?}
    Preflight --> DB{db?}

    P -->|false| P1["Check CDP_API_URL env var"]
    P1 --> P2{set?}
    P2 -->|no| P3["Add CDP_API_URL=http://posthog_plugins:6738\ndocker compose up --force-recreate posthog_web"]
    P2 -->|yes| P4["Check posthog_plugins logs\nfor EAI_AGAIN / Redis error"]
    P4 --> P5["Add LOGS_REDIS_HOST: redis_cdp\nAdd TRACES_REDIS_HOST: redis_cdp"]

    C -->|false| C1["GET POSTHOG_HEARTBEAT from Redis\nCompare with date +%s"]
    C1 --> C2{age < 300s?}
    C2 -->|no| C3["Check: ps aux | grep beat\nin posthog_worker"]
    C3 --> C4{beat running?}
    C4 -->|no| C5["docker exec -d posthog_worker\ncelery beat -S redbeat.RedBeatScheduler\nWait 60s for redbeat::lock TTL"]
    C4 -->|yes| C6["force-recreate posthog_worker"]

    R -->|false| R1["docker exec redis redis-cli ping\nCheck DNS alias in posthog_net"]
    R1 --> R2["force-recreate redis to restore\nDocker network alias"]

    DB -->|false| DB1["PgBouncer cached error?"]
    DB1 --> DB2["force-recreate pgbouncer"]

    P3 --> OK(["✅ All checks pass"])
    P5 --> OK
    C5 --> OK
    C6 --> OK
    R2 --> OK
    DB2 --> OK
    P -->|true| OK
    C -->|true| OK
    R -->|true| OK
    DB -->|true| OK
```

---

## Architecture

```mermaid
graph TB
    Internet((Internet)) -->|HTTPS 443| nginx

    subgraph ingress["Ingress"]
        nginx["nginx:1.27\nnginx:443 / 80"]
    end

    nginx -->|"/e/, /batch/, /capture/<br/>/track/, /engage/, /i/*<br/>HTTP 3000"| posthog_capture
    nginx -->|"/decide/, /, /api/, /admin/<br/>HTTP 8000"| posthog_web

    subgraph capture["Ingestion — ghcr.io/posthog/posthog/capture image (Rust)"]
        posthog_capture["posthog_capture\nRust event ingestion\nport 3000\nvalidates api_key via Redis<br/>writes to Kafka events_plugin_ingestion"]
    end

    subgraph app["Application — posthog/posthog image"]
        posthog_web["posthog_web\nDjango + Nginx Unit\n4 workers\n./bin/migrate && ./bin/docker-server\n(UI + queries + /decide/)"]
        posthog_worker["posthog_worker\nCelery + redbeat\ndocker-worker-celery --with-scheduler"]
    end

    subgraph plugins["Plugin Server — posthog/posthog-node image"]
        posthog_plugins["posthog_plugins\nCDP / Plugin Server\nport 6738\nnode dist/index.js\n(Kafka consumer → ClickHouse)"]
    end

    posthog_web -->|CDP_API_URL /_health| posthog_plugins
    posthog_worker -->|CDP_API_URL| posthog_plugins

    subgraph analytics["Analytics"]
        clickhouse["posthog_clickhouse\nClickHouse 24.8"]
        kafka["posthog_kafka\nKafka 7.6"]
        zookeeper["posthog_zookeeper\nZooKeeper 3.9"]
    end

    zookeeper --> kafka
    posthog_capture --> kafka
    posthog_web --> clickhouse
    posthog_web --> kafka
    posthog_worker --> clickhouse
    posthog_plugins --> clickhouse
    posthog_plugins --> kafka

    subgraph data["Data"]
        redis["redis\nRedis 7\nauthenticated\nport 6379 / 6380 TLS"]
        redis_cdp["redis_cdp\nRedis 7\nunauthenticated\nlogs + traces ingestion"]
        postgres["postgres\npgvector/pg17\nport 5432"]
        pgbouncer["pgbouncer\nport 6584\nexternal connections"]
    end

    posthog_capture -->|REDIS_URL\nteam-token cache| redis
    posthog_web --> redis
    posthog_worker --> redis
    posthog_plugins -->|CDP_REDIS| redis
    posthog_plugins -->|LOGS_REDIS / TRACES_REDIS| redis_cdp
    posthog_web --> postgres
    posthog_worker --> postgres
    posthog_plugins --> postgres
    postgres --> pgbouncer

    subgraph networks["Docker Networks"]
        direction LR
        db_net["db_net\nnginx · web · worker · plugins\nredis · postgres · pgbouncer"]
        posthog_net["posthog_net\nweb · worker · plugins\nclickhouse · kafka · zookeeper · redis_cdp"]
    end

    style ingress fill:#e8f5e9,stroke:#388e3c
    style app fill:#e3f2fd,stroke:#1565c0
    style plugins fill:#fce4ec,stroke:#c62828
    style analytics fill:#fff3e0,stroke:#e65100
    style data fill:#f3e5f5,stroke:#6a1b9a
    style networks fill:#fafafa,stroke:#bdbdbd
```

---

## Key lessons encoded

These are the hard problems this skill solves — so you don't have to discover them yourself:

### 🔌 `CDP_API_URL` — the hidden plugin server config
PostHog's `is_plugin_server_alive()` calls `CDP_API_URL + "/_health"`. In production (non-debug, non-cloud) it defaults to a Kubernetes service URL that doesn't exist in self-hosted setups. Without this, `"plugins": false` forever.

```yaml
CDP_API_URL: http://posthog_plugins:6738
```

### 📦 Split images — `posthog/posthog` vs `posthog/posthog-node`
The `posthog/posthog` image's default `CMD` (`./bin/docker`) runs `bin/docker-worker` which tries to start the Node.js plugin server — but the Node.js code only exists in `posthog/posthog-node`. Result: endless crash loop every 2 seconds consuming CPU. Fix: override the command.

```yaml
command: bash -c "./bin/migrate && ./bin/docker-server"
```

### 🔑 `ENCRYPTION_SALT_KEYS` format trap
The plugin server does `Buffer.from(key, 'utf-8').toString('base64')` internally. If you pass a base64-encoded key, it double-encodes and Fernet rejects it. Use a raw 32-character string.

```bash
openssl rand -hex 16   # 32 hex chars = 32 UTF-8 bytes ✓
```

### 🌐 Static IP → reboot failures
Assigning `ipv4_address` to postgres causes other containers to grab that IP first on reboot. postgres can't start. Never use static IPs with Docker Compose — let Docker DNS handle it.

### 🥁 Beat scheduler crash & redbeat lock
After a force-recreate, the redbeat distributed lock in Redis may not be released. New beat instance waits for the TTL (~60s) before it can schedule tasks. The fix: start beat manually with `docker exec -d` and wait for the lock to expire.

### 🔁 Nginx IP caching after container recreation
When a container is recreated it gets a new IP. Nginx resolves hostnames at startup and caches them. A `nginx -s reload` re-resolves the hostname without dropping connections.

### 🔌 logs-ingestion hardcoded Redis host
The plugin server's logs-ingestion and traces-ingestion consumers hardcode `127.0.0.1:6379` as their Redis host. Override with a dedicated unauthenticated Redis (`redis_cdp`) via env vars.

### 🦀 capture-rs is mandatory — Django no longer routes `/batch/`
Modern PostHog (commit `edb2bdd4` and later, ~Sep 2024) **removed** `/e/`, `/batch/`, `/capture/`, `/i/v0/e/` from Django's URL config and moved them to a separate Rust service. Without it, every event POST falls through to Django's CSRF-guarded 404 view → `403 CSRF verification failed`. Even POSTs to non-existent paths return 403, which is the diagnostic fingerprint.

```yaml
posthog_capture:
  image: ghcr.io/posthog/posthog/capture:master  # ← note doubled "posthog/posthog"
  environment:
    KAFKA_TOPIC: events_plugin_ingestion          # plugin server consumes this
    CAPTURE_MODE: events
```

The image is **only** at `ghcr.io/posthog/posthog/capture` — no Docker Hub mirror, no `:latest` tag (use `:master`).

### 🛣️ nginx must route ingestion paths to capture-rs
Add a location block before the catch-all `/`:
```nginx
location ~ ^/(e|batch|capture|track|engage)/ { proxy_pass http://posthog_capture:3000; }
location /i/                                  { proxy_pass http://posthog_capture:3000; }
location /decide/                             { proxy_pass http://posthog_web:8000; }   # stays on Django
```

### 🔒 Django 4.x CSRF needs `CSRF_TRUSTED_ORIGINS`
Even after capture-rs handles ingestion, Django's `/decide/` and admin POSTs still require explicit trusted origins. Setting `SITE_URL` alone is not enough on Django 4.x:
```yaml
CSRF_TRUSTED_ORIGINS: https://${DOMAIN_POSTHOG}
ALLOWED_HOSTS: ${DOMAIN_POSTHOG},localhost,127.0.0.1
```

---

## Startup time expectations

| Phase | Duration |
|---|---|
| postgres / redis / clickhouse healthy | ~30s |
| kafka ready | ~60s |
| Django + ClickHouse migrations | 3–5 min |
| `run_async_migrations --complete-noop-migrations` | 1–3 min |
| Nginx Unit worker spawn (4 × ~90s) | 6–8 min |
| **Total — first boot** | **~12 min** |
| **Subsequent restarts** | **~4–6 min** |

```mermaid
timeline
    title PostHog First Boot Timeline
    0s – 30s   : postgres healthy
                : redis healthy
                : clickhouse healthy
    30s – 60s  : kafka ready
                : zookeeper ready
    1min – 5min : Django migrations
                : ClickHouse schema
    5min – 8min : run_async_migrations
    8min – 12min : Nginx Unit spawns
                 : 4 Django workers
                 : PostHog ready ✓
```

---

## Requirements

- Node.js ≥ 18
- [Claude Code](https://claude.ai/code) CLI installed
- Target VPS: Ubuntu 22.04+, 8GB RAM minimum (16GB recommended for stability)
- Docker + Docker Compose plugin

---

## Contributing

Found a new PostHog self-hosting gotcha? PRs welcome.

1. Fork [Ismail-Mirza/selfhog](https://github.com/Ismail-Mirza/selfhog)
2. Add your fix to `skills/deploy-posthog.md` or `skills/posthog-health.md`
3. Open a pull request with a description of the failure mode

---

## Author

**Mohammad Ismail**

- 📧 [ismail.me.buet@gmail.com](mailto:ismail.me.buet@gmail.com)
- 🌐 [linkedin.com/in/ismail-mirza](https://www.linkedin.com/in/ismail-mirza/)
- 📘 [facebook.com/ismail.buet](https://www.facebook.com/ismail.buet)

---

## License

MIT © Mohammad Ismail
