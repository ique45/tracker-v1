export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  // Only intercept HTML page requests, skip static assets and API endpoints
  const isPageRequest = !url.pathname.match(
    /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|webp|avif|mp4|webm|pdf|xml|txt|robots)$/i
  ) && !url.pathname.startsWith('/tracker')
    && !url.pathname.startsWith('/analytics')
    && !url.pathname.startsWith('/scripts/')
    && !url.pathname.startsWith('/webhook/')
    && !url.pathname.startsWith('/checkout-session')
    && !url.pathname.startsWith('/api/');

  if (!isPageRequest) {
    return next();
  }

  // --- Extract tracking parameters from URL ---
  // CRITICAL: Use raw query string extraction, NOT url.searchParams.get().
  // searchParams.get() URL-decodes the value, but Meta expects the exact
  // raw fbclid as it appears in the URL.
  const fbclid = getRawParam(url.search, 'fbclid');
  const gclid = getRawParam(url.search, 'gclid');
  const msclkid = getRawParam(url.search, 'msclkid');

  // --- Extract UTM parameters ---
  const utmSource = url.searchParams.get('utm_source') || '';
  const utmMedium = url.searchParams.get('utm_medium') || '';
  const utmCampaign = url.searchParams.get('utm_campaign') || '';
  const utmContent = url.searchParams.get('utm_content') || '';
  const utmTerm = url.searchParams.get('utm_term') || '';

  // --- Read existing cookies ---
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  let sessionId = cookies['_krob_sid'] || '';
  let externalId = cookies['_krob_eid'] || '';
  let existingFbc = cookies['_fbc'] || '';
  let existingFbp = cookies['_fbp'] || '';

  // --- Generate identifiers if missing ---
  const isNewSession = !sessionId;
  if (!sessionId) sessionId = crypto.randomUUID();
  if (!externalId) externalId = crypto.randomUUID();

  // --- Compute sub_domain_index per Meta SDK spec ---
  // sub_domain_index = etld_plus_1.split('.').length - 1
  // gustavobork.com.br → 3 parts → index 2
  const SUB_DOMAIN_INDEX = 2;

  // --- Build _fbc from fbclid ---
  let fbc = existingFbc;
  if (fbclid) {
    const existingPayload = existingFbc ? extractFbcPayload(existingFbc) : '';
    if (!existingFbc || existingPayload !== fbclid) {
      fbc = `fb.${SUB_DOMAIN_INDEX}.${Date.now()}.${fbclid}`;
    }
  }

  // --- Generate _fbp if missing ---
  let fbp = existingFbp;
  if (!fbp) {
    fbp = `fb.${SUB_DOMAIN_INDEX}.${Date.now()}.${Math.floor(Math.random() * 9000000000) + 1000000000}`;
  }

  // --- Capture request metadata ---
  const clientIp = request.headers.get('cf-connecting-ip') || '';
  const userAgent = request.headers.get('user-agent') || '';
  const referrer = request.headers.get('referer') || '';
  const now = Math.floor(Date.now() / 1000);

  // --- Serve the page FIRST, then write to D1 in background ---
  const response = await next();

  // --- Set HTTP cookies ---
  const maxAge = 34560000; // 400 days
  const cookieBase = `Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure`;

  const newHeaders = new Headers(response.headers);
  newHeaders.append('Set-Cookie', `_krob_sid=${sessionId}; ${cookieBase}`);
  newHeaders.append('Set-Cookie', `_krob_eid=${externalId}; ${cookieBase}`);
  newHeaders.append('Set-Cookie', `_fbp=${fbp}; ${cookieBase}`);

  if (fbc) {
    newHeaders.append('Set-Cookie', `_fbc=${fbc}; ${cookieBase}`);
  }

  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });

  // --- D1 UPSERT (background, non-blocking) ---
  context.waitUntil(
    (async () => {
      try {
        if (env.DB) {
          await env.DB.prepare(`
            INSERT INTO sessions (session_id, external_id, fbclid, gclid, msclkid, fbc, fbp, ip_address, user_agent, referrer, landing_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              fbclid = CASE WHEN excluded.fbclid != '' THEN excluded.fbclid ELSE sessions.fbclid END,
              gclid = CASE WHEN excluded.gclid != '' THEN excluded.gclid ELSE sessions.gclid END,
              msclkid = CASE WHEN excluded.msclkid != '' THEN excluded.msclkid ELSE sessions.msclkid END,
              fbc = CASE WHEN excluded.fbc != '' THEN excluded.fbc ELSE sessions.fbc END,
              utm_source = CASE WHEN excluded.utm_source != '' THEN excluded.utm_source ELSE sessions.utm_source END,
              utm_medium = CASE WHEN excluded.utm_medium != '' THEN excluded.utm_medium ELSE sessions.utm_medium END,
              utm_campaign = CASE WHEN excluded.utm_campaign != '' THEN excluded.utm_campaign ELSE sessions.utm_campaign END,
              utm_content = CASE WHEN excluded.utm_content != '' THEN excluded.utm_content ELSE sessions.utm_content END,
              utm_term = CASE WHEN excluded.utm_term != '' THEN excluded.utm_term ELSE sessions.utm_term END,
              updated_at = excluded.updated_at
          `).bind(sessionId, externalId, fbclid, gclid, msclkid, fbc, fbp, clientIp, userAgent, referrer, url.toString(), utmSource, utmMedium, utmCampaign, utmContent, utmTerm, now, now).run();
        }
      } catch (e) {
        console.error('Middleware D1 error:', e.message);
      }
    })()
  );

  return newResponse;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  });
  return cookies;
}

function getRawParam(search, name) {
  const match = (search || '').match(new RegExp('[?&]' + name + '=([^&]*)'));
  return match ? match[1] : '';
}

function extractFbcPayload(fbc) {
  if (!fbc) return '';
  const parts = fbc.split('.');
  return parts.length >= 4 ? parts[3] : '';
}
