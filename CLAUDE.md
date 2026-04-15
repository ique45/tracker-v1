# Tracking Stack Template

> This file is Claude Code's anchor. It is loaded into the context of every
> conversation in this repo. Keep it under ~200 lines. Put detailed reference
> in `docs/` and procedural walkthroughs in `.claude/skills/`.

## What this repo is

A Cloudflare Pages + D1 tracking stack that captures first-party attribution
data and fires server-side conversion events to Meta CAPI, GA4, and Google Ads.
It replaces Stape + GTM Server-Side for creators running paid traffic to lead
or sales pages. Each recipient deploys their own copy in their own Cloudflare
account with their own D1 database — there is no shared backend.

The stack does two things simultaneously:

1. **Fires server-side conversion events** with ITP-resistant identifier capture
   (400-day first-party cookies, server-set fbp/fbc, GA4 client ID parsing).
2. **Persists first-party attribution data** (UTMs, fbp/fbc, gclid) per lead
   and per purchase, so the built-in dashboard shows where each conversion
   originated.

## Identifier chain

Every visit generates identifiers at the edge (middleware), persists them to
D1, and threads them through the checkout flow so the webhook can enrich the
purchase with the original attribution.

| Identifier | Origin | Storage | Used by |
|---|---|---|---|
| `_krob_sid` | Middleware, UUID per visit | 400d cookie + `sessions` row | Joins every event to its originating visit |
| `fbp` | Middleware, Meta spec `fb.2.{ts}.{rand}` | Cookie + `sessions.fbp` | Meta CAPI |
| `fbc` | Middleware, from `fbclid` URL param | Cookie + `sessions.fbc` | Meta CAPI |
| `ga_client_id` | Parsed from GA4's `_ga` cookie at edge | `checkout_sessions.ga_client_id` | GA4 Measurement Protocol |
| `trk` | Client, generated per sales-page visit | `checkout_sessions.trk` (PK) | Webhook lookup after purchase |
| `event_id` | Client, UUID per event | `event_log.event_id`, `purchase_log.event_id` | Dedup between browser pixel and server CAPI |
| `external_id` | Middleware, UUID per visitor | Cookie + `sessions.external_id` | Meta Advanced Matching |

**The `trk` chain is the critical one for sales pages**: generated on the page
visit → persisted to `checkout_sessions` with all attribution → passed to the
sales platform as a custom field (`tracker.code1` for Eduzz, `xcod` for
Hotmart, `sck` for Kiwify) → returned in the webhook payload → looked up to
enrich the Meta/GA4/Google Ads conversion.

Hop-by-hop detail with example payloads: `docs/data-flow.md`

## Hard rules (do not violate)

- **Never log PageView events to `event_log`.** PageView still fires to
  Meta/GA4 — it just doesn't write to D1. This keeps per-instance write volume
  sustainable forever. Enforced in `functions/tracker.js`.
- **Never commit secrets.** `wrangler.toml`, `.dev.vars`, `config/products.json`
  are all gitignored. Only `*.example` variants are tracked.
- **Always use parameterized SQL.** Every D1 query uses `.bind()`. No string
  interpolation, ever.
- **Hash PII before sending to ad platforms.** Email, phone, name are SHA-256
  hashed after lowercase + trim normalization (phone: digits-only + leading
  zeros stripped). Raw PII persists in D1 for debugging only and never leaves
  the recipient's own infrastructure.
- **Per-platform webhook adapter pattern.** Each sales platform gets its own
  file in `functions/webhook/<platform>.js` that handles payload parsing +
  signature verification. Shared lookup/enrichment/fan-out logic lives in
  `functions/webhook/_core.js`. When adding a new platform, copy an existing
  adapter as a structural reference — do not modify `_core.js` unless the
  change is genuinely platform-agnostic.
- **Webhook signatures are mandatory.** Every platform adapter MUST verify
  the incoming webhook signature before processing. A webhook without a valid
  signature is rejected with 401 and never hits the database. Missing the
  verification env var (e.g. `EDUZZ_WEBHOOK_SECRET`) is a deploy-blocking
  error, not a silent skip.

## File map

| Path | Purpose |
|---|---|
| `functions/_middleware.js` | Edge middleware: generates `_krob_sid`, captures `fbclid`/`gclid`/UTMs, sets cookies, upserts `sessions` row. Runs on every request. |
| `functions/tracker.js` | `/tracker` endpoint: receives client events, hashes PII, fires Meta CAPI + GA4 MP, logs to `event_log` (minus PageView). |
| `functions/checkout-session.js` | `/checkout-session` endpoint: persists `trk` + attribution when a sales-page form is submitted or a checkout button is clicked. |
| `functions/api/events.js` | Dashboard query: events with UTMs via JOIN on `sessions`. |
| `functions/api/leads.js` | Dashboard query: leads with UTMs (leads-only view). |
| `functions/api/purchases.js` | Dashboard query: purchases with attribution and platform delivery status. |
| `functions/webhook/_core.js` | Shared webhook logic: lookup `trk` → enrich → Meta/GA4/Google Ads fan-out → persist `purchase_log`. |
| `functions/webhook/eduzz.js` | Eduzz adapter: parses Eduzz payload, verifies `x-signature` HMAC-SHA256. |
| `functions/webhook/hotmart.js` | Hotmart adapter: parses Hotmart payload, verifies `hottok`. |
| `functions/webhook/kiwify.js` | Kiwify adapter: parses Kiwify payload, verifies Kiwify signature. |
| `migrations/` | D1 schema. Apply with `wrangler d1 migrations apply <db-name> --remote`. |
| `dash/index.html` | Self-contained dashboard reading from `/api/*` endpoints. Auth via `DASH_KEY`. |
| `examples/lead-form-page/` | Starter HTML for the three lead-form field variants. |
| `examples/sales-page/` | Starter HTML for a generic sales page with `trk` URL rewriting. |
| `config/products.json` | Per-product config: product IDs, Encharge tags, ManyChat tag IDs, Google Ads conversion actions. Recipient edits directly. Gitignored. |
| `docs/` | Deep reference — architecture, data flow, schema, per-page-type recipes, per-platform notes. |
| `.claude/skills/` | Procedural walkthroughs invoked by name when the recipient's request matches. |

## Skills

Invoke these when the recipient's request matches the trigger.

| Skill | Trigger phrases | What it does |
|---|---|---|
| `deploy-stack` | "set this up", "deploy this", "I just downloaded this", "first-time setup" | Phase A bootstrap: creates Pages project, D1 database, applies migrations, collects secrets interactively, deploys. Runs `wrangler` commands directly. |
| `verify-tracking` | "is my tracking working", "check my tracking", "verify", "test the chain" | Phase B: walks the 6-checkpoint Level 1 integrity chain (cookie → sessions row → checkout URL → webhook arrival → D1 lookup → platform receipt). |
| `add-page` | "add a lead page", "add a new sales page", "create a landing page" | Copies the matching example from `examples/`, reads the relevant recipe from `docs/page-types/`, wires routing and platform-specific snippets. |
| `add-sales-platform` | "I use [platform not in Eduzz/Hotmart/Kiwify]" | Creates a new webhook adapter following `docs/platforms/_template.md` by copying an existing adapter as the structural reference. |

## Deep reference

| For… | Read |
|---|---|
| How the pieces fit together (architecture diagram, request flow) | `docs/architecture.md` |
| Identifier chain hop-by-hop with example payloads (debugging bible) | `docs/data-flow.md` |
| D1 schema, every column, prose explanation | `docs/schema.md` |
| Lead form recipe (field variants, PII mapping for Meta) | `docs/page-types/lead-form-page.md` |
| Sales page recipe (`trk` generation, URL rewriting, webhook config) | `docs/page-types/sales-page.md` |
| Eduzz-specific notes (custom field, signature header, secret source) | `docs/platforms/eduzz.md` |
| Hotmart-specific notes | `docs/platforms/hotmart.md` |
| Kiwify-specific notes | `docs/platforms/kiwify.md` |
| Shape for adding a new sales platform | `docs/platforms/_template.md` |

## Decisions the recipient must make

These have sensible defaults. Change them only if you know why.

| Decision | Default | How to change |
|---|---|---|
| Domain handling | `_middleware.js` derives the ETLD+1 sub-domain index from the `Host` header at runtime | No action — it self-configures |
| Timezone for Google Ads conversion timestamps | `-03:00` (São Paulo) | Set `TIMEZONE_OFFSET` secret to any ISO offset (`+00:00`, `-05:00`, etc.) |
| PII retention window | Raw email/name/phone stored indefinitely in `purchase_log` and `event_log` | Run a periodic `DELETE WHERE created_at < ...` via a scheduled worker; not enforced by default |
| Which sales platforms are active | All three (Eduzz, Hotmart, Kiwify) are built in | Each platform is live once its webhook secret env var is set; missing secret = that endpoint returns 401 |
| Dashboard auth | Single `DASH_KEY` query param | Rotate by changing the env var; no code change needed |

<!-- TODO: expand this file during Day 7 once skills and docs exist. Current
     version is the Day 1 skeleton — section structure is locked, content is
     correct but minimal. -->
