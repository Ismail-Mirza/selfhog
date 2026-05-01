# LinkedIn Post

---

Mixpanel charges $450/month at scale.

PostHog is free to self-host. So I tried it.

That was a mistake — or at least, a 12-hour debugging nightmare I didn't see coming.

For startups and small businesses, self-hosting PostHog sounds like the dream:
✅ Full data ownership
✅ No usage limits
✅ No $450/month bill
✅ GDPR-friendly

But the moment you run `docker compose up`, reality hits:

❌ Plugin server stuck at "false" — Django checks a Kubernetes URL that doesn't exist in Docker Compose
❌ Node.js crash loop every 2 seconds — wrong image, missing code
❌ Encryption key silently rejected
❌ Postgres won't start after every reboot
❌ Celery goes offline, holds a Redis lock
❌ Nginx 502 after any container recreate

None of this is in the docs.

I fixed all 6 traps, packaged every lesson into **selfhog** — an open-source Claude Code skill:

```
npx selfhog
```

Installs two slash commands:
▸ `/deploy-posthog` — full guided setup with every gotcha handled
▸ `/posthog-health` — diagnoses and auto-fixes any broken service

The self-hosted route is worth it. You just need the map.

🔗 github.com/Ismail-Mirza/selfhog

#PostHog #Startups #Analytics #OpenSource #Docker #SelfHosted #DevOps

---

# LinkedIn Community Post

---

Question for the DevOps community 👇

Has anyone else hit this wall when self-hosting PostHog?

✅ Django — ok
✅ Redis — ok
✅ Kafka — ok
❌ Plugin server — Error

Turns out Django checks a **Kubernetes URL** by default that doesn't exist in Docker Compose. One env var fixes it — but the docs don't mention it.

I documented this and 5 other traps in an open-source Claude Code skill → **npx selfhog**

What's the most surprising self-hosting gotcha you've hit?

#PostHog #SelfHosted #DevOps #Docker

---

# Facebook Post

---

🦔 Spent 12 hours debugging PostHog self-hosting so you don't have to.

6 traps the docs skip. All fixed with one command:

👉 **npx selfhog**

Installs two Claude Code slash commands — /deploy-posthog and /posthog-health — with every fix baked in.

Open source → github.com/Ismail-Mirza/selfhog

If you're self-hosting analytics, this saves you a day. 🙌

#PostHog #OpenSource #Docker #Analytics
