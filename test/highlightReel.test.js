import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HighlightReel, buildHighlightCandidates, selectHighlightCandidates, curvePeaks, highlightRegimeCurves, highlightPeaks,
  highlightFrameState, highlightVisible, MAX_FRAMES, MIN_GAP_MS, START_MS, REGIMES, PEAK_TOLERANCE,
  REGIME_WINDOW_MS, paletteWarmth, FLASH_HOLD,
} from '../src/render/HighlightReel.js';
import { blendSections } from '../src/world/BiomeSchedule.js';
import { dayNight } from '../src/world/DayNight.js';
import { getWorld } from '../src/world/Worlds.js';
import { compileStorm } from '../src/world/alpine/RangeStorm.js';
import { FINALE_FREEZE_LEAD_MS } from '../src/core/SongFinale.js';
import { songSkyClock } from '../src/world/DayNight.js';
import { BIOMES } from '../src/world/BiomeProfiles.js';
import { REAL_BIOMES } from '../src/world/RealBiomes.js';

const canvases = [];
globalThis.document = { createElement: () => {
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:image/jpeg;base64,fake' };
  canvases.push(canvas);
  return canvas;
} };
const source = { width: 1280, height: 720 };
const CATEGORIES = Object.keys(REGIMES);
const candidate = (id, eventAtMs, category = 'noon', extra = {}) => ({
  id, eventAtMs, category, label: REGIMES[category]?.label ?? category,
  visibleStartMs: eventAtMs, visibleEndMs: eventAtMs + 100, score: .5, ...extra,
});
const signature = events => events.map(({ id, category, eventAtMs }) => ({ id, category, eventAtMs }));

function assertSchedule(events) {
  assert.ok(events.length <= MAX_FRAMES, `at most ${MAX_FRAMES} frames`);
  assert.equal(new Set(events.map(e => e.category)).size, events.length, 'one frame per regime');
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].eventAtMs - events[i - 1].eventAtMs >= MIN_GAP_MS, 'event-time gap');
  }
}

/** A song whose energy builds into one loud passage with heavy hits: a
 * real Landscape squall (compileStorm) between 60 and 100 s. */
function stormySong(durationMs = 180000) {
  const energyCurves = { globalEnergyNorm: t => t > 60000 && t < 100000 ? .9 : .25 };
  const timeline = Array.from({ length: Math.floor(durationMs / 500) }, (_, i) => ({
    tMs: i * 500, role: 'RHYTHM', pitch: i % 4 ? 36 : 38, vel: .9 }));
  const storm = compileStorm({ energyCurves, timeline, durationMs });
  return { energyCurves, storm: { at: t => storm.at(t), strikes: storm.episodes.flatMap(e => e.strikes) } };
}

test('selection keeps at most five regimes, one per regime, in song order', () => {
  const events = CATEGORIES.flatMap((category, i) => [
    candidate(`${category}:a`, 10000 + i * 7000, category, { score: 1 - i * .05 }),
    candidate(`${category}:b`, 200000 + i * 7000, category, { score: .1 }),
  ]);
  const selected = selectHighlightCandidates(events);
  assert.equal(selected.length, MAX_FRAMES);
  assertSchedule(selected);
  assert.deepEqual(selected.map(e => e.category), CATEGORIES.slice(0, MAX_FRAMES), 'highest scores win');
  assert.ok(selected.every(Object.isFrozen));
});

test('the event-time gap holds at 4999/5000 ms regardless of score or input order', () => {
  const events = [candidate('a', 0, 'noon', { score: .9 }), candidate('b', 4999, 'sunset', { score: 1 }),
    candidate('c', 5000, 'night', { score: .8 }), candidate('d', 9999, 'dawn', { score: .7 })];
  for (const order of [events, [...events].reverse()]) {
    assert.deepEqual(selectHighlightCandidates(order).map(e => e.id), ['b', 'd']);
  }
});

test('a colliding peak slides inside its near-maximum hold instead of being dropped', () => {
  const sunset = candidate('sunset:10000', 10000, 'sunset', { score: 1 });
  const noon = candidate('noon:8000', 8000, 'noon', { score: .5, holdFromMs: 2000, holdToMs: 9000 });
  const selected = selectHighlightCandidates([sunset, noon]);
  assert.deepEqual(signature(selected), [
    { id: 'noon:5000', category: 'noon', eventAtMs: 5000 },
    { id: 'sunset:10000', category: 'sunset', eventAtMs: 10000 }]);
  assert.equal(selected[0].visibleEndMs - selected[0].visibleStartMs, 100, 'the window moves with the peak');
  assert.deepEqual(signature(selectHighlightCandidates(selected)), signature(selected), 'selecting a selection is a no-op');
  // Both slide when that is the only way to fit a third, higher-scored peak.
  const night = candidate('night:12000', 12000, 'night', { score: .9, holdFromMs: 11000, holdToMs: 20000 });
  assertSchedule(selectHighlightCandidates([sunset, noon, night]));
  assert.equal(selectHighlightCandidates([sunset, noon, night]).length, 3);
});

test('decided candidates keep their exact time; the pool only fills around them', () => {
  const fixed = [candidate('night:3000', 3000, 'night')];
  const pool = [candidate('night:30000', 30000, 'night', { score: 1 }),
    candidate('noon:5000', 5000, 'noon', { score: 1, holdFromMs: 4000, holdToMs: 6000 })];
  const selected = selectHighlightCandidates(pool, fixed);
  assert.deepEqual(signature(selected), [{ id: 'night:3000', category: 'night', eventAtMs: 3000 }]);
});

test('unsupported categories and malformed windows never become candidates', () => {
  assert.deepEqual(selectHighlightCandidates([candidate('d', 0, 'drop'), candidate('f', 9000, 'finale'),
    { ...candidate('x', 1000), visibleEndMs: 1000 }]), []);
});

test('curve peaks sit at the maximum, with prominence and clipped holds', () => {
  const sine = t => Math.sin(Math.PI * t / 20000);
  const [peak] = curvePeaks(sine, { durationMs: 20000 });
  assert.equal(peak.atMs, 10000);
  assert.ok(Math.abs(peak.prominence - 1) < 1e-9);
  assert.ok(sine(peak.atMs) >= 1 - PEAK_TOLERANCE);
  // A plateau's peak is the middle of its hold.
  const mesa = t => t >= 6000 && t <= 14000 ? .8 : .1;
  assert.deepEqual(curvePeaks(mesa, { durationMs: 20000 }).map(p => [p.atMs, Number(p.prominence.toFixed(3))]), [[10000, .7]]);
  // An edge hold counts, clipped to the playable range (after START_MS and
  // ending a full window before the end).
  const dusk = t => t > 15000 ? 1 : 0;
  const [edge] = curvePeaks(dusk, { durationMs: 20000, endMs: 19000 });
  assert.equal(edge.holdFromMs, 15250);
  assert.equal(edge.holdToMs, 19000 - REGIME_WINDOW_MS);
  const [opening] = curvePeaks(t => t < 1000 ? 1 : 0, { durationMs: 20000 });
  assert.equal(opening, undefined, 'a hold that ends before START_MS has no visible peak');
  assert.deepEqual(curvePeaks(() => .6, { durationMs: 20000 }), [], 'a flat curve has no excursion');
});

test('day-only evidence peaks at each sky regime maximum and stays out of the finale', () => {
  const durationMs = 180000, finale = { freezeAtMs: 176000 };
  const events = buildHighlightCandidates({ durationMs, finale });
  assertSchedule(events);
  assert.deepEqual(events.map(e => e.category), ['night', 'dawn', 'noon', 'sunset']);
  const curves = highlightRegimeCurves({ durationMs, cycle: songSkyClock(durationMs) });
  for (const event of events) {
    let max = 0;
    for (let t = 0; t <= durationMs; t += 50) max = Math.max(max, curves[event.category](t));
    assert.ok(curves[event.category](event.eventAtMs) >= max - PEAK_TOLERANCE, `${event.category} at its maximum`);
    assert.ok(event.visibleStartMs >= START_MS);
    assert.ok(event.visibleEndMs <= finale.freezeAtMs - FINALE_FREEZE_LEAD_MS, 'no frame in the finale freeze');
  }
  const clock = songSkyClock(durationMs);
  const noon = events.find(e => e.category === 'noon').eventAtMs;
  assert.ok(Math.abs(noon - (clock.sunriseMs + clock.sunsetMs) / 2) <= 250, 'high sun is mid-day');
  const sunset = events.find(e => e.category === 'sunset').eventAtMs;
  assert.ok(sunset < clock.sunsetMs && clock.sunsetMs - sunset < 10000, 'the sunset glow peaks as the sun meets the horizon');
  assert.deepEqual(signature(buildHighlightCandidates({ durationMs, finale })), signature(events), 'deterministic');
});

test('regimes the world cannot produce are absent', () => {
  const durationMs = 120000;
  const plain = buildHighlightCandidates({ durationMs, sections: [{ startMs: 0, profile: 'SOLAR', barMs: 2000 }],
    palettes: BIOMES, energyCurves: { globalEnergyNorm: () => .5 } });
  assert.ok(plain.every(e => ['dawn', 'noon', 'sunset', 'night'].includes(e.category)),
    'no storm (Trio/no squall), no palette (one section), no climax (flat energy)');
  const curves = highlightRegimeCurves({ durationMs, sections: [{ startMs: 0, profile: 'CUSTOM' }, { startMs: 5000, profile: 'SOLAR' }],
    palettes: [...BIOMES, { name: 'CUSTOM' }] });
  assert.equal(curves.warmest, undefined, 'a palette without painted colors has no warmth');
  assert.equal(curves.storm, undefined);
});

test('contrasting cast palettes add their warmest and coolest sections', () => {
  const durationMs = 24000;
  const sections = [{ startMs: 0, profile: 'ARCTIC', barMs: 500, transition: 'fade' },
    { startMs: 8000, profile: 'SOLAR', barMs: 500, transition: 'fade' },
    { startMs: 16000, profile: 'JADE', barMs: 500, transition: 'fade' }];
  const events = buildHighlightCandidates({ durationMs, sections, palettes: BIOMES, cycle: 1e12 });
  const warm = events.find(e => e.category === 'warmest');
  assert.ok(warm, 'warmest palette selected');
  assert.equal(warm.detail, 'Solar');
  assert.equal(warm.palette, 'SOLAR');
  assert.ok(warm.eventAtMs >= 8000 + 2000 && warm.eventAtMs + REGIME_WINDOW_MS <= 16000, 'inside the settled SOLAR section');
  const cool = events.find(e => e.category === 'coolest');
  assert.equal(cool?.palette, 'ARCTIC');
});

test('palette warmth reads the painted colors, not the cast energy rank', () => {
  const warmth = name => paletteWarmth([...BIOMES, ...REAL_BIOMES].find(p => p.name === name));
  assert.ok(warmth('EMBER') > .75 && warmth('SOLAR') > warmth('ARCTIC'));
  assert.ok(warmth('ICEFIELD') < .4 && warmth('DESERT') > warmth('ICEFIELD') + .2);
  assert.equal(paletteWarmth({ name: 'bare' }), null);
});

test('a Landscape squall adds storm regimes and hides the sun behind its deck', () => {
  const durationMs = 180000, { energyCurves, storm } = stormySong(durationMs);
  const events = buildHighlightCandidates({ durationMs, energyCurves, storm, finale: { freezeAtMs: 178000 } });
  assertSchedule(events);
  assert.equal(events.length, MAX_FRAMES);
  const peak = events.find(e => e.category === 'storm');
  assert.ok(peak, 'the squall is the strongest regime');
  assert.ok(storm.at(peak.eventAtMs).amount >= .99 * Math.max(...Array.from({ length: 720 }, (_, i) => storm.at(i * 250).amount)));
  const curves = highlightRegimeCurves({ durationMs, energyCurves, storm });
  assert.ok(curves.noon(peak.eventAtMs) < .05, 'no high sun under the overcast');
  // The brightest strike flashes at its attack: amp x the deck's amount.
  const strike = highlightPeaks({ durationMs, storm, energyCurves }).find(e => e.category === 'lightning');
  const brightest = Math.max(...storm.strikes.map(s => s.amp * storm.at(s.tMs).amount));
  assert.ok(storm.strikes.some(s => s.tMs === strike.eventAtMs), 'at a strike attack');
  assert.ok(Math.abs(strike.peakValue - brightest) < 1e-9);
  assert.ok(Math.abs(strike.peakValue - storm.at(strike.eventAtMs).flash) < 1e-9, 'the renderer\'s own flash at that instant');
  // Every lightning window ends while the painted flash still holds half
  // the strike's peak: a late first draw cannot capture a dark sky.
  for (const e of highlightPeaks({ durationMs, storm, energyCurves }).filter(e => e.category === 'lightning')) {
    assert.ok(e.visibleEndMs > e.visibleStartMs);
    for (let t = e.visibleStartMs; t < e.visibleEndMs; t += 1) {
      assert.ok(storm.at(t).flash >= FLASH_HOLD * e.peakValue - 1e-9, `flash held at ${t}`);
    }
  }
  // Without the squall evidence (Trio) the same song has no weather frames.
  assert.ok(buildHighlightCandidates({ durationMs, energyCurves }).every(e => !['storm', 'lightning', 'clearing'].includes(e.category)));
});

test('committed history is preserved and no new peak is admitted at or before it', () => {
  const durationMs = 180000, { energyCurves, storm } = stormySong(durationMs);
  const before = buildHighlightCandidates({ durationMs, energyCurves, storm });
  const committedThroughMs = 70000;
  const preserved = before.filter(e => e.eventAtMs <= committedThroughMs);
  const after = buildHighlightCandidates({ durationMs, energyCurves: { globalEnergyNorm: () => .25 },
    preserved, committedThroughMs });
  assert.deepEqual(signature(after.filter(e => e.eventAtMs <= committedThroughMs)), signature(preserved));
  assert.ok(after.filter(e => e.eventAtMs > committedThroughMs).every(e => !preserved.some(p => p.category === e.category)));
  assertSchedule(after);
});

test('a stalled visible window is recorded as missed and cannot be revived by a backseek', () => {
  const reel = new HighlightReel(), events = [candidate('noon:5000', 5000)];
  reel.notify(events, source, 4900);
  reel.notify(events, source, 5200);
  assert.equal(reel.frames.length, 0);
  assert.equal(reel.selections[0].status, 'missed');
  assert.equal(reel.selections[0].observedAtMs, 5200);
  reel.notify(events, source, 5000);
  assert.equal(reel.selections[0].status, 'missed');
  assert.equal(reel.frames.length, 0);
});

test('a peak observed while its regime is hidden is rejected without a thumbnail', () => {
  const reel = new HighlightReel(), events = [candidate('storm:0', 0, 'storm')];
  reel.notify(events, source, 20, { isVisible: () => false });
  reel.notify(events, source, 100, { isVisible: () => false });
  assert.equal(reel.frames.length, 0);
  assert.equal(reel.selections[0].status, 'rejected');
});

test('captured frames carry the regime label, peak time and actual frame times', () => {
  const reel = new HighlightReel();
  const events = [candidate('sunset:0', 0, 'sunset'), candidate('noon:5000', 5000, 'noon')];
  reel.notify(events, source, 90, { frameTimeMs: 140 });
  reel.notify(events, source, 5000, { frameTimeMs: 5050 });
  assert.deepEqual(reel.frames.map(f => [f.label, f.category, f.eventAtMs, f.atMs, f.capturedAtMs]),
    [['Sunset', 'sunset', 0, 90, 140], ['High sun', 'noon', 5000, 5000, 5050]]);
});

test('candidate snapshot is immutable and repeated draws/seeks do not duplicate peaks', () => {
  const reel = new HighlightReel(), events = [candidate('night:0', 0, 'night'), candidate('noon:6000', 6000)];
  reel.notify(events, source, 0);
  events[1].id = 'mutated'; events[1].eventAtMs = 20000;
  for (const time of [10, 6000, 6010, 0, 6000]) reel.notify(events, source, time);
  assert.deepEqual(reel.selections.map(e => e.id), ['night:0', 'noon:6000']);
  assert.deepEqual(reel.frames.map(e => e.eventAtMs), [0, 6000]);
  assert.ok(reel.selections.every(Object.isFrozen));
});

test('five selected frames reuse and release one bounded thumbnail canvas', () => {
  const before = canvases.length, reel = new HighlightReel();
  const events = CATEGORIES.map((category, i) => candidate(`${category}:${i * 5000}`, i * 5000, category, { score: 1 - i * .01 }));
  const selected = selectHighlightCandidates(events);
  for (const event of selected) reel.notify(events, source, event.eventAtMs);
  assert.equal(reel.selections.length, MAX_FRAMES);
  assert.equal(reel.frames.length, MAX_FRAMES);
  assert.equal(canvases.length - before, 1);
  assert.equal(canvases.at(-1).width, 0);
  assert.equal(reel._thumbCanvas, null);
});

test('direct capture preserves its bounded public gate', () => {
  const reel = new HighlightReel();
  assert.equal(reel.capture(source, 0, 'High sun'), true);
  assert.equal(reel.capture(source, 4999, 'Sunset'), false);
  assert.equal(reel.capture(source, 5000, 'Sunset'), true);
});

test('frame visibility: freeze, assembly, arrival and cuts hide every regime; weather needs the Range sky', () => {
  const v2 = { _rangeV2Active: true, _pass: () => true, currentBlend: { from: 'SOLAR', to: 'SOLAR', t: 1 },
    _cutFlash: 0, rangePresentation: { arriving: false } };
  const live = highlightFrameState({ fracture: { isFrozen: false, isDone: false } }, v2);
  for (const category of CATEGORIES) assert.equal(highlightVisible({ category }, live), true, category);
  const legacy = highlightFrameState({}, { ...v2, _rangeV2Active: false });
  assert.equal(highlightVisible({ category: 'storm' }, legacy), false);
  assert.equal(highlightVisible({ category: 'noon' }, legacy), true);
  const blending = highlightFrameState({}, { ...v2, currentBlend: { from: 'ARCTIC', to: 'SOLAR', t: .5 } });
  assert.equal(highlightVisible({ category: 'warmest' }, blending), false);
  assert.equal(highlightVisible({ category: 'warmest', palette: 'ARCTIC' }, live), false, 'another palette is on screen');
  assert.equal(highlightVisible({ category: 'sunset' }, blending), true);
  for (const [sim, mgr] of [[{ fracture: { isFrozen: true } }, v2], [{ fracture: { isDone: true } }, v2],
    [{ assembly: { active: true } }, v2], [{}, { ...v2, _cutFlash: .9 }], [{}, { ...v2, rangePresentation: { arriving: true } }],
    [{}, { ...v2, _awaitingTerrain: true }]]) {
    assert.equal(highlightVisible({ category: 'noon' }, highlightFrameState(sim, mgr)), false);
  }
});

const LANDSCAPE = getWorld('alpine'), TRIO = getWorld('trio');

test('a palette peak sits inside one settled palette, never across a crossfade', () => {
  // CONIFER (.283) and ICEFIELD (.284) are nearly equally cool, so the
  // near-maximum hold spans both and the 4-bar crossfade between them.
  const sections = ['DESERT', 'CONIFER', 'ICEFIELD', 'CANYON'].map((profile, i) => ({
    startMs: i * 30000, profile, barMs: 2000, transition: 'fade' }));
  for (const travel of [false, true]) {
    const events = highlightPeaks({ durationMs: 120000, sections, palettes: REAL_BIOMES, travel, cycle: 1e12, world: LANDSCAPE })
      .filter(e => e.category === 'warmest' || e.category === 'coolest');
    assert.ok(events.some(e => e.category === 'coolest'), 'the coolest palette still has a frame');
    for (const e of events) {
      for (const at of [e.visibleStartMs, e.visibleEndMs - 1, e.holdFromMs, e.holdToMs + REGIME_WINDOW_MS - 1]) {
        const blend = blendSections(sections, at, { travel });
        assert.equal(blend.t, 1, `${e.id} settled at ${at} (travel ${travel})`);
        assert.equal(blend.to, e.palette);
      }
    }
  }
});

test('deepest night is only scheduled once the sun is down', () => {
  for (const durationMs of [60000, 180000, 300000]) {
    const clock = songSkyClock(durationMs);
    for (const [world, committedThroughMs] of [[null, -Infinity], [null, 6000], [TRIO, 6000], [LANDSCAPE, 6000]]) {
      const events = highlightPeaks({ durationMs, world, committedThroughMs, finale: { freezeAtMs: durationMs - 8000 } });
      for (const e of events.filter(e => e.category === 'night')) {
        for (const at of [e.eventAtMs, e.holdFromMs, e.holdToMs]) assert.equal(dayNight(at, clock).sunAlt, 0, `${durationMs} ${e.id}`);
      }
    }
  }
});

test('Trio\'s first light and dusk peak with the washes Trio paints', () => {
  for (const durationMs of [180000, 300000]) {
    const clock = songSkyClock(durationMs), argmax = key => {
      let best = 0, at = 0;
      for (let t = 0; t <= durationMs; t += 250) { const v = dayNight(t, clock)[key]; if (v > best) { best = v; at = t; } }
      return at;
    };
    const events = highlightPeaks({ durationMs, world: TRIO });
    const dawn = events.find(e => e.category === 'dawn'), dusk = events.find(e => e.category === 'sunset');
    assert.ok(Math.abs(dawn.eventAtMs - argmax('dawnAlpha')) <= 250, `dawn ${dawn.eventAtMs}`);
    assert.ok(Math.abs(dusk.eventAtMs - argmax('duskAlpha')) <= 250, `dusk ${dusk.eventAtMs}`);
    assert.equal(dusk.label, 'Dusk', 'the indigo wash is a dusk, not a burning sunset');
    // Landscape paints DayNight's twilight instead: its peaks are elsewhere.
    const range = highlightPeaks({ durationMs, world: LANDSCAPE });
    assert.equal(range.find(e => e.category === 'sunset').label, 'Sunset');
    assert.ok(Math.abs(range.find(e => e.category === 'dawn').eventAtMs - dawn.eventAtMs) > 5000);
  }
});

test('Trio rotates its palettes by the live key, so it has no palette regimes', () => {
  const sections = [{ startMs: 0, profile: 'ARCTIC', barMs: 500, transition: 'fade' },
    { startMs: 8000, profile: 'SOLAR', barMs: 500, transition: 'fade' }];
  const curves = highlightRegimeCurves({ durationMs: 24000, sections, palettes: BIOMES, world: TRIO });
  assert.equal(curves.warmest, undefined);
  assert.equal(curves.coolest, undefined);
  assert.ok(highlightRegimeCurves({ durationMs: 24000, sections, palettes: BIOMES }).warmest, 'evidence without a world keeps them');
});

test('regime groups are cached: new sections re-read only the palettes', () => {
  const durationMs = 300000, cache = {};
  const sectionsAt = offset => ['DESERT', 'ICEFIELD', 'CANYON', 'CONIFER'].map((profile, i) => ({
    startMs: i * 70000 + offset, profile, barMs: 2000, transition: 'fade' }));
  const evidence = { durationMs, palettes: REAL_BIOMES, world: LANDSCAPE, travel: true,
    energyCurves: { globalEnergyNorm: t => t > 120000 && t < 140000 ? .9 : .2 }, finale: { freezeAtMs: 296000 } };
  const cold = {};
  buildHighlightCandidates({ ...evidence, sections: sectionsAt(0) }, cold, cache);
  const warm = {};
  const rebuilt = buildHighlightCandidates({ ...evidence, sections: sectionsAt(4000) }, warm, cache);
  const samples = Math.floor(durationMs / 250) + 1;
  assert.equal(warm.samples, 2 * samples, 'only warmest and coolest are re-sampled');
  assert.ok(cold.samples > warm.samples);
  assert.deepEqual(signature(rebuilt), signature(buildHighlightCandidates({ ...evidence, sections: sectionsAt(4000) })),
    'a cached rebuild equals a fresh one');
});

test('a lost peak frees its slot for the best standby still ahead', () => {
  // A repeating 60 s sky cycle: every sky regime peaks three times.
  const durationMs = 180000, { energyCurves } = stormySong(durationMs);
  const schedule = buildHighlightCandidates({ durationMs, cycle: 60000, energyCurves, finale: { freezeAtMs: 176000 } });
  assert.ok(schedule.standby.length > 0, 'the pool keeps standby peaks');
  assert.ok(schedule.standby.every(Object.isFrozen));
  const run = () => {
    const reel = new HighlightReel(), first = schedule[0];
    reel.notify(schedule, source, first.visibleStartMs, { isVisible: () => false });
    reel.notify(schedule, source, first.visibleEndMs, { isVisible: () => false });
    return reel;
  };
  const reel = run(), [lost] = reel.selections;
  assert.equal(lost.status, 'rejected');
  const live = reel.selections.filter(e => e.status === 'pending');
  assert.equal(live.length, Math.min(MAX_FRAMES, schedule.length - 1 + schedule.standby.length), 'the freed slot is filled');
  assertSchedule(live);
  const promoted = live.filter(e => !schedule.some(s => s.id === e.id));
  assert.equal(promoted.length, 1);
  assert.ok(promoted[0].eventAtMs > lost.visibleEndMs, 'only from the unheard future');
  assert.deepEqual(signature(run().selections), signature(reel.selections), 'deterministic for one capture history');
  // A backseek neither revives the lost peak nor promotes again.
  const before = signature(reel.selections);
  reel.notify(schedule, source, lost.eventAtMs);
  reel.notify(schedule, source, lost.visibleEndMs + 10);
  assert.deepEqual(signature(reel.selections), before);
  assert.equal(reel.selections[0].status, 'rejected');
});

test('the reel is complete once every frame is taken', () => {
  const reel = new HighlightReel();
  const events = CATEGORIES.slice(0, MAX_FRAMES).map((category, i) => candidate(`${category}:${i * 5000}`, i * 5000, category));
  for (const event of events) { assert.equal(reel.complete, false); reel.notify(events, source, event.eventAtMs); }
  assert.equal(reel.complete, true);
});
