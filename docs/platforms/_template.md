# Platform template

Use this as the starting shape when documenting a new sales platform.
Copy this file to `docs/platforms/<platform>.md` and fill in each
section. The `add-sales-platform` skill walks through populating it.

Every adapter is a thin file that does four things: read raw body, verify
signature, parse into the normalized shape, delegate to `_core.js`. This
doc captures the parts that differ per platform so the adapter file
doesn't need prose comments.

---

## Identity

- **Platform name**: e.g. "ExamplePay"
- **Webhook endpoint**: `/webhook/<platform>` — keep lowercase, no dashes
  unless the platform name really contains one.
- **Adapter file**: `functions/webhook/<platform>.js`
- **Sandbox availability**: yes / no. If no, document how the recipient
  can trigger a test purchase in prod with a zero-cost coupon.

## The unique checkout identifier (`trk`)

- **URL parameter name for `trk` on the checkout URL**: the field the
  sales page appends (e.g. `trk`, `xcod`, `sck`, `custom1`).
- **Webhook payload field path**: where that value appears in the
  incoming JSON (e.g. `body.tracker.code1`, `body.custom.sck`).
- **Character-set constraints**: does the platform mangle the value?
  Most strip characters or silently truncate at some length. Test with a
  36-character UUID; if it comes back chopped, document the safe length.

## Signature verification

- **Header name**: e.g. `x-signature`, `hottok`, `x-kiwify-signature`.
- **Algorithm**: HMAC-SHA256, HMAC-SHA1, static token comparison, etc.
- **Encoding**: hex or base64?
- **What is signed**: raw request body, a concatenation of specific
  fields, or just a shared-secret comparison?
- **Shared-secret env var name**: e.g. `EDUZZ_WEBHOOK_SECRET`,
  `HOTMART_HOTTOK`, `KIWIFY_SIGNATURE_KEY`.
- **Where the recipient finds the secret**: exact path in the platform
  dashboard (Settings → Webhooks → …).
- **Verification code snippet**: the 5-10 lines the adapter runs. Example
  for HMAC-SHA256 hex:
  ```js
  async function verifySignature(rawBody, headerValue, secret) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return timingSafeEqual(hex, headerValue);
  }
  ```

## Payload shape

Paste a real (sanitized) webhook body here. This is the single most
useful thing in the platform doc — the adapter's parser is grown directly
from it.

```json
{
  "event": "…",
  "data": {
    "…": "…"
  }
}
```

Annotate the fields that map to the normalized shape:

| Normalized field | Payload path |
|---|---|
| `trk` | `body.???` |
| `email` | `body.???` |
| `name` | `body.???` |
| `phone` | `body.???` |
| `value` | `body.???` |
| `currency` | `body.???` |
| `transactionId` | `body.???` |
| `productId` | `body.???` |
| `productName` | `body.???` |
| `items[]` | `body.???` (or derived from the single product for platforms that don't ship arrays) |
| `platformUtm.utm_source` | `body.???` — or `''` if the platform doesn't carry UTMs |

## Paid-sale filter

Platforms send webhooks for pending, approved, refunded, chargeback, etc.
Only process the "paid" one; acknowledge the rest with 200 so the platform
stops retrying.

- **Paid status value(s)**: e.g. `'paid'`, `'PURCHASE_APPROVED'`,
  `'order_approved'`.
- **Status field path**: e.g. `body.status`, `body.event`.

## Known gotchas

- Anything the documentation lies about.
- Rate limits.
- Retry behavior (how often, for how long, with what backoff).
- Quirks like "value comes in cents for some products, reais for others".
- Anything that took debugging to figure out the first time.

## Verification test

How Claude confirms a new adapter works end-to-end:

1. Hit the adapter URL from the platform's "send test webhook" button.
2. Check the Cloudflare Workers log for `processPurchase` completion.
3. Query D1 for the resulting `purchase_log` row and confirm the
   normalized fields landed correctly.
4. Complete one real purchase (coupon to zero if available).
5. Confirm the Meta/GA4/Google Ads fire succeeded.

Document the exact commands so the recipient can repeat them after any
future platform-side API change.
