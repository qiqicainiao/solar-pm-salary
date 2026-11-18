/**
 * Cloudflare Pages Function — same-origin proxy for this site's manifest JSON.
 *
 * The telemetry SDK loads /manifests/<site_id>.json from the site origin.
 * Cloudflare Pages does not host the backend's manifest directory, so without
 * this Function the SDK silently falls back to embedded defaults and drift
 * between contract and client goes unnoticed.
 *
 * Only this site's manifest is forwarded. Other site ids are rejected so a
 * Pages domain cannot be used as a generic manifest mirror.
 */

const DEFAULT_API_ORIGIN = 'https://api.guomeijiayu.com';
const ALLOWED_MANIFEST = '/manifests/solar-pm-salary.json';

/* Matches the backend nginx rule: public, max-age=300 (manifest regenerates on schema change). */
const CACHE_CONTROL = 'public, max-age=300';

function jsonError(status, code, msg) {
  return new Response(JSON.stringify({ code: code, msg: msg, trace_id: '', data: null }), {
    status: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/**
 * @param {Request} request
 * @param {string} [apiOrigin] upstream origin (override with the API_ORIGIN env var)
 * @returns {Promise<Response>}
 */
export async function proxyManifest(request, apiOrigin) {
  const origin = (apiOrigin || DEFAULT_API_ORIGIN).replace(/\/+$/, '');
  const url = new URL(request.url);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }
    });
  }

  if (url.pathname !== ALLOWED_MANIFEST) {
    return jsonError(404, 40001, 'endpoint not found');
  }

  const headers = new Headers();
  headers.set('Host', new URL(origin).host);
  const etag = request.headers.get('If-None-Match');
  if (etag) headers.set('If-None-Match', etag);
  const ims = request.headers.get('If-Modified-Since');
  if (ims) headers.set('If-Modified-Since', ims);

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 15000);
  let upstream;
  try {
    upstream = await fetch(origin + url.pathname, {
      method: request.method,
      headers: headers,
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (e) {
    return jsonError(504, 'UPSTREAM_TIMEOUT', 'upstream timeout');
  } finally {
    clearTimeout(timer);
  }

  const out = new Headers();
  upstream.headers.forEach(function (value, key) {
    const k = key.toLowerCase();
    if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding' ||
        k === 'connection' || k === 'keep-alive' || k === 'set-cookie') {
      return;
    }
    out.set(key, value);
  });
  out.set('Cache-Control', CACHE_CONTROL);

  /* 204/304 must not carry a body; constructing a Response with one throws. */
  if (upstream.status === 204 || upstream.status === 304) {
    return new Response(null, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const onRequest = function (context) {
  return proxyManifest(context.request, context.env && context.env.API_ORIGIN);
};
