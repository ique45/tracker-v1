---
name: add-page
description: Add a new lead form page or sales page to this tracking stack. Use when the recipient says "add a lead page", "add a sales page", "create a landing page", "I need another form", "new offer page", or asks to wire up a page for capturing leads or driving a sales-platform checkout. Copies the right starter from examples/, wires it into Cloudflare Pages routing, reads the corresponding recipe in docs/page-types/ and (for sales pages) the target platform's doc in docs/platforms/, and runs a local smoke test.
---

# Skill: add-page

The recipient wants to add a page to their deployed stack. There are
exactly two page types — lead form and sales page — and each has one
canonical recipe. This skill's job is to pick the right recipe, copy it
into the recipient's repo, wire the minimum per-page configuration, and
confirm it works before letting the recipient edit the content.

## Step 1 — Identify the page type

Ask the recipient:

> Is this a **lead form** (capture an email/phone, fire a Lead event) or a
> **sales page** (show an offer, send the buyer to a checkout URL)?

If they're not sure, read them the short version:

- **Lead form** = the visitor gives you their contact details and you get
  nothing else. Example: "free ebook download". Fires a `Lead` event.
- **Sales page** = the visitor clicks a CTA that takes them to a
  sales-platform checkout (Eduzz / Hotmart / Kiwify) where they pay.
  Fires `InitiateCheckout` on click and (later) a `Purchase` event from
  the webhook handler.

If they want both on the same page (capture leads AND sell), pick sales
page — it's the more capable recipe. Hint that you can add a lead form
block inside it afterwards.

## Step 2 — Pick the target path

Ask:

> What URL path should this page live at? E.g. `/black-friday`,
> `/free-guide`, `/offer-2`.

Rules:

- Must not start with `/api/`, `/webhook/`, `/dash`, or `/tracker` —
  those bypass middleware and break attribution. If the recipient
  suggests one of those, explain why and ask for another.
- Should be a short, memorable path that fits in a Meta ad URL.
- Lowercase, dashes between words, no query strings.

The file will live at `<path>/index.html` so the page is served without
a trailing extension.

## Step 3 — Copy the starter

**For a lead form**:
```bash
mkdir -p <path>
cp examples/lead-form-page/index.html <path>/index.html
```

**For a sales page**:
```bash
mkdir -p <path>
cp examples/sales-page/starter.html <path>/index.html
```

## Step 4 — Read the matching recipe

Before editing, read the right docs into context so the edits follow the
established pattern:

- Lead form: read [docs/page-types/lead-form-page.md](../../../docs/page-types/lead-form-page.md).
- Sales page: read [docs/page-types/sales-page.md](../../../docs/page-types/sales-page.md)
  AND the target platform doc:
  - Eduzz → [docs/platforms/eduzz.md](../../../docs/platforms/eduzz.md)
  - Hotmart → [docs/platforms/hotmart.md](../../../docs/platforms/hotmart.md)
  - Kiwify → [docs/platforms/kiwify.md](../../../docs/platforms/kiwify.md)

If the recipient uses a platform NOT in Eduzz/Hotmart/Kiwify, pause and
tell them to run the `add-sales-platform` skill first — then come back
to this one.

## Step 5 — Apply the minimum per-page configuration

Open `<path>/index.html` and edit the values the recipient must set
(search the file for `YOUR_` and `XXXXXXXXXX`):

**Lead form** — ask the recipient for:
- Meta Pixel ID (numeric) → replace `YOUR_META_PIXEL_ID`
- GA4 Measurement ID (`G-XXXXXXXXXX`) → replace both occurrences

**Sales page** — ask for the lead-form values PLUS:
- Checkout URL (from the sales platform's product settings) → replace
  `CHECKOUT_URL` near the top of the `<script>` block
- Which platform drives checkout → set `CHECKOUT_PLATFORM` to `'eduzz'`,
  `'hotmart'`, or `'kiwify'`

Do NOT change any other code unless the recipient explicitly asks and
you've re-read the recipe doc to confirm it's safe. The scripts in the
starters are deliberately minimal and tested.

### Lead form: pick which PII fields the form collects

Ask which fields they want:
- Email only (shortest form, lowest friction)
- Email + phone (WhatsApp funnels)
- Email + phone + name (the starter default — highest Advanced Matching
  coverage)

For email-only, remove the `phone` and `name` `<div>`-wrapped inputs and
trim the submit handler's `user_data` to `{ em: email }`.

For email + phone, remove the `name` input and trim `user_data` to
`{ em: email, ph: phone }`.

Keep the Meta key names exact: `em`, `fn`, `ln`, `ph`. Never invent new
keys — see the recipe doc.

### Sales page: edit the offer content

The recipient will almost certainly want to edit the headline, subhead,
price display, and bullet points. These are marked with obvious
placeholder copy in the starter — let them do it, don't do it for them
unless they ask.

## Step 6 — Deploy and verify

Deploy by committing and pushing to the GitHub repo wired up during
`deploy-stack` — Cloudflare Pages auto-builds on every push to `main`:

```bash
git add <path>/
git commit -m "Add <page-type> at /<path>"
git push
```

Cloudflare's dashboard → Pages project → **Deployments** shows the
build; give it ~1-2 minutes to turn green. If the recipient hasn't set
up the git+Pages connection yet, stop and run `deploy-stack` first.

Then run the smoke test that matches the page type.

### Lead form smoke test

1. Open `https://<pages-domain>/<path>?utm_source=test_claude` in a browser.
2. Open DevTools → Application → Cookies and confirm `_krob_sid` is set.
3. Submit the form with a test email (`claude-test@example.com` is fine).
4. DevTools → Network: `/tracker` should return 200 with `{"ok": true}`.
5. Query D1:
   ```
   wrangler d1 execute <db-name> --remote --command \
     "SELECT event_name, raw_email, timestamp FROM event_log WHERE raw_email = 'claude-test@example.com' ORDER BY id DESC LIMIT 1"
   ```
6. Open `https://<pages-domain>/dash?key=<DASH_KEY>`, go to the Leads
   tab, confirm the test row shows `utm_source = test_claude`.

If any step fails, go to [docs/data-flow.md](../../../docs/data-flow.md)
Hop 1 and walk forward until you find the break.

### Sales page smoke test

1. Open `https://<pages-domain>/<path>?utm_source=test_claude` in a browser.
2. Cookies check: `_krob_sid` and `_fbp` should be set.
3. DevTools → Network: `/checkout-session` should return 200 on page
   load.
4. Query D1 to confirm the row:
   ```
   wrangler d1 execute <db-name> --remote --command \
     "SELECT trk, utm_source, fbp FROM checkout_sessions ORDER BY created_at DESC LIMIT 1"
   ```
5. Click the CTA. The destination URL should contain
   `?<paramName>=<uuid>` where `<paramName>` matches the platform
   (`trk` for Eduzz, `xcod` for Hotmart, `sck` for Kiwify) and `<uuid>`
   matches the `trk` value from step 4.
6. Tell the recipient to run one real test purchase (ideally via a
   100%-off coupon) to confirm the webhook chain. After the purchase,
   re-query:
   ```
   wrangler d1 execute <db-name> --remote --command \
     "SELECT trk, transaction_id, utm_source, meta_response_ok, ga4_response_ok FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
   Confirm `utm_source = test_claude` and `meta_response_ok = 1`.

## Step 7 — Tell the recipient what to do next

After the smoke test passes:

- **The page is live**. They can edit the copy/content directly in the
  `.html` file and redeploy with `git add . && git commit -m "..." && git push`
  — Cloudflare auto-redeploys on every push to `main`.
- **Ad URLs should always include UTMs.** A Meta ad without
  `?utm_source=facebook&utm_medium=paid&utm_campaign=…` will land in
  the dashboard as "(empty)" — the middleware captures what's in the
  URL, nothing more.
- **If they want a second lead form on the same page** or a second
  sales platform, tell them to call this skill again or (for a new
  platform) run `add-sales-platform`.

## When to stop and ask

Stop and ask the recipient if:

- They want features the starter doesn't support (quiz flows, multi-step
  forms, A/B variants, country redirects). Don't pattern-match and
  write them yourself — ask what exactly they need.
- The chosen path conflicts with an existing file.
- The smoke test fails at a step you can't explain with the Data Flow
  doc. Don't guess — surface the D1 row and the browser network trace
  to the recipient and walk them through triaging together.
