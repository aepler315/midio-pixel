// Range v2 performer capture (plan §6.3, Task 12). A performer eligible for a
// reflection this frame draws its body ONCE, into a tight transparent layer,
// instead of straight onto the stage; the Renderer composites that same layer
// back at its original place in the cast order and WetReflection reuses it.
// Performers with nothing to reflect in draw directly, exactly as before.
//
// Body draws blend two ways: ordinary source-over, and 'lighter' glows that
// add onto whatever is beneath. A single transparent layer would turn those
// additive glows into ordinary paint, so a layer is an ordered run of
// SEGMENTS, each a canvas with one composite mode: the capture context
// starts a new segment whenever the body switches mode, mirrors every state
// change (transform, clip, path, styles) into all segments, and the
// composite replays the segments in order with their own modes -- the same
// paint order as a direct draw. Past MAX_SEGMENTS switches, later draws join
// the last segment of their mode (never observed in the cast's draws).
//
// Layers are device-pixel exact: the capture reads the stage transform at
// capture time and the composite places the segments back at the same device
// rectangle under an identity transform. Only axis-aligned scale+translate
// transforms are captured (the fixed-ground view); anything else draws
// directly. Bounds are clipped to the canvas, so partial or negative
// offscreen subjects capture only what can be seen.

export const MAX_SEGMENTS = 6;
const DRAWS = new Set(['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage', 'clearRect', 'putImageData']);
const QUERIES = new Set(['createLinearGradient', 'createRadialGradient', 'createConicGradient', 'createPattern', 'createImageData',
  'measureText', 'isPointInPath', 'isPointInStroke', 'getTransform', 'getImageData', 'getLineDash', 'getContextAttributes']);
// Stage state a body draw may inherit from whatever ran before it.
const INHERITED = ['globalAlpha', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
  'font', 'textAlign', 'textBaseline', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'filter', 'imageSmoothingEnabled'];

/** A 2D context facade over ordered single-mode segment contexts. Segment i
 *  paints with modes[i]; `used()` reports the last segment drawn into. */
export function segmentedContext(contexts, modes, initialMode = 'source-over') {
  let mode = initialMode === 'lighter' ? 'lighter' : 'source-over';
  let other = initialMode !== 'lighter' && initialMode !== 'source-over' ? initialMode : null;
  let seg = modes.indexOf(mode);
  let last = -1;
  const stack = [];
  const target = () => {
    if (modes[seg] !== mode) {
      let next = seg + 1;
      while (next < modes.length && modes[next] !== mode) next++;
      if (next < modes.length) seg = next;
      else seg = modes.lastIndexOf(mode); // out of segments: join the last of this mode
    }
    last = Math.max(last, seg);
    return contexts[seg];
  };
  const all = (prop, a) => { let r; for (let i = contexts.length - 1; i >= 0; i--) r = contexts[i][prop](...a); return r; };
  const facade = new Proxy({}, {
    get(_, prop) {
      if (prop === 'globalCompositeOperation') return other || mode;
      if (prop === 'canvas') return contexts[0].canvas;
      const v = contexts[0][prop];
      if (typeof v !== 'function') return v;
      if (DRAWS.has(prop)) return (...a) => target()[prop](...a);
      if (QUERIES.has(prop)) return (...a) => contexts[0][prop](...a);
      if (prop === 'save') return () => { stack.push([mode, other]); all('save', []); };
      if (prop === 'restore') return () => { if (stack.length) [mode, other] = stack.pop(); all('restore', []); };
      return (...a) => all(prop, a);
    },
    set(_, prop, value) {
      if (prop === 'globalCompositeOperation') {
        // Only the two modes body draws use get their own segments; any
        // other mode is applied inside the current source-over segment.
        mode = value === 'lighter' ? 'lighter' : 'source-over';
        other = value === 'lighter' || value === 'source-over' ? null : value;
        for (let i = 0; i < contexts.length; i++) if (modes[i] === 'source-over') contexts[i].globalCompositeOperation = other || 'source-over';
        return true;
      }
      for (const c of contexts) c[prop] = value;
      return true;
    },
  });
  return { ctx: facade, used: () => last };
}

/** Two-segment form (normal, additive), kept for callers that want it. */
export function splitContext(normal, additive, { additiveFirst = false } = {}) {
  return segmentedContext([normal, additive], ['source-over', 'lighter'], additiveFirst ? 'lighter' : 'source-over').ctx;
}

function defaultCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export class PerformerCapture {
  /** `residency` (GraphicsResidency) owns the canvas bytes: a set is only
   *  created or resized after its reservation succeeds. */
  constructor({ createCanvas = defaultCanvas, residency = null } = {}) {
    this.createCanvas = createCanvas;
    this.residency = residency;
    this.serial = 0;
    this.pool = [];
    this.stats = { captures: 0, allocations: 0, direct: 0 };
  }

  /** A set of segment canvases not held by an unfinished layer, sized
   *  w x h and clear. */
  _acquire(w, h) {
    let entry = this.pool.find((e) => !e.layer || e.layer.pending === 0);
    const resized = !entry || entry.canvases[0].width !== w || entry.canvases[0].height !== h;
    if (resized && this.residency) {
      // Own the bytes before allocating them; a refusal means this body is
      // drawn directly this frame (no reflection), never an overcommit.
      const key = entry ? entry.key : `performer-capture#${++this.serial}`;
      this.residency.release(key);
      const res = this.residency.reserve({ key, bytes: w * h * 4 * MAX_SEGMENTS, owner: 'performer-capture', evictable: false });
      if (!res) {
        if (entry) { for (const c of entry.canvases) { c.width = 0; c.height = 0; } this.pool.splice(this.pool.indexOf(entry), 1); }
        this.stats.denied = (this.stats.denied || 0) + 1;
        return null;
      }
      this.residency.commit(res, null);
      if (entry) entry.key = key;
      else entry = { key, canvases: null, layer: null };
    }
    if (!entry) entry = { key: null, canvases: null, layer: null };
    if (!entry.canvases) {
      entry.canvases = Array.from({ length: MAX_SEGMENTS }, () => this.createCanvas(w, h));
      this.pool.push(entry);
      this.stats.allocations++;
    }
    for (const c of entry.canvases) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } // resizing clears
      else {
        const x = c.getContext('2d');
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.clearRect(0, 0, w, h);
      }
    }
    return entry;
  }

  /**
   * Draw one performer into a layer.
   *   ctx       the stage context, under the transform the body would use
   *   frameId   the RangeFrame id this layer is valid for
   *   p         { id, bounds: {x,y,w,h} logical incl. glow, hue, visible,
   *               contactY, airbornePx, draw(ctx) }
   *   consumers how many releases (composite + reflection) end its life
   * Returns the layer, or null when it cannot be captured; the caller then
   * draws the body directly (still exactly once).
   */
  capture(ctx, frameId, p, consumers = 2) {
    if (!p?.visible || !p.bounds || typeof ctx.getTransform !== 'function') return null;
    const m = ctx.getTransform();
    if (Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9 || !(m.a > 0) || !(m.d > 0)) return null;
    const cw = ctx.canvas?.width ?? Infinity, ch = ctx.canvas?.height ?? Infinity;
    const x0 = Math.max(0, Math.floor(m.a * p.bounds.x + m.e));
    const y0 = Math.max(0, Math.floor(m.d * p.bounds.y + m.f));
    const x1 = Math.min(cw, Math.ceil(m.a * (p.bounds.x + p.bounds.w) + m.e));
    const y1 = Math.min(ch, Math.ceil(m.d * (p.bounds.y + p.bounds.h) + m.f));
    if (!(x1 > x0 && y1 > y0)) return null;
    const w = x1 - x0, h = y1 - y0;
    const entry = this._acquire(w, h);
    if (!entry) return null;
    const first = ctx.globalCompositeOperation === 'lighter' ? 'lighter' : 'source-over';
    const second = first === 'lighter' ? 'source-over' : 'lighter';
    const modes = entry.canvases.map((_, i) => (i % 2 === 0 ? first : second));
    const contexts = entry.canvases.map((c) => c.getContext('2d'));
    const dash = typeof ctx.getLineDash === 'function' ? ctx.getLineDash() : null;
    contexts.forEach((c, i) => {
      c.save();
      c.setTransform(m.a, 0, 0, m.d, m.e - x0, m.f - y0);
      for (const k of INHERITED) if (ctx[k] !== undefined) c[k] = ctx[k];
      c.globalCompositeOperation = modes[i];
      if (dash) c.setLineDash(dash);
    });
    const seg = segmentedContext(contexts, modes, ctx.globalCompositeOperation);
    try { p.draw(seg.ctx); } finally { for (const c of contexts) c.restore(); }
    const used = seg.used();
    const layer = {
      id: p.id, frameId,
      segments: entry.canvases.slice(0, used + 1).map((canvas, i) => ({ canvas, op: modes[i] })),
      device: { x: x0, y: y0, w, h },
      transform: { a: m.a, d: m.d, e: m.e, f: m.f },
      bounds: { x: (x0 - m.e) / m.a, y: (y0 - m.f) / m.d, w: w / m.a, h: h / m.d },
      hue: p.hue, visible: true, contactY: p.contactY, airbornePx: p.airbornePx || 0,
      pending: consumers,
    };
    entry.layer = layer;
    this.stats.captures++;
    return layer;
  }

  /** Composite a layer at its original device rectangle (one consumer). */
  composite(ctx, layer) {
    if (!layer) return;
    const { x, y } = layer.device;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.shadowBlur = 0;
    for (const s of layer.segments) {
      ctx.globalCompositeOperation = s.op;
      ctx.drawImage(s.canvas, x, y);
    }
    ctx.restore();
    this.release(layer);
  }

  /** One consumer is done with the layer; its canvases return to the pool
   *  only when every consumer has finished. */
  release(layer) {
    if (layer && layer.pending > 0) layer.pending--;
  }

  dispose() {
    for (const e of this.pool) {
      for (const c of e.canvases) { c.width = 0; c.height = 0; }
      if (e.key) this.residency?.release(e.key);
    }
    this.pool.length = 0;
  }
}

/** Plan §7 interface: capture every eligible performer of a frame. */
export function capturePerformerLayers(frame, drawCallbacks, { ctx, capture }) {
  const layers = [];
  for (const p of drawCallbacks) {
    const layer = capture.capture(ctx, frame.frameId, p);
    if (layer) layers.push(layer);
  }
  return layers;
}
