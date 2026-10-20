import { CanvasBuffers } from '../../render/CanvasResidency.js';
import { cameraBasis } from '../terrain/SceneTravel.js';
import { projectSkyDirection, tourSkyDirection } from './RangeSkyComposition.js';
import { drawStormSky } from './RangeStorm.js';
import { LightningFX } from '../Lightning.js';
import { cloudBanks } from './RangeCloudField.js';
import { buildCloudTexture } from './RangeCloudTexture.js';
export { cloudDensity } from './RangeCloudTexture.js';

const TAU = Math.PI * 2;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
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
function fractal(x, y, seed) {
  return noise(x, y, seed) * .54 + noise(x * 2.13 + 7, y * 2.13, seed + 1) * .27
    + noise(x * 4.61, y * 4.61 + 3, seed + 2) * .13 + noise(x * 9.7, y * 9.7, seed + 3) * .06;
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
export function createSkyCatalogue(seed, count = 2600) {
  return Array.from({ length: count }, (_, i) => {
    const az = hash(i, 0, seed) * 360;
    const alt = i % 3 ? Math.asin(hash(i, 1, seed)) * 180 / Math.PI
      : 31 + 25 * Math.sin(az * Math.PI / 180 + .5) + (hash(i, 2, seed) - .5) * 15;
    const bright = hash(i, 3, seed) ** 5;
    return { direction: tourSkyDirection(az, alt), brightness: .12 + .88 * bright,
      radius: .35 + .85 * bright, phase: hash(i, 4, seed) * TAU, color: Math.floor(hash(i, 5, seed) * 5) };
  });
}

const STAR_COLORS = ['190,210,255', '218,229,255', '245,244,231', '255,226,188', '217,231,255'];

/** Full-resolution sky experiment. Cached density/albedo images are small,
 * accounted CanvasBuffers; the destination belongs to the presenter.
 * This painter never reads terrain pixels or changes the terrain grid. */
export class RangeSkyRenderer {
  constructor({ residency, makeCanvas } = {}) {
    this.buffers = new CanvasBuffers({ residency, makeCanvas, owner: 'range-sky-detail' });
    this.seed = null;
    this.stars = [];
    this.painted = new WeakSet();
    this.stormTints = new WeakMap();
  }
  _seed(seed) {
    if (seed === this.seed) return;
    this.seed = seed;
    this.stars = createSkyCatalogue(seed);
    this.buffers.dispose();
    this.painted = new WeakSet();
    this.stormTints = new WeakMap();
  }
  _cloud(index) {
    const canvas = this.buffers.ensure(`cloud-${index}`, 192, 128);
    if (!canvas || this.painted.has(canvas)) return canvas;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(canvas.width, canvas.height);
    const seed = this.seed + index * 71;
    image.data.set(buildCloudTexture(seed, canvas.width, canvas.height));
    ctx.putImageData(image, 0, 0);
    this.painted.add(canvas);
    return canvas;
  }
  _moon() {
    const canvas = this.buffers.ensure('moon', 192, 192);
    if (!canvas || this.painted.has(canvas)) return canvas;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(canvas.width, canvas.height);
    const craters = Array.from({ length: 35 }, (_, i) => ({
      x: (hash(i, 20, 739) - .5) * 1.7, y: (hash(i, 21, 739) - .5) * 1.7,
      r: .018 + hash(i, 22, 739) ** 3 * .13,
    }));
    for (let y = 0; y < 192; y++) for (let x = 0; x < 192; x++) {
      const nx = (x + .5) / 96 - 1, ny = (y + .5) / 96 - 1, r2 = nx * nx + ny * ny;
      if (r2 > 1) continue;
      const nz = Math.sqrt(1 - r2);
      const maria = smooth((fractal(nx * 2.4 + 10, ny * 2.4 + 10, 791) - .42) * 4.5);
      let albedo = .93 - maria * .32 + (noise(nx * 58, ny * 58, 812) - .5) * .11;
      for (const crater of craters) {
        const distance = Math.hypot(nx - crater.x, ny - crater.y) / crater.r;
        if (distance < 1.4) albedo += .09 * Math.exp(-(((distance - 1) * 7) ** 2)) - .075 * Math.exp(-distance * distance * 2);
      }
      const brightness = albedo * (.62 + .38 * nz);
      const i = (y * 192 + x) * 4;
      image.data[i] = 243 * brightness; image.data[i + 1] = 239 * brightness;
      image.data[i + 2] = 222 * brightness; image.data[i + 3] = clamp((1 - Math.sqrt(r2)) * 96) * 255;
    }
    ctx.putImageData(image, 0, 0);
    this.painted.add(canvas);
    return canvas;
  }
  draw(ctx, frame) {
    const project = skyProjector(frame.camera);
    if (!project) return false;
    this._seed(frame.seed);
    const width = frame.sourceWidth, height = frame.sourceHeight;
    const night = clamp(frame.night), time = frame.reducedMotion ? 0 : frame.timeSec;
    ctx.save();
    // Pixel terrain presentation leaves nearest-neighbor sampling enabled.
    // Sky density/albedo textures belong to the smooth output layer.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const horizontal = [project.forward[0], 0, project.forward[2]];
    const horizon = project(horizontal);
    const horizonY = clamp(horizon.yFrac, -.3, 1.8) * height;
    const gradient = ctx.createLinearGradient(0, Math.min(-height * .4, horizonY - height), 0, Math.max(height * .2, horizonY + height * .25));
    gradient.addColorStop(0, frame.colors.top);
    gradient.addColorStop(.65, frame.colors.mid);
    gradient.addColorStop(1, frame.colors.horizon);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
    this._stars(ctx, project, width, height, night, time, frame.reducedFlash);
    this._aurora(ctx, project, width, height, night, time, frame.authority);
    if (frame.lightning) LightningFX.prototype.draw.call(frame.lightning, ctx, { width, height }, frame.timeSec * 1000, frame.reducedFlash);
    this._bodies(ctx, frame, width, height, night);
    this._clouds(ctx, frame.camera, width, height, night, time, frame.storm);
    // Keep the existing heard-time storm score and triggered bolts. Only
    // their target and the cloud shape change; terrain wetness stays native.
    const storm = frame.reducedFlash && frame.storm ? { ...frame.storm, flash: 0 } : frame.storm;
    drawStormSky(ctx, { width, height }, storm, { tSec: frame.timeSec, seed: frame.seed, pan: frame.camera,
      light: frame.light, reducedMotion: frame.reducedMotion,
      cloudBankFactory: () => cloudBanks({ camera: frame.camera, width, height,
        timeSec: frame.timeSec, seed: frame.seed, storm: true, reducedMotion: frame.reducedMotion }),
      cloudPainter: (target, banks, options) => this._stormClouds(target, banks, options) });
    ctx.restore();
    return true;
  }
  _stars(ctx, project, width, height, night, time, reducedFlash) {
    const strength = .07 + .93 * smooth(night);
    if (strength < .01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const star of this.stars) {
      const p = project(star.direction);
      if (!p.visible) continue;
      const x = p.xFrac * width, y = p.yFrac * height;
      const scintillation = reducedFlash ? 1 : .94 + .06 * Math.sin(time * 1.3 + star.phase);
      const radius = Math.max(.32, star.radius * height / 850);
      ctx.fillStyle = `rgba(${STAR_COLORS[star.color]},${strength * star.brightness * scintillation})`;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
      if (star.brightness > .7) {
        const halo = ctx.createRadialGradient(x, y, 0, x, y, radius * 4);
        halo.addColorStop(0, `rgba(${STAR_COLORS[star.color]},${strength * .18})`);
        halo.addColorStop(1, `rgba(${STAR_COLORS[star.color]},0)`);
        ctx.fillStyle = halo; ctx.fillRect(x - radius * 4, y - radius * 4, radius * 8, radius * 8);
      }
    }
    ctx.restore();
  }
  _aurora(ctx, project, width, height, night, time, authority = 1) {
    const alpha = smooth((night - .18) / .7) * (.045 + .035 * clamp(authority));
    if (alpha < .005) return;
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    for (let sheet = 0; sheet < 2; sheet++) {
      const sample = az => {
        const wave = Math.sin(az * .052 + sheet + time * .025) + .32 * Math.sin(az * .17 - time * .018);
        const base = 9 + sheet * 7 + wave * 3;
        const top = base + 12 + 7 * (.5 + .5 * Math.sin(az * .081 + time * .013));
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
          const fold = .3 + .7 * noise(az * .14 + time * .015, sheet * 13, seed + 51);
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
  _bodies(ctx, frame, width, height, night) {
    const sun = frame.sun;
    if (sun && sun.visible !== false && sun.altitude01 > .005) {
      const x = sun.xFrac * width, y = sun.yFrac * height, radius = Math.max(height * .006, sun.radiusFrac * width * .65);
      const glow = ctx.createRadialGradient(x, y, radius, x, y, height * .28);
      glow.addColorStop(0, 'rgba(255,230,179,.33)'); glow.addColorStop(.2, 'rgba(255,198,137,.1)');
      glow.addColorStop(1, 'rgba(255,174,126,0)');
      ctx.fillStyle = glow; ctx.fillRect(x - height, y - height, height * 2, height * 2);
      ctx.fillStyle = '#fff7df'; ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
    }
    const moon = frame.moon;
    if (!moon || moon.visible === false || !(moon.altitude01 > .001)) return;
    const x = moon.xFrac * width, y = moon.yFrac * height, radius = moon.radiusFrac * width;
    if (!(radius > 0)) return;
    const texture = this._moon(), visibility = (moon.visibility ?? 1) * (.3 + .7 * night);
    ctx.save(); ctx.globalAlpha = visibility;
    const glow = ctx.createRadialGradient(x, y, radius * .9, x, y, radius * 4.5);
    glow.addColorStop(0, 'rgba(205,223,242,.11)'); glow.addColorStop(.35, 'rgba(188,209,238,.025)');
    glow.addColorStop(1, 'rgba(188,209,238,0)');
    ctx.fillStyle = glow; ctx.fillRect(x - radius * 5, y - radius * 5, radius * 10, radius * 10);
    ctx.fillStyle = '#101a29'; ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
    if (texture) {
      ctx.globalAlpha = visibility * .12; ctx.drawImage(texture, x - radius, y - radius, radius * 2, radius * 2);
    }
    const light = moon.illuminant || sun || { xFrac: moon.xFrac + 1, yFrac: moon.yFrac + 1 };
    const angle = Math.atan2((light.yFrac - moon.yFrac) * height, (light.xFrac - moon.xFrac) * width);
    const phase = Math.max(.16, .5 - .5 * Math.cos(TAU * clamp(frame.phase)));
    const terminator = 1 - 2 * phase;
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.beginPath(); ctx.arc(0, 0, radius, -Math.PI / 2, Math.PI / 2);
    ctx.ellipse(0, 0, Math.abs(terminator) * radius, radius, 0, Math.PI / 2, -Math.PI / 2, terminator > 0);
    ctx.closePath(); ctx.clip(); ctx.rotate(-angle);
    ctx.globalAlpha = visibility;
    if (texture) ctx.drawImage(texture, -radius, -radius, radius * 2, radius * 2);
    else { ctx.fillStyle = '#e7e5d9'; ctx.fillRect(-radius, -radius, radius * 2, radius * 2); }
    ctx.restore();
  }
  _clouds(ctx, camera, width, height, night, time, storm = 0) {
    ctx.save();
    for (const bank of cloudBanks({ camera, width, height, timeSec: time, seed: this.seed })) {
      const image = this._cloud(bank.index);
      if (!image) continue;
      ctx.save(); ctx.transform(...bank.matrix);
      ctx.globalAlpha = bank.alpha * (1 - night * .48) * (1 + clamp(storm?.amount ?? storm) * .35);
      ctx.drawImage(image, -.5, -.5, 1, 1);
      ctx.restore();
    }
    ctx.restore();
  }
  _stormClouds(ctx, banks, { dark, lit, directGain = 1 }) {
    const images = new Map();
    ctx.save();
    for (const [i, bank] of banks.entries()) {
      const index = bank.index ?? Number(String(bank.id || `bank${i}`).slice(4)) % 6;
      let image = images.get(index);
      if (!image) {
        const density = this._cloud(index);
        image = this.buffers.ensure(`storm-cloud-${index}`, 192, 128);
        if (!density || !image) continue;
        // Density and tint determine these pixels exactly. Bank motion and
        // opacity affect only the destination draw below, so stable weather
        // need not repaint the same six owned scratch canvases every frame.
        const key = [density, ...dark, ...lit, directGain];
        const prior = this.stormTints.get(image);
        if (!prior || prior.length !== key.length || !prior.every((value, i) => Object.is(value, key[i]))) {
          const target = image.getContext('2d');
          target.clearRect(0, 0, image.width, image.height);
          target.globalCompositeOperation = 'source-over';
          const light = lit.map((value, channel) => Math.round(dark[channel] + (value - dark[channel]) * Math.min(1, directGain)));
          const gradient = target.createLinearGradient(0, 0, 0, image.height);
          gradient.addColorStop(0, `rgb(${light.join(',')})`);
          gradient.addColorStop(1, `rgb(${dark.join(',')})`);
          target.fillStyle = gradient; target.fillRect(0, 0, image.width, image.height);
          // Preserve each billow's internal light and shadow. An alpha-only
          // mask flattens the volume into a mottled slab, even with a new shape.
          target.globalCompositeOperation = 'multiply';
          target.drawImage(density, 0, 0);
          target.globalCompositeOperation = 'destination-in';
          target.drawImage(density, 0, 0);
          target.globalCompositeOperation = 'source-over';
          this.stormTints.set(image, key);
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
  dispose() { this.buffers.dispose(); this.stars = []; this.seed = null; this.painted = new WeakSet(); this.stormTints = new WeakMap(); }
}
