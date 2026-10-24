/** RFC 6266 attachment header for any filename. Node refuses a header value
 *  outside Latin-1, so `Björk – Jóga.flac` used to throw inside writeHead
 *  and turn a finished download into a 500. An ASCII fallback for old
 *  clients, and the exact name as UTF-8 in filename*. */
export function contentDisposition(filename) {
  const name = String(filename || 'download');
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
