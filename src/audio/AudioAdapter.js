// Adapter: decoded AudioBuffer -> unified NoteEvent[] timeline + bar grid +
// continuous EnergyCurves (spec §1.2). Produces the exact same shapes the
// MIDI adapter does, so the two inputs are indistinguishable downstream.
//
// The parity pass: melody/bass events carry REAL pitches (FFT peak
// tracking + bass autocorrelation, see PitchTracker.js) and real sustain
// lengths, and sustained harmony is emitted as per-bar PAD chord events --
// so every pitch consumer (Midasus's vertical dance, Broshi's hop heights,
// VibeDirector's valence/tonic, KeyDirector's key changes, the biome
// fingerprint's dominant-class hue) behaves the same as it does on MIDI.
// The adapter also returns an `analysis` fingerprint (chroma, tonality,
// brightness, dynamic range, stereo width) for the custom-biome importer.
import { bandRenderConcurrency, separateStemsPooled } from './StemSeparator.js';
import { computePitchFeaturesOffThread } from './PitchWorkerClient.js';
import { BANDS } from './bands.js';
import {
  bandEnvelope, bandEnvelopeAsync, envelopeFrameCount, normalizeBands, detectRhythmOnsets, estimateTempo,
  extractPseudoLane, mixBandEnvelopes, estimateSustainMs, globalBandReferences,
  buildDriftAwareBarGrid,
} from './OnsetDetector.js';
import {
  chromaHistogram, melodyPitchAt, estimateBassPitchAt,
  tonalityFrom, tonalityTimeline, meanBrightness, brightnessAt, windowChroma,
} from './PitchTracker.js';
import { throwIfAborted } from './loadLimits.js';
import { createYielder } from '../utils/yieldToMain.js';
import { EnergyCurves } from './EnergyCurves.js';
import { summarizeRhythmOnsets } from './RhythmProfile.js';
import { analyzeStructureOffThread } from './StructureWorkerClient.js';
import { sectionPacing } from './sectionBudget.js';
import { Role, makeNoteEvent, sortNoteEvents } from '../core/NoteEvent.js';
import { Lane, melodyLaneForNote, laneForStemName, delegateByStemActivity } from '../core/Casting.js';
import { clamp01 } from '../utils/math.js';
import { buildSongProfile } from './SongProfile.js';

/** Channel views for phase-safe analysis. Keep channels separate until an
 * algorithm explicitly combines their energy; a signed L+R mix can erase a
 * deliberately wide, phase-inverted source. */
function channelArrays(audioBuffer) {
  const chans = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));
  return chans.length ? chans : [new Float32Array(audioBuffer.length)];
}

/** Stereo width 0..1 from L/R decorrelation (0 = mono, 1 = fully decorrelated). */
function stereoWidth(audioBuffer) {
  if (audioBuffer.numberOfChannels < 2) return 0;
  const L = audioBuffer.getChannelData(0), R = audioBuffer.getChannelData(1);
  const stride = Math.max(1, Math.floor(audioBuffer.length / 200000)); // cap the work on long files
  let sLR = 0, sLL = 0, sRR = 0;
  for (let i = 0; i < audioBuffer.length; i += stride) {
    sLR += L[i] * R[i]; sLL += L[i] * L[i]; sRR += R[i] * R[i];
  }
  const denom = Math.sqrt(sLL * sRR);
  if (denom < 1e-9) return 0;
  return clamp01(1 - sLR / denom);
}

/** Dynamic range 0..1 from loudness-envelope percentiles: how far the
 *  quiet passages sit below the loud ones (compressed wall-of-sound -> 0). */
function dynamicRange(rawBands) {
  const n = rawBands[0].length;
  const loud = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const b of rawBands) s += b[i];
    loud[i] = s;
  }
  const sorted = Array.from(loud).sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(n - 1, Math.floor(q * n))];
  const hi = p(0.90);
  if (hi < 1e-9) return 0;
  return clamp01(1 - p(0.25) / hi);
}

/** Coarse loudness-over-time of one decoded buffer: mean per-sample RMS
 * across channels. Accepts a historic mono array or a channel array, and is
 * deliberately phase-safe because it is the stem-vote's ballot. */
export function activityEnvelope(samples, sampleRate, rate = 86, signal = null) {
  const chans = Array.isArray(samples) ? samples : [samples];
  const length = chans.reduce((min, ch) => Math.min(min, ch?.length ?? 0), Infinity);
  if (!Number.isFinite(length) || length <= 0) return new Float32Array(1);
  const hop = Math.max(1, Math.round(sampleRate / rate));
  const n = Math.max(1, Math.ceil(length / hop));
  const env = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    throwIfAborted(signal);
    const from = f * hop, to = Math.min(length, from + hop);
    let s = 0;
    for (let i = from; i < to; i++) {
      let power = 0;
      for (const ch of chans) {
        const x = ch?.[i] || 0;
        power += x * x;
      }
      s += Math.sqrt(power / Math.max(1, chans.length));
    }
    env[f] = to > from ? s / (to - from) : 0;
  }
  return env;
}

/**
 * @param {AudioBuffer} audioBuffer  the full mix (when the user dropped
 *   separate stems, main.js sums them into one buffer first -- the mix is
 *   the master clock and the analysis subject either way)
 * @param {Array<{name: string, buffer: AudioBuffer}>} [opts.userStems]
 *   the individual stem files as dropped, when there were several: their
 *   FILENAMES cast the characters (Casting.laneForStemName) and their
 *   per-moment loudness decides which stem owns each melodic/bass note.
 */
export async function audioToTimeline(audioBuffer, {
  onProgress = null, userStems = null, groove = null, signal = null, cooperative = false,
} = {}) {
  throwIfAborted(signal);
  // Cooperative: the analysis runs while a song is already playing (the
  // whole-song pass behind an opening, OpeningAnalysis.js), so its main-
  // thread work pauses for the browser every few milliseconds instead of
  // holding frames. Same computation, same result; it only takes turns.
  const maybeYield = cooperative ? createYielder(8) : async () => false;
  // Stream the 7 bands one at a time rather than holding all of them fully
  // decoded at once (~565MB for a 4-minute 44.1kHz song, held simultaneously
  // by the old separateStems+computeBandEnvelopes pairing) -- everything
  // past this point needs only each band's compact envelope, not the raw
  // audio. The one exception is the BASS band, whose actual samples feed
  // estimateBassPitchAt's autocorrelation later; that one buffer's channel
  // data is kept, every other band's buffer is released as soon as its
  // envelope is extracted.
  let rate, numFrames, bassChannels = null;
  const raw = new Array(BANDS.length);
  // The pitch pass needs only the mix, so it starts now, in a worker, and
  // runs while the bands render instead of after them.
  const mixChannels = channelArrays(audioBuffer);
  const pitchPromise = computePitchFeaturesOffThread(mixChannels, audioBuffer.sampleRate, { signal });
  // Settled either way before anything below can throw, so an abort or a
  // failed band never leaves an unhandled rejection behind.
  pitchPromise.catch(() => {});
  await separateStemsPooled(audioBuffer, async (i, buf) => {
    if (numFrames === undefined) ({ numFrames, rate } = envelopeFrameCount(buf.length, buf.sampleRate));
    raw[i] = cooperative ? await bandEnvelopeAsync(buf, numFrames, maybeYield) : bandEnvelope(buf, numFrames);
    if (i === 1) bassChannels = channelArrays(buf); // the BASS band: 60-250 Hz, already isolated
  }, (p) => onProgress?.({ phase: 'separate', progress: p }), signal, bandRenderConcurrency({
    length: audioBuffer.length,
    channels: audioBuffer.numberOfChannels,
    deviceMemoryGb: typeof navigator !== 'undefined' ? navigator.deviceMemory : null,
  }));
  throwIfAborted(signal);
  onProgress?.({ phase: 'analyze', progress: 0 });

  await maybeYield();
  const normBands = normalizeBands(raw, rate);
  throwIfAborted(signal);
  await maybeYield();

  const { O, onsets: rhythmOnsets } = detectRhythmOnsets(normBands, raw, rate, 1, groove);
  const kickFrames = rhythmOnsets.filter((o) => o.kick).map((o) => o.frame);
  await maybeYield();
  const tempo = estimateTempo(O, rate, kickFrames);
  throwIfAborted(signal);
  await maybeYield();

  // Real pitch analysis on the actual samples: FFT peak tracking over the
  // full mix for melody/harmony, autocorrelation over the bass stem (FFT
  // bins are far too coarse below ~100 Hz to separate semitones).
  onProgress?.({ phase: 'pitch', progress: 0 });
  const pitchFeatures = await pitchPromise;
  throwIfAborted(signal);

  await maybeYield();
  const melodyLane = extractPseudoLane(normBands, rate, {
    bandIndices: [2, 3, 4], pitchLo: 60, pitchHi: 96, role: Role.MELODY, onsetThreshold: 1, rawBands: raw,
  });
  await maybeYield();
  const bassLane = extractPseudoLane(normBands, rate, {
    bandIndices: [0, 1], pitchLo: 28, pitchHi: 52, role: Role.BASS, onsetThreshold: 1, rawBands: raw,
  });
  const melodyMix = mixBandEnvelopes(normBands, [2, 3, 4]);
  const bassMix = mixBandEnvelopes(normBands, [0, 1]);

  const timeline = [];
  for (const o of rhythmOnsets) {
    timeline.push(makeNoteEvent({
      tMs: o.tMs, durMs: 90, pitch: o.pitch, vel: o.vel, role: Role.RHYTHM, kick: o.kick, src: 'audio', channel: 0,
    }));
  }
  for (const n of melodyLane) {
    await maybeYield();
    const tracked = melodyPitchAt(pitchFeatures, n.tMs, { returnEstimate: true });
    const pitch = tracked?.pitch ?? n.pitch;
    // Casting inside one mixed file: no track names exist, but the spectrum
    // does -- a note whose centroid rides far above its own fundamental is
    // a driven/synth lead (Midio's line), one that stays near it is a clean
    // instrument (Midasus's line). See melodyLaneForNote.
    timeline.push(makeNoteEvent({
      tMs: n.tMs, durMs: estimateSustainMs(melodyMix, rate, n.frame), pitch,
      vel: n.vel, role: Role.MELODY, src: 'audio', channel: 3,
      lane: melodyLaneForNote(pitch, brightnessAt(pitchFeatures, n.tMs)),
      pitchProvenance: tracked == null ? 'inferred' : 'tracked', pitchConfidence: tracked?.confidence ?? 0,
    }));
  }
  for (const n of bassLane) {
    await maybeYield();
    const tracked = estimateBassPitchAt(bassChannels || mixChannels, audioBuffer.sampleRate, n.tMs, { returnEstimate: true });
    timeline.push(makeNoteEvent({
      tMs: n.tMs, durMs: estimateSustainMs(bassMix, rate, n.frame), pitch: tracked?.pitch ?? n.pitch,
      vel: n.vel, role: Role.BASS, src: 'audio', channel: 1, lane: Lane.BROSHI,
      pitchProvenance: tracked == null ? 'inferred' : 'tracked', pitchConfidence: tracked?.confidence ?? 0,
    }));
  }

  const durationMs = (raw[0].length / rate) * 1000;

  // tempo.firstBarMs is already the first downbeat at/after t=0 (spec §1.2.5).
  // Walked with each window's own locally re-estimated period (tempo.curve)
  // rather than one period extrapolated across the whole song: a fixed
  // period accumulates drift error linearly with duration, and a live or
  // acoustic take not tracked to a click routinely drifts past what a rigid
  // grid can absorb. tempo.beatsPerBar carries a detected 3/4 (see
  // estimateTempo's meter search) instead of assuming 4/4 unconditionally.
  const barGrid = tempo.freeTime
    ? []
    : buildDriftAwareBarGrid(tempo.firstBarMs, durationMs, tempo.beatsPerBar, rate, tempo.curve, tempo.tau);

  // PAD chords: each bar's sustained harmonic content collapsed to its
  // strongest pitch classes and emitted as long chord tones -- the same
  // material a MIDI pad track would carry. Feeds VibeDirector's tonality
  // window, the composer strip, and the fingerprint's role mix. Free-time
  // audio chords on a fixed 2s pseudo-bar instead.
  // Stem-vote casting: filenames name the lanes, live loudness assigns the
  // notes. Runs after the single-file heuristic above so any note no stem
  // is audibly playing keeps its spectral verdict as the fallback.
  let stemsSummary = null;
  if (userStems && userStems.length > 1) {
    const voters = userStems.map(({ name, buffer }) => ({
      name,
      lane: laneForStemName(name),
      env: activityEnvelope(channelArrays(buffer), buffer.sampleRate, rate, signal),
    }));
    delegateByStemActivity(timeline, voters, rate);
    stemsSummary = voters.map(({ name, lane }) => ({ name, lane }));
  }

  const chordWindows = [];
  if (barGrid.length > 0) {
    for (let i = 0; i < barGrid.length; i++) {
      chordWindows.push([barGrid[i].ms, i + 1 < barGrid.length ? barGrid[i + 1].ms : durationMs]);
    }
  } else {
    for (let t = 0; t < durationMs; t += 2000) chordWindows.push([t, Math.min(durationMs, t + 2000)]);
  }
  const midMix = mixBandEnvelopes(normBands, [2, 3]);
  for (const [fromMs, toMs] of chordWindows) {
    await maybeYield();
    const chord = windowChroma(pitchFeatures, fromMs, toMs, 3);
    if (chord.length < 2) continue; // a lone class is a melody note's residue, not harmony
    const frame = Math.min(midMix.length - 1, Math.round((fromMs / 1000) * rate));
    const vel = clamp01(0.25 + 0.5 * midMix[frame]);
    for (const c of chord) {
      timeline.push(makeNoteEvent({
        tMs: fromMs, durMs: Math.max(300, (toMs - fromMs) * 0.9), pitch: 60 + c.pc,
        vel: vel * (0.6 + 0.4 * c.strength), role: Role.PAD, src: 'audio', channel: 2, pitchProvenance: 'synthetic', pitchConfidence: 0,
      }));
    }
  }
  throwIfAborted(signal);
  sortNoteEvents(timeline);

  // EnergyCurves must carry the song's TRUE relative loudness, not
  // normBands' per-band AGC (release tau=4s) -- an AGC'd quiet intro decays
  // its own follower down to the intro's peak and reads full-scale, while a
  // loud chorus normalizes against ITS OWN peak too, so nothing downstream
  // (CalmDirector, HypeDirector, the section/biome schedule, the mountain
  // groove, VibeDirector.epic, OrogenyDirector's climax finder...) can ever
  // tell the intro was quiet or the chorus was loud. normBands stays the
  // detection domain (onsets/pseudo-lanes/sustains want that local
  // contrast); this is the one place "how loud RIGHT NOW, relative to the
  // whole song" actually needs to be answered honestly.
  await maybeYield();
  const refBands = globalBandReferences(raw);
  const energyCurves = new EnergyCurves(durationMs, rate);
  energyCurves.rmsBands = raw.map(b => Float32Array.from({ length: energyCurves.n }, (_,i) => b[Math.min(b.length - 1,i)]));
  for (let i = 0; i < energyCurves.n; i++) {
    const frame = Math.min(raw[0].length - 1, i);
    energyCurves.setFrame(i, raw.map((b, bi) => clamp01((b[frame] ?? 0) / refBands[bi])));
  }

  // The song's analysis fingerprint: whole-song tonality + texture stats
  // the custom-biome importer turns into this file's unique world.
  await maybeYield();
  const chroma = chromaHistogram(pitchFeatures);
  const tonality = tonalityFrom(chroma);
  const keyTimeline = tonalityTimeline(pitchFeatures, { durationMs });
  const analysis = {
    chroma,
    tonic: tonality.tonic,
    mode: tonality.mode,
    majorness: tonality.majorness,
    tonalConfidence: tonality.confidence,
    brightness: meanBrightness(pitchFeatures),
    dynamicRange: dynamicRange(raw),
    stereoWidth: stereoWidth(audioBuffer),
    rhythm: summarizeRhythmOnsets(rhythmOnsets, durationMs, tempo),
  };

  // Song structure (StructureAnalyzer): a beat-synchronous chroma+timbre
  // self-similarity matrix, Foote novelty for the boundaries and a repetition
  // pass for the labels. Reuses the pitchFeatures FFT already computed above,
  // so it costs one matrix and no new analysis. BiomeManager prefers this
  // over its own band-energy novelty when the confidence clears its floor,
  // and falls back otherwise. MIDI and the demo timeline never reach here;
  // free-time audio does, via the even-step fallback grid below.
  const structurePoints = barGrid.length >= 8
    ? barGrid.map((b) => b.ms)
    : (() => { const p = []; for (let t = 0; t < durationMs; t += 2000) p.push(t); return p; })();
  // Section pacing follows musical bars when a credible bar grid exists. A
  // fixed seconds-only gap makes a 70 BPM ballad and a 180 BPM dance track
  // express different numbers of phrases for no musical reason; free-time
  // recordings retain the time-based fallback.
  const pacing = sectionPacing({
    durationMs,
    pointCount: structurePoints.length,
    barSynchronous: barGrid.length >= 8,
  });
  await maybeYield();
  const structure = await analyzeStructureOffThread({
    pointsMs: structurePoints, pitchFeatures, energyCurves, durationMs,
    minGapMs: pacing.minGapMs,
    minGapPoints: pacing.minGapPoints,
    maxCuts: pacing.maxCuts,
  }, { signal });
  throwIfAborted(signal);

  onProgress?.({ phase: 'done', progress: 1 });

  return {
    timeline, barGrid, durationMs,
    firstBarMs: tempo.firstBarMs,
    localTempo: (tempo.curve || []).map(c => ({ tMs: c.startFrame / rate * 1000, beatPeriodMs: c.tau / rate * 1000, confidence: c.confidence, firstBeatMs: c.phaseFrame / rate * 1000, phaseConfidence: c.phaseConfidence })),
    phaseConfidence: tempo.phaseConfidence, downbeatConfidence: tempo.downbeatConfidence, meterConfidence: tempo.meterConfidence,
    bpm: tempo.bpm, beatPeriodMs: tempo.beatPeriodMs, confidence: tempo.confidence, freeTime: tempo.freeTime,
    energyCurves, analysis, tonalityTimeline: keyTimeline, structure, stems: stemsSummary,
    songProfile: buildSongProfile({
      timeline, barGrid, durationMs,
      phaseConfidence: tempo.phaseConfidence, downbeatConfidence: tempo.downbeatConfidence, meterConfidence: tempo.meterConfidence,
      bpm: tempo.bpm, beatPeriodMs: tempo.beatPeriodMs, confidence: tempo.confidence, freeTime: tempo.freeTime,
      energyCurves, analysis, structure,
    }),
  };
}
