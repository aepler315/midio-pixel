// Chooser previews: stills and one live passage, rendered by the same world
// configuration (the Range uses a labeled legacy illustration). Pure
// passage/copy helpers live here so
// Node tests can pin the contract without a document. Canvas work is
// browser-only and injectable, so a test never has to boot BiomeManager.
import { Conductor } from '../core/Conductor.js';
import { Role } from '../core/NoteEvent.js';
import { clamp, clamp01 } from '../utils/math.js';
import { buildWorldVariant } from '../world/WorldScore.js';
import {
  listWorlds, getWorld, resolveWorldId, getCustomWorld, setCustomWorld, clearCustomWorld,
} from '../world/Worlds.js';

export const PREVIEW_VERSION = 1;
export const PREVIEW_SPAN_MS = 8000;
export const PREVIEW_W = 480;
export const PREVIEW_H = 270;

const EDGE = 0.08;
const STEP_MS = 200;
const WINDOW_MS = 1200;

const PREVIEW_PERF = {
  phenomenaFull: false,
  particleMul: 0.35,
  contactShadowsEnabled: false,
  rimLightEnabled: false,
  brushEnabled: false,
};

/**
 * Two timestamps shared by every world: a quiet stretch and a peak stretch.
 * Same song, same clock, so a card comparison is a comparison of worlds,
 * not of different moments. Falls back to proportional positions when there
 * is no energy curve to read.
 */
export function pickPreviewPassages({ energyCurves = null, durationMs = 0 } = {}) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const span = Math.min(PREVIEW_SPAN_MS, duration);
  if (duration <= 0) {
    return { quietMs: 0, peakMs: 0, durationMs: 0, spanMs: 0 };
  }
  const maxStart = Math.max(0, duration - span);
  let quietMs = clamp(duration * 0.15, 0, maxStart);
  let peakMs = clamp(duration * 0.52, 0, maxStart);

  const sample = energyCurves && typeof energyCurves.globalEnergyNorm === 'function'
    ? (t) => {
      let sum = 0, n = 0;
      for (let i = 0; i < WINDOW_MS / 200; i++) {
        const at = t + i * 200;
        if (at > duration) break;
        const v = energyCurves.globalEnergyNorm(at);
        if (Number.isFinite(v)) { sum += v; n++; }
      }
      return n ? sum / n : 0;
    }
    : null;

  if (sample && duration > span + 1000) {
    const lo = duration * EDGE;
    const hi = Math.max(lo, duration * (1 - EDGE) - span);
    let minE = Infinity, maxE = -Infinity;
    for (let t = lo; t <= hi; t += STEP_MS) {
      const e = sample(t);
      if (e < minE) { minE = e; quietMs = t; }
      if (e > maxE) { maxE = e; peakMs = t; }
    }
    if (Math.abs(peakMs - quietMs) < span * 0.45) {
      const shifted = clamp(quietMs + span, 0, maxStart);
      if (Math.abs(shifted - quietMs) >= span * 0.45) peakMs = shifted;
      else quietMs = clamp(peakMs - span, 0, maxStart);
    }
  }

  return {
    quietMs: Math.round(quietMs),
    peakMs: Math.round(peakMs),
    durationMs: duration,
    spanMs: span,
  };
}

export function passageStart(passages, which = 'peak') {
  if (!passages) return 0;
  return which === 'quiet' ? passages.quietMs : passages.peakMs;
}

/**
 * One sentence the chooser can show, derived from measured features.
 * Never mentions a score, a rank, or a musical fact we did not measure.
 */
export function describeWorldResponse(kind, features = {}, extras = {}) {
  const f = features || {};
  const onset = Number(f.onset) || 0;
  const bass = Number(f.bass) || 0;
  const groove = Number(f.groove) || 0;
  const phrase = Number(f.phrase) || 0;
  const air = Number(f.air) || 0;
  const texture = Number(f.texture) || 0;
  const contrast = Number(f.contrast) || 0;
  const form = Number(f.form) || 0;
  const hasLabels = !!extras.hasLabels;

  switch (kind) {
    case 'alpine':
      return phrase > 0.45
        ? 'Phrases shape the ridgeline; bass gives the range its weight.'
        : 'Atmosphere first. Isolated phrases move the ridgeline.';
    case 'city':
      return onset > 0.38
        ? 'Selected hits light one district at a time; the rest of the city stays dim.'
        : groove > 0.4
          ? 'Windows follow the groove; lamps idle with the mix.'
          : 'A quieter city. Sparse windows, no invented traffic.';
    case 'abyssal':
      return bass > 0.4
        ? 'Broad waves follow the bass; small lights follow the percussion.'
        : 'A still column. Light follows whatever low end is there.';
    case 'airless':
      return air > 0.45
        ? 'Slow form guides the illumination. Isolated accents leave a surface trace.'
        : 'Composition and stillness. Dense hits are filtered so the limb does not strobe.';
    case 'strip':
      return groove > 0.45
        ? 'The road cruises with the mix. Phrase boundaries open a tunnel, then a horizon.'
        : 'A controlled cruise. No tempo is invented from a missing beat.';
    case 'foundry':
      return onset > 0.4
        ? 'Percussion drops one hammer at a time; sustained energy is the heat.'
        : 'Low embers. A kick is not a pour.';
    case 'overgrowth':
      return texture > 0.4
        ? 'Sustained texture grows the canopy; phrases open the light. One colony answers each hit.'
        : 'Slow structural growth. Fine activity follows whatever detail is there.';
    case 'nave':
      if (hasLabels) {
        return 'Returning sections light the same stained-glass bays; bass fills the interior.';
      }
      return bass > 0.35
        ? 'Bays follow the bass equally. No chorus is invented from missing labels.'
        : 'Broad phrasing. Weak structure does not mint a motif.';
    default:
      return contrast + form > 0.8
        ? 'The scene follows measured contrast and shape, not a guessed genre.'
        : 'The scene follows the mix as measured.';
  }
}

export function previewCacheKey({
  worldId, seed, tMs, reducedFlash = false, reducedMotion = false, version = PREVIEW_VERSION,
} = {}) {
  return `${version}|${worldId}|${seed >>> 0}|${Math.round(tMs || 0)}|${reducedFlash ? 1 : 0}|${reducedMotion ? 1 : 0}`;
}

function withCustomWorld(world, fn) {
  const prev = getCustomWorld();
  setCustomWorld(world);
  try {
    return fn();
  } finally {
    if (prev) setCustomWorld(prev);
    else clearCustomWorld();
  }
}

/**
 * Build a tailored world, then draw it at `tMs`. The Range illustrates its
 * legacy configuration; its chooser card labels this explicitly.
 * Caller must dispose(). Browser-only: strip bakes need a canvas factory.
 */
export function createPreviewWorld({
  worldId, data = {}, features = null, seed = 1,
  reducedFlash = false, reducedMotion = false, width = PREVIEW_W, height = PREVIEW_H,
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  worldId = resolveWorldId(worldId);
  const stock = getWorld(worldId);

  const variant = worldId === getCustomWorld()?.id ? stock : buildWorldVariant(worldId, features, data).world;
  const conductor = new Conductor();
  conductor.load({
    timeline: data.timeline || [],
    barGrid: data.barGrid || [],
    durationMs: data.durationMs || 0,
  });
  const groundY = Math.round(625 * (height / 720));
  const Ctor = createPreviewWorld._BiomeManager;
  if (!Ctor) throw new Error('Preview renderer is not loaded');
  const mgr = withCustomWorld(variant, () => new Ctor({
    conductor,
    energyCurves: data.energyCurves || null,
    durationMs: data.durationMs || 0,
    canvasWidth: width,
    canvasHeight: height,
    groundY,
    songSeed: seed >>> 0,
    structure: data.structure || null,
    lyricSections: data.lyricSections || null,
    worldId: 'custom',
  }));
  mgr.reducedFlash = !!reducedFlash;
  mgr.reducedMotion = !!reducedMotion;
  mgr.openingGain = 1;
  const scale = height / 720;
  const speed = 220 * scale;
  const originX = 220 * scale;

  return {
    kind: variant.kind,
    canvas,
    draw(tMs) {
      const now = Math.max(0, tMs);
      mgr.orogenyGrowth = clamp01(0.12 + (now / Math.max(1, data.durationMs || 1)) * 0.75);
      mgr._progress = clamp01(now / Math.max(1, data.durationMs || 1));
      const nearest = conductor.nearestEventMs((e) => e.role === Role.RHYTHM, now, 1200);
      if (nearest) mgr.worldRhythm = nearest;
      mgr.update(now, 1 / 30, data.energyCurves || null, 0.18, now / 1000 * speed);
      const ctx = canvas.getContext('2d');
      mgr.draw(ctx, canvas, now / 1000 * speed, originX, null, PREVIEW_PERF.particleMul, PREVIEW_PERF, null);
    },
    dispose() {
      mgr.dispose();
    },
  };
}

createPreviewWorld._BiomeManager = null;

export async function loadPreviewRenderer() {
  if (createPreviewWorld._BiomeManager) return;
  const mod = await import('../world/BiomeManager.js');
  createPreviewWorld._BiomeManager = mod.BiomeManager;
}

export function renderWorldStill(args) {
  const world = createPreviewWorld(args);
  try {
    world.draw(args.tMs || 0);
    return world.canvas.toDataURL('image/png');
  } finally {
    world.dispose();
  }
}

function defaultSchedule(fn) {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(() => fn(), { timeout: 240 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 0);
  return () => clearTimeout(id);
}

/**
 * One session per analyzed song. Stills are generated one world at a time
 * and cached by world/seed/timestamp. Only one animated preview runs.
 * cancel() drops the queue, stops audio, and disposes any live world so a
 * later Play cannot inherit preview timing.
 */
export class PreviewSession {
  constructor({
    data, features, seed = 1, reducedFlash = false, reducedMotion = false,
    worldIds = null,
    renderStill = null,
    createWorld = null,
    schedule = defaultSchedule,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    playAudio = null,
    stopAudio = () => {},
    onStill = () => {},
    onPreviewFrame = () => {},
    onPreviewStart = () => {},
    onPreviewEnd = () => {},
  } = {}) {
    this.data = data || {};
    this.features = features || {};
    this.seed = seed >>> 0;
    this.reducedFlash = !!reducedFlash;
    this.reducedMotion = !!reducedMotion;
    this.passages = pickPreviewPassages(this.data);
    this.passage = 'peak';
    this.worldIds = worldIds || listWorlds().map((w) => w.id);
    this.cache = new Map();
    this._queue = [];
    this._busy = false;
    this._alive = true;
    this._cancelSchedule = null;
    this._renderStill = renderStill;
    this._createWorld = createWorld;
    this._schedule = schedule;
    this._now = now;
    this._playAudio = playAudio;
    this._stopAudio = stopAudio;
    this.onStill = onStill;
    this.onPreviewFrame = onPreviewFrame;
    this.onPreviewStart = onPreviewStart;
    this.onPreviewEnd = onPreviewEnd;
    this._live = null;
    this._raf = 0;
    this._previewWorldId = null;
  }

  get activePreviewId() {
    return this._previewWorldId;
  }

  keyFor(worldId, which = this.passage) {
    return previewCacheKey({
      worldId,
      seed: this.seed,
      tMs: passageStart(this.passages, which),
      reducedFlash: this.reducedFlash,
      reducedMotion: this.reducedMotion,
    });
  }

  enqueueAll() {
    if (!this._alive) return;
    for (const id of this.worldIds) this.enqueue(id);
  }

  enqueue(worldId, front = false) {
    if (!this._alive) return;
    const key = this.keyFor(worldId);
    if (this.cache.has(key)) {
      this.onStill({ worldId, dataUrl: this.cache.get(key), passage: this.passage, cached: true });
      return;
    }
    if (this._queue.some((job) => job.worldId === worldId && job.key === key)) return;
    const job = { worldId, key, passage: this.passage };
    if (front) this._queue.unshift(job);
    else this._queue.push(job);
    this._kick();
  }

  setPassage(which) {
    if (which !== 'quiet' && which !== 'peak') return;
    if (this.passage === which) return;
    this.stopPreview();
    this.passage = which;
    this._queue = [];
    this.enqueueAll();
  }

  async preview(worldId) {
    if (!this._alive) return;
    if (this._previewWorldId === worldId && this._live) return;
    this.stopPreview();
    this.enqueue(worldId, true);
    this._previewWorldId = worldId;
    this.onPreviewStart({ worldId, reduced: this.reducedFlash || this.reducedMotion });
    if (this.reducedFlash || this.reducedMotion) return;

    const t0 = passageStart(this.passages, this.passage);
    const create = this._createWorld || ((args) => {
      if (!createPreviewWorld._BiomeManager) {
        throw new Error('Preview renderer is not loaded');
      }
      return createPreviewWorld(args);
    });
    let live;
    try {
      live = create({
        worldId,
        data: this.data,
        features: this.features,
        seed: this.seed,
        reducedFlash: this.reducedFlash,
        reducedMotion: this.reducedMotion,
      });
    } catch (err) {
      this._previewWorldId = null;
      this.onPreviewEnd({ worldId });
      throw err;
    }
    this._live = live;
    const started = this._now();
    if (this._playAudio) {
      try { this._playAudio(t0 / 1000, this.passages.spanMs / 1000); } catch { /* preview audio is optional */ }
    }
    const tick = () => {
      if (!this._alive || this._previewWorldId !== worldId) return;
      const elapsed = this._now() - started;
      if (elapsed >= this.passages.spanMs) {
        live.draw(t0 + this.passages.spanMs);
        this.onPreviewFrame({ worldId, canvas: live.canvas, tMs: t0 + this.passages.spanMs, done: true });
        this.stopPreview();
        return;
      }
      const tMs = t0 + elapsed;
      live.draw(tMs);
      this.onPreviewFrame({ worldId, canvas: live.canvas, tMs, done: false });
      this._raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(tick)
        : setTimeout(tick, 32);
    };
    tick();
  }

  stopPreview() {
    if (this._raf) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
      else clearTimeout(this._raf);
      this._raf = 0;
    }
    if (this._live) {
      try { this._live.dispose(); } catch { /* ignore */ }
      this._live = null;
    }
    try { this._stopAudio(); } catch { /* ignore */ }
    if (this._previewWorldId) {
      const id = this._previewWorldId;
      this._previewWorldId = null;
      this.onPreviewEnd({ worldId: id });
    }
  }

  cancel() {
    this._alive = false;
    this._queue = [];
    if (this._cancelSchedule) {
      this._cancelSchedule();
      this._cancelSchedule = null;
    }
    this.stopPreview();
    this.cache.clear();
  }

  _kick() {
    if (this._busy || !this._alive || !this._queue.length) return;
    this._busy = true;
    this._cancelSchedule = this._schedule(() => {
      this._cancelSchedule = null;
      this._runNext();
    });
  }

  _runNext() {
    if (!this._alive) { this._busy = false; return; }
    const job = this._queue.shift();
    if (!job) { this._busy = false; return; }
    const finish = (dataUrl) => {
      if (dataUrl && this._alive) {
        this.cache.set(job.key, dataUrl);
        this.onStill({ worldId: job.worldId, dataUrl, passage: job.passage, cached: false });
      }
      this._busy = false;
      this._kick();
    };
    try {
      const render = this._renderStill || ((args) => renderWorldStill(args));
      const result = render({
        worldId: job.worldId,
        data: this.data,
        features: this.features,
        seed: this.seed,
        tMs: passageStart(this.passages, job.passage),
        reducedFlash: this.reducedFlash,
        reducedMotion: this.reducedMotion,
      });
      if (result && typeof result.then === 'function') {
        result.then(finish, () => finish(null));
      } else {
        finish(result);
      }
    } catch (err) {
      console.warn('[world preview] still failed', job.worldId, err);
      finish(null);
    }
  }
}
