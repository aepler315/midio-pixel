import { CanvasBuffers } from '../../render/CanvasResidency.js';
import { cameraBasis } from '../terrain/SceneTravel.js';
import { projectSkyDirection, tourSkyDirection } from './RangeSkyComposition.js';
import { CelestialPainter } from './CelestialPainter.js';
import { drawStormSky } from './RangeStorm.js';
import { LightningFX } from '../Lightning.js';
import { cloudBanks } from './RangeCloudField.js';
import { buildCloudTexture } from './RangeCloudTexture.js';
import { sampleSkyPerformance } from './SkyPerformance.js';
export { cloudDensity } from './RangeCloudTexture.js';

const TAU = Math.PI * 2;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
/** Visible lunar area; exact new/full phases need no artificial floor. */
export function moonIllumination(phase) {
  return Number.isFinite(phase) ? .5 - .5 * Math.cos(TAU * clamp(phase)) : 0;
}
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const fract = x => x - Math.floor(x);
/** Seconds over which the Milky Way eases in or out across the q3 rung. */
const MILKY_FADE_SEC = 1.5;
/** Flash-lit storm sprites kept beside the deck tints (LRU). */
const FLASH_TINT_POOL = 8;
const hash = (x, y, seed) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
};
function noise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), a = smooth(x - ix), b = smooth(y - iy);
  const top = hash(ix, iy, seed) * (1 - a) + hash(ix + 1, iy, seed) * a;
  const bottom = hash(ix, iy + 1, seed) * (1 - a) + hash(ix + 1, iy + 1, seed) * a;
  return top * (1 - b) + bottom * b;
}

/** Sky content shares the resolved terrain camera, lens and pointer crop.
 * Eye translation has no effect on objects at celestial distance. */
export function skyProjector(camera) {
  const entries = camera?.tourPose ? [{ pose: camera.tourPose, aspect: camera.tourPose.aspect || 16 / 9 }]
    : [camera?.skyCamera?.from, camera?.skyCamera?.to].filter(Boolean);
  if (!entries.length) return null;
  const prepared = entries.map(c => ({ ...c, projection: {
    basis: cameraBasis(c.pose), tan: Math.tan(c.pose.fovYDeg * Math.PI / 360),
  } }));
  const mix = camera?.skyCamera?.mix || 0;
  const one = (entry, direction) => ({
    ...projectSkyDirection(entry.pose, direction, entry.aspect, entry.projection),
    inFront: direction.reduce((sum, v, i) => sum + v * entry.projection.basis.forward[i], 0) > 0,
  });
  const project = direction => {
    const a = one(prepared[0], direction);
    if (prepared.length < 2 || !mix) return a;
    const b = one(prepared[1], direction);
    // Never interpolate through the sentinel for a point behind one view.
    if (!a.inFront || !b.inFront) return mix < .5 ? a : b;
    const xFrac = a.xFrac + (b.xFrac - a.xFrac) * mix;
    const yFrac = a.yFrac + (b.yFrac - a.yFrac) * mix;
    return { xFrac, yFrac, inFront: true, visible: xFrac > -.1 && xFrac < 1.1 && yFrac > -.1 && yFrac < 1.1 };
  };
  const focal = c => 1 / (2 * c.projection.tan * (1 - (c.pose.viewOffset?.fx || 0)));
  project.focal = focal(prepared[0]) * (1 - mix) + focal(prepared[1] || prepared[0]) * mix;
  project.forward = prepared[mix >= .5 && prepared.length > 1 ? 1 : 0].projection.basis.forward;
  return project;
}

/** A fixed, repeatable sphere, with a richer band of faint galactic stars.
 * Bright objects are uncommon; no positions are integrated frame to frame. */
export function createSkyCatalogue(seed, count = 4000) {
  return Array.from({ length: count }, (_, i) => {
    const az = hash(i, 0, seed) * 360;
    const alt = i % 3 ? Math.asin(hash(i, 1, seed)) * 180 / Math.PI
      : 31 + 25 * Math.sin(az * Math.PI / 180 + .5) + (hash(i, 2, seed) - .5) * 15;
    const bright = hash(i, 3, seed) ** 5;
    return { direction: tourSkyDirection(az, alt), brightness: .12 + .88 * bright,
      radius: .35 + .85 * bright, phase: hash(i, 4, seed) * TAU, color: Math.floor(hash(i, 5, seed) * 5),
      glintFamily: Math.floor(hash(i, 11, seed) * 32) };
  });
}

const STAR_COLORS = ['190,210,255', '218,229,255', '245,244,231', '255,226,188', '217,231,255'];

// A fixed field of overlapping, faint stellar clouds along the same band as
// the star catalogue. The dim central channel suggests obscuring dust without
// painting black over the sky or stars. No texture or frame history is kept.
export function createGalacticClouds(seed) {
  return Array.from({ length: 432 }, (_, i) => {
    const az = (i % 144) * 2.5 + (hash(i, 6, seed) - .5) * 3;
    const lane = Math.sin(az * Math.PI / 72 + .7) * 2;
    const offset = (Math.floor(i / 144) - 1) * 5 + (hash(i, 7, seed) - .5) * 5;
    const alt = 31 + 25 * Math.sin(az * Math.PI / 180 + .5) + offset;
    const dust = .2 + .8 * smooth(Math.abs(offset - lane) / 4);
    return { direction: tourSkyDirection(az, alt), opacity: (.32 + .68 * hash(i, 8, seed)) * dust,
      radius: .095 + .035 * hash(i, 9, seed), warm: hash(i, 10, seed) > .7 };
  });
}

// Three premultiplied cloud colours share one density: cool volume, warm
// left light, warm right light. Continuous weights preserve its exact alpha
// without direction buckets, frame history or rebuilding the optical field.
export function cinematicCloudWeights(bank, frame, width, height) {
  const m = bank.matrix, sun = frame.sun;
  if (!m?.every(Number.isFinite) || !sun || sun.visible === false || !(sun.altitude01 > .005)) return [1, 0, 0];
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-8 || !Number.isFinite(sun.xFrac) || !Number.isFinite(sun.yFrac)) return [1, 0, 0];
  const dx = sun.xFrac * width - m[4], dy = sun.yFrac * height - m[5];
  const x = (m[3] * dx - m[2] * dy) / det, y = (-m[1] * dx + m[0] * dy) / det;
  const right = .5 + .5 * x / Math.hypot(x, y, .5);
  const light = .82 * (1 - clamp(frame.night || 0)) * clamp(sun.visibility ?? 1)
    * clamp(frame.light?.intensity ?? 1) * (1 - .85 * clamp(frame.storm?.amount || 0));
  return [1 - light, light * (1 - right), light * right];
}

function skyTint(hex, target, amount) {
  const match = /^#([a-f\d]{3}|[a-f\d]{6})$/i.exec(hex || '');
  if (!match) return hex;
  const raw = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1];
  const value = parseInt(raw, 16);
  return `rgb(${target.map((channel, i) => Math.round(((value >>> (16 - i * 8)) & 255) * (1 - amount) + channel * amount)).join(',')})`;
}

/** Full-resolution sky experiment. Cached density/albedo images are small,
 * accounted CanvasBuffers; the destination belongs to the presenter.
 * This painter never reads terrain pixels or changes the terrain grid. */
export class RangeSkyRenderer {
  constructor({ residency, makeCanvas } = {}) {
    this.buffers = new CanvasBuffers({ residency, makeCanvas, owner: 'range-sky-detail' });
    this.seed = null;
    this.stars = [];
    this.galacticClouds = [];
    this.painted = new WeakSet();
    this.stormTints = new WeakMap();
    this.cloudCache = new Map();
    this.flashCache = new Map();
    this.celestial = new CelestialPainter({ buffers: this.buffers });
    // The Milky Way's eased presence across quality rungs (heard time).
    this._milkyFade = NaN;
    this._milkyAtSec = NaN;
    this._milkyTarget = NaN;
  }
  _seed(seed) {
    if (seed === this.seed) return;
    this.seed = seed;
    this.stars = createSkyCatalogue(seed);
    this.galacticClouds = createGalacticClouds(seed);
    this.buffers.dispose();
    this.painted = new WeakSet();
    this.stormTints = new WeakMap();
    this.cloudCache = new Map();
    this.flashCache = new Map();
    this.celestial.reset();
  }
  _cloud(index) {
    // Stable world identities replace the six repeating stamps. Evict both
    // density and tint together; seed changes and disposal clear ownership.
    this.cloudCache.delete(index);
    this.cloudCache.set(index, true);
    if (this.cloudCache.size > 48) {
      const oldest = this.cloudCache.keys().next().value;
      this.cloudCache.delete(oldest);
      this.buffers.release(`cloud-${oldest}`);
      this.buffers.release(`storm-cloud-${oldest}`);
      this.buffers.release(`cinematic-cloud-${oldest}`);
      if (this.flashCache.delete(oldest)) this.buffers.release(`storm-flash-cloud-${oldest}`);
    }
    const canvas = this.buffers.ensure(`cloud-${index}`, 192, 128);
    if (!canvas || this.painted.has(canvas)) return canvas;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(canvas.width, canvas.height);
    const seed = this.seed + index * 71;
    image.data.set(buildCloudTexture(seed, canvas.width, canvas.height));
    ctx.putImageData(image, 0, 0);
    this.painted.add(canvas);
    return canvas;
  }
  /** Return optional storage before terrain streaming reserves its next
   * window, including frames that cannot reach the final sky composite. */
  setQualityLevel(level = 0) {
    if (level >= 2) this._setCinematic(false);
  }
  _setCinematic(enabled) {
    if (enabled === this._cinematicActive) return;
    this._cinematicActive = enabled;
    if (!enabled) for (const name of this.buffers.buffers.keys()) {
      if (name.startsWith('cinematic-')) this.buffers.release(name);
    }
  }
  _cinematicCloud(index, density) {
    // The whole variant bundle is admitted together. A denied allocation
    // leaves this frame's established density available to the caller.
    const images = this.buffers.ensure(`cinematic-cloud-${index}`, 192, 128, 3);
    if (!images || this.painted.has(images[0])) return images;
    for (const [variant, image] of images.entries()) {
      const target = image.getContext('2d');
      target.clearRect(0, 0, image.width, image.height);
      target.globalAlpha = 1; target.globalCompositeOperation = 'source-over';
      const from = variant === 2 ? image.width : 0;
      const to = variant === 1 ? image.width : 0;
      const gradient = target.createLinearGradient(from, 0, to, image.height);
      gradient.addColorStop(0, variant ? 'rgb(255,247,228)' : 'rgb(215,226,240)');
      gradient.addColorStop(1, variant ? 'rgb(181,202,227)' : 'rgb(150,172,201)');
      target.fillStyle = gradient; target.fillRect(0, 0, image.width, image.height);
      target.globalCompositeOperation = 'multiply'; target.drawImage(density, 0, 0);
      target.globalCompositeOperation = 'destination-in'; target.drawImage(density, 0, 0);
      target.globalCompositeOperation = 'source-over';
      this.painted.add(image);
    }
    return images;
  }
  _mixCinematicCloud(images, weights, canvas) {
    const target = canvas.getContext('2d');
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, canvas.width, canvas.height);
    target.globalCompositeOperation = 'lighter';
    for (const [i, image] of images.entries()) {
      target.globalAlpha = weights[i]; target.drawImage(image, 0, 0);
    }
    target.globalCompositeOperation = 'source-over'; target.globalAlpha = 1;
    return canvas;
  }
  draw(ctx, frame) {
    const project = skyProjector(frame.camera);
    if (!project) return false;
    this._seed(frame.seed);
    // Shed the optional tinted volumes with near tree detail. The grade,
    // stars, aurora and established cloud densities retain the selected look.
    const cinematicClouds = !!frame.cinematicPixel && (frame.qualityLevel ?? 0) < 2;
    this._setCinematic(cinematicClouds);
    const width = frame.sourceWidth, height = frame.sourceHeight;
    const night = clamp(frame.night), time = frame.timeSec;
    const performance = sampleSkyPerformance(frame.effects, frame.qualityLevel ?? 0);
    ctx.save();
    // Pixel terrain presentation leaves nearest-neighbor sampling enabled.
    // Sky density/albedo textures belong to the smooth output layer.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const horizontal = [project.forward[0], 0, project.forward[2]];
    const horizon = project(horizontal);
    const horizonY = clamp(horizon.yFrac, -.3, 1.8) * height;
    const gradient = ctx.createLinearGradient(0, Math.min(-height * .4, horizonY - height), 0, Math.max(height * .2, horizonY + height * .25));
    gradient.addColorStop(0, frame.cinematicPixel ? skyTint(frame.colors.top, [11, 27, 53], .16 - .08 * night) : frame.colors.top);
    gradient.addColorStop(.65, frame.cinematicPixel ? skyTint(frame.colors.mid, [66, 106, 146], .07 * (1 - night)) : frame.colors.mid);
    gradient.addColorStop(1, frame.colors.horizon);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
    // Dusk and dawn burn around the (possibly set) sun, under every layer.
    if (frame.twilight) this._twilightGlow(ctx, project, width, height, frame);
    // The moon is screened onto the sky with no backing disc, so the stars
    // it covers are cut out here instead of painted over.
    this.celestial.prepareMoon(frame.moon, width, height, night, frame.phase);
    if (performance) this._musicAtmosphere(ctx, project, width, height, night, performance);
    // Shedding the Milky Way at q3 eases over 1.5 s instead of popping.
    const milky = this._milkyFadeAt(frame);
    if (milky > 0) {
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha * milky;
      this._milkyWay(ctx, project, width, height, night, frame.storm);
      ctx.globalAlpha = alpha;
    }
    // Output pixels per sky unit: hairlines and the moon texture's resolution.
    const matrix = ctx.getTransform?.();
    const outputScale = matrix ? Math.hypot(matrix.a, matrix.b) || 1 : 1;
    if (performance) {
      this._stars(ctx, project, width, height, night, time, !!frame.cinematicPixel, this.celestial.disc, performance);
      this._aurora(ctx, project, width, height, night, time, frame.authority, !!frame.cinematicPixel, performance);
      this._streaks(ctx, project, width, height, night, performance, outputScale);
    } else {
      this._stars(ctx, project, width, height, night, time, !!frame.cinematicPixel);
      this._aurora(ctx, project, width, height, night, time, frame.authority, !!frame.cinematicPixel);
    }
    if (frame.lightning) LightningFX.prototype.draw.call(frame.lightning, ctx, { width, height }, frame.timeSec * 1000);
    this._bodies(ctx, frame, width, height, night, outputScale, performance);
    this._clouds(ctx, frame.camera, width, height, night, time, frame.storm, cinematicClouds ? frame : null);
    // Keep the existing heard-time storm score and triggered bolts. Only
    // their target and the cloud shape change; terrain wetness stays native.
    drawStormSky(ctx, { width, height }, frame.storm, { tSec: frame.timeSec, seed: frame.seed, pan: frame.camera,
      light: frame.light,
      cloudBankFactory: () => cloudBanks({ camera: frame.camera, width, height,
        timeSec: frame.timeSec, seed: frame.seed, storm: true }),
      cloudPainter: (target, banks, options) => this._stormClouds(target, banks, options) });
    this._veiledBodies(ctx, frame, width, height, night);
    ctx.restore();
    return true;
  }
  /** The Milky Way's presence: 1 below q3, 0 from it, eased over 1.5 s of
   *  heard time. A repeated time (pause, the water mirror's second draw)
   *  holds; a seek, the first frame or a backwards step snaps. A rung
   *  change at an unchanged heard time (a paused preset change) has no
   *  time to ease over, so it snaps too. */
  _milkyFadeAt(frame) {
    const target = (frame.qualityLevel ?? 0) < 3 ? 1 : 0, at = frame.timeSec;
    const dt = at - this._milkyAtSec, current = this._milkyFade, retarget = target !== this._milkyTarget;
    this._milkyAtSec = at; this._milkyTarget = target;
    if (Number.isFinite(current) && dt === 0 && !retarget) return current;
    if (!Number.isFinite(current) || !(dt > 0 && dt <= .5)) return (this._milkyFade = target);
    const step = dt / MILKY_FADE_SEC;
    return (this._milkyFade = current < target ? Math.min(target, current + step) : Math.max(target, current - step));
  }
  /** Twilight in the high-resolution sky (frame.twilight, BiomeManager's
   *  frozen copy of DayNight's twilightAt): a warm glow on the horizon
   *  around the sun's azimuth, also while it is still below the horizon,
   *  plus the antisolar Belt of Venus for headings that face away from it.
   *  Absent or faint twilight paints nothing at all. */
  _twilightGlow(ctx, project, width, height, frame) {
    const tw = frame.twilight, amount = clamp(tw?.amount01 || 0);
    if (amount <= .01) return;
    const storm = clamp(frame.storm?.amount || 0), clear = 1 - storm;
    const f = project.forward, dir = frame.sun?.worldDirection;
    const az = dir && Number.isFinite(dir[0]) && Number.isFinite(dir[2]) && (dir[0] || dir[2])
      ? Math.atan2(dir[0], -dir[2]) * 180 / Math.PI : null;
    const sunAlt = clamp(frame.sun?.altitude01 || 0);
    // drawSun's glare takes over as the sun climbs: no double brightening.
    const alpha = .55 * amount * (1 - .6 * smooth(sunAlt / .12)) * clear * (frame.cinematicPixel ? .7 : 1);
    let x = null, y = null;
    if (az !== null) {
      const p = project(tourSkyDirection(az, 2));
      if (p.inFront) { x = p.xFrac * width; y = p.yFrac * height; }
    } else {
      const xFrac = Number.isFinite(tw.xFrac) ? tw.xFrac : frame.sun?.xFrac;
      if (Number.isFinite(xFrac)) {
        x = clamp(xFrac, -.2, 1.2) * width;
        const ahead = f && (f[0] || f[2]) ? project(tourSkyDirection(Math.atan2(f[0], -f[2]) * 180 / Math.PI, 2)) : null;
        y = ahead?.inFront && Number.isFinite(ahead.yFrac) ? ahead.yFrac * height : height * .62;
      }
    }
    if (x !== null && Number.isFinite(x) && Number.isFinite(y) && alpha > .001) {
      const r = clamp(.7 * width * (project.focal ?? 1), .35 * width, 1.1 * width);
      const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r), y0 = Math.max(0, y - r), y1 = Math.min(height, y + r);
      if (x1 > x0 && y1 > y0) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
        glow.addColorStop(0, tw.glow); glow.addColorStop(.35, tw.horizon); glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save();
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha;
        ctx.fillStyle = glow; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.restore();
      }
    }
    // The Belt of Venus: pink over the blue-grey earth shadow, opposite the
    // sun. Only the tour projection knows where that is.
    const belt = .22 * amount * clear;
    if (az === null || belt < .002 || !f) return;
    const anti = project(tourSkyDirection(az + 180, 4));
    if (!anti.inFront || !Number.isFinite(anti.xFrac)) return;
    const horizon = project([f[0], 0, f[2]]);
    const base = clamp(Number.isFinite(horizon.yFrac) ? horizon.yFrac : .62, -.3, 1.8) * height;
    // About +-60 degrees of horizon, never narrower than 0.9 of the frame.
    const half = Math.max(.45 * width, 1.05 * (project.focal ?? 1) * height), cx = anti.xFrac * width;
    const x0 = Math.max(0, cx - half), x1 = Math.min(width, cx + half);
    const top = base - .12 * height, y0 = Math.max(0, top), y1 = Math.min(height, base);
    if (!(x1 > x0 && y1 > y0)) return;
    const band = ctx.createLinearGradient(0, top, 0, base);
    band.addColorStop(0, 'rgba(232,170,190,0)'); band.addColorStop(.45, `rgba(232,170,190,${belt})`);
    band.addColorStop(1, `rgba(120,130,160,${belt})`);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = band; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }
  /** A rare night meteor for a strong melody note (or any note in a lift):
   *  one stroked line whose head moves fast and then slows, its tail lagging,
   *  all a pure function of the note's heard age. The moon paints over it. */
  _streaks(ctx, project, width, height, night, performance, outputScale = 1) {
    const streak = performance?.streaks?.[0];
    if (!streak) return;
    const a = smooth((night - .3) / .5) * performance.detail * clamp(streak.strength);
    if (a < .005) return;
    const seed = streak.seed, az = seed * 360, alt = 12 + 16 * fract(seed * 7.3);
    const side = fract(seed * 13.1) < .5 ? -1 : 1;
    // Most of the travel in the first quarter second.
    const p = 1 - (1 - clamp(streak.age / .45)) ** 3, q = p * .35;
    const head = project(tourSkyDirection(az + side * 9 * p, alt - 4 * p));
    const tail = project(tourSkyDirection(az + side * 9 * q, alt - 4 * q));
    if (!head.inFront || !tail.inFront) return;
    const hx = head.xFrac * width, hy = head.yFrac * height, tx = tail.xFrac * width, ty = tail.yFrac * height;
    if (Math.max(hx, tx) < 0 || Math.min(hx, tx) > width || Math.max(hy, ty) < 0 || Math.min(hy, ty) > height) return;
    const trail = ctx.createLinearGradient(hx, hy, tx, ty);
    trail.addColorStop(0, `rgba(235,240,255,${clamp(a)})`); trail.addColorStop(1, 'rgba(235,240,255,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = trail; ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(.5 / outputScale, height * .0016);
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.restore();
  }
  _milkyWay(ctx, project, width, height, night, storm, moon = this.celestial.disc) {
    const strength = smooth((night - .3) / .6) * (1 - .8 * clamp(storm?.amount || 0));
    if (strength < .005 || !Number.isFinite(project.focal)) return;
    const paint = opacity => {
      if (opacity <= 0) return;
      for (const cloud of this.galacticClouds) {
        const p = project(cloud.direction);
        if (!p.inFront) continue;
        const x = p.xFrac * width, y = p.yFrac * height;
        const r = cloud.radius * height * project.focal;
        if (!(r > 0) || x + r < 0 || x - r > width || y + r < 0 || y - r > height) continue;
        const color = cloud.warm ? '203,187,175' : '180,199,224';
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
        gradient.addColorStop(0, `rgba(${color},${.025 * strength * opacity * cloud.opacity})`);
        gradient.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = gradient; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    };
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const cover = moon?.visible ? clamp(moon.cover) : 0;
    paint(1 - cover);
    if (cover > 0) {
      // The lunar image is screened over the sky, so mask its background in
      // the same way as the discrete stars, including partial disc fades.
      ctx.beginPath(); ctx.rect(0, 0, width, height);
      ctx.arc(moon.x, moon.y, moon.r * 1.04, 0, TAU);
      ctx.clip('evenodd');
      paint(cover);
    }
    ctx.restore();
  }
  /** `moon`: the disc the stars behind are cut out for (this frame's, prepared before). */
  _stars(ctx, project, width, height, night, time, cinematic = false, moon = this.celestial.disc, performance = null) {
    // As the sky brightens the faint points disappear instead of lingering
    // as daytime specks. The catalogue stays fixed across time and seeks.
    const strength = smooth((night - .12) / .78) * (cinematic ? .85 : 1);
    if (strength < .01) return;
    // Stars behind the moon fade with its disc and vanish once it is whole.
    const occluded = !!moon?.visible, mx = occluded ? moon.x : 0, my = occluded ? moon.y : 0;
    const reach = occluded ? moon.r * moon.r * 1.0816 : 0, cover = occluded ? moon.cover : 0; // (1.04 R)^2
    const matrix = ctx.getTransform?.();
    const outputScale = matrix ? Math.hypot(matrix.a, matrix.b) || 1 : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const star of this.stars) {
      const p = project(star.direction);
      if (!p.visible) continue;
      const x = p.xFrac * width, y = p.yFrac * height;
      let shown = strength;
      if (occluded) {
        const dx = x - mx, dy = y - my;
        if (dx * dx + dy * dy < reach) {
          if (cover > .99) continue;
          shown *= 1 - cover;
        }
      }
      // Atmospheric scintillation is strongest near the horizon. Two slow,
      // incommensurate oscillations avoid a synchronized blinking pattern.
      const air = 1 - clamp(star.direction[1]);
      const scintillation = 1 - .07 * air + .07 * air *
        (.65 * Math.sin(time * 1.3 + star.phase) + .35 * Math.sin(time * 2.17 + star.phase * 2));
      const glint = performance?.glints[star.glintFamily] || 0;
      const radius = Math.max(.28 / outputScale, star.radius * height / 1000) * (1 + 1.8 * glint);
      ctx.fillStyle = `rgba(${STAR_COLORS[star.color]},${shown * clamp(star.brightness * scintillation + glint * .9)})`;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
      if (star.brightness > .7 || glint > .08) {
        const halo = ctx.createRadialGradient(x, y, 0, x, y, radius * 5);
        halo.addColorStop(0, `rgba(${STAR_COLORS[star.color]},${shown * (star.brightness * .15 + glint * .3)})`);
        halo.addColorStop(1, `rgba(${STAR_COLORS[star.color]},0)`);
        ctx.fillStyle = halo; ctx.fillRect(x - radius * 5, y - radius * 5, radius * 10, radius * 10);
      }
      if (glint > .35) {
        const reach = radius * (2 + 3 * glint), thin = .5 / outputScale;
        ctx.fillStyle = `rgba(${STAR_COLORS[star.color]},${shown * glint * .26})`;
        ctx.fillRect(x - reach, y - thin / 2, reach * 2, thin);
        ctx.fillRect(x - thin / 2, y - reach * .65, thin, reach * 1.3);
      }
    }
    ctx.restore();
  }
  _aurora(ctx, project, width, height, night, time, authority = 1, cinematic = false, performance = null) {
    const open = performance?.open || 0, folding = performance?.fold || 0, travel = performance?.travel || 0;
    const alpha = smooth((night - .18) / .7) * (.045 + .035 * clamp(authority)) * (cinematic ? .6 : 1)
      * (1 + (performance?.radiance || 0) * 3.4);
    if (alpha < .005) return;
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    for (let sheet = 0; sheet < 2; sheet++) {
      const sample = az => {
        const wave = Math.sin(az * .052 + sheet + time * .025) + .32 * Math.sin(az * .17 - time * .018)
          + folding * Math.sin(az * .095 - time * .65 + sheet) * 1.7 + travel * Math.cos(az * .06 + sheet);
        const base = 9 + sheet * 7 + wave * 3 + open * (1 + 2 * Math.sin(az * .035 + sheet));
        const top = base + 12 + 7 * (.5 + .5 * Math.sin(az * .081 + time * .013))
          + open * (9 + 7 * Math.sin(az * .045 + sheet + travel)) + (performance?.lift || 0) * 5;
        const a = project(tourSkyDirection(az, base)), b = project(tourSkyDirection(az, top));
        return { az, x: a.xFrac * width, y: a.yFrac * height, tx: b.xFrac * width, ty: b.yFrac * height,
          visible: a.inFront && b.inFront };
      };
      const paint = (previous, current, depth = 0) => {
        if (!previous.visible || !current.visible) return;
        const xs = [previous.x, previous.tx, current.x, current.tx];
        const ys = [previous.y, previous.ty, current.y, current.ty];
        if (Math.max(...xs) < 0 || Math.min(...xs) > width || Math.max(...ys) < 0 || Math.min(...ys) > height) return;
        // Narrow tour lenses magnify a fixed angular step enormously. Refine
        // only visible curtain pieces; the world scaffold and depth cap bound
        // CPU cost independently of the camera's lens and output resolution.
        const spacing = Math.max(Math.hypot(current.x - previous.x, current.y - previous.y),
          Math.hypot(current.tx - previous.tx, current.ty - previous.ty));
        if (spacing > 8 && depth < 6) {
          const middle = sample((previous.az + current.az) / 2);
          paint(previous, middle, depth + 1); paint(middle, current, depth + 1);
        } else {
          const az = (previous.az + current.az) / 2;
          const middle = sample(az), seed = (this.seed || 0) + sheet * 91;
          const fold = .3 + .7 * noise(az * .14 + time * .015 + travel * .5, sheet * 13, seed + 51);
          const ray = smooth((noise(az * 1.35 + time * .012, sheet * 7 + 4, seed + 81) - .2) / .6);
          const emission = alpha * fold * (.12 + .88 * ray * ray);
          const gradient = ctx.createLinearGradient(middle.x, middle.y, middle.tx, middle.ty);
          // Emission grows inside the ray and dissipates at BOTH ends. A
          // nonzero first stop made the old filled sheet a hard blue ribbon.
          gradient.addColorStop(0, 'rgba(108,246,181,0)');
          gradient.addColorStop(.14, `rgba(108,246,181,${emission * .6})`);
          gradient.addColorStop(.32, `rgba(65,211,176,${emission})`);
          gradient.addColorStop(.7, `rgba(115,125,216,${emission * .12})`);
          gradient.addColorStop(1, 'rgba(158,104,202,0)');
          ctx.strokeStyle = gradient; ctx.lineCap = 'round';
          const width = Math.max(.5, Math.min(6, spacing * .7)) * (.6 + .4 * ray);
          // Soft surrounding emission and a narrower ray share world-space
          // endpoints. No filled panels, blur filters or frame-sized buffers.
          for (const [rayWidth, gain] of [[Math.min(14, width * 2.3), .25], [width, .85]]) {
            ctx.lineWidth = rayWidth; ctx.globalAlpha = gain;
            ctx.beginPath(); ctx.moveTo(middle.x, middle.y); ctx.lineTo(middle.tx, middle.ty); ctx.stroke();
          }
        }
      };
      let previous = sample(0);
      for (let i = 1; i <= 160; i++) {
        const current = sample(i * 360 / 160);
        paint(previous, current);
        previous = current;
      }
    }
    ctx.restore();
  }
  /** Short, angular light sweeps read in daylight too. Each event has six
   * fixed compass echoes, with culling before gradients. They travel through
   * the landscape camera rather than sticking to a screen coordinate. */
  _musicAtmosphere(ctx, project, width, height, night, performance, moon = this.celestial.disc) {
    if (!performance?.sweeps.length || !Number.isFinite(project.focal)) return;
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    if (moon?.visible && moon.cover > .99) {
      ctx.beginPath(); ctx.rect(0, 0, width, height);
      ctx.arc(moon.x, moon.y, moon.r * 1.04, 0, TAU); ctx.clip('evenodd');
    }
    const daylight = 1 - smooth((night - .15) / .7);
    for (const sweep of performance.sweeps) {
      const emission = sweep.strength * (.12 + .3 * daylight) * performance.detail;
      const color = sweep.kind === 'snare' ? '218,239,255' : '255,208,139';
      for (let echo = 0; echo < 6; echo++) {
        const az = sweep.phase * 360 + echo * 60 + sweep.age * 24;
        // Stay above the skyline but inside the tour's narrow lake lens for
        // the note's first beat; a fast high arc left that view almost at once.
        const altitude = 7 + sweep.age * 4 + performance.lift * 1.5;
        const p = project(tourSkyDirection(az, altitude));
        if (!p.inFront) continue;
        const x = p.xFrac * width, y = p.yFrac * height;
        const r = Math.min(height * .32, height * project.focal * (.14 + sweep.age * .035));
        if (x + r * 1.6 < 0 || x - r * 1.6 > width || y + r * .5 < 0 || y - r * .5 > height) continue;
        // The warm ellipse lifts above the horizon as the phrase opens.
        // Make its gradient in the same transformed space as its footprint.
        ctx.save(); ctx.translate(x, y); ctx.scale(1.6, .5); ctx.translate(-x, -y);
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
        glow.addColorStop(0, `rgba(${color},${emission})`);
        glow.addColorStop(.3, `rgba(${color},${emission * .42})`);
        glow.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = glow; ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.restore();
      }
    }
    ctx.restore();
  }
  _bodies(ctx, frame, width, height, night, outputScale = 1, performance = null) {
    const storm = clamp(frame.storm?.amount ?? 0);
    // The cinematic look keeps a quieter halo around the sun. The score
    // (sampled once in draw) reaches only the glare, bloom and aureole.
    this.celestial.drawSun(ctx, frame.sun, width, height, storm, { quiet: !!frame.cinematicPixel, music: performance });
    this.celestial.drawMoon(ctx, frame.moon, frame.sun, width, height, night, frame.phase, outputScale, storm,
      { music: performance });
  }
  /** The bodies seen through the storm deck, painted over it. These stay
   *  deaf to the score: a pulsing patch in a storm deck would read as
   *  lightning. */
  _veiledBodies(ctx, frame, width, height, night) {
    const storm = clamp(frame.storm?.amount ?? 0);
    if (storm < .01) return;
    this.celestial.drawVeiledSun(ctx, frame.sun, width, height, storm);
    this.celestial.drawVeiledMoon(ctx, frame.moon, width, height, night, frame.phase, storm);
  }

  _clouds(ctx, camera, width, height, night, time, storm = 0, cinematic = null) {
    ctx.save();
    for (const bank of cloudBanks({ camera, width, height, timeSec: time, seed: this.seed })) {
      const index = bank.shapeSeed ?? bank.index;
      let image = this._cloud(index);
      if (!image) continue;
      if (cinematic) {
        const mix = this.buffers.ensure('cinematic-cloud-mix', 192, 128);
        const variants = mix && this._cinematicCloud(index, image);
        if (variants) image = this._mixCinematicCloud(variants, cinematicCloudWeights(bank, cinematic, width, height), mix);
      }
      ctx.save(); ctx.transform(...bank.matrix);
      ctx.globalAlpha = bank.alpha * (1 - night * .48) * (1 + clamp(storm?.amount ?? storm) * .35);
      ctx.drawImage(image, -.5, -.5, 1, 1);
      ctx.restore();
    }
    ctx.restore();
  }
  /** `variant` 'flash' (RangeStorm's lightning-lit repaint) tints its own
   *  small LRU pool, so deck and flash never evict each other's pixels. */
  _flashTint(index) {
    this.flashCache.delete(index);
    this.flashCache.set(index, true);
    if (this.flashCache.size > FLASH_TINT_POOL) {
      const oldest = this.flashCache.keys().next().value;
      this.flashCache.delete(oldest);
      this.buffers.release(`storm-flash-cloud-${oldest}`);
    }
    return this.buffers.ensure(`storm-flash-cloud-${index}`, 192, 128);
  }
  _stormClouds(ctx, banks, { dark, lit, directGain = 1, variant = 'deck' }) {
    const images = new Map(), flash = variant === 'flash';
    const gain = Math.min(1, directGain);
    // The painted colours, as integers: a clearing that moves directGain
    // repaints only when one of these channels actually changes.
    const d0 = Math.round(dark[0]), d1 = Math.round(dark[1]), d2 = Math.round(dark[2]);
    const l0 = Math.round(dark[0] + (lit[0] - dark[0]) * gain);
    const l1 = Math.round(dark[1] + (lit[1] - dark[1]) * gain);
    const l2 = Math.round(dark[2] + (lit[2] - dark[2]) * gain);
    ctx.save();
    for (const [i, bank] of banks.entries()) {
      const index = bank.shapeSeed ?? bank.index ?? Number(String(bank.id || `bank${i}`).slice(4)) % 6;
      let image = images.get(index);
      if (!image) {
        const density = this._cloud(index);
        image = density && (flash ? this._flashTint(index) : this.buffers.ensure(`storm-cloud-${index}`, 192, 128));
        if (!density || !image) continue;
        // Density and tint determine these pixels exactly. Bank motion and
        // opacity affect only the destination draw below, so stable weather
        // need not repaint owned scratch canvases every frame.
        const prior = this.stormTints.get(image);
        if (!prior || prior[0] !== density || prior[1] !== variant || prior[2] !== d0 || prior[3] !== d1
          || prior[4] !== d2 || prior[5] !== l0 || prior[6] !== l1 || prior[7] !== l2) {
          const target = image.getContext('2d');
          target.clearRect(0, 0, image.width, image.height);
          target.globalCompositeOperation = 'source-over';
          const light = [l0, l1, l2];
          const gradient = target.createLinearGradient(0, 0, 0, image.height);
          gradient.addColorStop(0, `rgb(${light.join(',')})`);
          gradient.addColorStop(1, `rgb(${d0},${d1},${d2})`);
          target.fillStyle = gradient; target.fillRect(0, 0, image.width, image.height);
          // Preserve each billow's internal light and shadow. An alpha-only
          // mask flattens the volume into a mottled slab, even with a new shape.
          target.globalCompositeOperation = 'multiply';
          target.drawImage(density, 0, 0);
          target.globalCompositeOperation = 'destination-in';
          target.drawImage(density, 0, 0);
          target.globalCompositeOperation = 'source-over';
          this.stormTints.set(image, [density, variant, d0, d1, d2, l0, l1, l2]);
        }
        images.set(index, image);
      }
      ctx.globalAlpha = bank.alpha;
      if (bank.matrix) {
        ctx.save(); ctx.transform(...bank.matrix);
        ctx.drawImage(image, -.5, -.5, 1, 1); ctx.restore();
      } else ctx.drawImage(image, bank.x - bank.w * .5, bank.y - bank.h, bank.w, bank.h * 2);
    }
    ctx.restore();
  }
  dispose() {
    this.buffers.dispose(); this.stars = []; this.galacticClouds = []; this.seed = null;
    this.painted = new WeakSet(); this.stormTints = new WeakMap(); this.cloudCache.clear(); this.flashCache.clear();
    this.celestial.dispose();
  }
}
