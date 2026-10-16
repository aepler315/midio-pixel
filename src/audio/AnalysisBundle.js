// Everything the engine learned about a recording, in a form that can be
// stored, shipped, and handed back later instead of recomputed.
//
// Analysing a dropped song costs tens of seconds of separation, onset and
// pitch work, and the result is identical every time the same recording is
// analysed. This packs that result into a portable object keyed by an
// acoustic fingerprint, so the second play is instant -- and so the same
// artifact can one day be served from a database while the listener's own app
// plays the audio, which is the only way to get a composed show (a real arc,
// on-time sections, a climax in the right place) out of music this page is
// never allowed to touch.
//
// What is NOT in here, deliberately: any audio. A bundle is derived numbers
// only -- band envelopes, onset times, a chroma histogram. It cannot be
// played back or turned into a recording, which is what makes sharing one a
// different act from sharing the song.
//
// Two encoding decisions worth stating, because a naive JSON dump of this
// structure is roughly twenty times larger and would make the whole idea
// impractical to store or serve:
//
//   THE CURVES ARE QUANTIZED. `energyCurves` is seven float arrays at 50Hz --
//   for a four-minute song, 84,000 floats. They are all in 0..1 and every
//   consumer treats them as approximate, so they store as bytes. That is a
//   4x saving with a quantization step of 1/255, far below the precision
//   anything downstream acts on.
//
//   THE TIMELINE IS COLUMNAR. An array of note objects re-states every key
//   name for every note. Stored as parallel typed arrays -- all the times,
//   then all the pitches -- the field names are paid for once.
import { EnergyCurves } from './EnergyCurves.js';
import { ANALYSIS_REVISION } from './AnalysisRevision.js';
import { BANDS } from './bands.js';
import { Role } from '../core/NoteEvent.js';
import { Lane } from '../core/Casting.js';
import { buildSongProfile, snapshotSongProfile, PROFILE_VERSION, validSongProfileSnapshot } from './SongProfile.js';

/** Bump when the shape changes incompatibly. `unpackBundle` refuses a
 *  version it does not know rather than misreading it, because a bundle
 *  silently decoded under the wrong layout produces a show that is subtly,
 *  inexplicably wrong instead of an error anyone can act on. */
export const BUNDLE_VERSION = 4;

const ROLES = [Role.MELODY, Role.RHYTHM, Role.BASS, Role.PAD];
const LANES = [null, Lane.MIDASUS, Lane.MIDIO, Lane.BROSHI];

// --- base64 for typed arrays ----------------------------------------------
// Neither btoa nor Buffer exists in both a browser and node, and this module
// is used from both (the engine packs; the tests read).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

export function b64ToBytes(str) {
  const clean = String(str || '').replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

const packU32 = (arr) => bytesToB64(new Uint8Array(Uint32Array.from(arr).buffer));
const unpackU32 = (s) => {
  const bytes = b64ToBytes(s);
  // A copy rather than a view: the decoded bytes are not guaranteed to sit at
  // a 4-byte offset in their own buffer, and Uint32Array demands alignment.
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  return new Uint32Array(aligned.buffer, 0, Math.floor(aligned.length / 4));
};
const packF32 = (arr) => bytesToB64(new Uint8Array(Float32Array.from(arr).buffer));
const unpackF32 = (s) => {
  const bytes = b64ToBytes(s);
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  return new Float32Array(aligned.buffer, 0, Math.floor(aligned.length / 4));
};

/** 0..1 floats to bytes and back. The step is 1/255; nothing downstream acts
 *  on a difference that small. */
function quantize01(arr) {
  const out = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out[i] = v <= 0 || !Number.isFinite(v) ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return out;
}

/**
 * Pack an `audioToTimeline` result plus its identity into a storable object.
 *
 * @param {object} data the analysis, exactly as the adapter returned it
 * @param {object} meta
 * @param {object} meta.fingerprint from fingerprintBuffer()
 * @param {string} [meta.name] the dropped file's name, for display only
 * @param {object} [meta.identity] resolved artist/title, when known
 * @returns {object} JSON-serializable
 */
export function packBundle(data, { fingerprint, name = '', identity = null } = {}) {
  const curves = data.energyCurves;
  const timeline = data.timeline || [];
  const n = timeline.length;
  const tMs = new Float32Array(n), durMs = new Float32Array(n);
  const pitch = new Uint8Array(n), vel = new Uint8Array(n);
  // Role, the kick flag and the source all fit in one byte with room spare.
  const flags = new Uint8Array(n), channel = new Uint8Array(n), pan = new Int8Array(n), lane = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = timeline[i];
    tMs[i] = e.tMs; durMs[i] = e.durMs;
    pitch[i] = Math.max(0, Math.min(127, e.pitch | 0));
    vel[i] = Math.round(Math.max(0, Math.min(1, e.vel)) * 255);
    const roleIdx = Math.max(0, ROLES.indexOf(e.role));
    flags[i] = roleIdx | (e.kick ? 0x80 : 0);
    channel[i] = Math.max(0, Math.min(255, e.channel | 0));
    pan[i] = Math.round(Math.max(-1, Math.min(1, e.pan || 0)) * 127);
    lane[i] = Math.max(0, LANES.indexOf(e.lane));
  }

  return {
    v: BUNDLE_VERSION,
    key: fingerprint?.key || '',
    // The frames themselves, not just the key: a different rip of the same
    // master hashes to a different key, and only the sequence can be aligned
    // against it. This is also what makes a bundle locatable by sound alone.
    fpFrames: fingerprint?.frames ? packU32(fingerprint.frames) : '',
    fpFrameHz: fingerprint?.frameHz || 0,
    name,
    identity: identity ? { artist: identity.artist || '', title: identity.title || '' } : null,
    createdMs: Date.now(),

    analysisRevision: ANALYSIS_REVISION,
    durationMs: data.durationMs || 0,
    bpm: data.bpm || 0,
    beatPeriodMs: data.beatPeriodMs || 0,
    firstBarMs: data.firstBarMs ?? data.barGrid?.[0]?.ms ?? 0,
    localTempo: data.localTempo || [],
    phaseConfidence: data.phaseConfidence ?? 0,
    downbeatConfidence: data.downbeatConfidence ?? 0,
    meterConfidence: data.meterConfidence ?? 0,
    confidence: data.confidence ?? 0,
    freeTime: !!data.freeTime,
    // Restoring only bar times used to silently turn a detected 3/4 audio
    // grid back into 4/4. Keep meter and tick as well as the timestamps.
    barGrid: {
      ms: packF32((data.barGrid || []).map((b) => b.ms)),
      tick: packF32((data.barGrid || []).map((b, index) => b.tick ?? index * (b.numerator || 4))),
      numerator: bytesToB64(Uint8Array.from((data.barGrid || []).map((b) => b.numerator || 4))),
      denominator: bytesToB64(Uint8Array.from((data.barGrid || []).map((b) => b.denominator || 4))),
    },
    stems: data.stems || null,
    analysis: data.analysis || null,
    tonalityTimeline: Array.isArray(data.tonalityTimeline)
      ? data.tonalityTimeline
        .filter((k) => Number.isFinite(k?.tMs) && Number.isFinite(k?.tonic))
        .map((k) => ({
          tMs: k.tMs,
          tonic: ((Math.round(k.tonic) % 12) + 12) % 12,
          mode: k.mode === 'minor' ? 'minor' : 'major',
          majorness: Number.isFinite(k.majorness) ? k.majorness : 0,
          confidence: Number.isFinite(k.confidence) ? k.confidence : 0,
        }))
      : null,
    structure: data.structure
      ? {
        boundariesMs: packF32(data.structure.boundariesMs || []),
        boundaryStrengths: packF32(data.structure.boundaryStrengths || (data.structure.boundariesMs || []).map(() => 0)),
        fineBoundariesMs: packF32(data.structure.fineBoundariesMs || []),
        fineBoundaryStrengths: packF32(
          data.structure.fineBoundaryEvidence
            ? data.structure.fineBoundaryEvidence.map((b) => b?.strength ?? 0)
            : (data.structure.fineBoundariesMs || []).map(() => 0),
        ),
        boundaryEvidence: data.structure.boundaryEvidence || null,
        labels: data.structure.labels || [],
        confidence: data.structure.confidence ?? 0,
      }
      : null,

    curves: curves
      ? {
        rateHz: curves.rateHz,
        n: curves.n,
        bands: curves.bands.map((b) => bytesToB64(quantize01(b))),
        rmsBands: curves.rmsBands ? curves.rmsBands.map(packF32) : null,
        hasPhysicalRms: !!curves.rmsBands,
        units: { bands: 'normalized-activity', rmsBands: 'rms-amplitude', shares: 'squared-power' },
      }
      : null,

    notes: {
      count: n,
      provenance: timeline.map(e => e.pitchProvenance || (e.src === 'midi' ? 'authored' : e.role === Role.RHYTHM ? 'unpitched' : 'inferred')),
      pitchConfidence: timeline.map(e => e.pitchConfidence ?? (e.src === 'midi' ? 1 : 0)),
      source: timeline.map(e => e.src || 'audio'),
      tMs: packF32(tMs),
      durMs: packF32(durMs),
      pitch: bytesToB64(pitch),
      vel: bytesToB64(vel),
      flags: bytesToB64(flags),
      channel: bytesToB64(channel),
      pan: bytesToB64(new Uint8Array(pan.buffer, pan.byteOffset, pan.length)),
      lane: bytesToB64(lane),
    },
    // Optional. Current bundles may omit it; a mismatched
    // profile version is dropped so the caller rebuilds from the analysis.
    // Malformed snapshots at the current version reject the whole bundle.
    songProfile: (() => {
      try {
        const live = data.songProfile?.version === PROFILE_VERSION
          ? data.songProfile
          : buildSongProfile(data);
        return snapshotSongProfile(live);
      } catch {
        return null;
      }
    })(),
    // Optional. How the song LOOKS -- its seed, the profile its world is
    // tailored and its ranges matched from, its custom biome -- as first
    // made, from the song's opening when it started on one
    // (OpeningAnalysis.js), so every later play looks the same.
    songIdentity: (() => {
      const id = data.songIdentity;
      if (!id) return null;
      try {
        return {
          seed: Number.isFinite(id.seed) ? id.seed >>> 0 : null,
          songProfile: id.songProfile?.version === PROFILE_VERSION ? snapshotSongProfile(id.songProfile) : null,
          customBiome: id.customBiome ? JSON.parse(JSON.stringify(id.customBiome)) : null,
        };
      } catch {
        return null;
      }
    })(),
  };
}

/**
 * Rebuild an analysis from a bundle.
 *
 * The result is shaped exactly like `audioToTimeline`'s return, so every
 * caller downstream is unchanged -- that equivalence is the whole point, and
 * `test/analysisBundle.test.js` pins it by round-tripping a real analysis.
 *
 * @returns {object|null} null when the bundle is unreadable (wrong version,
 *   truncated, hand-edited) -- the caller then analyses from scratch, which
 *   is slow but always correct.
 */
export function unpackBundle(bundle) {
  if (!bundle || bundle.v !== BUNDLE_VERSION || bundle.analysisRevision !== ANALYSIS_REVISION) return null;
  try {
    const encoded = (value, byteLength = null) => typeof value === 'string'
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
      && (byteLength == null || b64ToBytes(value).length === byteLength);
    const ordered = (values, max, strict = false) => Array.from(values).every((v,i) => Number.isFinite(v) && v >= 0 && v <= max && (!i || (strict ? v > values[i-1] : v >= values[i-1])));
    const duration = bundle.durationMs;
    for (const snapshot of [bundle.songProfile,bundle.songIdentity?.songProfile]) {
      if (snapshot?.version === PROFILE_VERSION && !validSongProfileSnapshot(snapshot)) return null;
    }
    if (['phaseConfidence', 'downbeatConfidence', 'meterConfidence'].some(k => !Number.isFinite(bundle[k]) || bundle[k] < 0 || bundle[k] > 1)) return null;
    if (!Number.isFinite(bundle.firstBarMs) || bundle.firstBarMs < 0 || bundle.firstBarMs > duration) return null;
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(bundle.bpm) || !Number.isFinite(bundle.beatPeriodMs) || !Number.isFinite(bundle.confidence)) return null;
    if (!encoded(bundle.barGrid?.ms) || b64ToBytes(bundle.barGrid.ms).length % 4) return null;
    const barCount = b64ToBytes(bundle.barGrid.ms).length / 4;
    if (!encoded(bundle.barGrid.tick, barCount * 4) || !encoded(bundle.barGrid.numerator, barCount) || !encoded(bundle.barGrid.denominator, barCount)) return null;
    if (!ordered(unpackF32(bundle.barGrid.ms), duration, true) || !ordered(unpackF32(bundle.barGrid.tick), Infinity, true)) return null;
    if (bundle.localTempo && (!Array.isArray(bundle.localTempo) || !ordered(bundle.localTempo.map(t => t.tMs), duration) || bundle.localTempo.some(t => !Number.isFinite(t.beatPeriodMs) || t.beatPeriodMs <= 0 || !Number.isFinite(t.confidence) || t.firstBeatMs != null && !Number.isFinite(t.firstBeatMs) || t.phaseConfidence != null && (!Number.isFinite(t.phaseConfidence) || t.phaseConfidence < 0 || t.phaseConfidence > 1)))) return null;
    if (bundle.tonalityTimeline && (!Array.isArray(bundle.tonalityTimeline) || !ordered(bundle.tonalityTimeline.map(k => k.tMs), duration) || bundle.tonalityTimeline.some(k => !Number.isFinite(k.tonic) || k.tonic < 0 || k.tonic > 11 || !['major','minor'].includes(k.mode) || !Number.isFinite(k.confidence)))) return null;
    if (bundle.curves) {
      const c = bundle.curves;
      if (!Number.isFinite(c.rateHz) || c.rateHz <= 0 || !Number.isInteger(c.n) || c.n !== Math.max(2, Math.ceil(duration / 1000 * c.rateHz) + 1) || !Array.isArray(c.bands) || c.bands.length !== 7 || c.bands.some(b => !encoded(b,c.n))) return null;
      if (typeof c.hasPhysicalRms !== 'boolean' || c.hasPhysicalRms !== !!c.rmsBands) return null;
      if (c.rmsBands && (!Array.isArray(c.rmsBands) || c.rmsBands.length !== 7 || c.rmsBands.some(b => !encoded(b,c.n * 4) || Array.from(unpackF32(b)).some(v => !Number.isFinite(v) || v < 0)))) return null;
    }
    if (bundle.structure) {
      const st = bundle.structure;
      if (!encoded(st.boundariesMs) || b64ToBytes(st.boundariesMs).length % 4 || !encoded(st.fineBoundariesMs) || b64ToBytes(st.fineBoundariesMs).length % 4) return null;
      const starts = unpackF32(st.boundariesMs), fine = unpackF32(st.fineBoundariesMs);
      if (!starts.length || starts[0] !== 0 || !ordered(starts, duration, true) || starts.at(-1) >= duration || !ordered(fine, duration, true) || !Array.isArray(st.labels) || st.labels.length !== starts.length || st.labels.some(l => !['number','string'].includes(typeof l) || typeof l === 'number' && !Number.isFinite(l)) || !Number.isFinite(st.confidence)) return null;
      if (!encoded(st.boundaryStrengths, starts.length * 4) || !encoded(st.fineBoundaryStrengths, fine.length * 4) || [...unpackF32(st.boundaryStrengths),...unpackF32(st.fineBoundaryStrengths)].some(v => !Number.isFinite(v) || v < 0 || v > 1)) return null;
      if (st.boundaryEvidence && (!Array.isArray(st.boundaryEvidence) || st.boundaryEvidence.length !== starts.length || st.boundaryEvidence.some((e,i) => !Number.isFinite(e.timeMs) || Math.abs(e.timeMs - starts[i]) > .1 || !Number.isFinite(e.strength)))) return null;
    }
    const count = bundle.notes?.count;
    if (!Number.isInteger(count) || count < 0) return null;
    for (const field of ['tMs','durMs','pitch','vel','flags','channel','pan','lane']) {
      if (!encoded(bundle.notes[field], count * (['tMs','durMs'].includes(field) ? 4 : 1))) return null;
    }
    if (!ordered(unpackF32(bundle.notes.tMs), duration) || Array.from(unpackF32(bundle.notes.durMs)).some(v => !Number.isFinite(v) || v < 0)) return null;
    if (['provenance','pitchConfidence','source'].some(field => !Array.isArray(bundle.notes[field]) || bundle.notes[field].length !== count)) return null;
    if (bundle.notes.provenance.some(p => !['authored','tracked','inferred','synthetic','unpitched'].includes(p)) || bundle.notes.pitchConfidence.some(c => !Number.isFinite(c) || c < 0 || c > 1) || bundle.notes.source.some(p => !['audio','midi'].includes(p))) return null;
    if (Array.from(b64ToBytes(bundle.notes.flags)).some(f => (f & 0x7f) >= ROLES.length) || Array.from(b64ToBytes(bundle.notes.pitch)).some(p => p > 127) || Array.from(b64ToBytes(bundle.notes.lane)).some(l => l >= LANES.length)) return null;
    const barMs = unpackF32(bundle.barGrid?.ms || '');
    const barTicks = unpackF32(bundle.barGrid?.tick || '');
    const numerators = b64ToBytes(bundle.barGrid?.numerator || '');
    const denominators = b64ToBytes(bundle.barGrid?.denominator || '');
    const barGrid = Array.from(barMs, (ms, index) => ({
      ms,
      index,
      tick: barTicks[index] ?? index * (numerators[index] || 4),
      numerator: numerators[index] || 4,
      denominator: denominators[index] || 4,
    }));

    let energyCurves = null;
    if (bundle.curves) {
      energyCurves = new EnergyCurves(1, bundle.curves.rateHz || 50);
      energyCurves.n = bundle.curves.n;
      energyCurves.bands = bundle.curves.bands.map((s) => {
        const bytes = b64ToBytes(s);
        const out = new Float32Array(bundle.curves.n);
        for (let i = 0; i < out.length; i++) out[i] = (bytes[i] || 0) / 255;
        return out;
      });
      energyCurves.rmsBands = bundle.curves.rmsBands ? bundle.curves.rmsBands.map(unpackF32) : null;
      energyCurves._calCache = new Map();
    }

    const nt = bundle.notes?.count || 0;
    const tMs = unpackF32(bundle.notes?.tMs || '');
    const durMs = unpackF32(bundle.notes?.durMs || '');
    const pitch = b64ToBytes(bundle.notes?.pitch || '');
    const vel = b64ToBytes(bundle.notes?.vel || '');
    const flags = b64ToBytes(bundle.notes?.flags || '');
    const channel = b64ToBytes(bundle.notes?.channel || '');
    const panBytes = b64ToBytes(bundle.notes?.pan || '');
    const lane = b64ToBytes(bundle.notes?.lane || '');
    if (!Number.isInteger(nt) || nt < 0 ||
      tMs.length < nt || durMs.length < nt || pitch.length < nt || vel.length < nt ||
      flags.length < nt || channel.length < nt || panBytes.length < nt || lane.length < nt) {
      return null;
    }
    const timeline = new Array(nt);
    for (let i = 0; i < nt; i++) {
      const pan8 = panBytes[i] > 127 ? panBytes[i] - 256 : panBytes[i];
      timeline[i] = {
        tMs: tMs[i], durMs: durMs[i], pitch: pitch[i], vel: vel[i] / 255,
        role: ROLES[flags[i] & 0x7f] || Role.MELODY,
        kick: !!(flags[i] & 0x80),
        pitchProvenance: bundle.notes.provenance[i], pitchConfidence: bundle.notes.pitchConfidence[i],
        src: bundle.notes.source[i], channel: channel[i], pan: (pan8 || 0) / 127, program: -1, lane: LANES[lane[i]] || null,
      };
    }

    return {
      timeline, barGrid,
      durationMs: bundle.durationMs || 0,
      firstBarMs: bundle.firstBarMs ?? 0,
      localTempo: bundle.localTempo || [],
      bpm: bundle.bpm || 0,
      beatPeriodMs: bundle.beatPeriodMs || 0,
      phaseConfidence: bundle.phaseConfidence,
      downbeatConfidence: bundle.downbeatConfidence,
      meterConfidence: bundle.meterConfidence,
      confidence: bundle.confidence ?? 0,
      freeTime: !!bundle.freeTime,
      energyCurves,
      analysis: bundle.analysis || null,
      tonalityTimeline: Array.isArray(bundle.tonalityTimeline) ? bundle.tonalityTimeline.map((k) => ({ ...k })) : null,
      structure: bundle.structure
        ? (() => {
          const boundariesMs = Array.from(unpackF32(bundle.structure.boundariesMs || ''));
          const boundaryStrengths = Array.from(unpackF32(bundle.structure.boundaryStrengths || ''));
          const fineBoundariesMs = Array.from(unpackF32(bundle.structure.fineBoundariesMs || ''));
          const fineBoundaryStrengths = Array.from(unpackF32(bundle.structure.fineBoundaryStrengths || ''));
          return {
            boundariesMs,
            boundaryStrengths,
            boundaryEvidence: bundle.structure.boundaryEvidence || boundariesMs.map((timeMs, index) => ({
              timeMs,
              strength: boundaryStrengths[index] ?? 0,
              source: index === 0 ? 'start' : 'ssm',
              scale: 'coarse',
            })),
            fineBoundariesMs,
            fineBoundaryEvidence: fineBoundariesMs.map((timeMs, index) => ({
              timeMs,
              strength: fineBoundaryStrengths[index] ?? 0,
              source: 'ssm',
              scale: 'fine',
            })),
            labels: bundle.structure.labels || [],
            // A restored bundle carries no novelty curve: nothing reads it
            // after the boundaries are chosen, and it is the largest array in
            // the structure for no downstream benefit.
            novelty: [],
            cutIndices: [],
            confidence: bundle.structure.confidence ?? 0,
          };
        })()
        : null,
      stems: bundle.stems || null,
      songProfile: bundle.songProfile?.version === PROFILE_VERSION ? bundle.songProfile : null,
      songIdentity: bundle.songIdentity
        ? {
          seed: Number.isFinite(bundle.songIdentity.seed) ? bundle.songIdentity.seed >>> 0 : null,
          // A profile from another profile version is dropped; the world is
          // then chosen from the song's own profile, as for an old bundle.
          songProfile: bundle.songIdentity.songProfile?.version === PROFILE_VERSION ? bundle.songIdentity.songProfile : null,
          customBiome: bundle.songIdentity.customBiome || null,
        }
        : null,
      /** Set so the rest of the app can tell a restored analysis from a fresh
       *  one -- for the progress copy, and so a bug here is attributable. */
      fromBundle: true,
    };
  } catch {
    return null;
  }
}

/** The fingerprint frames a bundle was keyed by, for alignment. */
export function bundleFrames(bundle) {
  return bundle?.fpFrames ? unpackU32(bundle.fpFrames) : new Uint32Array(0);
}
