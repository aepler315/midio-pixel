import { hashSeed } from '../utils/math.js';

/** Preserve an outer fade even in older painters that assign absolute alpha.
 * The proxy exposes the painter's unfaded alpha, so *= never squares it.
 * Captures bake this fade once; composites/reflections reuse those pixels. */
export function withNarrativeAlpha(ctx, presence, draw) {
  if (!(presence > 0)) return;
  if (presence >= 1) { draw(ctx); return; }
  ctx.save();
  let alpha = ctx.globalAlpha;
  const stack = [], methods = new Map();
  ctx.globalAlpha = alpha * presence;
  const proxy = new Proxy(ctx, {
    get(target, key) {
      if (key === 'globalAlpha') return alpha;
      if (key === 'save') return () => { stack.push(alpha); target.save(); };
      if (key === 'restore') return () => { target.restore(); alpha = stack.pop() ?? alpha; };
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!methods.has(key)) methods.set(key, value.bind(target));
      return methods.get(key);
    },
    set(target, key, value) {
      if (key === 'globalAlpha') { alpha = value; target.globalAlpha = value * presence; }
      else Reflect.set(target, key, value, target);
      return true;
    },
  });
  try { draw(proxy); } finally { ctx.restore(); }
}

export function composedNarrativeEdge(narrativeEdge = 0, filmEdge = 0) {
  return Math.min(.40, 1 - (1 - narrativeEdge) * (1 - filmEdge));
}

/** Bounded, source-linked graphic phrases; no previous-frame particles. */
export function narrativeMarks(n, timeMs, width, height, seed = 0) {
  if (!n || n.revelation >= 1 || n.shortClip) return [];
  const out = [];
  for (const [id, source] of Object.entries(n.sources)) {
    if (!(source.activity > .01)) continue;
    const h = n.handoff[id], trace = 4 * h * (1 - h) * (1 - n.traceResolution);
    const voidWeight = (1 - n.revelation) * .35;
    for (let i = 0; i < 5; i++) {
      const hash = hashSeed(`${seed}:${id}:${i}`) / 4294967296;
      const phase = timeMs / (id === 'broshi' ? 1700 : id === 'midio' ? 950 : 3200) + hash * 6;
      const x = width * (.12 + .76 * hash), baseY = height * (id === 'broshi' ? .66 : id === 'midio' ? .44 : .18);
      out.push({ owner: id, x, y: baseY + Math.sin(phase) * 12 * source.activity,
        length: 6 + 16 * source.activity, alpha: Math.min(.45, source.activity * (voidWeight + trace * .3)),
        hue: id === 'broshi' ? 32 : id === 'midio' ? 42 : 205 });
    }
  }
  return out;
}

export function drawNarrativeMarks(ctx, n, timeMs, canvas, seed, reducedMotion) {
  const marks = narrativeMarks(n, reducedMotion ? 0 : timeMs, canvas.width, canvas.height, seed);
  ctx.save();
  ctx.lineWidth = 1.2; ctx.lineCap = 'round';
  for (const m of marks) {
    ctx.globalAlpha = m.alpha;
    ctx.strokeStyle = `hsl(${m.hue} 42% 48%)`;
    ctx.beginPath(); ctx.moveTo(m.x - m.length / 2, m.y);
    ctx.quadraticCurveTo(m.x, m.y - 4, m.x + m.length / 2, m.y); ctx.stroke();
  }
  ctx.restore();
}
