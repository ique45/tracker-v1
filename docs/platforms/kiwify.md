# Kiwify

Brazilian platform, simpler API surface than Hotmart. Kiwify's webhook
signature format needs confirmation during the Day 9 implementation
window — treat everything below as the target spec, not established
behavior.

> **Status**: the Kiwify adapter file exists at
> `functions/webhook/kiwify.js` as a Day 2 stub. Full implementation
> lands Day 9 per `~/.claude/plans/snoopy-baking-pinwheel.md`. Day 9
> must include triggering a real Kiwify webhook and inspecting the raw
> headers + body to confirm signature format before merging.

## Identity

- **Webhook endpoint**: `/webhook/kiwify`
- **Adapter file**: `functions/webhook/kiwify.js`
- **Sandbox availability**: Kiwify does not have a formal sandbox mode.
  Test with a real product under a 100%-off coupon.
- **Dashboard URL for webhook config**: Kiwify → Configurações →
  Webhooks.

## The `trk` field

- **URL parameter name on checkout URL**: `sck`. This is Kiwify's
  "source code" parameter and is surfaced in reports as "SCK".
- **Webhook payload path**: `body.TrackingParameters.sck` (Kiwify uses
  PascalCase keys on some webhook endpoints — confirm on Day 9 against a
  real payload and adjust the parser if the casing is different in the
  installed plan).
- **Character-set**: Kiwify has been observed to truncate tracking
  values at 50 characters. A 36-char UUID is safely under the limit,
  but don't be tempted to concatenate extras into `sck`.

## Signature verification

- **Header name**: TBD — Day 9 work must confirm. Current Kiwify
  documentation mentions an `x-kiwify-signature` header on v2 webhooks;
  some older accounts verify via a query-string secret instead
  (`?webhook_secret=xxx`).
- **Algorithm**: expected HMAC-SHA256 over the raw body, hex-encoded.
  Confirm against a real webhook.
- **Shared-secret env var**: `KIWIFY_SIGNATURE_KEY`
- **Where the recipient finds the secret**: Kiwify → Configurações →
  Webhooks → click the endpoint → "Chave secreta" (or equivalent
  label — Kiwify renames this field occasionally).
- **Storage**:
  ```
  wrangler pages secret put KIWIFY_SIGNATURE_KEY
  ```

If Kiwify turns out to use the query-string secret pattern, the adapter
must read it from the URL at request time and compare to
`env.KIWIFY_SIGNATURE_KEY`, then strip the parameter from any logged
URLs to avoid leaking the secret into Cloudflare logs.

## Payload shape (target — verify on Day 9)

```json
{
  "webhook_event_type": "order_approved",
  "order_id": "kwfy-987654",
  "order_status": "paid",
  "product_type": "digital",
  "Product": {
    "product_id": "abc123xyz",
    "product_name": "My Product"
  },
  "Customer": {
    "full_name": "Alice Silva",
    "email": "alice@example.com",
    "mobile": "+5511987654321"
  },
  "Commissions": {
    "charge_amount": "9700",
    "currency": "BRL"
  },
  "TrackingParameters": {
    "sck": "f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d",
    "utm_source": "facebook",
    "utm_medium": "paid",
    "utm_campaign": "black-friday-2026",
    "utm_content": "ad-variant-a",
    "utm_term": ""
  }
}
```

| Normalized field | Payload path |
|---|---|
| `trk` | `body.TrackingParameters.sck` |
| `email` | `body.Customer.email` |
| `name` | `body.Customer.full_name` |
| `phone` | `body.Customer.mobile` |
| `value` | `parseFloat(body.Commissions.charge_amount) / 100` (Kiwify sends cents as a string on some payloads; verify) |
| `currency` | `body.Commissions.currency` |
| `transactionId` | `body.order_id` |
| `productId` | `body.Product.product_id` |
| `productName` | `body.Product.product_name` |
| `items[]` | Single-item array built from `body.Product` |
| `platformUtm.utm_source` | `body.TrackingParameters.utm_source` |
| `platformUtm.utm_medium` / `utm_campaign` / `utm_content` / `utm_term` | same path |

## Paid-sale filter

- **Paid event**: `body.webhook_event_type === 'order_approved'`
- **Status field**: `body.order_status === 'paid'`

Other event types to acknowledge-and-skip:
- `order_refunded`
- `order_chargeback`
- `pix_created` / `billet_created` (awaiting payment)
- `subscription_canceled`

## Known gotchas

- **Casing inconsistency**: Kiwify webhooks mix PascalCase (`Product`,
  `Customer`, `TrackingParameters`) and snake_case (`order_id`,
  `order_status`). Don't assume a convention; match the payload
  exactly.
- **`charge_amount` as cents string**: on some payloads the amount
  arrives as a cents-integer string (`"9700"`), on others as a
  reais-decimal number (`97.00`). Parse both: if the value is a string
  that parses to an integer ≥ 1000 and there's no decimal point, divide
  by 100; otherwise take as-is. Verify on Day 9.
- **Kiwify retries aggressively**: failing to return 200 within ~5s
  triggers a retry storm. The `purchase_log` unique index on
  `transaction_id` prevents duplicates, but the adapter still burns
  Cloudflare request quota if it 500s on every retry — fail fast on
  parse errors.
- **UTMs inside the payload**: unlike Hotmart, Kiwify forwards the UTMs
  the buyer landed with. The adapter should still trust
  `checkout_sessions.utm_*` (which came from the session at sales-page
  visit time) over `body.TrackingParameters.utm_*` (which came from
  whatever Kiwify captured at checkout), because the session UTMs are
  what the recipient's ads actually used. Use `platformUtm` only for
  audit comparison.
- **Subscription renewals** fire `order_approved` each cycle —
  same-transaction-ID safety net from `purchase_log` unique index
  prevents double-logging if two webhooks fire for the same renewal,
  but legitimate renewals use a NEW `order_id` per cycle and DO get
  logged as new purchases. This is correct for Meta revenue tracking.

## Verification test

1. Create a 100%-off coupon on a Kiwify product.
2. Configure the Kiwify webhook to point at
   `https://<your-pages-domain>/webhook/kiwify` and set the
   `KIWIFY_SIGNATURE_KEY` secret in Cloudflare.
3. Complete a purchase through your sales page with the coupon.
4. Watch the Cloudflare Workers log for the adapter invocation. Copy
   the raw headers and raw body out of the log (one-time, for Day 9
   signature-format confirmation).
5. Query D1:
   ```
   wrangler d1 execute <db> --remote --command \
     "SELECT transaction_id, trk, value, currency, utm_source, meta_response_ok FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
6. Confirm `trk` matches the sales-page UUID, `value` is right
   (97.00, not 9700), `meta_response_ok = 1`.
7. Fire a refund from the Kiwify dashboard and confirm the adapter
   acknowledges with 200 but does NOT fire a second Meta event.
