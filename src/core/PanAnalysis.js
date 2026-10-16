// Detects MIDI voices authored with hard-opposite stereo pan (CC#10) that
// actually sound together — the classic call-and-response / ping-pong
// mixing trick. Two voices panned to opposite sides and overlapping in time
// are "intertwined": rather than blast the full authored width from note
// one, their pan eases from dead-center at song-start out to the authored
// spread by song-end, so the stereo image visibly widens as the piece
// unfolds. Voices with no such partner just play at their authored pan the
// whole time, exactly as an ordinary mixer channel would.
const OPPOSITE_PAN_THRESHOLD = 0.25; // |pan| must clear this on both sides to count as "panned"
const OVERLAP_FRACTION = 0.3;        // fraction of the quieter voice's active time that must coincide

/** Merges a voice's notes into non-overlapping [start, end] ms spans. */
function activeSpans(notes) {
  if (notes.length === 0) return [];
  const spans = notes.map((n) => [n.startMs, n.startMs + n.durMs]).sort((a, b) => a[0] - b[0]);
  const merged = [spans[0].slice()];
  for (const [s, e] of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function totalMs(spans) {
  let sum = 0;
  for (const [s, e] of spans) sum += e - s;
  return sum;
}

/** ms of overlap between two span lists (both sorted, each internally non-overlapping). */
function overlapMs(a, b) {
  let i = 0, j = 0, total = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) total += hi - lo;
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return total;
}

/**
 * @param {Array<{track:{channel:number,pan:number}, notes:Array<{startMs:number,durMs:number}>}>} trackData
 * @returns {Map<number, {pan:number, dynamic:boolean, partnerChannel?:number}>} MIDI channel -> pan assignment
 */
export function assignPan(trackData) {
  const byChannel = new Map(); // channel -> { pan, notes[] }
  for (const { track, notes } of trackData) {
    if (notes.length === 0) continue;
    if (!byChannel.has(track.channel)) {
      byChannel.set(track.channel, { pan: track.pan || 0, notes: [] });
    }
    byChannel.get(track.channel).notes.push(...notes);
  }

  const channels = [...byChannel.entries()];
  const result = new Map();
  for (const [channel, info] of channels) result.set(channel, { pan: info.pan, dynamic: false });

  const spans = new Map(channels.map(([ch, info]) => [ch, activeSpans(info.notes)]));

  for (let i = 0; i < channels.length; i++) {
    const [chA, infoA] = channels[i];
    if (Math.abs(infoA.pan) < OPPOSITE_PAN_THRESHOLD) continue;
    for (let j = i + 1; j < channels.length; j++) {
      const [chB, infoB] = channels[j];
      if (Math.abs(infoB.pan) < OPPOSITE_PAN_THRESHOLD) continue;
      if (Math.sign(infoA.pan) === Math.sign(infoB.pan)) continue; // same side isn't "opposite"

      const spanA = spans.get(chA), spanB = spans.get(chB);
      const shorter = Math.min(totalMs(spanA), totalMs(spanB));
      if (shorter <= 0) continue;
      if (overlapMs(spanA, spanB) / shorter < OVERLAP_FRACTION) continue;

      result.set(chA, { pan: infoA.pan, dynamic: true, partnerChannel: chB });
      result.set(chB, { pan: infoB.pan, dynamic: true, partnerChannel: chA });
    }
  }
  return result;
}

/** Smoothstep ease: 0 at t<=0, 1 at t>=1, gentle S-curve between. */
function ease(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * Resolves a channel's live pan at `tMs` out of `durationMs`. A static
 * (non-intertwined) channel returns its authored pan unchanged; a dynamic
 * one eases from dead-center at song-start to its full authored pan by
 * song-end.
 */
export function panAt(entry, tMs, durationMs) {
  if (!entry) return 0;
  if (!entry.dynamic) return entry.pan;
  const t = durationMs > 0 ? tMs / durationMs : 1;
  return entry.pan * ease(t) || 0; // normalize -0 (e.g. negative pan at t=0) to 0
}

/** De-duplicated list of intertwined channel pairs, for display purposes. */
export function intertwinedPairs(panByChannel) {
  const pairs = [];
  const seen = new Set();
  for (const [channel, entry] of panByChannel) {
    if (!entry.dynamic || entry.partnerChannel == null) continue;
    const lo = Math.min(channel, entry.partnerChannel);
    const hi = Math.max(channel, entry.partnerChannel);
    const key = `${lo}:${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ channelA: lo, channelB: hi });
  }
  return pairs;
}
