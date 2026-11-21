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

/* Must exceed the slowest upstream path and stay below the browser timeout, otherwise
   visitors see a client-side timeout instead of a readable error. */
const TIMEOUT_MS = 25000;

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

  if (request.method !== 'POST' && request.method !== 'OPTIONS') {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'POST, OPTIONS', 'Cache-Control': 'no-store' }
    });
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'bff' || parts[1] !== ALLOWED_SITE_SLUG) {
    return jsonError(404, 40001, 'endpoint not found');
  }

  /* Strip /bff only; keep /{site_id}/{action} so it matches the backend route regex. */
  const upstreamPath = parts.slice(1).join('/');
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

  /* Host must be the upstream host, otherwise PHP sees the Pages hostname.
     Cookies are not forwarded, matching `proxy_set_header Cookie ""` in nginx. */
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
