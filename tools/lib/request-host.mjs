// Host-header gates for the local servers (dev server bridge, music server,
// Plex adapter).
//
// Binding to loopback keeps other machines out but not other websites: a page
// on attacker.example can re-resolve its own name to 127.0.0.1 (DNS
// rebinding) and then read these servers as same-origin, with no Origin
// header on a simple GET. What it cannot forge is the Host header, which
// still names attacker.example. A rebinding attack needs a DNS name the
// attacker controls, so loopback names and IP literals are safe to accept;
// any other name must be configured explicitly.
import { isIP } from 'node:net';
import { isLoopbackHost } from '../../src/net/UrlAudioSource.js';

export { isLoopbackHost };

/** The hostname a request's Host header names (lowercase, IPv6 still in
 *  brackets), or null when the header is missing or is not a bare
 *  `host[:port]` authority. */
export function requestHostname(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (!raw || /[/?#@\\\s]/.test(raw)) return null;
  try {
    const url = new URL(`http://${raw}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

export function isIpLiteral(hostname) {
  return isIP(String(hostname || '').replace(/^\[|\]$/g, '')) !== 0;
}

/** Comma-separated hostnames from an environment value, lowercased. */
export function hostList(value) {
  return String(value || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** True when the Host header names loopback, (optionally) an IP literal, or
 *  one of the explicitly configured names. */
export function requestHostAllowed(hostHeader, { allowIpLiterals = false, extraHosts = [] } = {}) {
  const hostname = requestHostname(hostHeader);
  if (!hostname) return false;
  if (isLoopbackHost(hostname)) return true;
  if (allowIpLiterals && isIpLiteral(hostname)) return true;
  return extraHosts.includes(hostname);
}
