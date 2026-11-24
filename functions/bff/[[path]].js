/**
 * Cloudflare Pages Function — thin reverse proxy for /bff/*.
 *
 * Mirrors the production nginx rule:
 *   location ^~ /bff/ { rewrite ^/bff/(.*)$ /$1 break; proxy_pass https://api.guomeijiayu.com; }
 *
 * Forwarding contract (matches the multi-site BFF router in public/index.php):
 *   /bff/{site_id}/{action}  ->  https://api.guomeijiayu.com/{site_id}/{action}
 *
 * Why a same-origin proxy instead of calling the API domain directly:
 *   1) same origin: no CORS, no preflight, cookie semantics unchanged;
 *   2) new sites do not need to be added to VIDRANK_CORS_ORIGINS, so a missing
 *      whitelist entry cannot break a launch;
 *   3) CSP can stay at connect-src 'self'.
 *
 * Pages ignores .htaccess / nginx.htaccess; this file is the only proxy implementation.
 */

const DEFAULT_API_ORIGIN = 'https://api.guomeijiayu.com';

/* One deployment per site: only forward this site's own site_id, so nobody can call
   /bff/li-resume-check/check through another site's domain and drain its free quota. */
const ALLOWED_SITE_SLUG = 'solar-pm-salary';

/* Read-only endpoints (account session + billing status) must be GET.
   Everything else stays POST-only: a GET must never be able to spend quota. */
const GET_PATHS = new Set(['account/me', 'billing/status']);

/* Cookie allowlist. Two reasons to filter instead of passing everything through:
   1) privacy — analytics/third-party cookies on this origin have no business reaching the API;
   2) safety — an upstream bug must not be able to set arbitrary cookies on this domain. */
const COOKIE_NAMES = ['vr_acct'];

/* Must exceed the slowest upstream path and stay below the browser timeout, otherwise
   visitors see a client-side timeout instead of a readable error. */
const TIMEOUT_MS = 25000;

function pickCookies(headerValue) {
  if (!headerValue) return '';
  const out = [];
  headerValue.split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx <= 0) return;
    const name = pair.slice(0, idx).trim();
    if (COOKIE_NAMES.indexOf(name) !== -1) out.push(pair.trim());
  });
  return out.join('; ');
}

function upstreamSetCookies(headers) {
  /* Workers: getSetCookie() keeps multiple Set-Cookie values separate; getAll() is the
     older spelling. Never use headers.get('set-cookie') — it comma-joins, and expires
     attributes contain commas, so the cookie would silently break. */
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  if (typeof headers.getAll === 'function') return headers.getAll('set-cookie');
  return [];
}

function jsonError(status, code, msg) {
  return new Response(JSON.stringify({ code: code, msg: msg, trace_id: '', data: null }), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/**
 * @param {Request} request
 * @param {string} [apiOrigin] upstream origin (override with the API_ORIGIN env var)
 * @returns {Promise<Response>}
 */
export async function proxyBff(request, apiOrigin) {
  const origin = (apiOrigin || DEFAULT_API_ORIGIN).replace(/\/+$/, '');
  const url = new URL(request.url);

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'bff' || parts[1] !== ALLOWED_SITE_SLUG) {
    return jsonError(404, 40001, 'endpoint not found');
  }

  /* Method gate lives here (after the path is known): a GET is only allowed on the
     read-only endpoints. A GET must never be able to spend quota or write data. */
  const method = request.method;
  const isReadOnly = method === 'GET';
  if (method !== 'GET' && method !== 'POST' && method !== 'OPTIONS') {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' }
    });
  }

  /* Strip /bff only; keep /{site_id}/{action} so it matches the backend route regex. */
  const upstreamPath = parts.slice(1).join('/');
  const actionPath = parts.slice(2).join('/');

  if (isReadOnly && !GET_PATHS.has(actionPath)) {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'POST, OPTIONS', 'Cache-Control': 'no-store' }
    });
  }

  const target = origin + '/' + upstreamPath + url.search;

  const headers = new Headers();
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);
  const accept = request.headers.get('Accept');
  if (accept) headers.set('Accept', accept);
  const ua = request.headers.get('User-Agent');
  if (ua) headers.set('User-Agent', ua);
  const originHeader = request.headers.get('Origin');
  if (originHeader) headers.set('Origin', originHeader);

  /* Session cookie only (see COOKIE_NAMES). Without this the account endpoints always
     answer "not logged in" — the browser sends the cookie to this origin, and we are the
     only party that can hand it to the API. */
  const cookie = pickCookies(request.headers.get('Cookie'));
  if (cookie) headers.set('Cookie', cookie);

  /* Host must be the upstream host, otherwise PHP sees the Pages hostname. */
  headers.set('Host', new URL(origin).host);
  headers.set('X-Forwarded-Proto', 'https');

  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) {
    /* The backend reads X-Real-IP first (enabled unless VIDRANK_TRUST_PROXY=0).
       Without it every visitor would share Cloudflare egress IPs and the
       10 requests/minute check limit would be exhausted by normal traffic. */
    headers.set('X-Real-IP', clientIp);
    headers.set('X-Forwarded-For', clientIp);
  }

  let body;
  if (request.method === 'POST') {
    /* Backend limits: check 256KB, track 32KB. Buffering is cheap and avoids
       streaming-body compatibility issues across runtimes. */
    body = await request.arrayBuffer();
  }

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: headers,
      body: body,
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (e) {
    return jsonError(504, 'UPSTREAM_TIMEOUT', 'upstream timeout');
  } finally {
    clearTimeout(timer);
  }

  /* Pass the status and headers through byte for byte: the UI depends on
     X-RateLimit-Reset / Retry-After for countdowns and on the business code
     (40001 / 40901 / 42901 / 42201) to pick the right message. */
  const out = new Headers();
  upstream.headers.forEach(function (value, key) {
    const k = key.toLowerCase();
    if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding' ||
        k === 'connection' || k === 'keep-alive' || k === 'set-cookie') {
      return;
    }
    out.set(key, value);
  });
  out.set('Cache-Control', 'no-store');

  /* Session cookie must reach the browser, otherwise login "succeeds" and the very next
     request is anonymous again — the classic silent session bug. Only allowlisted names. */
  upstreamSetCookies(upstream.headers).forEach(function (raw) {
    const eq = raw.indexOf('=');
    const name = (eq > 0 ? raw.slice(0, eq) : '').trim().toLowerCase();
    if (COOKIE_NAMES.indexOf(name) !== -1) out.append('set-cookie', raw);
  });

  /* 204/304 must not carry a body; constructing a Response with one throws.
     The track endpoint always returns 204, so this branch is on the hot path. */
  if (upstream.status === 204 || upstream.status === 304) {
    return new Response(null, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const onRequest = function (context) {
  return proxyBff(context.request, context.env && context.env.API_ORIGIN);
};
