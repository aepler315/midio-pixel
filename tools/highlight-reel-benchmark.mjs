// Construction cost of the color-regime highlight schedule for long songs.
import { performance } from 'node:perf_hooks';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { buildHighlightCandidates } from '../src/render/HighlightReel.js';
import { compileStorm } from '../src/world/alpine/RangeStorm.js';
import { songSkyClock } from '../src/world/DayNight.js';

const results = [];
for (const durationMs of [300000, 1200000]) {
  for (const profile of ['quiet', 'contrast', 'squall']) {
    const energyCurves = new EnergyCurves(durationMs);
    for (let frame = 0; frame < energyCurves.n; frame++) {
      const timeMs = frame * 1000 / energyCurves.rateHz;
      const value = profile !== 'quiet' && timeMs % 60000 >= 40000 ? .95 : .1;
      for (const band of energyCurves.bands) band[frame] = value;
    }
    const timeline = profile === 'squall' ? Array.from({ length: Math.floor(durationMs / 500) }, (_, i) => ({
      tMs: i * 500, role: 'RHYTHM', pitch: 36, vel: .9 })) : [];
    const storm = profile === 'squall' ? compileStorm({ energyCurves, timeline, durationMs }) : null;
    const evidence = { durationMs, energyCurves, cycle: songSkyClock(durationMs),
      storm: storm ? { at: t => storm.at(t), strikes: storm.episodes.flatMap(e => e.strikes) } : null,
      finale: { freezeAtMs: durationMs - 2000 } };
    for (const run of ['cold', 'warm']) {
      const stats = {}, started = performance.now();
      const candidates = buildHighlightCandidates(evidence, stats);
      results.push({ minutes: durationMs / 60000, profile, run,
        constructionMs: Number((performance.now() - started).toFixed(3)), ...stats,
        schedule: candidates.map(event => `${event.label}@${event.eventAtMs}`) });
    }
  }
}
console.log(JSON.stringify(results, null, 2));
