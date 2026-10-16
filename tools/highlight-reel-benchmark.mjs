import { performance } from 'node:perf_hooks';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { buildHighlightCandidates } from '../src/render/HighlightReel.js';

const results = [];
for (const durationMs of [300000, 1200000]) {
  for (const profile of ['quiet', 'contrast', 'eight-cues']) {
    const energyCurves = new EnergyCurves(durationMs);
    for (let frame = 0; frame < energyCurves.n; frame++) {
      const timeMs = frame * 1000 / energyCurves.rateHz;
      const value = profile === 'contrast' && timeMs % 15000 >= 8000 ? .95 : .1;
      for (const band of energyCurves.bands) band[frame] = value;
    }
    const evidence = { durationMs, energyCurves,
      cues: profile === 'eight-cues' ? Array.from({ length: 8 }, (_, i) => ({
        id: `cue:${i}`, tMs: 5000 + i * 6000, kind: 'drop', value: 1 })) : [],
      timeline: [], finale: null };
    for (const run of ['cold', 'warm']) {
      const stats = {}, started = performance.now();
      const candidates = buildHighlightCandidates(evidence, stats);
      results.push({ minutes: durationMs / 60000, profile, run,
        constructionMs: Number((performance.now() - started).toFixed(3)), ...stats,
        eventTimesMs: candidates.map(event => event.eventAtMs) });
    }
  }
}
console.log(JSON.stringify(results, null, 2));
