---
name: deploy-stack
description: First-time bootstrap of the tracking stack into a recipient's Cloudflare account. Use when the recipient says "set this up", "deploy this", "I just downloaded this", "first-time setup", "get this running", "install", "configure", or when the repo looks freshly unpacked (no wrangler.toml, .dev.vars missing, no prior deployment). Creates the Cloudflare Pages project, creates and binds the D1 database, applies all migrations, collects required and optional secrets interactively, and runs the first deploy. Drives wrangler CLI directly.
---

# Skill: deploy-stack

You are helping a recipient deploy this tracking stack into their own Cloudflare account for the first time. The recipient is almost certainly a non-developer. Talk to them plainly, explain *why* each step matters in one sentence, and don't dump raw command output on them — summarize.

This skill runs once per recipient. When it's done, they should have a live Pages URL with the database bound, migrations applied, required secrets set, and an initial deploy completed. The next step for them after this skill is the `verify-tracking` skill.

## Before you start

Confirm with the recipient:
1. They have a Cloudflare account (free tier is fine).
2. They know how to open a browser window (they'll need to for `wrangler login`).
3. `wrangler` is installed. Run `wrangler --version`. If it errors or the version is older than 4.x, tell them to run `npm install -g wrangler` and re-run this skill after.

If they don't have Node / npm installed at all, stop and tell them how to install Node (point at [nodejs.org](https://nodejs.org), LTS version). Claude Code can guide them through the install but should not attempt it silently — they'll need admin rights on their own machine.

## Step 1 — Login to Cloudflare

```bash
wrangler login
```

This opens their browser. Wait for them to confirm "Allow" in the Cloudflare dashboard. When wrangler prints "Successfully logged in", move on.

## Step 2 — Pick a project name

Ask the recipient: "What should we call this tracking project? This becomes part of your URL (e.g. `my-tracking.pages.dev`). Use lowercase letters, numbers, and hyphens only. Examples: `acme-tracking`, `brand-ads-2026`."

Store the answer as `PROJECT_NAME`. The D1 database will be named `${PROJECT_NAME}-db`.

## Step 3 — Create the Cloudflare Pages project

```bash
wrangler pages project create ${PROJECT_NAME} --production-branch main
```

If wrangler errors with "project already exists", ask the recipient: "A project with this name already exists in your Cloudflare account. Do you want to reuse it, or pick a different name?" If they reuse, continue. If they pick a new name, restart from Step 2.

## Step 4 — Create the D1 database

```bash
wrangler d1 create ${PROJECT_NAME}-db
```

**Parse the output carefully.** Wrangler prints the binding snippet including `database_id = "..."` on success. Extract that UUID. You'll need it for the next step.

If creation fails with "already exists", run:

```bash
wrangler d1 list
```

...find the matching row, and use its `database_id`. Tell the recipient you're reusing the existing database.

## Step 5 — Write `wrangler.toml` from the template

The repo ships `wrangler.toml.example` with three `__REPLACE_ME_*__` placeholders. Read that file, substitute:

- `__REPLACE_ME_PROJECT_NAME__` → the recipient's `PROJECT_NAME` from Step 2
- `__REPLACE_ME_DB_NAME__` → `${PROJECT_NAME}-db`
- `__REPLACE_ME_DB_ID__` → the UUID from Step 4

Write the result to `wrangler.toml`. This file is gitignored; do not commit it.

Confirm by reading `wrangler.toml` back and showing the recipient the non-placeholder contents.

## Step 6 — Apply migrations

```bash
wrangler d1 migrations apply ${PROJECT_NAME}-db --remote
```

You should see 13 migrations applied (0001-0014, missing 0005 which is intentional). If any migration fails, stop and investigate — do not try to work around it. Likely causes: stale local wrangler state, network timeout, or a schema conflict if they reused an existing database with data in it.

## Step 7 — Collect required secrets

These five are non-negotiable. Prompt the recipient for each, one at a time, and explain what it is. Set each via:

```bash
wrangler pages secret put ${SECRET_NAME} --project-name ${PROJECT_NAME}
```

`wrangler pages secret put` opens an interactive prompt. Tell the recipient to paste the value when prompted (it won't echo).

| Secret | What it is | Where to find it |
|---|---|---|
| `META_PIXEL_ID` | Your Meta Pixel's numeric ID | Meta Events Manager → your Pixel → top of the page |
| `META_ACCESS_TOKEN` | A CAPI access token for that Pixel | Meta Events Manager → your Pixel → Settings → "Generate access token" |
| `GA4_MEASUREMENT_ID` | Your GA4 Measurement ID, format `G-XXXXXXXXXX` | GA4 Admin → Data Streams → your stream → top right |
| `GA4_API_SECRET` | A GA4 Measurement Protocol API secret | GA4 Admin → Data Streams → your stream → Measurement Protocol API secrets → Create |
| `DASH_KEY` | A random string gating the dashboard | Generate one: `openssl rand -hex 32` or let the recipient pick a strong password |

For `DASH_KEY`, offer to generate one: tell them the value after you set it so they can save it in their password manager. The dashboard URL they open later is `https://<project>.pages.dev/dash/?key=<DASH_KEY>`.

## Step 8 — Offer optional secrets

Ask the recipient: "The stack has several optional integrations. I'll list them — tell me which you want to set up now, and we can skip the rest (you can add them later)."

**Meta test events** — for debugging before going live:
- `META_TEST_EVENT_CODE` — any test code from Meta Events Manager → Test Events tab

**Timezone for Google Ads conversions** — defaults to São Paulo (`-03:00`):
- `TIMEZONE_OFFSET` — ISO offset like `-05:00`, `+00:00`, etc. Must match the recipient's Google Ads account timezone or conversions get rejected.

**Google Ads conversion uploads** (all six required together — if any one is missing, Google Ads integration silently skips):
- `GOOGLE_ADS_CLIENT_ID`
- `GOOGLE_ADS_CLIENT_SECRET`
- `GOOGLE_ADS_REFRESH_TOKEN`
- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_CUSTOMER_ID` (format `1234567890`, no hyphens)
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC/manager account ID, still required even without MCC — use the same value as `GOOGLE_ADS_CUSTOMER_ID` if they don't use MCC)

If the recipient doesn't already have a developer token, tell them "This takes a few days to get approved by Google. Skip for now — we can add Google Ads later."

**Encharge** (email marketing automation):
- `ENCHARGE_API_KEY` — from Encharge → Apps → HTTP API

**ManyChat** (WhatsApp / Messenger):
- `MANYCHAT_KEY` — from ManyChat → Settings → API → Your API Key

**Ad spend sync via cron** (so the dashboard shows Meta spend, CPA, ROAS):
- `SYNC_SECRET` — random string, e.g. `openssl rand -hex 32`
- `META_ADS_ACCESS_TOKEN` — Meta Marketing API token (system user recommended, see `docs/ad-spend-sync.md`)
- `META_ADS_ACCOUNT_ID` — ad account ID, digits only, no `act_` prefix

If they set ad spend secrets, remind them they still need to schedule the cron externally. Point them at `docs/ad-spend-sync.md` for the three cron provider walkthroughs (cron-job.org, GitHub Actions, EasyCron).

**Per-platform webhook slugs** (set only the ones matching the sales platforms they actually use):

Sales-platform webhooks hit the stack at `/webhook/<platform>/<slug>`, where
`<slug>` is a random 36-character UUID that gates the endpoint. It's the
only thing standing between a public URL and arbitrary purchase
injection, so treat it like a secret — but YOU generate it, the recipient
doesn't need to find anything in any dashboard.

Ask which sales platforms they use (Eduzz / Hotmart / Kiwify / none of
those). For each YES, generate a fresh UUID and set it as the platform's
slug secret:

```bash
# Generate UUIDs (one per platform the recipient uses)
EDUZZ_SLUG=$(uuidgen | tr '[:upper:]' '[:lower:]')
HOTMART_SLUG=$(uuidgen | tr '[:upper:]' '[:lower:]')
KIWIFY_SLUG=$(uuidgen | tr '[:upper:]' '[:lower:]')

# Set each as a Cloudflare secret (recipient sees the prompt but we paste)
echo "$EDUZZ_SLUG"   | wrangler pages secret put EDUZZ_WEBHOOK_SLUG   --project-name ${PROJECT_NAME}
echo "$HOTMART_SLUG" | wrangler pages secret put HOTMART_WEBHOOK_SLUG --project-name ${PROJECT_NAME}
echo "$KIWIFY_SLUG"  | wrangler pages secret put KIWIFY_WEBHOOK_SLUG  --project-name ${PROJECT_NAME}
```

After setting, **capture and display the full webhook URLs back to the
recipient** — they'll paste these into each platform's dashboard in a
later step. This is the ONLY time the slugs are surfaced; they should
save them in a password manager alongside `DASH_KEY`.

```
Eduzz webhook URL:   https://${PROJECT_NAME}.pages.dev/webhook/eduzz/${EDUZZ_SLUG}
Hotmart webhook URL: https://${PROJECT_NAME}.pages.dev/webhook/hotmart/${HOTMART_SLUG}
Kiwify webhook URL:  https://${PROJECT_NAME}.pages.dev/webhook/kiwify/${KIWIFY_SLUG}
```

Tell the recipient: "These URLs are how your sales platform reaches your
tracking stack. Save them — you'll paste one into each platform's
webhook configuration. If anyone else gets the URL, they can inject fake
purchases into your reporting, so don't share them publicly."

## Step 9 — Initial deploy

```bash
wrangler pages deploy --project-name ${PROJECT_NAME}
```

Wrangler prints a URL on success (something like `https://${PROJECT_NAME}.pages.dev`). Capture it. If the deploy fails, the most common causes are:

- A secret was set with a trailing newline — re-run `wrangler pages secret put` for the suspect one.
- `wrangler.toml` still has a `__REPLACE_ME__` placeholder — go back to Step 5.
- The account doesn't have Pages enabled — tell the recipient to visit dash.cloudflare.com/pages once to accept terms.

## Step 10 — Report and hand off

Show the recipient a short summary:

```
✓ Project: ${PROJECT_NAME}
✓ Live at:  https://${PROJECT_NAME}.pages.dev
✓ D1:       ${PROJECT_NAME}-db (13 migrations applied)
✓ Secrets:  <list the ones they set, not the values>

Dashboard: https://${PROJECT_NAME}.pages.dev/dash/?key=<DASH_KEY>
            (Save the DASH_KEY somewhere safe — it's the only way to access the dashboard.)

Next steps:
  1. Add your first lead or sales page — say "add a lead page" or "add a sales page".
  2. Run "verify tracking" to walk the 6-checkpoint integrity chain.
  3. If you use Meta Ads, configure ad-spend sync — see docs/ad-spend-sync.md.
```

Do not suggest they run `verify-tracking` immediately if they have no pages yet. Tell them to add at least one page first, visit it once in a browser, then run `verify-tracking`. The verify skill needs real traffic data in D1 to check anything meaningful.

## Troubleshooting

**"wrangler login" opens the browser but never returns.**
The recipient probably didn't click "Allow" in the Cloudflare dashboard. Ask them to check the browser tab.

**"No account found"** or similar after login.
The Cloudflare account might not have been fully activated yet. Tell them to visit [dash.cloudflare.com](https://dash.cloudflare.com) once to accept any pending terms.

**Migrations apply but `sessions` table is empty after visiting a page.**
The D1 binding isn't wired correctly. Re-read `wrangler.toml`, confirm `binding = "DB"` (not `PURCHASES_DB` or anything else), confirm `database_id` matches what `wrangler d1 list` shows for `${PROJECT_NAME}-db`.

**Deploy succeeds but `/dash/?key=...` returns 401.**
Most likely the recipient pasted the `DASH_KEY` with a trailing space or newline when setting the secret. Re-run `wrangler pages secret put DASH_KEY --project-name ${PROJECT_NAME}` and paste carefully.

**The recipient asks "is it working?"**
That's `verify-tracking`'s job. Don't answer yourself — invoke that skill.
