import { compileLandscapeScore, landscapeScoreFor } from './LandscapeScore.js';
// Musical weather episodes. All envelopes are evaluated at heard time; playback,
// pause, seeking and offline exports share exactly the same weather.
import { rangeCloudBanks, drawRangeClouds } from './RangeSkyComposition.js';
import { cameraBasis } from '../terrain/SceneTravel.js';
const unit = x => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
const ease = x => { const t = unit(x); return t * t * (3 - 2 * t); };
const EMPTY = Object.freeze({ amount: 0, flash: 0, flashU: .5, break01: 0, wet01: 0, kind: 1 });
const hash01 = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const smooth = (a, b, x) => ease((x - a) / (b - a));

/** Where rain curtains hang, across the sky (u: 0..1 of the frame's width
 *  in the sky's own coordinates), slowly drifting on the wind. Only the
 *  sky's no-camera fallback uses it; the world-anchored curtains are
 *  rainCurtainAz, whose GLSL twin is STORM_GLSL rainCurtainAz. */
export function rainCurtain(u, tSec = 0) {
  const a = .5 + .5 * Math.sin(6.2832 * (u * 1.6 + tSec * .003) + 1.3);
  const b = .5 + .5 * Math.sin(6.2832 * (u * 3.7 - tSec * .005) + 4.1);
  return smooth(.32, .86, a * .65 + b * .35);
}

const TAU = Math.PI * 2;
const fract = x => x - Math.floor(x);
/** The song seed folded to 0..1 exactly as RangeScene sets uRainSeed. */
export function rainSeed01(seed = 0) {
  const s = Number.isFinite(seed) ? Math.trunc(seed) % 9973 : 0;
  return (s < 0 ? s + 9973 : s) / 9973;
}
/** World-anchored rain curtains around the eye. az01 is the view ray's
 *  compass azimuth as a fraction of a turn (atan2(dx, -dz) / 2pi + .5, the
 *  tourSkyDirection convention). Integer cycles per revolution (8 and 19)
 *  leave no seam where the azimuth wraps; the seed only shifts the phases.
 *  The folded seed (rainSeed01) recovers the integer song seed in float32,
 *  so the GLSL twin (STORM_GLSL rainCurtainAz) computes the same phases. */
export function rainCurtainAz(az01, tSec = 0, seed = 0) {
  const k = Math.round(rainSeed01(seed) * 9973);
  const pa = TAU * fract(k * .6180339887), pb = TAU * fract(k * .7548776662 + .5);
  const a = .5 + .5 * Math.sin(TAU * (az01 * 8 + tSec * .003) + 1.3 + pa);
  const b = .5 + .5 * Math.sin(TAU * (az01 * 19 - tSec * .005) + 4.1 + pb);
  return smooth(.32, .86, a * .65 + b * .35);
}
/** Compass azimuth (0..1 of a turn) of each screen column's view ray, from
 *  the same pose selection the sky projector uses (frame.camera.tourPose,
 *  or the rail skyCamera from/to blend). Null without a camera. */
export function skyColumnAzimuth(camera) {
  const entries = camera?.tourPose ? [{ pose: camera.tourPose, aspect: camera.tourPose.aspect || 16 / 9 }]
    : [camera?.skyCamera?.from, camera?.skyCamera?.to].filter(Boolean);
  const prepared = entries.filter(e => e.pose?.eyeM && e.pose?.targetM && e.pose.fovYDeg > 0).map(e => {
    const { forward, right } = cameraBasis(e.pose), aspect = e.aspect || e.pose.aspect || 16 / 9;
    const tan = Math.tan(e.pose.fovYDeg * Math.PI / 360), { fx = 0, rx = 0 } = e.pose.viewOffset || {};
    return { forward, right, spread: tan * aspect, fx, rx: rx / (tan * aspect) };
  });
  if (!prepared.length || !prepared.every(e => e.forward.every(Number.isFinite) && e.right.every(Number.isFinite))) return null;
  const mix = prepared.length > 1 ? unit(camera?.skyCamera?.mix || 0) : 0;
  const one = (e, xFrac) => {
    // Inverse of projectSkyDirection's horizontal mapping, incl. view offset.
    const x = ((xFrac * 2 - 1) * (1 - e.fx) + e.rx) * e.spread;
    return Math.atan2(e.forward[0] + e.right[0] * x, -(e.forward[2] + e.right[2] * x));
  };
  return xFrac => {
    let az = one(prepared[0], xFrac);
    if (mix > 0) {
      const b = one(prepared[1], xFrac);
      az += (Math.atan2(Math.sin(b - az), Math.cos(b - az))) * mix;
    }
    return fract(az / TAU + .5);
  };
}
/** Where a lightning strike lights the frame, in the frame's own pixels.
 *  The sky glow, the land's flash key (uLightDir) and the rock stage's key
 *  all read this one point so they cannot drift apart. */
export function flashScreenPoint(storm, pan, w = 1, h = 1) {
  return { x: ((storm?.flashU ?? .5) + (pan?.x || 0) / 2) * w, y: h * .15 };
}

/** Shared by the terrain and forest shaders, which declare uStorm,
 *  uViewProj, uTime and uCameraPos. The rain hangs in the distance (it
 *  veils far land, not the near shore) inside the same curtains the sky
 *  draws; after the storm, broken cloud lets the sun through in swathes
 *  fixed to the land. */
export const STORM_GLSL = /* glsl */`
  uniform float uRainSeed;
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
  float rainCurtainAz(float az01, float t, float seed01) {
    float k = floor(seed01 * 9973.0 + 0.5);
    float pa = 6.283185307 * fract(k * 0.6180339887), pb = 6.283185307 * fract(k * 0.7548776662 + 0.5);
    float a = 0.5 + 0.5 * sin(6.283185307 * (az01 * 8.0 + t * 0.003) + 1.3 + pa);
    float b = 0.5 + 0.5 * sin(6.283185307 * (az01 * 19.0 - t * 0.005) + 4.1 + pb);
    return smoothstep(0.32, 0.86, a * 0.65 + b * 0.35);
  }
  // World-anchored: the curtain at this point's compass azimuth from the
  // eye, the same curtain the sky draws along that view ray.
  float rainVeil(vec3 world, float dist) {
    if (uStorm.x < 0.001 || dist < 2500.0) return 0.0;
    vec2 d = world.xz - uCameraPos.xz;
    float az01 = atan(d.x, -d.y) / 6.283185307 + 0.5;
    return uStorm.x * rainCurtainAz(az01, uTime, uRainSeed) * smoothstep(2500.0, 14000.0, dist);
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
/** Each weather episode's character, fixed at compile time from its own
 *  frozen fields (stormKind): 0 shower, 1 downpour, 2 thunderstorm. Rows:
 *  the sky's overcast gradient (drawStormSky), the deck's dark/lit tint,
 *  and the GPU scene's linear zenith/horizon/air (RangeScene). Downpour is
 *  the original squall exactly. Every row stays slate (hue ~210-220deg),
 *  clear of the protected Midio cyan, #ff4d4d and #ffd75e. */
export const STORM_KINDS = Object.freeze([
  Object.freeze({ name: 'shower', maxStrength: .6,
    skyTop: Object.freeze([52, 60, 70]), skyBottom: Object.freeze([104, 113, 122]),
    deckDark: Object.freeze([46, 52, 61]), deckLit: Object.freeze([98, 105, 115]),
    zenith: Object.freeze({ r: .036, g: .044, b: .056 }), horizon: Object.freeze({ r: .052, g: .062, b: .074 }),
    air: Object.freeze({ r: .048, g: .058, b: .07 }) }),
  Object.freeze({ name: 'downpour', maxStrength: 1,
    skyTop: Object.freeze([30, 36, 45]), skyBottom: Object.freeze([78, 88, 98]),
    deckDark: Object.freeze([26, 31, 39]), deckLit: Object.freeze([70, 76, 86]),
    zenith: Object.freeze({ r: .02, g: .026, b: .036 }), horizon: Object.freeze({ r: .03, g: .038, b: .05 }),
    air: Object.freeze({ r: .028, g: .036, b: .048 }) }),
  Object.freeze({ name: 'thunderstorm', maxStrength: 1,
    skyTop: Object.freeze([19, 25, 36]), skyBottom: Object.freeze([58, 68, 84]),
    deckDark: Object.freeze([15, 20, 30]), deckLit: Object.freeze([48, 56, 72]),
    zenith: Object.freeze({ r: .012, g: .017, b: .028 }), horizon: Object.freeze({ r: .019, g: .026, b: .04 }),
    air: Object.freeze({ r: .018, g: .025, b: .038 }) }),
]);
/** A row of STORM_KINDS for a storm state (downpour when unknown). */
export const stormKindRow = storm => STORM_KINDS[storm?.kind] || STORM_KINDS[1];
/** An episode's character from its own strikes and energy: lightning-dense
 *  loud weather is a thunderstorm, a nearly strike-free one a shower. */
export function stormKind(episode) {
  const minutes = Math.max(1e-6, (episode.endMs - episode.startMs) / 60000);
  const strikes = (episode.strikes || []).filter(s => s.tMs >= episode.startMs && s.tMs <= episode.endMs).length;
  const density = strikes / minutes;
  if (density >= 6 && episode.energy01 >= .7) return 2;
  return density < 1.5 ? 0 : 1;
}
const KIND_MEMO = new WeakMap();
export function compileStorm({ energyCurves, sections = [], timeline = [], durationMs = 0, landscape = null,
  previous = null, committedThroughMs = -1 } = {}) {
  landscape ||= compileLandscapeScore({ energyCurves, sections, timeline, durationMs, previous, committedThroughMs });
  const episodes = landscape.episodes;
  const strongest = [...episodes].sort((a, b) => b.energy01 - a.energy01 || a.startMs - b.startMs)[0];
  const section = strongest ? Object.freeze({ startMs: strongest.startMs, endMs: strongest.endMs }) : null;
  const strikes = episodes.flatMap(e => e.strikes);
  // Classified once from frozen episode fields. A song with no percussion
  // evidence at all (no strike anywhere) keeps the downpour it had before
  // kinds existed. The first classification is remembered on the episode's
  // frozen strike list, which adopted (protected) episodes keep, so heard
  // weather never changes character when later analysis arrives.
  const evidence = strikes.length > 0;
  const kinds = Object.freeze(episodes.map(e => {
    const known = e.strikes && KIND_MEMO.get(e.strikes);
    if (known != null) return known;
    const kind = evidence ? stormKind(e) : 1;
    if (e.strikes && Object.isFrozen(e.strikes)) KIND_MEMO.set(e.strikes, kind);
    return kind;
  }));
  const strikeKinds = Object.freeze(episodes.flatMap((e, i) => e.strikes.map(() => kinds[i])));
  return Object.freeze({ section, episodes, kinds, landscape, at(timeMs) {
    const t = Number.isFinite(timeMs) ? timeMs : 0;
    let amount = 0, break01 = 0, wet01 = 0, kind = 0, kindBreak = 0, breakKind = -1;
    for (let i = 0; i < episodes.length; i++) {
      const { startMs: a, endMs: b, energy01 } = episodes[i];
      const strength = Math.min(STORM_KINDS[kinds[i]].maxStrength, 1, Math.max(.35, (energy01 - .5) * 3));
      const own = strength * ease((t - a + 6000) / 8000) * (1 - ease((t - b) / 4000));
      if (own > amount) { amount = own; kind = kinds[i]; }
      const broken = ease((t - b - 2000) / 6000) * (1 - ease((t - b - 14000) / 20000));
      if (broken > kindBreak) { kindBreak = broken; breakKind = kinds[i]; }
      break01 = Math.max(break01, broken);
      wet01 = Math.max(wet01, ease((t - a) / 6000) * (1 - ease((t - b) / 45000)));
    }
    // With no deck overhead, the clearing keeps its own storm's character.
    if (!(amount > 0) && breakKind >= 0) kind = breakKind;
    let flash = 0, flashU = .5;
    if (amount > .2) {
      let lo = 0, hi = strikes.length;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (strikes[m].tMs <= t) lo = m + 1; else hi = m; }
      // A shower never flashes, whatever strikes a later storm owns.
      if (strikeKinds[lo - 1] === 0) lo = 0;
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
    return { amount, flash, flashU, break01, wet01, kind };
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
  const columnAz = skyColumnAzimuth(pan);
  ctx.save();
  // Overcast: slate from the zenith down to the rain-dimmed horizon, dense
  // enough to hide the sun. The land's air (STORM_KINDS air, RangeScene) meets it.
  const row = stormKindRow(storm);
  const dark = ctx.createLinearGradient(0, 0, 0, h * .62);
  dark.addColorStop(0, `rgba(${row.skyTop.join(',')},${amount * .96})`);
  dark.addColorStop(1, `rgba(${row.skyBottom.join(',')},${amount * .9})`);
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
  cloudPainter(ctx, banks, { dark: mixRgb(row.deckDark, [104, 114, 128]), lit: mixRgb(row.deckLit, [240, 228, 206]), light,
    directGain: .35 + sun * 1.2 });
  if (flash > .001) {
    // Lightning inside the cloud: the banks near the strike are painted
    // again in its light, so only the deck itself glows (no screen flash).
    const { x: fx, y: fy } = flashScreenPoint(storm, pan, w, h), reach = w * .32;
    const lit = banks.map(b => ({ ...b, alpha: b.alpha * flash * Math.max(0, 1 - Math.hypot(b.x - fx, (b.y - fy) * 2) / reach) }))
      .filter(b => b.alpha > .01);
    cloudPainter(ctx, lit, { dark: [150, 168, 215], lit: [222, 232, 255], light: { x: fx, y: fy }, directGain: 1.2, variant: 'flash' });
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
      // Each column's view ray finds its world curtain (as the land's veil
      // does); without a camera (fixtures) the old frame-width curtain.
      const k = columnAz ? rainCurtainAz(columnAz((x + step * .5) / w), tSec, seed)
        : rainCurtain((x + step * .5) / w - panX, tSec);
      if (k < .01) continue;
      ctx.globalAlpha = k * amount * .5;
      ctx.fillRect(x, top, step, bottom - top);
    }
  }
  ctx.restore();
}
