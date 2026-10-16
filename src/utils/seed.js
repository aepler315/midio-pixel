// World-seed helpers: parse freeform input into a 32-bit seed, format for
// display/share, and derive a default seed from a song timeline when the
// player didn't pin one.
import { hashSeed } from './math.js';

/** Format a 32-bit seed as 8-digit uppercase hex (e.g. A3F0C12B). */
export function formatSeed(seed) {
  return ((seed >>> 0)).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Parse a seed string. Accepts:
 *   - empty / null → null (caller should fall back to auto)
 *   - hex (optional 0x): "A3F0C12B", "0xa3f0c12b"
 *   - decimal integers
 *   - free text → hashSeed(text)
 */
export function parseSeed(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^0x[0-9a-f]{1,8}$/i.test(s)) return (parseInt(s.slice(2), 16) >>> 0);
  if (/^[0-9a-f]{1,8}$/i.test(s) && /[a-f]/i.test(s)) return (parseInt(s, 16) >>> 0);
  if (/^\d+$/.test(s)) return (Number(s) >>> 0);
  return hashSeed(s);
}

/** Deterministic seed from song timing shape (legacy default). */
export function seedFromTimeline(conductor) {
  const tl = conductor?.timeline || [];
  return hashSeed(
    `${tl.length}:${conductor?.durationMs ?? 0}:${tl[0]?.tMs ?? 0}:${tl.at?.(-1)?.tMs ?? tl[tl.length - 1]?.tMs ?? 0}`,
  );
}

/** Resolve the seed used for a run: pinned override wins, else timeline. */
export function resolveSongSeed(conductor, pinned) {
  if (pinned != null && Number.isFinite(pinned)) return (pinned >>> 0);
  return seedFromTimeline(conductor);
}
