// -----------------------------------------------------------------------------
// Eduzz webhook adapter.
//
// Responsibilities:
//   1. Read the raw request body.
//   2. Verify the Eduzz HMAC-SHA256 signature (populated Day 4).
//   3. Parse the Eduzz payload shape into the normalized purchase object that
//      _core.js expects.
//   4. Hand off to processPurchase().
//
// Platform specifics captured here:
//   - Unique checkout identifier arrives as `body.tracker.code1` → maps to `trk`.
//   - Eduzz wraps the payload as `{ event_name, data: {...} }` — unwrap if present.
//   - Sale statuses that indicate a real paid purchase: 'paid'.
//   - Signature header: `x-signature` (HMAC-SHA256 of the raw body, hex).
//   - Shared secret: env.EDUZZ_WEBHOOK_SECRET (generated in Eduzz dashboard).
// -----------------------------------------------------------------------------

import { processPurchase } from './_core.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // TODO (Day 4): HMAC-SHA256 verification against env.EDUZZ_WEBHOOK_SECRET.
    // When that lands, this block becomes:
    //   const rawBody = await request.text();
    //   if (!(await verifyEduzzSignature(rawBody, request.headers.get('x-signature'), env.EDUZZ_WEBHOOK_SECRET))) {
    //     return new Response(JSON.stringify({ error: 'invalid signature' }), {
    //       status: 401, headers: { 'Content-Type': 'application/json' },
    //     });
    //   }
    //   const rawPayload = JSON.parse(rawBody);
    const rawPayload = await request.json();

    // Eduzz wraps the payload as { event_name, data: {...} }
    const body = rawPayload.data || rawPayload;
    const firstItem = body.items?.[0] || {};

    // Only process paid sales. Eduzz uses 'paid' — other statuses (pending,
    // refunded, chargeback) get acknowledged with 200 so Eduzz stops retrying.
    const saleStatus = body.status || '';
    if (saleStatus !== 'paid') {
      return new Response(JSON.stringify({ ok: true, skipped: 'not paid', status: saleStatus }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Normalize into the shape _core.js expects.
    const parsed = {
      platform: 'eduzz',
      trk: body.tracker?.code1 || '',
      email: body.buyer?.email || body.student?.email || '',
      name: body.buyer?.name || body.student?.name || '',
      phone: body.buyer?.cellphone || body.buyer?.phone || '',
      value: body.paid?.value || body.price?.value || 0,
      currency: body.paid?.currency || body.price?.currency || 'BRL',
      transactionId: body.transaction?.id || body.id || '',
      productId: String(firstItem.productId || ''),
      productName: firstItem.name || '',
      items: body.items || [],
      platformUtm: {
        utm_source: body.utm?.source || '',
        utm_medium: body.utm?.medium || '',
        utm_campaign: body.utm?.campaign || '',
        utm_content: body.utm?.content || '',
        utm_term: body.utm?.term || '',
      },
    };

    const result = await processPurchase({ parsed, env, context });

    return new Response(JSON.stringify({ ok: true, event_id: result.eventId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Eduzz webhook error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
