import { compileLandscapeScore, landscapeScoreFor } from './LandscapeScore.js';
// Musical weather episodes. All envelopes are evaluated at heard time; playback,
// pause, seeking and offline exports share exactly the same weather.
import { rangeCloudBanks, drawRangeClouds } from './RangeSkyComposition.js';
const unit = x => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
const ease = x => { const t = unit(x); return t * t * (3 - 2 * t); };
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
  uniform float uReceiverFillMin;
  // Preserve sky chromaticity while lifting only low receiver irradiance.
  // A true zero has no hue to preserve; do not invent emissive white fill.
  vec3 receiverFill(vec3 hemi, float minimum) {
    if (!(minimum > 0.0) || isnan(minimum) || isinf(minimum)) return hemi;
    if (any(isnan(hemi)) || any(isinf(hemi))) return vec3(0.0);
    float luminance = dot(hemi, vec3(0.2126, 0.7152, 0.0722));
    if (!(luminance > 0.0) || luminance >= minimum) return hemi;
    return hemi / luminance * minimum;
  }
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
  float stormShadow(float opening) {
    return 1.0 - uStorm.z * (1.0 - opening) * 0.5;
  }
  // The sheltered moon component is diffuse receiver fill. The moving
  // clearing mask still shades the remaining sky fill and direct light.
  float stormAmbient(float total, float sheltered, float opening) {
    float shadow = stormShadow(opening);
    return total * shadow + clamp(sheltered, 0.0, total) * (1.0 - shadow);
  }
  // Rain-washed air, lit from inside by lightning.
  vec3 rainColor() { return uAirColor * 1.1 + uLightColor * 0.04; }
`;
export function compileStorm({ energyCurves, sections = [], timeline = [], durationMs = 0, landscape = null,
  previous = null, committedThroughMs = -1 } = {}) {
  landscape ||= compileLandscapeScore({ energyCurves, sections, timeline, durationMs, previous, committedThroughMs });
  const episodes = landscape.episodes;
  const strongest = [...episodes].sort((a, b) => b.energy01 - a.energy01 || a.startMs - b.startMs)[0];
  const section = strongest ? Object.freeze({ startMs: strongest.startMs, endMs: strongest.endMs }) : null;
  const strikes = episodes.flatMap(e => e.strikes);
  return Object.freeze({ section, episodes, landscape, at(timeMs) {
    const t = Number.isFinite(timeMs) ? timeMs : 0;
    let amount = 0, break01 = 0, wet01 = 0;
    for (const { startMs: a, endMs: b, energy01 } of episodes) {
      const strength = Math.min(1, Math.max(.35, (energy01 - .5) * 3));
      amount = Math.max(amount, strength * ease((t - a + 6000) / 8000) * (1 - ease((t - b) / 4000)));
      break01 = Math.max(break01, ease((t - b - 2000) / 6000) * (1 - ease((t - b - 14000) / 20000)));
      wet01 = Math.max(wet01, ease((t - a) / 6000) * (1 - ease((t - b) / 45000)));
    }
    let flash = 0, flashU = .5;
    if (amount > .2) {
      let lo = 0, hi = strikes.length;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (strikes[m].tMs <= t) lo = m + 1; else hi = m; }
      const hit = strikes[lo - 1], age = hit ? t - hit.tMs : Infinity;
      // Heard-time envelopes keep attack timing exact under seek/export.
      // Hard accents flash longer and earn a stronger cloud restrike;
      // soft hits remain brief, dim illumination rather than white washes.
      if (hit && age < 320) {
        const decayMs = 65 + 100 * hit.amp;
        const restrikeMs = 80 + 35 * hash01(lo + 17);
        const echo = age > restrikeMs ? (.25 + .5 * hit.amp)
          * (1 - ease((age - restrikeMs) / (100 + 100 * hit.amp))) : 0;
        flash = hit.amp * Math.max(1 - ease(age / decayMs), echo) * amount;
      }
      if (hit) flashU = .18 + .64 * hash01(lo);
    }
    return { amount, flash, flashU, break01, wet01 };
  } });
}
const cache = new WeakMap();
export function stormAt(mgr, timeMs) {
  if (!mgr || mgr.terrainPreview) return EMPTY;
  const landscape = landscapeScoreFor(mgr);
  let hit = cache.get(mgr);
  if (!hit || hit.landscape !== landscape) {
    hit = { landscape, score: compileStorm({ energyCurves: mgr.energyCurves, timeline: mgr.conductor?.timeline || [], landscape }) };
    cache.set(mgr, hit);
  }
  const state = hit.score.at(timeMs);
  const override = mgr.stormOverride;
  if (override && typeof override === 'object') return { ...state, ...override, flash: unit(override.flash ?? state.flash) };
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
export function drawStormSky(ctx, canvas, storm, { tSec = 0, seed = 0, pan = null, light,
  cloudPainter = drawRangeClouds, cloudBankFactory = null } = {}) {
  const amount = unit(storm?.amount), breaking = unit(storm?.break01), flash = unit(storm?.flash);
  if (amount < .001 && breaking < .001) return;
  const { width: w, height: h } = canvas;
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
  const banks = cloudBankFactory ? cloudBankFactory()
    : rangeCloudBanks({ width: w, height: h, tSec: tSec * .6, seed: (seed % 9973) + 17, panPx: (pan?.x || 0) * w / 2, panYPx: -(pan?.y || 0) * h / 2, count: 14 });
  banks.forEach((b, i) => {
    // Camera culling changes the array ordinal, not a world's cloud identity.
    const identity = cloudBankFactory
      ? String(b.id).split('').reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) | 0, 0) : i;
    const remnant = breaking * smooth(.35, .75, hash01(identity + seed % 101)) * .9;
    b.alpha = Math.min(1, Math.max(amount, remnant) * (.75 + .25 * hash01(identity + 7)))
      * (cloudBankFactory ? b.alpha : 1);
    if (!cloudBankFactory) {
      b.w *= 1.9; b.h *= 1.6; b.y = h * (.03 + .22 * hash01(i + 3)) - (pan?.y || 0) * h / 2;
    }
  });
  const sun = breaking * (1 - amount);
  const mixRgb = (a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * sun));
  cloudPainter(ctx, banks, { dark: mixRgb([26, 31, 39], [104, 114, 128]), lit: mixRgb([70, 76, 86], [240, 228, 206]), light,
    directGain: .35 + sun * 1.2 });
  if (flash > .001) {
    // Lightning inside the cloud: the banks near the strike are painted
    // again in its light, so only the deck itself glows (no screen flash).
    const fx = ((storm.flashU ?? .5) + panX) * w, fy = h * .15, reach = w * .32;
    const lit = banks.map(b => ({ ...b, alpha: b.alpha * flash * Math.max(0, 1 - Math.hypot(b.x - fx, (b.y - fy) * 2) / reach) }))
      .filter(b => b.alpha > .01);
    cloudPainter(ctx, lit, { dark: [150, 168, 215], lit: [222, 232, 255], light: { x: fx, y: fy }, directGain: 1.2 });
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
      const k = rainCurtain((x + step * .5) / w - panX, tSec);
      if (k < .01) continue;
      ctx.globalAlpha = k * amount * .5;
      ctx.fillRect(x, top, step, bottom - top);
    }
  }
  ctx.restore();
}
