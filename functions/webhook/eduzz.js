// -------------------------------------------------------
// PRODUCT CONFIG — maps Eduzz product ID to integration settings
// Add new products here. Unknown IDs are only logged to purchase_log.
// -------------------------------------------------------
const PRODUCT_CONFIG = {
  '2991843': {
    name: 'Workshop AO-VIVO: Traqueamento com o Claude Code',
    enchargeTag: 'inscrito-ws-track-claudecode-abril-26',
    manychatTagId: 83998307,
    googleAdsConversionActionId: '7567568040',
  },
};

// Module-scope OAuth2 access token cache for Google Ads API.
// Reused across warm worker invocations to skip the refresh round-trip.
let googleAdsTokenCache = { token: null, expiresAt: 0 };

// -------------------------------------------------------
// ROUTER — single entry point for all Eduzz webhooks
// -------------------------------------------------------
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const rawBody = await request.json();

    // Eduzz wraps payload in { event_name, data }
    const body = rawBody.data || rawBody;

    // Log raw body for product ID discovery on new products
    const firstItem = body.items?.[0] || {};
    console.log('Eduzz raw payload keys:', JSON.stringify({
      topLevel: Object.keys(rawBody),
      dataKeys: body ? Object.keys(body) : [],
      itemProductId: firstItem.productId,
      itemName: firstItem.name,
    }));

    // --- Parse payload once ---
    const trk = body.tracker?.code1 || '';
    const email = body.buyer?.email || body.student?.email || '';
    const name = body.buyer?.name || body.student?.name || '';
    const phone = body.buyer?.cellphone || body.buyer?.phone || '';
    const value = body.paid?.value || body.price?.value || 0;
    const currency = body.paid?.currency || body.price?.currency || 'BRL';
    const transactionId = body.transaction?.id || body.id || '';
    const saleStatus = body.status || '';
    const productId = String(firstItem.productId || '');
    const productName = firstItem.name || '';

    // Eduzz sends UTMs in body.utm
    const eduzzUtm = {
      utm_source: body.utm?.source || '',
      utm_medium: body.utm?.medium || '',
      utm_campaign: body.utm?.campaign || '',
      utm_content: body.utm?.content || '',
      utm_term: body.utm?.term || '',
    };

    // Only process paid sales
    if (saleStatus !== 'paid') {
      return new Response(JSON.stringify({ ok: true, skipped: 'not paid', status: saleStatus }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Lookup product config (null if unknown/recurring)
    const productConfig = PRODUCT_CONFIG[productId] || null;

    // Lookup checkout session if trk exists
    let checkoutData = {};
    if (trk && env.DB) {
      try {
        const row = await env.DB.prepare(
          'SELECT * FROM checkout_sessions WHERE trk = ?'
        ).bind(trk).first();
        if (row) checkoutData = row;
      } catch (e) {
        console.error('D1 checkout lookup error:', e.message);
      }
    }

    // Shared parsed data for all handlers
    const parsed = {
      trk, email, name, phone, value, currency, transactionId,
      productId, productName, productConfig, checkoutData, eduzzUtm,
      items: body.items || [],
    };

    const eventId = crypto.randomUUID();
    const eventTime = Math.floor(Date.now() / 1000);

    // --- Fan out to handlers independently ---
    const handlerPromises = [];

    // Tracking: only if trk exists AND checkout session was found
    if (trk && checkoutData.trk) {
      handlerPromises.push(
        handleTracking({ parsed, eventId, eventTime, env })
          .then(r => ({ handler: 'tracking', ...r }))
          .catch(e => ({ handler: 'tracking', error: e.message }))
      );
    }

    // Encharge: only for known products with email
    if (productConfig && email) {
      handlerPromises.push(
        handleEncharge({ parsed, env })
          .then(r => ({ handler: 'encharge', ...r }))
          .catch(e => ({ handler: 'encharge', error: e.message }))
      );
    }

    // ManyChat: only for known products with phone
    if (productConfig && phone) {
      handlerPromises.push(
        handleManyChat({ parsed, env })
          .then(r => ({ handler: 'manychat', ...r }))
          .catch(e => ({ handler: 'manychat', error: e.message }))
      );
    }

    const results = await Promise.allSettled(handlerPromises);

    // Build result map by handler name
    const resultMap = {};
    for (const r of results) {
      const val = r.status === 'fulfilled' ? r.value : { handler: 'unknown', error: r.reason?.message };
      resultMap[val.handler] = val;
    }

    // Purchase log: ALWAYS runs (background, non-blocking)
    context.waitUntil(
      handlePurchaseLog({ parsed, eventId, eventTime, resultMap, env })
    );

    console.log('Eduzz webhook processed:', {
      trk: trk || '(none)',
      productId: productId || '(none)',
      email,
      handlers: Object.keys(resultMap),
    });

    return new Response(JSON.stringify({ ok: true, event_id: eventId }), {
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

// -------------------------------------------------------
// HANDLER: Tracking — Meta CAPI + GA4 (needs trk)
// -------------------------------------------------------
async function handleTracking({ parsed, eventId, eventTime, env }) {
  const { email, name, phone, value, currency, transactionId, checkoutData, productConfig } = parsed;

  const hashedEm = await sha256(email);
  const nameParts = splitName(name);
  const hashedFn = await sha256(normalizeName(nameParts.fn));
  const hashedLn = await sha256(normalizeName(nameParts.ln));
  const hashedPh = await sha256(normalizePhone(phone));
  const hashedExternalId = await sha256(checkoutData.external_id || '');

  const [metaResult, ga4Result, googleAdsResult] = await Promise.allSettled([
    sendToMeta({ checkoutData, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, eventId, eventTime, value, currency, env }),
    sendToGA4({ checkoutData, hashedEm, transactionId, value, currency, env }),
    sendToGoogleAds({ checkoutData, productConfig, hashedEm, transactionId, value, currency, eventTime, env }),
  ]);

  // Each sendToX returns { payload, response } on a real call, or
  // { skipped, payload: null, response: null } when guards trip.
  // payload is the exact JSON string POSTed; persist it for /dash debugging.

  // Parse Meta response
  let metaStatusCode = 0, metaResponseOk = 0, metaResponseBody = '', metaPayloadSent = null;
  if (metaResult?.status === 'fulfilled' && metaResult.value) {
    const v = metaResult.value;
    metaPayloadSent = v.payload;
    if (v.skipped) {
      metaResponseBody = `skipped: ${v.skipped}`;
    } else if (v.response) {
      metaStatusCode = v.response.status;
      metaResponseOk = v.response.ok ? 1 : 0;
      try { metaResponseBody = await v.response.text(); } catch (e) { metaResponseBody = `Read error: ${e.message}`; }
    }
  } else if (metaResult?.status === 'rejected') {
    metaResponseBody = `Fetch error: ${metaResult.reason?.message || 'unknown'}`;
  }

  // Parse GA4 response (now also captures response body)
  let ga4StatusCode = 0, ga4ResponseOk = 0, ga4ResponseBody = '', ga4PayloadSent = null;
  if (ga4Result?.status === 'fulfilled' && ga4Result.value) {
    const v = ga4Result.value;
    ga4PayloadSent = v.payload;
    if (v.skipped) {
      ga4ResponseBody = `skipped: ${v.skipped}`;
    } else if (v.response) {
      ga4StatusCode = v.response.status;
      ga4ResponseOk = v.response.ok ? 1 : 0;
      try { ga4ResponseBody = await v.response.text(); } catch (e) { ga4ResponseBody = `Read error: ${e.message}`; }
    }
  } else if (ga4Result?.status === 'rejected') {
    ga4ResponseBody = `Fetch error: ${ga4Result.reason?.message || 'unknown'}`;
  }

  // Parse Google Ads response. HTTP 200 is not enough — partialFailureError
  // can hold per-row rejections, so inspect the body on success.
  let googleAdsStatusCode = 0, googleAdsResponseOk = 0, googleAdsResponseBody = '', googleAdsPayloadSent = null;
  if (googleAdsResult?.status === 'fulfilled' && googleAdsResult.value) {
    const v = googleAdsResult.value;
    googleAdsPayloadSent = v.payload;
    if (v.skipped) {
      googleAdsResponseBody = `skipped: ${v.skipped}`;
    } else if (v.response) {
      googleAdsStatusCode = v.response.status;
      try { googleAdsResponseBody = await v.response.text(); } catch (e) { googleAdsResponseBody = `Read error: ${e.message}`; }
      if (v.response.ok) {
        let partialErr = null;
        try {
          const parsedBody = JSON.parse(googleAdsResponseBody);
          partialErr = parsedBody?.partialFailureError || null;
        } catch (_) { /* non-JSON body, leave partialErr null */ }
        googleAdsResponseOk = partialErr ? 0 : 1;
      }
    }
  } else if (googleAdsResult?.status === 'rejected') {
    googleAdsResponseBody = `Fetch error: ${googleAdsResult.reason?.message || 'unknown'}`;
  }

  return {
    metaStatusCode, metaResponseOk, metaResponseBody, metaPayloadSent,
    ga4StatusCode, ga4ResponseOk, ga4ResponseBody, ga4PayloadSent,
    googleAdsStatusCode, googleAdsResponseOk, googleAdsResponseBody, googleAdsPayloadSent,
    hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId,
  };
}

// -------------------------------------------------------
// HANDLER: Encharge — email marketing
// -------------------------------------------------------
async function handleEncharge({ parsed, env }) {
  if (!env.ENCHARGE_API_KEY) {
    return { statusCode: 0, responseOk: 0, responseBody: 'Missing ENCHARGE_API_KEY' };
  }

  const { email, name, productConfig } = parsed;
  const nameParts = splitName(name);

  const response = await fetch('https://api.encharge.io/v1/people', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Encharge-Token': env.ENCHARGE_API_KEY,
    },
    body: JSON.stringify({
      email: email,
      firstName: nameParts.fn,
      tags: productConfig.enchargeTag,
    }),
  });

  let responseBody = '';
  try { responseBody = await response.text(); } catch (e) { responseBody = `Read error: ${e.message}`; }

  console.log('Encharge response:', { status: response.status, ok: response.ok, body: responseBody });

  return {
    statusCode: response.status,
    responseOk: response.ok ? 1 : 0,
    responseBody: responseBody,
  };
}

// -------------------------------------------------------
// HANDLER: ManyChat — create subscriber + add tag
// -------------------------------------------------------
async function handleManyChat({ parsed, env }) {
  if (!env.MANYCHAT_KEY) {
    return { statusCode: 0, responseOk: 0, responseBody: 'Missing MANYCHAT_KEY' };
  }

  const { name, phone, productConfig } = parsed;
  const nameParts = splitName(name);
  const manychatPhone = formatPhoneForManyChat(phone);

  if (!manychatPhone) {
    return { statusCode: 0, responseOk: 0, responseBody: 'No valid phone for ManyChat' };
  }

  const authHeaders = {
    'Authorization': `Bearer ${env.MANYCHAT_KEY}`,
    'Content-Type': 'application/json',
  };

  // Step 1: Try to create subscriber
  let subscriberId = '';
  let createBody = '';

  const createRes = await fetch('https://api.manychat.com/fb/subscriber/createSubscriber', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      first_name: nameParts.fn,
      last_name: nameParts.ln,
      whatsapp_phone: manychatPhone,
    }),
  });

  try { createBody = await createRes.text(); } catch (e) { createBody = `Read error: ${e.message}`; }
  console.log('ManyChat createSubscriber:', { status: createRes.status, body: createBody });

  if (!createRes.ok) {
    return {
      statusCode: createRes.status,
      responseOk: 0,
      responseBody: `createSubscriber failed: ${createBody}`,
    };
  }

  // Step 2: Extract subscriber_id and add tag
  try {
    const createData = JSON.parse(createBody);
    subscriberId = createData.data?.id || '';
  } catch (e) {
    return { statusCode: createRes.status, responseOk: 0, responseBody: `Parse error: ${e.message} | body: ${createBody}` };
  }

  if (!subscriberId) {
    return { statusCode: createRes.status, responseOk: 0, responseBody: `No subscriber_id in response: ${createBody}` };
  }

  const tagRes = await fetch('https://api.manychat.com/fb/subscriber/addTag', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      subscriber_id: subscriberId,
      tag_id: productConfig.manychatTagId,
    }),
  });

  let tagBody = '';
  try { tagBody = await tagRes.text(); } catch (e) { tagBody = `Read error: ${e.message}`; }

  console.log('ManyChat addTag:', { status: tagRes.status, body: tagBody });

  return {
    statusCode: tagRes.status,
    responseOk: tagRes.ok ? 1 : 0,
    responseBody: `createSubscriber: ${createBody} | addTag: ${tagBody}`,
  };
}

// -------------------------------------------------------
// HANDLER: Purchase Log — D1 insert (always runs)
// -------------------------------------------------------
async function handlePurchaseLog({ parsed, eventId, eventTime, resultMap, env }) {
  if (!env.DB) return;

  const { trk, email, name, phone, value, currency, transactionId, productId, productName, checkoutData, eduzzUtm, items } = parsed;
  const tracking = resultMap.tracking || {};
  const encharge = resultMap.encharge || {};
  const manychat = resultMap.manychat || {};

  const createdAt = Math.floor(Date.now() / 1000);
  let purchaseId = null;

  try {
    const result = await env.DB.prepare(`
      INSERT INTO purchase_log (
        trk, event_id, event_time,
        raw_email, raw_name, raw_phone,
        hashed_em, hashed_fn, hashed_ln, hashed_ph, hashed_external_id,
        client_ip_address, client_user_agent, fbp, fbc,
        value, currency, transaction_id,
        event_source_url,
        meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
        ga4_status_code, ga4_response_ok, ga4_response_body, ga4_payload_sent,
        google_ads_status_code, google_ads_response_ok, google_ads_response_body, google_ads_payload_sent,
        gclid, gbraid, wbraid,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        product_id, product_name,
        encharge_status_code, encharge_response_ok, encharge_response_body,
        manychat_status_code, manychat_response_ok, manychat_response_body,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      trk || '', eventId, eventTime,
      email, name, phone,
      tracking.hashedEm || '', tracking.hashedFn || '', tracking.hashedLn || '',
      tracking.hashedPh || '', tracking.hashedExternalId || '',
      checkoutData.ip_address || '', checkoutData.user_agent || '',
      checkoutData.fbp || '', checkoutData.fbc || '',
      parseFloat(value) || 0, currency, transactionId,
      checkoutData.event_source_url || '',
      tracking.metaStatusCode || 0, tracking.metaResponseOk || 0, tracking.metaResponseBody || '', tracking.metaPayloadSent ?? null,
      tracking.ga4StatusCode || 0, tracking.ga4ResponseOk || 0, tracking.ga4ResponseBody || '', tracking.ga4PayloadSent ?? null,
      tracking.googleAdsStatusCode || 0, tracking.googleAdsResponseOk || 0, tracking.googleAdsResponseBody || '', tracking.googleAdsPayloadSent ?? null,
      checkoutData.gclid || '', checkoutData.gbraid || '', checkoutData.wbraid || '',
      eduzzUtm.utm_source || '', eduzzUtm.utm_medium || '',
      eduzzUtm.utm_campaign || '', eduzzUtm.utm_content || '', eduzzUtm.utm_term || '',
      productId || '', productName || '',
      encharge.statusCode || 0, encharge.responseOk || 0, encharge.responseBody || '',
      manychat.statusCode || 0, manychat.responseOk || 0, manychat.responseBody || '',
      createdAt
    ).run();

    purchaseId = result.meta?.last_row_id ?? null;
  } catch (e) {
    console.error('D1 purchase_log error:', e.message);
    return;
  }

  if (purchaseId == null) {
    console.error('D1 purchase_log: no last_row_id returned, skipping purchase_items insert', { transactionId });
    return;
  }

  const itemList = Array.isArray(items) ? items : [];
  if (itemList.length === 0) {
    console.warn('Eduzz webhook: no items[] in payload, skipping purchase_items insert', { transactionId, purchaseId });
    return;
  }

  try {
    const itemStmt = env.DB.prepare(`
      INSERT INTO purchase_items (
        purchase_id, transaction_id, product_id, product_name,
        value, currency, created_at,
        utm_source, utm_campaign, utm_medium, utm_content, utm_term
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const batch = itemList.map(item => itemStmt.bind(
      purchaseId,
      transactionId || null,
      String(item.productId || ''),
      item.name || null,
      parseFloat(item?.price?.value) || 0,
      item?.price?.currency || currency || 'BRL',
      createdAt,
      eduzzUtm.utm_source || null,
      eduzzUtm.utm_campaign || null,
      eduzzUtm.utm_medium || null,
      eduzzUtm.utm_content || null,
      eduzzUtm.utm_term || null,
    ));

    await env.DB.batch(batch);
  } catch (e) {
    // Lines failed but parent succeeded — roll back parent so SUM(items) == header invariant holds.
    console.error('D1 purchase_items error, rolling back parent purchase_log row', {
      transactionId, purchaseId, error: e.message,
    });
    try {
      await env.DB.prepare('DELETE FROM purchase_log WHERE id = ?').bind(purchaseId).run();
    } catch (rollbackErr) {
      console.error('CRITICAL: purchase_log rollback failed — manual reconciliation needed', {
        transactionId, purchaseId, error: rollbackErr.message,
      });
    }
  }
}

// -------------------------------------------------------
// META CAPI — Purchase with full navigation data from D1
// -------------------------------------------------------
async function sendToMeta({ checkoutData, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, eventId, eventTime, value, currency, env }) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) {
    return { skipped: 'missing meta env', payload: null, response: null };
  }

  const metaUserData = {
    client_ip_address: checkoutData.ip_address || '',
    client_user_agent: checkoutData.user_agent || '',
  };

  if (hashedEm) metaUserData.em = [hashedEm];
  if (hashedFn) metaUserData.fn = [hashedFn];
  if (hashedLn) metaUserData.ln = [hashedLn];
  if (hashedPh) metaUserData.ph = [hashedPh];
  if (hashedExternalId) metaUserData.external_id = [hashedExternalId];
  if (checkoutData.fbp) metaUserData.fbp = checkoutData.fbp;
  if (checkoutData.fbc) metaUserData.fbc = checkoutData.fbc;

  const metaPayload = {
    data: [{
      event_name: 'Purchase',
      event_time: eventTime,
      event_id: eventId,
      event_source_url: checkoutData.event_source_url || '',
      action_source: 'website',
      user_data: metaUserData,
      custom_data: {
        value: parseFloat(value) || 0,
        currency: currency,
      },
    }],
  };

  if (env.META_TEST_EVENT_CODE) {
    metaPayload.test_event_code = env.META_TEST_EVENT_CODE;
  }

  const payloadJson = JSON.stringify(metaPayload);
  const response = await fetch(
    `https://graph.facebook.com/v22.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadJson,
    }
  );
  return { payload: payloadJson, response };
}

// -------------------------------------------------------
// GA4 Measurement Protocol — Purchase
// -------------------------------------------------------
async function sendToGA4({ checkoutData, hashedEm, transactionId, value, currency, env }) {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) {
    return { skipped: 'missing ga4 env', payload: null, response: null };
  }

  // Use real client_id from _ga cookie captured at checkout; fall back to random
  const gaClientId = checkoutData.ga_client_id || `${Date.now()}.${Math.floor(Math.random() * 1000000000)}`;

  const ga4Payload = {
    client_id: gaClientId,
    events: [{
      name: 'purchase',
      params: {
        transaction_id: transactionId,
        value: parseFloat(value) || 0,
        currency: currency,
        engagement_time_msec: 100,
      },
    }],
  };

  if (hashedEm) {
    ga4Payload.user_properties = { email: { value: hashedEm } };
  }

  const payloadJson = JSON.stringify(ga4Payload);
  const response = await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadJson,
    }
  );
  return { payload: payloadJson, response };
}

// -------------------------------------------------------
// GOOGLE ADS API — uploadClickConversions (v21 REST, hand-rolled)
// -------------------------------------------------------
// IMPORTANT: pin v21 in the URL. SDKs (google-ads-api / google-ads-node) lag the
// REST API and break with "API version not found" — call REST directly via fetch.
async function getGoogleAdsAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (googleAdsTokenCache.token && googleAdsTokenCache.expiresAt > now + 30) {
    return googleAdsTokenCache.token;
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.error('Google Ads token refresh failed:', resp.status, errBody);
    return null;
  }

  const data = await resp.json();
  if (!data.access_token) {
    console.error('Google Ads token refresh: no access_token in response', data);
    return null;
  }

  googleAdsTokenCache = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600) - 60,
  };
  return data.access_token;
}

// Format unix seconds → "YYYY-MM-DD HH:MM:SS-03:00" in America/Sao_Paulo.
// Brazil dropped DST in 2019, so the offset is fixed at -03:00 year-round.
// UTC drift here can trigger CONVERSION_PRECEDES_GCLID, so do not skip the offset.
function formatConversionDateTimeBR(unixSeconds) {
  const shifted = new Date((unixSeconds - 3 * 3600) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}-03:00`;
}

async function sendToGoogleAds({ checkoutData, productConfig, hashedEm, transactionId, value, currency, eventTime, env }) {
  // Required env
  if (!env.GOOGLE_ADS_CUSTOMER_ID || !env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ||
      !env.GOOGLE_ADS_DEVELOPER_TOKEN || !env.GOOGLE_ADS_CLIENT_ID ||
      !env.GOOGLE_ADS_CLIENT_SECRET || !env.GOOGLE_ADS_REFRESH_TOKEN) {
    return { skipped: 'missing google ads env', payload: null, response: null };
  }

  // Per-product conversion action
  if (!productConfig?.googleAdsConversionActionId) {
    return { skipped: 'no conversion action configured', payload: null, response: null };
  }

  // Click identifier required (gclid > wbraid > gbraid). No fallback to
  // Enhanced Conversions for Leads — that's a different API surface.
  const gclid = checkoutData.gclid || '';
  const wbraid = checkoutData.wbraid || '';
  const gbraid = checkoutData.gbraid || '';
  if (!gclid && !wbraid && !gbraid) {
    return { skipped: 'no click id', payload: null, response: null };
  }

  const accessToken = await getGoogleAdsAccessToken(env);
  if (!accessToken) {
    return { skipped: 'oauth token unavailable', payload: null, response: null };
  }

  const customerId = String(env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, '');
  const loginCustomerId = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, '');

  const conversion = {
    conversionAction: `customers/${customerId}/conversionActions/${productConfig.googleAdsConversionActionId}`,
    conversionDateTime: formatConversionDateTimeBR(eventTime),
    conversionValue: parseFloat(value) || 0,
    currencyCode: currency || 'BRL',
    orderId: String(transactionId || ''),
  };
  // Exactly one click identifier; gclid wins, then wbraid, then gbraid.
  if (gclid) conversion.gclid = gclid;
  else if (wbraid) conversion.wbraid = wbraid;
  else if (gbraid) conversion.gbraid = gbraid;

  if (hashedEm) {
    conversion.userIdentifiers = [{ hashedEmail: hashedEm }];
  }

  const body = {
    conversions: [conversion],
    partialFailure: true,
    validateOnly: false,
  };

  const payloadJson = JSON.stringify(body);
  const response = await fetch(
    `https://googleads.googleapis.com/v21/customers/${customerId}:uploadClickConversions`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': loginCustomerId,
        'Content-Type': 'application/json',
      },
      body: payloadJson,
    }
  );
  return { payload: payloadJson, response };
}

// -------------------------------------------------------
// HELPERS
// -------------------------------------------------------
async function sha256(value) {
  if (!value) return '';
  const normalized = value.toLowerCase().trim();
  const encoded = new TextEncoder().encode(normalized);
  const buffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function normalizePhone(ph) {
  if (!ph) return '';
  const digits = ph.replace(/\D/g, '');
  return digits.replace(/^0+/, '') || '';
}

function normalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '');
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  return { fn: parts[0] || '', ln: parts.slice(1).join(' ') || '' };
}

function formatPhoneForManyChat(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (!digits) return '';
  // Already has country code (55) + DDD + number = 12-13 digits
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
    return digits;
  }
  // Brazilian: DDD (2) + number (8-9) = 10-11 digits → prepend 55
  if (digits.length >= 10 && digits.length <= 11) {
    return '55' + digits;
  }
  // Fallback: return as-is
  return digits;
}
