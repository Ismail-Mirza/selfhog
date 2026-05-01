# LinkedIn Post

---

Mixpanel costs $450/month at scale.

PostHog is free to self-host.

So I tried it — for a startup looking to cut costs. What followed was 12 hours of debugging that nobody warned me about.

Here's what nobody tells you about self-hosting PostHog 👇

━━━━━━━━━━━━━━━━━━━━━━━
🦔 THE STARTUP SELF-HOST TRAP MAP
━━━━━━━━━━━━━━━━━━━━━━━

❌ "plugins: false" forever
→ Django checks a Kubernetes URL by default
→ Fix: CDP_API_URL=http://posthog_plugins:6738

❌ Node.js crash loop every 2 seconds
→ Wrong image — posthog/posthog has no Node.js code
→ Fix: override command to skip the worker

❌ Fernet key rejected
→ ENCRYPTION_SALT_KEYS must be 32 raw chars, not base64
→ Fix: openssl rand -hex 16

❌ Postgres fails on every reboot
→ Static ipv4_address gets stolen by another container
→ Fix: delete the static IP, use Docker DNS

❌ "celery: false" after a restart
→ redbeat distributed lock not released
→ Fix: docker exec -d to restart beat without downtime

❌ Nginx 502 after container recreation
→ IP changed, Nginx cached the old one
→ Fix: nginx -s reload

━━━━━━━━━━━━━━━━━━━━━━━

I packaged every fix into selfhog — a Claude Code skill:

npx selfhog

Installs two slash commands:
▸ /deploy-posthog — full guided deployment with all gotchas handled
▸ /posthog-health — diagnose and auto-fix any broken service

Open source → github.com/Ismail-Mirza/selfhog
npm → npmjs.com/package/selfhog

━━━━━━━━━━━━━━━━━━━━━━━

Why startups should self-host PostHog:
✅ Full data ownership
✅ No usage limits
✅ Saves $450+/month vs Mixpanel
✅ GDPR-friendly by default

The self-hosted route is worth it — you just need the map.

#PostHog #Startups #Analytics #DevOps #Docker #OpenSource #SelfHosted #ClaudeCode

---

## Infographic (attach as image)

```
┌─────────────────────────────────────────────────────────┐
│          🦔 SELF-HOSTING POSTHOG: THE REAL MAP           │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  WHAT DOCS SAY          WHAT ACTUALLY HAPPENS           │
│  ─────────────          ──────────────────────          │
│  docker compose up  →   ❌ plugins: false               │
│                         ❌ Node.js crash loop           │
│                         ❌ Postgres won't start         │
│                         ❌ celery: false                │
│                         ❌ nginx 502                    │
│                                                          │
│  ──────────────────────────────────────────────────     │
│                                                          │
│  THE FIXES                                               │
│  ─────────                                               │
│  🔌  CDP_API_URL=http://posthog_plugins:6738            │
│  📦  command: ./bin/migrate && ./bin/docker-server      │
│  🔑  ENCRYPTION_SALT_KEYS = 32 raw chars                │
│  🌐  No static ipv4_address on postgres                 │
│  🥁  docker exec -d ... celery beat                     │
│  🔁  nginx -s reload                                    │
│                                                          │
│  ──────────────────────────────────────────────────     │
│                                                          │
│  npx selfhog  →  /deploy-posthog  /posthog-health      │
│                                                          │
│         github.com/Ismail-Mirza/selfhog                 │
│                                                          │
│                         — Mohammad Ismail               │
└─────────────────────────────────────────────────────────┘
```
