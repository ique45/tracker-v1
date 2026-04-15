---
name: add-sales-platform
description: Add support for a new sales platform beyond the built-in Eduzz/Hotmart/Kiwify adapters. Use when the recipient says "I use [some platform that isn't Eduzz/Hotmart/Kiwify]", "add support for X", "my checkout runs on Y", or asks how to wire a new sales platform into the webhook pipeline. Creates a new functions/webhook/<platform>.js adapter by copying an existing one, creates a matching docs/platforms/<platform>.md from the template, and walks the recipient through capturing the platform's payload shape and signature format.
---

# Skill: add-sales-platform

The recipient's sales platform isn't in the built-in
Eduzz/Hotmart/Kiwify set. This skill adds it as a new webhook adapter.
The architecture is deliberately built to make this safe: `_core.js`
never branches per platform, so all the new logic lives in exactly two
new files — one adapter under `functions/webhook/` and one doc under
`docs/platforms/`.

If the recipient isn't sure whether they need this skill, ask them what
sales platform they use. If it's literally Eduzz, Hotmart, or Kiwify,
send them to `add-page` instead.

## Step 1 — Gather the platform info

You need seven pieces of information from the recipient. Ask for them in
this order, one or two at a time — don't dump the whole list at once.

1. **Platform name** — used as the filename (lowercase, no spaces). e.g.
   `"PayPal Checkout"` → `paypal`.
2. **A real (sanitized) webhook body**. The single most important input.
   Ask the recipient to:
   - Log into the platform's dashboard.
   - Trigger a test webhook (many platforms have a "send test" button;
     if not, run a real purchase with a 100%-off coupon).
   - Paste the full JSON body here. They can redact real email/phone
     values with `example@example.com` / `+5511999999999` but must keep
     the JSON structure and field names exact.
3. **Which field carries the `trk` / custom tracking value** (JSON path
   inside the body). If the platform doesn't have a custom-tracking
   field at all, this skill cannot make attribution work — flag it
   clearly and ask if they have any other URL parameter that round-trips
   to the webhook.
4. **Which URL parameter name the sales page should use** to send `trk`
   into the checkout. Usually documented under "UTM tracking",
   "partner ID", or "custom source code" in the platform's checkout
   settings.
5. **Which field signals a successful paid purchase** (e.g.
   `event === 'paid'`, `status === 'APPROVED'`). There may be multiple
   statuses — we only process the "money received, delivery triggered"
   one.
6. **Signature header name and format**. Common patterns:
   - HMAC-SHA256 of raw body, hex-encoded, in an `x-signature` header
     (Eduzz-style)
   - Static bearer token in a header (Hotmart `hottok`-style)
   - HMAC-SHA256 with base64 encoding
   - Query-string shared secret
   Ask the recipient to paste the platform's webhook-security docs URL
   if they have it, or screenshot the signature-related fields in the
   dashboard.
7. **Where in the dashboard they generate or view the webhook signing
   secret**. This is the value they'll store as a Cloudflare secret.

If any of 2-7 are missing and they can't get them, stop here — the
adapter cannot be written safely without signature verification, and
signature verification cannot be written without the format info.

## Step 2 — Pick the structural reference

Read `functions/webhook/eduzz.js` into context. It's the
reference-quality adapter and the best structural base for any new
platform that uses HMAC-SHA256.

If the new platform uses a static bearer token (not HMAC), note that
Hotmart's adapter (once Day 9 is complete) is the structural reference
for that pattern instead. For v1 shipping, prefer copying Eduzz's
structure regardless and swapping the verification block — it's the
battle-tested file.

## Step 3 — Read the platform template

Read [docs/platforms/_template.md](../../../docs/platforms/_template.md)
— it defines the shape of the per-platform doc and doubles as a
checklist of what the adapter must handle. Every field in that template
maps to something the adapter needs to parse, verify, or filter on.

## Step 4 — Create the new doc first

Create `docs/platforms/<platform>.md` by copying `_template.md`.
Populate every section using the info gathered in Step 1. Writing the
doc before the adapter forces the adapter's parser to match reality
instead of drifting into assumptions.

```bash
cp docs/platforms/_template.md docs/platforms/<platform>.md
```

Then edit `docs/platforms/<platform>.md` to fill in:
- Identity (name, endpoint, sandbox availability, dashboard URL)
- The `trk` field (URL parameter name + webhook payload path)
- Signature verification (header, algorithm, encoding, env var name)
- **Payload shape** — paste the real sanitized JSON from Step 1, item 2
- Normalized-field mapping table
- Paid-sale filter
- Known gotchas (leave empty for now — will be populated after the
  first real test)
- Verification test commands

## Step 5 — Create the adapter

Copy Eduzz's adapter as the base:
```bash
cp functions/webhook/eduzz.js functions/webhook/<platform>.js
```

Then edit `functions/webhook/<platform>.js`:

1. **Update the file-top comment** to describe this platform's specifics.
2. **Change the `platform` string** in the normalized object from
   `'eduzz'` to the new platform name.
3. **Replace the signature verification block** with the platform's
   scheme. For HMAC-SHA256 hex:
   ```js
   const rawBody = await request.text();
   const sigHeader = request.headers.get('x-platform-signature') || '';
   const expected = await hmacSha256Hex(rawBody, env.PLATFORM_WEBHOOK_SECRET);
   if (!timingSafeEqual(expected, sigHeader)) {
     return new Response(JSON.stringify({ error: 'invalid signature' }),
       { status: 401, headers: { 'Content-Type': 'application/json' } });
   }
   const rawPayload = JSON.parse(rawBody);
   ```
   For static bearer token:
   ```js
   const token = request.headers.get('x-platform-token') || '';
   if (!timingSafeEqual(token, env.PLATFORM_WEBHOOK_SECRET || '')) {
     return new Response(JSON.stringify({ error: 'invalid token' }),
       { status: 401, headers: { 'Content-Type': 'application/json' } });
   }
   const rawPayload = await request.json();
   ```
4. **Replace the payload unwrap and parser** with the new mapping from
   the doc's table. Keep the `parsed` object's shape exactly — every
   key in the normalized purchase object is required by `_core.js`. If
   the platform doesn't provide a field, use `''` or `0`, never omit
   the key.
5. **Replace the paid-status filter** with the new platform's check.
   Return `200 { ok: true, skipped: <reason> }` for non-paid events so
   the platform stops retrying.

Import `processPurchase` from `_core.js` (should already be there from
the copy). Do NOT touch `_core.js` — if you feel the urge to add a
platform branch there, push the logic back into the adapter.

## Step 6 — Add the env var placeholder

Tell the recipient to set the signing secret:
```bash
wrangler pages secret put <PLATFORM>_WEBHOOK_SECRET
```

Use a consistent naming scheme: `<PLATFORMUPPERCASE>_WEBHOOK_SECRET` for
HMAC secrets, `<PLATFORMUPPERCASE>_TOKEN` for static bearer tokens, etc.
Document the exact variable name in `docs/platforms/<platform>.md` so
they can find it later.

## Step 7 — Update the sales page routing

If the recipient already has sales pages using
`examples/sales-page/starter.html`, the `TRK_FIELD_BY_PLATFORM` lookup
table in each page needs the new entry. Tell the recipient:

> Any existing sales page that wants to send traffic to this new
> platform needs `CHECKOUT_PLATFORM = '<platform>'` and the
> `TRK_FIELD_BY_PLATFORM` object updated with the new param name.

New sales pages created via the `add-page` skill will automatically
pick it up if you also update the starter — for v1, just instruct the
recipient to edit their existing pages.

## Step 8 — Deploy and verify

```bash
wrangler pages deploy
```

Then run the verification test written in
`docs/platforms/<platform>.md`. The test should:

1. Fire a test webhook from the platform dashboard if available.
2. Check Cloudflare Workers logs for the adapter invocation.
3. Query `purchase_log` for the new row.
4. If possible, complete one real zero-cost purchase end to end.
5. Confirm `meta_response_ok = 1` in the purchase row.

If the first real webhook reveals the payload shape is different from
what the recipient pasted in Step 1 (missing fields, different
casing, different status string), go back to Step 4, update the doc,
then Step 5 update the adapter, then redeploy. The doc is the source
of truth; keep it synced.

## Step 9 — Update CLAUDE.md's file map (optional, recommended)

If the new platform is going to be the recipient's primary checkout,
add a one-line entry to the edge-runtime table in `CLAUDE.md`:

```
| `webhook/<platform>.js` | <Platform> adapter. Verifies <signature scheme>, parses <platform> shape. |
```

This makes the file discoverable in future conversations without
grepping.

## When to stop and ask

Stop and ask the recipient if:

- The platform has no custom-tracking field at all — without one,
  webhook attribution is impossible in this architecture.
- The signature scheme is exotic (e.g. requires a public-key
  verification chain, or signs a specific subset of fields). Surface
  the docs URL and ask for guidance before writing the verification
  code.
- The platform's webhook body structure differs between event types in
  ways that make a single parser brittle. Consider whether the recipient
  really needs all event types or only the paid one.
- The recipient wants to support multiple new platforms at once. Do
  them one at a time — each verification test needs its own focus.
