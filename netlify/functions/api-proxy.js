const BACKEND_BASE = 'https://www.itcatalystindia.com/Development/CustomerPortal_API';

export default async (request) => {
  const pathname = new URL(request.url).pathname;
  const path = pathname.replace(/^.*\/api-proxy\/?/, '') || '';
  const backendUrl = `${BACKEND_BASE}/${path}`;
  const method = request.method;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');

  const opts = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && request.body) {
    opts.body = request.body;
  }

  const res = await fetch(backendUrl, opts);
  const resHeaders = new Headers(res.headers);
  resHeaders.set('Access-Control-Allow-Origin', request.headers.get('origin') || '*');
  resHeaders.delete('content-encoding');

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: resHeaders,
  });
};
