// POST /qualificacao — salva respostas de lead scoring vinculadas à sessão.
// Lê _krob_sid do cookie (não-HttpOnly, legível pelo JS e pelo servidor).
// Não dispara eventos ao Meta — é dado interno de qualificação.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const sessionId = cookies['_krob_sid'] || body.session_id || '';

  if (!sessionId) {
    return json({ error: 'session not found' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(`
      INSERT INTO lead_qualification (session_id, instagram, especialidade, faturamento, foco, disposto, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId,
      body.instagram     || null,
      body.especialidade || null,
      body.faturamento   || null,
      body.foco          || null,
      body.disposto      || null,
      now
    ).run();

    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function parseCookies(header) {
  const cookies = {};
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=');
  });
  return cookies;
}
