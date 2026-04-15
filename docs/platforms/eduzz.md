# Eduzz

The reference adapter. Eduzz is Brazilian, uses Portuguese field names in
its dashboard, and has a well-behaved webhook with an HMAC-SHA256
signature. Everything else (Hotmart, Kiwify, future platforms) is
structured by copying this.

## Identity

- **Webhook endpoint**: `/webhook/eduzz`
- **Adapter file**: `functions/webhook/eduzz.js`
- **Sandbox availability**: no native sandbox. Test by creating a product
  with a 100%-off coupon and running a real purchase.
- **Dashboard URL for webhook config**: Eduzz → Minha Conta → Integrações
  → Webhooks.

## The `trk` field

- **URL parameter name on checkout URL**: `trk` (the Eduzz custom tracker
  slot labelled `tracker.code1` internally).
- **Webhook payload path**: `body.tracker.code1`.
- **Character-set**: Eduzz preserves full 36-char UUIDs without mangling.
  Tested with `crypto.randomUUID()` output — arrives intact.

When you create the Eduzz product you'll see a "Rastreamento" field in
the checkout configuration. Leave it empty; the sales page appends `trk`
at click time as a query parameter, and Eduzz copies query parameters
into `tracker.code1` automatically.

## Signature verification

- **Header name**: `x-signature`
- **Algorithm**: HMAC-SHA256
- **Encoding**: hex, lowercase (confirmed Day 9 during the signature
  implementation work — see plan note).
- **What is signed**: the raw request body as a UTF-8 byte string.
- **Shared-secret env var**: `EDUZZ_WEBHOOK_SECRET`
- **Where the recipient finds the secret**: Eduzz → Minha Conta →
  Integrações → Webhooks → click the webhook → "Chave de assinatura"
  (signing key). Generate if empty, copy, store via:
  ```
  wrangler pages secret put EDUZZ_WEBHOOK_SECRET
  ```

> **Status**: full HMAC verification lands on Day 9 (see
> `~/.claude/plans/snoopy-baking-pinwheel.md`). Until then the adapter
> accepts unsigned bodies, which is fine for template development but
> must NOT be deployed that way. The adapter file has a `TODO (Day 9)`
> comment at the top marking the block to replace.

## Payload shape (real sanitized webhook body)

Eduzz wraps its actual payload under `{ event_name, data }`. The adapter
unwraps transparently: `const body = rawPayload.data || rawPayload;`.

```json
{
  "event_name": "sale.paid",
  "data": {
    "id": "eduzz-sale-987654",
    "status": "paid",
    "transaction": {
      "id": "eduzz-sale-987654",
      "paid_at": "2026-04-15 14:32:10"
    },
    "paid": {
      "value": 97.00,
      "currency": "BRL"
    },
    "price": {
      "value": 97.00,
      "currency": "BRL"
    },
    "items": [
      {
        "productId": 1234567,
        "name": "My Product",
        "price": { "value": 97.00, "currency": "BRL" }
      }
    ],
    "buyer": {
      "name": "Alice Silva",
      "email": "alice@example.com",
      "cellphone": "+55 11 98765-4321"
    },
    "tracker": {
      "code1": "f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d",
      "code2": "",
      "code3": ""
    },
    "utm": {
      "source": "facebook",
      "medium": "paid",
      "campaign": "black-friday-2026",
      "content": "ad-variant-a",
      "term": ""
    }
  }
}
```

| Normalized field | Payload path |
|---|---|
| `trk` | `body.tracker.code1` |
| `email` | `body.buyer.email` (fallback `body.student.email`) |
| `name` | `body.buyer.name` (fallback `body.student.name`) |
| `phone` | `body.buyer.cellphone` (fallback `body.buyer.phone`) |
| `value` | `body.paid.value` (fallback `body.price.value`) |
| `currency` | `body.paid.currency` (fallback `body.price.currency`, else `'BRL'`) |
| `transactionId` | `body.transaction.id` (fallback `body.id`) |
| `productId` | `body.items[0].productId` stringified |
| `productName` | `body.items[0].name` |
| `items[]` | `body.items` as-is (already matches the normalized item shape) |
| `platformUtm.utm_*` | `body.utm.{source,medium,campaign,content,term}` |

## Paid-sale filter

- **Paid status value**: `'paid'` (exact string, lowercase).
- **Status field path**: `body.status`.

Other statuses you'll see in the Eduzz webhook stream: `pending`
(Pix/boleto not yet settled), `refunded`, `chargeback`, `canceled`.
The adapter acknowledges all of them with `200 { ok: true, skipped: 'not paid' }`
so Eduzz stops retrying.

## Known gotchas

- **Subscriptions**: recurring products fire `sale.paid` on the initial
  purchase AND on each renewal. Meta considers each a separate `Purchase`
  event, which is correct for revenue tracking. If the recipient only
  wants to attribute the first charge, filter by
  `body.recurrence?.current_cycle === 1` in the adapter.
- **Currency variance**: Eduzz supports BRL, USD, EUR on some accounts.
  The adapter defaults to `'BRL'` when the payload omits currency — audit
  if the recipient sells in multiple currencies.
- **`cellphone` vs `phone`**: Eduzz used to send just `phone`; newer
  accounts send `cellphone`. The adapter tries both.
- **Test webhooks from the Eduzz dashboard** send a fixed example payload
  that does NOT include `tracker.code1`. That's fine for signature
  verification but will fail the `trk` lookup in `_core.js` — meaning the
  row lands in `purchase_log` without `checkoutData`. Not a bug; expected.

## Verification test

1. Set the webhook URL in the Eduzz dashboard to
   `https://<your-pages-domain>/webhook/eduzz`.
2. Click "Enviar teste" in the Eduzz webhook settings. Expect a 200
   response. Check the Cloudflare Workers log for
   `processPurchase` completion; a row should appear in `purchase_log`
   with `trk = ''` (test payloads have no `trk`).
3. Create a coupon that brings one of your products to R$ 0,00.
4. Go through a real purchase flow starting from your sales page.
5. Query D1:
   ```
   wrangler d1 execute <db> --remote --command \
     "SELECT transaction_id, trk, meta_response_ok, ga4_response_ok, google_ads_response_ok, value, currency FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
6. The row should have: a non-empty `trk`, `meta_response_ok = 1`,
   `ga4_response_ok = 1`, and (if `gclid` was present) `google_ads_response_ok = 1`.
7. Check Meta Events Manager → Test Events for the matching `Purchase`.
