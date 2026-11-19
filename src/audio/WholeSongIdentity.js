// A song's look -- the seed and the profile its world is tailored from, its
// home biome, catalog view, ridges and sky -- comes from the WHOLE song.
//
// A long song starts playing on its first OPENING_SECONDS (OpeningAnalysis.js)
// and is analysed whole in the background. The opening is good enough to
// start on, but it has no arc and no climax, and a look taken from it would
// differ from the one an export (which analyses the whole song first) takes.
// So the opening only ever drives a PROVISIONAL look: it is never written to
// `songIdentity`, the analysis cache or the music library. When the whole-song
// analysis lands (or a cache hit brings it), the identity is frozen from it,
// and every path -- live, export, stems, cached -- draws the same song.
//
// The seed hashes the timeline's shape with its times quantised to Float32,
// the precision the analysis cache stores them at, so a song restored from
// the cache derives the very seed a fresh analysis did.
import { buildSongProfile, PROFILE_VERSION } from './SongProfile.js';
import { copySongprint } from './SongprintData.js';
import { hashSeed } from '../utils/math.js';

/** Seed from the timeline's shape, stable across an analysis-cache round
 *  trip (bundles store note times as Float32). */
export function identitySeed({ timeline, durationMs } = {}) {
  const tl = Array.isArray(timeline) ? timeline : [];
  const q = (v) => (Number.isFinite(v) ? Math.fround(v) : 0);
  return hashSeed(`${tl.length}:${q(durationMs ?? 0)}:${q(tl[0]?.tMs)}:${q(tl[tl.length - 1]?.tMs)}`);
}

/** The data's own profile when it is current, else one built from it. */
export function profileOf(data = {}) {
  if (data.songProfile?.version === PROFILE_VERSION) return data.songProfile;
  return buildSongProfile({
    energyCurves: data.energyCurves,
    durationMs: data.durationMs,
    bpm: data.bpm,
    beatPeriodMs: data.beatPeriodMs,
    confidence: data.confidence,
    freeTime: data.freeTime,
    analysis: data.analysis,
    structure: data.structure,
    timeline: data.timeline,
    barGrid: data.barGrid,
  });
}

/** Whether `identity` is a complete, current identity worth keeping. */
export function isSongIdentity(identity) {
  return !!identity && Number.isFinite(identity.seed) && identity.songProfile?.version === PROFILE_VERSION;
}

/**
 * The identity of `data`: its own (from the cache) when complete, else built
 * from it. Call it only on whole-song data; on an opening it is provisional
 * (see provisionalIdentity).
 */
export function buildSongIdentity(data = {}) {
  const cached = isSongIdentity(data.songIdentity) ? data.songIdentity : null;
  const identity = cached ? { seed: cached.seed >>> 0, songProfile: cached.songProfile }
    : { seed: identitySeed(data), songProfile: profileOf(data) };
  const print = Object.hasOwn(data, 'songprint') ? data.songprint : cached?.songprint;
  const songprint = !data.opening && copySongprint(print, data.durationMs);
  if (songprint) identity.songprint = songprint;
  return identity;
}

/** The look an opening plays on until the whole song is in. Never stored. */
export function provisionalIdentity(opening = {}) {
  return { seed: identitySeed(opening), songProfile: profileOf(opening), provisional: true };
}

/** Whether a song's look is still provisional: on its opening, or waiting
 *  for the whole-song identity's terrain to be ready. Exports wait for it. */
export function identityProvisional(data) {
  return !!(data?.opening || data?.identityPending);
}
