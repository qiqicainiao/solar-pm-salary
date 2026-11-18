/**
 * functions/_middleware.js
 *
 * Canonical host normalisation: www.<domain> -> <domain>, HTTP 301.
 *
 * Runs before every route handled by Functions, including /bff/*. The canonical
 * host is derived from the request host itself, so this file embeds no domain and
 * needs no edit when the site is pointed at a different domain.
 *
 * Cloudflare Pages never evaluates .htaccess or nginx.htaccess, so this middleware
 * is the only in-repo mechanism that answers www.<domain> with a redirect. For zero
 * Functions invocations an equivalent Redirect Rule can be configured in the
 * Cloudflare dashboard; see the deployment notes under _site-docs.
 */

const WWW_PREFIX = 'www.';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const host = url.hostname.toLowerCase();

  if (host.startsWith(WWW_PREFIX) && host.length > WWW_PREFIX.length) {
    url.hostname = host.slice(WWW_PREFIX.length);
    url.protocol = 'https:';
    url.port = '';
    return new Response(null, {
      status: 301,
      headers: {
        Location: url.toString(),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  return context.next();
}
