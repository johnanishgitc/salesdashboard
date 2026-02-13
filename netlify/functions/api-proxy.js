const BACKEND_BASE = 'https://www.itcatalystindia.com/Development/CustomerPortal_API/api';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export default async (request) => {
  try {
    const pathname = new URL(request.url).pathname;
    const path = pathname.includes('/api-proxy/')
      ? pathname.replace(/^.*\/api-proxy\/?/, '')
      : pathname.replace(/^\/api\/?/, '');
    const backendUrl = `${BACKEND_BASE}/${path}`;
    const method = request.method;
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('connection');

    const opts = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        opts.body = await request.arrayBuffer();
        if (opts.body.byteLength === 0) opts.body = undefined;
      } catch (_) {}
    }

    const res = await fetch(backendUrl, opts);
    const resHeaders = new Headers(res.headers);
    resHeaders.set('Access-Control-Allow-Origin', request.headers.get('origin') || '*');

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Proxy error', message: err?.message || 'Unknown error' }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(request.headers?.get?.('origin')),
        },
      }
    );
  }
};
