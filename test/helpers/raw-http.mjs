import http from 'node:http';

/** A request whose Host header is sent exactly as given. fetch() treats Host
 *  as a forbidden header and silently replaces it with the URL's authority,
 *  so a fetch-based "forged Host" test never forges anything. */
export function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers,
      timeout: 15_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`request to ${url} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}
