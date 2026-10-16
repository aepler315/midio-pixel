// Shared pure paint geometry and neutral-relative musical measurements.
import { crestHeightAt } from '../terrain/HorizonRidge.js';
import { clamp, clamp01 } from '../../utils/math.js';

export const DEFAULT_RIDGE_TUNING = Object.freeze({ maxHeightFrac: .4, advection: .0054,
  phaseRate: .8, crestWavePx: 12, fallbackWavePx: 18, sourceLiftPx: 14, kickLiftPx: 24 });
export const DEFAULT_SPACE_RIDGE_TUNING = Object.freeze({ musicHeightFrac: .11, sourceLiftPx: 10,
  depthGain: .45, globalDepthGain: .3 });
const frozenPoints = pts => Object.freeze(pts.map(p => Object.freeze(p)));
const bounded = v => clamp(v, -1, 1);
function measured(evaluate, timeMs, reducedMotion) {
  if (reducedMotion) return { displacement01: 0, velocity01: 0 };
  let displacement01 = 0, velocity01 = 0;
  for (let tap = 0; tap < 5; tap++) {
    const at = Math.max(0, timeMs - tap * 20);
    const d = evaluate(at), before = evaluate(Math.max(0, at - 50));
    displacement01 += d / 5;
    velocity01 += bounded((d - before) / .05) / 5;
  }
  return { displacement01: bounded(displacement01), velocity01: bounded(velocity01) };
}
const silent = Object.freeze({ bands: Array(7).fill(0), spaceLevels: Array(7).fill(0), spaceDepths: Array(7).fill(0), activity01: 0, kick01: 0, sources: {} });

export function sampleHorizonRidge({ viewport, crest = null, songP = 0, advectionPx = 0, heardTimeMs = 0,
  history, tuning = DEFAULT_RIDGE_TUNING, reducedMotion = false }) {
  tuning = { ...DEFAULT_RIDGE_TUNING, ...tuning };
  const { width, height } = viewport, scale = height / 720, baseline = height * .6, maxH = height * tuning.maxHeightFrac;
  const shape = u => crest ? crestHeightAt(crest, songP, u) : 1;
  const wavePx = (crest ? tuning.crestWavePx : tuning.fallbackWavePx) * scale;
  const designBound = (crest ? .6 : 1) * maxH + wavePx * 1.25 + tuning.sourceLiftPx * scale + tuning.kickLiftPx * scale;
  const boundPx = designBound * (crest ? Math.max(...crest.heights) : 1);
  const sourceShape = u => {
    if (!crest) return 1;
    const at = clamp01(u) * (crest.heights.length - 1);
    const i = Math.min(crest.heights.length - 2, Math.floor(at)), f = at - i;
    return crest.heights[i] * (1 - f) + crest.heights[i + 1] * f;
  };
  const point = (u, music, at, metric = false) => {
    // Fixed authored source stations share paint's headroom and design bound.
    const base = metric ? sourceShape(u) : shape(u);
    const p = ((u * 7 + (metric ? 0 : advectionPx * tuning.advection)) % 7 + 7) % 7;
    const i = Math.floor(p), f = (1 - Math.cos((p - i) * Math.PI)) / 2;
    const local = clamp01((music.bands[i] || 0) * (1 - f) + (music.bands[(i + 1) % 7] || 0) * f);
    const mean = music.bands.reduce((sum, band) => sum + clamp01(band), 0) / 7;
    // Move the mountain as one mass, retaining half of the travelling band's
    // contrast. Full-spectrum strength stays unchanged; isolated bands no
    // longer pull seven unrelated small hills across the geographic crest.
    const v = .5 * mean + .5 * local;
    const source = music.motionMelody ?? music.sources.midio;
    const presence = music.motionPresence01 ?? music.activity01;
    const phase = u * Math.PI * 2 + at / 1000 * tuning.phaseRate;
    const neutralY = baseline - (crest ? base * .4 * maxH : 0);
    const bound = base * designBound;
    const lift = base * ((crest ? .6 : 1) * v * maxH
      + Math.sin(phase) * wavePx * (.25 * presence + v)
      + (source?.activity || 0) * tuning.sourceLiftPx * scale * Math.sin(phase + (source?.pitch01 ?? .5) * 2)
      + music.kick01 * tuning.kickLiftPx * scale);
    // C1 shoulder: loud peaks retain a response while approaching headroom.
    const floor = height * .12, shoulder = 24 * scale, rawY = neutralY - lift;
    const y = rawY >= floor + shoulder ? rawY : floor + shoulder * Math.exp((rawY - floor - shoulder) / shoulder);
    return { x: u * width, y, neutralY, normalized: bound > 1e-9 ? (neutralY - y) / bound : 0, bound };
  };
  const metricAt = at => {
    const music = history?.sample(at) || silent;
    let total = 0;
    for (let i = 0; i < 64; i++) total += point(i / 63, music, at, true).normalized;
    return total / 64;
  };
  const count = crest ? Math.max(64, Math.ceil(width / 4)) : 64;
  const music = reducedMotion ? silent : history?.sample(heardTimeMs) || silent;
  const raw = Array.from({ length: count + 3 }, (_, k) => point((k - 1) / count, music, heardTimeMs));
  return Object.freeze({ points: frozenPoints(raw.map(p => ({ x: p.x, y: p.y }))),
    neutralPoints: frozenPoints(raw.map(p => ({ x: p.x, y: p.neutralY }))),
    boundPx, ...measured(metricAt, heardTimeMs, reducedMotion) });
}

export function sampleSpaceRidge({ viewport, seededGeometry, heardTimeMs = 0, history, reducedMotion = false, tuning = DEFAULT_SPACE_RIDGE_TUNING }) {
  tuning = { ...DEFAULT_SPACE_RIDGE_TUNING, ...tuning };
  const { width, height } = viewport, nodes = seededGeometry.nodes, spine = seededGeometry._spine;
  const tSec = reducedMotion ? 0 : heardTimeMs / 1000;
  const tide = height * .012 * (.6 * Math.sin(tSec * 2 * Math.PI / 19) + .4 * Math.sin(tSec * 2 * Math.PI / 47 + 1.3));
  const globalZ = reducedMotion ? 0 : Math.sin(tSec * 2 * Math.PI / 31);
  const y0 = height * .33 + (reducedMotion ? 0 : tide), maxH = height * tuning.musicHeightFrac;
  const sourceLift = tuning.sourceLiftPx * height / 720;
  const boundPx = maxH + sourceLift;
  const evaluate = (at, neutral = false) => {
    const music = neutral ? silent : history?.sample(at) || silent;
    const levels = nodes.map(n => music.spaceLevels[n.band] || 0);
    const pts = nodes.map((n, i) => {
      const level = (levels[Math.max(0, i - 1)] + levels[i] + levels[Math.min(nodes.length - 1, i + 1)]) / 3;
      const depthMul = clamp(1 + tuning.depthGain * (music.spaceDepths[n.band] || 0) + tuning.globalDepthGain * globalZ, .42, 1.85);
      const x = width / 2 + (n.xFrac * width - width / 2) * depthMul;
      const mass = Math.min(1, spine.reduce((sum, peak) => sum + peak.height * Math.exp(-(((n.xFrac - peak.x) / peak.width) ** 2)), 0));
      const resting = height * (.045 + .09 * mass);
      const lift = level * maxH + sourceLift * (music.sources.midasus?.activity || 0) * Math.sin(n.xFrac * 1280 / 370 + at / 1000 * .42);
      return { x, y: y0 - resting - lift, i, level: levels[i], depthMul, lift };
    });
    for (let i = 1; i < pts.length; i++) pts[i].x = Math.max(pts[i].x, pts[i - 1].x + 3);
    return pts;
  };
  const metricAt = at => evaluate(at).reduce((sum, p) => sum + p.lift / boundPx, 0) / nodes.length;
  const clean = pts => pts.map(({ lift, ...p }) => { void lift; return p; });
  const neutralPoints = frozenPoints(clean(evaluate(heardTimeMs, true)));
  return Object.freeze({ points: reducedMotion ? neutralPoints : frozenPoints(clean(evaluate(heardTimeMs))), neutralPoints,
    y0, maxH, boundPx, ...measured(metricAt, heardTimeMs, reducedMotion) });
}

/** Samples already carry fixed-source, causal trailing measurements. */
export function sampleRidgeRelationship({ space, dance, nominalViewport, moonVisibility = 1, reducedMotion = false }) {
  if (reducedMotion) return { dxPx: 0, dyPx: 0 };
  const q = bounded((space?.displacement01 || 0) - (dance?.displacement01 || 0));
  const v = bounded((space?.velocity01 || 0) - (dance?.velocity01 || 0));
  const scale = (nominalViewport?.height || 720) / 720 * clamp01(moonVisibility);
  const dx = 2 * v, dy = 3 * q, bound = Math.min(1, 6 / (Math.hypot(dx, dy) || 1));
  return { dxPx: dx * bound * scale, dyPx: dy * bound * scale };
}
