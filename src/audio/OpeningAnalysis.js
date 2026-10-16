// Start a long song on its opening, finish analysing it while it plays.
//
// Analysing a whole song before the world picker appears takes time in
// proportion to its length -- about 3.8s for five minutes on a fast desktop,
// more on a phone. So a song long enough to matter is analysed in two passes:
// its first OPENING_SECONDS, which is enough to recommend a world and start
// playing in well under a second, and then the whole song, in the
// background. When the whole-song analysis lands, the song's data is
// upgraded in place (adoptFullAnalysis) and a song already playing is
// rebuilt at the moment it has reached, with the music left running.
//
// A song's LOOK -- its seed, the profile its world is tailored and its
// ranges matched from, its custom biome -- comes from the opening pass and
// stays put. Swapping it at the upgrade would repaint the world mid-song,
// and deriving it from the whole song on a later play would make a song look
// different the second time. So it is kept as `songIdentity` and cached with
// the analysis (AnalysisBundle), and every later play reuses it.

export const OPENING_SECONDS = 15;
// Below this the whole song analyses about as fast as its opening would.
export const MIN_SECONDS_FOR_OPENING = 30;

/** Whether this load should start on its opening. Stem drops and bulk export
 *  analyse the whole song first: stems need every file's full length to cast
 *  source lanes, and an export must render frame one from final data. */
export function useOpeningAnalysis({ durationSec = 0, stemDrop = false, exporting = false, rangeListening = false } = {}) {
  return !stemDrop && !exporting && durationSec >= MIN_SECONDS_FOR_OPENING;
}

/**
 * The first `seconds` of `buffer` as a new AudioBuffer. `make` builds the
 * empty buffer (the browser's AudioBuffer constructor by default), so tests
 * can supply their own.
 */
export function sliceAudioBuffer(buffer, seconds, make = (opts) => new AudioBuffer(opts)) {
  const length = Math.min(buffer.length, Math.max(1, Math.round(seconds * buffer.sampleRate)));
  const out = make({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(0, length), c);
  }
  return out;
}

/** The bar grid carried on past the analysed opening at its own recent bar
 *  length, so beat-locked motion keeps its pulse if the whole-song analysis
 *  is still running when the opening runs out (a slow phone). */
export function extendBarGrid(barGrid, toMs) {
  if (!Array.isArray(barGrid) || barGrid.length < 2) return barGrid;
  const recent = barGrid.slice(-9);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) gaps.push(recent[i].ms - recent[i - 1].ms);
  gaps.sort((a, b) => a - b);
  const barMs = gaps[gaps.length >> 1];
  if (!(barMs > 0)) return barGrid;
  const out = barGrid.slice();
  let last = out[out.length - 1];
  while (last.ms + barMs < toMs) {
    const numerator = last.numerator || 4;
    last = {
      ...last,
      ms: last.ms + barMs,
      tick: (last.tick ?? (out.length - 1) * numerator) + numerator,
      ...(Number.isInteger(last.index) ? { index: last.index + 1 } : {}),
    };
    out.push(last);
  }
  return out;
}

/**
 * The opening's analysis, stretched to stand for the whole song until the
 * real one arrives: the song's true length (so the arc, the sections' pacing
 * and the ending are proportioned right), and its bar grid carried on. The
 * energy curves are left at the opening's length; EnergyCurves holds its last
 * value past its end, where zeros would read as a sudden silence.
 */
export function asOpening(result, fullDurationMs) {
  return {
    ...result,
    durationMs: fullDurationMs,
    barGrid: extendBarGrid(result.barGrid, fullDurationMs),
    // songProfile stays the opening's own, built over the opening's length:
    // rebuilt against the song's length it would read the silence past the
    // opening as part of the song. It is what the world is chosen from.
    opening: {
      analyzedMs: result.durationMs, provisional: true,
      informative: !result.freeTime && (result.confidence ?? 0) >= .3,
      evidenceScope: 'opening',
    },
  };
}

/**
 * Upgrade `data` (the object the picker and the running song hold) in place
 * to the whole-song analysis. Everything the analysis produced is replaced;
 * what was built on top of it -- the song's identity, its world, its matched
 * ranges, its lyrics -- is not in `full` and so is left as it is.
 */
export function adoptFullAnalysis(data, full) {
  if (!data || !full) return data;
  // A cached whole-song analysis carries the identity it was first made
  // with; the song already has the same one, from the same opening.
  const analysis = { ...full };
  delete analysis.songIdentity;
  Object.assign(data, analysis);
  delete data.opening;
  return data;
}

/** Cheap whole-recording overview, independent of the slower note analysis.
 * Sample short windows throughout each bucket and combine channels in power
 * so stereo phase cancellation cannot turn audible music into silence. */
export function buildAudioOverview(buffer, count = 320) {
  const out = new Float32Array(count);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  let peak = 0;
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * buffer.length / count);
    const to = Math.floor((b + 1) * buffer.length / count);
    const windows = Math.min(64, to - from);
    let power = 0, n = 0;
    for (let w = 0; w < windows; w++) {
      const start = from + Math.floor(w * (to - from) / windows);
      const end = Math.min(to, start + 16);
      for (let i = start; i < end; i++) {
        for (const channel of channels) { const v = channel[i] || 0; power += v * v; n++; }
      }
    }
    out[b] = n ? Math.sqrt(power / n) : 0;
    peak = Math.max(peak, out[b]);
  }
  if (peak > 0) for (let i = 0; i < count; i++) out[i] /= peak;
  return out;
}
