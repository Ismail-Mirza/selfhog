# Facebook Post

---

🦔 This weekend I decided to learn PostHog by self-hosting it. What I thought would take an afternoon turned into 12 hours of debugging.

PostHog is a great open-source analytics platform. The docs look simple. But the moment you actually try to run it with Docker Compose, things start breaking in ways that are hard to explain and even harder to find answers for.

Here is what I ran into:

Plugin server stuck at false. The Django app checks a Kubernetes URL by default — a URL that simply does not exist in a Docker Compose setup. Nothing in the docs mentions this.

Node.js crash loop. The default Docker image tries to run Node.js code that is not actually in the image. It crashes every 2 seconds, restarts, crashes again. Took me a long time to figure out it was the wrong command entirely.

Encryption key silently rejected. The key format has a specific requirement — 32 raw characters. Pass anything else and it fails quietly with no useful error message.

Postgres not starting after reboot. A static IP assignment in the compose file was being taken by another container on startup. This happened every single reboot until I removed the static IP.

Celery going offline. The beat scheduler crashed and left a distributed lock in Redis. The lock had a TTL but it meant waiting before restarting. Nothing in the logs made this obvious.

Nginx returning 502 after container recreate. The container got a new IP, Nginx had cached the old one, and traffic was going nowhere. A simple reload fixed it but I had no idea that was the issue.

After getting through all of this, I put everything I learned into an open-source Claude Code skill called selfhog. The idea is simple — if you want to learn PostHog by self-hosting it, you should not have to spend 12 hours hitting the same walls I did.

npx selfhog

This installs two slash commands into Claude Code:
/deploy-posthog — walks you through the full setup with all the known issues handled
/posthog-health — checks what is broken and fixes it automatically

github.com/Ismail-Mirza/selfhog
npmjs.com/package/selfhog

Hope this helps someone out there who is trying to do the same thing.

#PostHog #OpenSource #Docker #SelfHosted #Analytics #DevOps

---

## Infographic (attach as image)

```
╔═════════════════════════════════════════════════════════╗
║       🦔  SELF-HOSTING POSTHOG IN REAL LIFE             ║
╠═════════════════════════════════════════════════════════╣
║                                                          ║
║   FIRST BOOT TIMELINE                                    ║
║   ─────────────────────────────────────────────────     ║
║   0:00  ████░░░░░░░░░░░░  postgres + redis ready        ║
║   1:00  ████████░░░░░░░░  kafka ready                   ║
║   5:00  ████████████░░░░  migrations done               ║
║   8:00  ████████████████  all workers up  ✅            ║
║                                                          ║
║   ─────────────────────────────────────────────────     ║
║                                                          ║
║   PREFLIGHT CHECKLIST                                    ║
║   ─────────────────────────────────────────────────     ║
║   ✅  Django       ✅  Redis       ✅  ClickHouse        ║
║   ✅  Kafka        ✅  Celery      ✅  Database          ║
║   ✅  Plugin Server  ← hardest one to fix               ║
║                                                          ║
║   ─────────────────────────────────────────────────     ║
║                                                          ║
║   THE SHORTCUT                                           ║
║                                                          ║
║       npx selfhog                                        ║
║                                                          ║
║       /deploy-posthog   Full guided setup               ║
║       /posthog-health   Fix any broken service          ║
║                                                          ║
║              github.com/Ismail-Mirza/selfhog            ║
║                          — Mohammad Ismail              ║
╚═════════════════════════════════════════════════════════╝
```
