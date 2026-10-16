// One squall per song. All envelopes are evaluated at heard time; playback,
// pause, seeking and offline exports share exactly the same weather.
import { rangeCloudBanks, drawRangeClouds } from './RangeSkyComposition.js';
const unit = x => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
const ease = x => { const t = unit(x); return t * t * (3 - 2 * t); };
const EMPTY_TIMELINE = Object.freeze([]);
const EMPTY = Object.freeze({ amount: 0, flash: 0, flashU: .5, break01: 0, wet01: 0 });
const hash01 = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const smooth = (a, b, x) => ease((x - a) / (b - a));

/** Where rain curtains hang, across the sky (u: 0..1 of the frame's width
 *  in the sky's own coordinates, so they turn with the camera like the
 *  clouds), slowly drifting on the wind. GLSL twin: STORM_GLSL rainCurtain. */
export function rainCurtain(u, tSec = 0) {
  const a = .5 + .5 * Math.sin(6.2832 * (u * 1.6 + tSec * .003) + 1.3);
  const b = .5 + .5 * Math.sin(6.2832 * (u * 3.7 - tSec * .005) + 4.1);
  return smooth(.32, .86, a * .65 + b * .35);
}

/** Shared by the terrain and forest shaders, which declare uStorm,
 *  uViewProj, uTime and uCameraPos. The rain hangs in the distance (it
 *  veils far land, not the near shore) inside the same curtains the sky
 *  draws; after the storm, broken cloud lets the sun through in swathes
 *  fixed to the land. */
export const STORM_GLSL = /* glsl */`
  uniform float uRainShift;
  float rainCurtain(float u, float t) {
    float a = 0.5 + 0.5 * sin(6.2832 * (u * 1.6 + t * 0.003) + 1.3);
    float b = 0.5 + 0.5 * sin(6.2832 * (u * 3.7 - t * 0.005) + 4.1);
    return smoothstep(0.32, 0.86, a * 0.65 + b * 0.35);
  }
  float rainVeil(vec3 world, float dist) {
    if (uStorm.x < 0.001) return 0.0;
    vec4 c = uViewProj * vec4(world, 1.0);
    float u = c.x / max(c.w, 1e-4) * 0.5 + 0.5 - uRainShift;
    return uStorm.x * rainCurtain(u, uTime) * smoothstep(2500.0, 14000.0, dist);
  }
  float stormNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    vec4 h = fract(sin(vec4(dot(i, vec2(127.1, 311.7)), dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7)),
      dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7)), dot(i + vec2(1.0), vec2(127.1, 311.7)))) * 43758.5453);
    return mix(mix(h.x, h.y, f.x), mix(h.z, h.w, f.x), f.y);
  }
  // Sunlit swathes between cloud shadows as the storm breaks, 0..1.
  float stormOpening(vec3 world) {
    if (uStorm.z <= 0.0) return 0.0; // only while the storm breaks
    return smoothstep(0.35, 0.72, stormNoise(world.xz / 1100.0 + vec2(uTime * 0.02, 0.0)));
  }
  // Rain-washed air, lit from inside by lightning.
  vec3 rainColor() { return uAirColor * 1.1 + uLightColor * 0.04; }
`;
export function compileStorm({ energyCurves, sections = [], timeline = [], durationMs = 0 } = {}) {
  if (!(durationMs > 0)) return { section: null, at: () => EMPTY };
  const read = energyCurves?.globalEnergyNorm?.bind(energyCurves) || energyCurves?.globalEnergy?.bind(energyCurves);
  if (!read) return { section: null, at: () => EMPTY };
  const average = (a, b) => {
    if (!read) return 0;
    let sum = 0, n = 0;
    for (let t = a; t < b; t += 250) { sum += unit(read(t)); n++; }
    return sum / Math.max(1, n);
  };
  // Clip away arrival time; do not discard a sustained climax merely
  // because its structural section also contains the song's opening.
  let candidates = sections.filter(s => s.provenance !== 'decorative' && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs && s.endMs > 8000)
    .map(s => ({ startMs: Math.max(8000, s.startMs), endMs: Math.min(durationMs, s.endMs) })).filter(s => s.endMs > s.startMs);
  // Unsegmented songs still get their strongest sustained passage. The
  // averaging window prevents a short opening/ending transient from winning.
  if (!candidates.length) {
    const span = Math.min(20000, durationMs * .24);
    for (let t = 8000; t + span <= durationMs; t += 1000) candidates.push({ startMs: t, endMs: t + span });
  }
  const scored = candidates.map(section => ({ section, energy: average(section.startMs, section.endMs) }));
  scored.sort((a, b) => b.energy - a.energy || Math.abs((a.section.startMs+a.section.endMs)/2-durationMs*.5)
    - Math.abs((b.section.startMs+b.section.endMs)/2-durationMs*.5));
  const section = scored[0]?.section || { startMs: durationMs * .4, endMs: durationMs * .65 };
  const snares = [];
  for (const event of [...timeline].sort((a, b) => a.tMs - b.tMs)) {
    if (!(event.role === 'RHYTHM' || event.channel === 9) || ![38, 40].includes(event.pitch) || !Number.isFinite(event.tMs) || event.tMs < section.startMs || event.tMs >= section.endMs) continue;
    if (event.tMs - (snares.at(-1)?.tMs ?? -Infinity) >= 700) snares.push({ tMs: event.tMs, amp: unit(event.vel ?? event.velocity ?? .8) });
  }
  return Object.freeze({ section: Object.freeze(section), at(timeMs, { reducedFlash = false } = {}) {
    const t = Number.isFinite(timeMs) ? timeMs : 0, a = section.startMs, b = section.endMs;
    const amount = ease((t - a + 6000) / 8000) * (1 - ease((t - b) / 4000));
    let flash = 0, flashU = .5;
    if (!reducedFlash && amount > .2) {
      let lo = 0, hi = snares.length;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (snares[m].tMs <= t) lo = m + 1; else hi = m; }
      const hit = snares[lo - 1], age = hit ? t - hit.tMs : Infinity;
      // A stroke, then a fainter restrike, as cloud lightning flickers.
      if (age < 290) flash = hit.amp * Math.max(1 - ease(age / 120), age > 90 ? .7 * (1 - ease((age - 90) / 200)) : 0) * amount;
      if (hit) flashU = .18 + .64 * hash01(lo);
    }
    return { amount, flash, flashU, break01: ease((t - b - 2000) / 6000) * (1 - ease((t - b - 14000) / 20000)),
      wet01: ease((t - a) / 6000) * (1 - ease((t - b) / 45000)) };
  } });
}
const cache = new WeakMap();
export function stormAt(mgr, timeMs) {
  if (!mgr || mgr.terrainPreview) return EMPTY;
  const timeline = mgr.conductor?.timeline || EMPTY_TIMELINE;
  let hit = cache.get(mgr);
  if (!hit || hit.curves !== mgr.energyCurves || hit.sections !== mgr.sections || hit.timeline !== timeline || hit.durationMs !== mgr.durationMs) {
    hit = { curves: mgr.energyCurves, sections: mgr.sections, timeline, durationMs: mgr.durationMs,
      score: compileStorm({ energyCurves: mgr.energyCurves, sections: mgr.sections, timeline, durationMs: mgr.durationMs }) };
    cache.set(mgr, hit);
  }
  const state = hit.score.at(timeMs, { reducedFlash: !!mgr.reducedFlash });
  const override = mgr.stormOverride;
  if (override && typeof override === 'object') return { ...state, ...override, flash: mgr.reducedFlash ? 0 : unit(override.flash ?? state.flash) };
  return state;
}
/** Behind the terrain passes: the squall's sky. An overcast deck swallows
 * the sun, rain curtains hang from its base (the land shaders veil the far
 * ground inside the same curtains, rainCurtain), lightning glows inside the
 * cloud rather than as a bolt laid over the peaks, and as the storm breaks
 * the deck tears into sunlit remnants. The lake's backdrop captures this sky. */
/** The storm's sky scaled to an arriving scene's alpha (0..1). */
export function arrivingStorm(storm, arrival = 1) {
  const a = unit(arrival);
  return a >= 1 || !storm ? storm : { ...storm, amount: unit(storm.amount) * a, break01: unit(storm.break01) * a, flash: unit(storm.flash) * a };
}
export function drawStormSky(ctx, canvas, storm, { tSec = 0, seed = 0, pan = null, light, reducedMotion = false } = {}) {
  const amount = unit(storm?.amount), breaking = unit(storm?.break01), flash = unit(storm?.flash);
  if (amount < .001 && breaking < .001) return;
  const { width: w, height: h } = canvas;
  const motion = reducedMotion ? 0 : tSec;
  const panX = (pan?.x || 0) / 2;
  ctx.save();
  // Overcast: slate from the zenith down to the rain-dimmed horizon, dense
  // enough to hide the sun. The land's air (RangeScene STORM_AIR) meets it.
  const dark = ctx.createLinearGradient(0, 0, 0, h * .62);
  dark.addColorStop(0, `rgba(30,36,45,${amount * .96})`);
  dark.addColorStop(1, `rgba(78,88,98,${amount * .9})`);
  ctx.fillStyle = dark; ctx.fillRect(0, 0, w, h);
  // The deck: heavy banks low over the peaks. As the storm breaks they thin
  // to scattered remnants with sunlit rims, the sky washed clean between.
  const banks = rangeCloudBanks({ width: w, height: h, tSec: motion * .6, seed: (seed % 9973) + 17, panPx: (pan?.x || 0) * w / 2, panYPx: -(pan?.y || 0) * h / 2, count: 14 });
  banks.forEach((b, i) => {
    const remnant = breaking * smooth(.35, .75, hash01(i + seed % 101)) * .9;
    b.alpha = Math.min(1, Math.max(amount, remnant) * (.75 + .25 * hash01(i + 7)));
    b.w *= 1.9; b.h *= 1.6; b.y = h * (.03 + .22 * hash01(i + 3)) - (pan?.y || 0) * h / 2;
  });
  const sun = breaking * (1 - amount);
  const mixRgb = (a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * sun));
  drawRangeClouds(ctx, banks, { dark: mixRgb([26, 31, 39], [104, 114, 128]), lit: mixRgb([70, 76, 86], [240, 228, 206]), light,
    directGain: .35 + sun * 1.2 });
  if (flash > .001) {
    // Lightning inside the cloud: the banks near the strike are painted
    // again in its light, so only the deck itself glows (no screen flash).
    const fx = ((storm.flashU ?? .5) + panX) * w, fy = h * .15, reach = w * .32;
    const lit = banks.map(b => ({ ...b, alpha: b.alpha * flash * Math.max(0, 1 - Math.hypot(b.x - fx, (b.y - fy) * 2) / reach) }))
      .filter(b => b.alpha > .01);
    drawRangeClouds(ctx, lit, { dark: [150, 168, 215], lit: [222, 232, 255], light: { x: fx, y: fy }, directGain: 1.2 });
  }
  // Rain curtains hanging from the deck's base; the terrain passes continue
  // them in front of the far land, so they hang plumb like the veil does.
  if (amount > .001) {
    const top = h * .2, bottom = h, step = Math.max(1, Math.round(w / 240));
    const fall = ctx.createLinearGradient(0, top, 0, bottom);
    const c = [118 + flash * 90, 128 + flash * 90, 140 + flash * 95].map(Math.round).join(',');
    fall.addColorStop(0, `rgba(${c},0)`); fall.addColorStop(.18, `rgba(${c},1)`); fall.addColorStop(1, `rgba(${c},.8)`);
    ctx.fillStyle = fall;
    for (let x = 0; x < w; x += step) {
      const k = rainCurtain((x + step * .5) / w - panX, motion);
      if (k < .01) continue;
      ctx.globalAlpha = k * amount * .5;
      ctx.fillRect(x, top, step, bottom - top);
    }
  }
  ctx.restore();
}
