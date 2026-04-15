# Hotmart

Brazilian platform, international reach. Hotmart's webhook uses a fixed
token called `hottok` instead of a per-request HMAC — simpler to verify
but more sensitive to secret leaks (rotate immediately if you suspect
exposure). Custom tracking lands under the `xcod` field.

> **Status**: the Hotmart adapter file exists at
> `functions/webhook/hotmart.js` as a Day 2 stub. Full implementation
> (parser + `hottok` verification + real test purchase) lands Day 9 per
> `~/.claude/plans/snoopy-baking-pinwheel.md`. Everything below is the
> target shape — Claude Code should use this doc as the specification
> when writing the Day 9 code and should verify each field against a
> real sanitized webhook body before shipping.

## Identity

- **Webhook endpoint**: `/webhook/hotmart`
- **Adapter file**: `functions/webhook/hotmart.js`
- **Sandbox availability**: yes — Hotmart has a "Ambiente de testes"
  mode per product. Create a sandbox product, copy the sandbox webhook
  URL into Cloudflare, fire test purchases with fake card numbers.
- **Dashboard URL for webhook config**: Hotmart → Ferramentas → Webhook.

## The `trk` field

- **URL parameter name on checkout URL**: `xcod`. Hotmart calls this the
  "source code" and exposes it in Analytics as `src`.
- **Webhook payload path**: `body.data.purchase.origin.xcod` on current
  v2 webhooks; older webhooks used `body.buyer.source` or
  `body.prod_utm`. The adapter MUST try both (xcod-first, source-fallback)
  to survive account-level webhook version differences.
- **Character-set**: Hotmart preserves full 36-char UUIDs. URL-encode
  defensively anyway (the sales page already does).

## Signature verification (`hottok`)

- **Header name**: `x-hotmart-hottok` on current webhooks; legacy is a
  `hottok` query parameter on the POST URL. The adapter should accept
  both locations.
- **Algorithm**: **not HMAC** — `hottok` is a fixed secret string. The
  adapter compares `request.headers.get('x-hotmart-hottok') === env.HOTMART_HOTTOK`
  using a timing-safe comparison (`crypto.subtle` constant-time string
  comparison via Uint8Array equality).
- **Shared-secret env var**: `HOTMART_HOTTOK`
- **Where the recipient finds the secret**: Hotmart → Ferramentas →
  Webhook → "HOTTOK" column on the configured endpoint. Generate one if
  missing; rotate by generating a new one and updating Cloudflare via:
  ```
  wrangler pages secret put HOTMART_HOTTOK
  ```

**Critical**: because `hottok` is a fixed bearer token, leaking it is
worse than leaking an HMAC secret — an attacker with the value can fire
arbitrary purchases at your endpoint until you rotate. Never log the
value, never include it in error messages, always rotate after support
tickets that required sharing Cloudflare logs.

## Payload shape (target — verify against a real webhook on Day 9)

Hotmart wraps everything under `{ event, version, data }`. The adapter
unwraps as `const body = rawPayload.data || rawPayload`.

```json
{
  "event": "PURCHASE_APPROVED",
  "version": "2.0.0",
  "data": {
    "purchase": {
      "transaction": "HP12345678",
      "status": "APPROVED",
      "price": { "value": 97.00, "currency_value": "BRL" },
      "offer": { "code": "abc123" },
      "origin": { "xcod": "f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d" },
      "tracking": {
        "source": "facebook",
        "source_sck": "",
        "external_code": ""
      }
    },
    "product": {
      "id": 1234567,
      "name": "My Product"
    },
    "buyer": {
      "name": "Alice Silva",
      "email": "alice@example.com",
      "checkout_phone": "+5511987654321"
    }
  }
}
```

| Normalized field | Payload path |
|---|---|
| `trk` | `body.purchase.origin.xcod` (fallback: `body.purchase.tracking.source_sck`) |
| `email` | `body.buyer.email` |
| `name` | `body.buyer.name` |
| `phone` | `body.buyer.checkout_phone` (fallback `body.buyer.documents?.[0]?.value` — no, that's the CPF; use phone-only fields) |
| `value` | `body.purchase.price.value` |
| `currency` | `body.purchase.price.currency_value` (note: Hotmart's field is `currency_value`, not `currency`) |
| `transactionId` | `body.purchase.transaction` |
| `productId` | `String(body.product.id)` |
| `productName` | `body.product.name` |
| `items[]` | Single-item array built from `body.product` (Hotmart v2 webhooks don't support carts in the standard `PURCHASE_APPROVED` event) |
| `platformUtm.utm_source` | `body.purchase.tracking.source` |
| `platformUtm.utm_medium` / `utm_campaign` / `utm_content` / `utm_term` | Hotmart doesn't carry UTM breakdown by default; leave empty and rely on `checkout_sessions` UTMs instead |

## Paid-sale filter

- **Paid event**: `rawPayload.event === 'PURCHASE_APPROVED'`
- **Status field**: `body.purchase.status === 'APPROVED'`
- **Status field path**: `body.purchase.status`

Hotmart fires separate events for different lifecycle stages:
`PURCHASE_APPROVED`, `PURCHASE_COMPLETE` (product delivered),
`PURCHASE_REFUNDED`, `PURCHASE_CHARGEBACK`, `PURCHASE_DELAYED`
(Pix/boleto pending), `PURCHASE_CANCELED`. Only fire Meta/GA4/Ads on
`PURCHASE_APPROVED`; acknowledge everything else with 200 and skip.

**Gotcha**: if the recipient ALSO enables `PURCHASE_COMPLETE`, the
adapter will double-fire. Either filter strictly on `PURCHASE_APPROVED`
(current approach) or use the `transaction_id` unique index on
`purchase_log` as the dedup safety net. The adapter should log a warning
if a second event for the same transaction arrives.

## Known gotchas

- **Multiple offers per product**: Hotmart lets you run multiple offers
  for the same product (different prices/coupons). `product.id` stays
  constant across offers; use `purchase.offer.code` if the recipient
  needs per-offer segmentation in the dashboard.
- **Installment sales**: Hotmart fires `PURCHASE_APPROVED` on the first
  paid installment, then a separate event per subsequent installment.
  Meta will see one `Purchase` event at the full value — correct for
  ROAS but may surprise recipients comparing Meta revenue to actual cash
  flow.
- **Sandbox vs production `hottok`**: Hotmart issues one `hottok` per
  environment. Sandbox webhooks won't validate against a production
  `hottok` and vice versa. Document which environment the deployed
  Cloudflare instance is wired to.
- **`currency_value` not `currency`**: easy to miss. Hotmart's
  documentation isn't consistent about it across webhook versions.
- **Query-string `hottok`**: some older Hotmart webhook configurations
  append `?hottok=xxx` to the endpoint URL instead of using a header.
  The adapter should check both.

## Verification test

1. In Hotmart sandbox: create a product with a sandbox webhook URL
   pointing at `https://<your-pages-domain>/webhook/hotmart`.
2. Set the `HOTMART_HOTTOK` Cloudflare secret to the sandbox token.
3. Click Hotmart's "Enviar teste" button if available; otherwise trigger
   a real sandbox purchase.
4. Check Cloudflare Workers logs for the adapter hit, then:
   ```
   wrangler d1 execute <db> --remote --command \
     "SELECT transaction_id, trk, value, currency, utm_source, meta_response_ok FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
5. Confirm `trk` matches what your sales page generated, `value` is
   right, and `meta_response_ok = 1`.
6. Check Meta Events Manager → Test Events for the `Purchase` event.
7. Rotate the sandbox `hottok` to confirm rotation works, re-test.
8. Swap the Cloudflare secret to the production `hottok` only after step
   7 passes.
