// Runs inside Chromium via page.evaluate. Compare actual drawing geometry at
// two times while keeping the world/camera/music inputs other than sway fixed.
export async function worldMotionAudit() {
  const mgr = window.__SMW.sim.biomes, kind = mgr.world.kind;
  if (!['city', 'strip', 'overgrowth'].includes(kind)) return null;
  const { drawCityWorld } = await import('/src/world/city/drawCity.js');
  const { drawRoad } = await import('/src/world/redline/drawRedline.js');
  const { drawCanopy } = await import('/src/world/understory/drawUnderstory.js');
  const old = { tSec: mgr.tSec, reducedMotion: mgr.reducedMotion, reducedFlash: mgr.reducedFlash };
  const canvas = document.createElement('canvas');
  canvas.width = window.__SMW.sim.stageW || 1280; canvas.height = window.__SMW.sim.stageH || 720;
  const raw = canvas.getContext('2d', { willReadFrequently: true });
  let geometry = [];
  const ctx = new Proxy(raw, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (kind === 'city' && name === 'fillRect' && ['#ee856b', '#f9dfa0'].includes(target.fillStyle)
          || kind === 'strip' && ['moveTo', 'lineTo'].includes(name)
          || kind === 'overgrowth' && name === 'bezierCurveTo') geometry.push([name, ...args]);
        return value.apply(target, args);
      };
    },
    set(target, name, value) { target[name] = value; return true; },
  });
  const A = mgr._profile(mgr.currentBlend.from), B = mgr._profile(mgr.currentBlend.to);
  const frame = { ctx, canvas, worldX: 0, originX: 0, A, B, t: mgr.currentBlend.t,
    dn: { night: .8, sunAlt: .3, moonAlt: .6, moonAz01: .7 }, phenomenaFull: false,
    particleMul: 0, groundView: null, skyVoyage: null };
  const draw = kind === 'city' ? () => drawCityWorld(mgr, frame) : kind === 'strip'
    ? () => drawRoad(mgr, frame, { energy: .5 }) : () => drawCanopy(mgr, frame, { current: Math.sin(mgr.tSec / 8) * .5 });
  const samples = [];
  try {
    mgr.reducedFlash = false;
    for (const reducedMotion of [false, true]) {
      mgr.reducedMotion = reducedMotion;
      const frames = [];
      for (const tSec of [10, 20]) {
        mgr.tSec = tSec; geometry = [];
        raw.setTransform(1, 0, 0, 1, 0, 0); raw.clearRect(0, 0, canvas.width, canvas.height);
        draw();
        frames.push({ geometry, pixels: raw.getImageData(0, 0, canvas.width, canvas.height).data });
      }
      let changedPixels = 0;
      for (let i = 0; i < frames[0].pixels.length; i += 4) {
        if (frames[0].pixels.slice(i, i + 4).some((v, j) => v !== frames[1].pixels[i + j])) changedPixels++;
      }
      samples.push({ reducedMotion, geometryCount: frames[0].geometry.length,
        geometryChanged: JSON.stringify(frames[0].geometry) !== JSON.stringify(frames[1].geometry), changedPixels });
    }
    return { kind, samples, scope: 'two rendered frames at 10s/20s; fixed camera, time-dependent motion; geometry excludes unrelated lighting' };
  } finally { Object.assign(mgr, old); canvas.width = 0; canvas.height = 0; }
}
