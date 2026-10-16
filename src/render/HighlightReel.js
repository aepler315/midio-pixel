import { HypeDirector } from '../sim/HypeDirector.js';
import { FINALE_FREEZE_LEAD_MS } from '../core/SongFinale.js';
import { EnergyCurves } from '../audio/EnergyCurves.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const MAX_FRAMES = 8;
const MIN_GAP_MS = 5000;
const DROP_WINDOW_MS = 100;
const STEP_MS = 1000 / 120; // The app's simulation step, independent of draws.
const THUMB_W = 320, THUMB_H = 180;
const JPEG_QUALITY = 0.72;
const PRIORITY = Object.freeze({ finale: 0, drop: 1 });
const songCandidates = new WeakMap();
const historyCandidates = new WeakMap();

function compareEvents(a, b) {
  return a.eventAtMs - b.eventAtMs || PRIORITY[a.category] - PRIORITY[b.category]
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Earliest eligible event wins; simultaneous events prefer Finale, then ID.
 * The gap belongs to song events, never to when a draw happened to capture. */
export function selectHighlightCandidates(events) {
  const selected = [], ids = new Set();
  for (const event of [...events].filter(event => event && Object.hasOwn(PRIORITY, event.category)
    && typeof event.id === 'string' && Number.isFinite(event.eventAtMs)
    && Number.isFinite(event.visibleStartMs) && Number.isFinite(event.visibleEndMs)
    && event.visibleEndMs > event.visibleStartMs).sort(compareEvents)) {
    if (ids.has(event.id) || event.eventAtMs - (selected.at(-1)?.eventAtMs ?? -Infinity) < MIN_GAP_MS) continue;
    selected.push(Object.freeze({ ...event })); ids.add(event.id);
    if (selected.length === MAX_FRAMES) break;
  }
  return Object.freeze(selected);
}

/** Replay only the existing drop detector over completed song evidence.
 * Cue ordering matches Simulation: cueDrop first, detector update second.
 * No actors, world, kicks (slam only), render state or live Hype are replayed.
 * Work ends at song duration or as soon as all eight winners are fixed. */
export function buildHighlightCandidates({ durationMs = 0, cues = [], energyCurves = null,
  timeline = [], finale = null, preserved = [], committedThroughMs = -Infinity } = {}, stats = null) {
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return Object.freeze([]);
  const drops = cues.filter(cue => cue.kind === 'drop' && Number.isFinite(cue.tMs)
    && cue.tMs >= 0 && cue.tMs < durationMs).map((cue, index) => ({
    tMs: cue.tMs, strength: typeof cue.value === 'number' ? cue.value : 1,
    id: `drop:cue:${cue.id ?? `${cue.tMs}:${cue.bucket ?? ''}:${index}`}`,
  })).sort((a, b) => a.tMs - b.tMs);
  const events = [...preserved, ...drops.filter(cue => cue.strength > 0 && cue.tMs > committedThroughMs).map(cue => ({
    id: cue.id, category: 'drop', label: 'Drop', source: 'cue', eventAtMs: cue.tMs,
    visibleStartMs: cue.tMs, visibleEndMs: cue.tMs + DROP_WINDOW_MS,
  }))];
  if (timeline.some(event => Number.isFinite(event.tMs) && event.tMs >= 0 && event.tMs <= durationMs)
      && Number.isFinite(finale?.freezeAtMs)) {
    const atMs = Math.max(0, finale.freezeAtMs - FINALE_FREEZE_LEAD_MS);
    if (atMs > committedThroughMs) events.push({ id: `finale:${finale.lastImpactMs}`, category: 'finale', label: 'Finale', source: 'finale',
      eventAtMs: atMs, visibleStartMs: atMs, visibleEndMs: finale.freezeAtMs });
  }
  let selected = selectHighlightCandidates(events), replaySteps = 0;
  if (energyCurves?.globalEnergyNorm) {
    const detector = new HypeDirector();
    // Use the existing normalization unchanged, but resolve its immutable
    // flat-weight percentile once rather than constructing 144k cache keys.
    let replayEnergy = energyCurves;
    if (Object.getPrototypeOf(energyCurves) === EnergyCurves.prototype) {
      const calibration = energyCurves.calibration(FLAT_WEIGHTS);
      replayEnergy = Object.create(energyCurves);
      replayEnergy.calibration = () => calibration;
      let lastTimeMs = NaN, lastIndex = 0;
      replayEnergy._indexAt = timeMs => {
        if (timeMs !== lastTimeMs) { lastTimeMs = timeMs; lastIndex = energyCurves._indexAt(timeMs); }
        return lastIndex;
      };
    }
    let cueIndex = 0;
    const finalTick = Math.ceil(durationMs / STEP_MS);
    for (let tick = 0; tick <= finalTick; tick++) {
      const timeMs = tick * STEP_MS;
      while (cueIndex < drops.length && drops[cueIndex].tMs <= timeMs) {
        detector.cueDrop(timeMs, drops[cueIndex++].strength);
      }
      const before = detector.dropCount;
      detector.update(timeMs, tick === 0 ? 0 : STEP_MS / 1000, replayEnergy);
      replaySteps++;
      if (detector.dropCount > before && timeMs > committedThroughMs) {
        events.push({ id: `drop:energy:${tick}`, category: 'drop', label: 'Drop', source: 'energy',
          eventAtMs: timeMs, visibleStartMs: timeMs, visibleEndMs: timeMs + DROP_WINDOW_MS });
        selected = selectHighlightCandidates(events);
      }
      if (selected.length === MAX_FRAMES && timeMs >= selected.at(-1).eventAtMs) break;
    }
  }
  if (stats) Object.assign(stats, { replaySteps, selected: selected.length });
  return selected;
}

export function highlightCandidatesFor(sim, producerTimeMs = null) {
  const evidence = { durationMs: sim.conductor?.durationMs ?? sim.biomes?.durationMs,
    cues: sim.cues?.cues, energyCurves: sim.energyCurves, timeline: sim.conductor?.timeline,
    finale: sim.fracture?.finale };
  const session = sim.biomes?.ridgeMusicSession;
  const remember = record => {
    if (Number.isFinite(producerTimeMs)) record.producerThroughMs = Math.max(record.producerThroughMs, producerTimeMs);
    songCandidates.set(sim, record);
    if (session?.primary) historyCandidates.set(session.primary, {
      candidates: record.candidates, producerThroughMs: record.producerThroughMs,
    });
    return record.candidates;
  };
  const cached = songCandidates.get(sim);
  if (cached && Object.keys(evidence).every(key => evidence[key] === cached.evidence[key])) return remember(cached);
  let preserved = [], committedThroughMs = -Infinity;
  if (cached) {
    committedThroughMs = Math.max(sim.heardTimeMs ?? sim.timeMs, cached.producerThroughMs);
    preserved = cached.candidates.filter(candidate => candidate.eventAtMs <= committedThroughMs);
  } else if (session?.primary && historyCandidates.has(session.primary)) {
    const prior = historyCandidates.get(session.primary);
    return remember({ evidence, candidates: prior.candidates, producerThroughMs: prior.producerThroughMs });
  } else if (session?.previous) {
    // The existing song-owned history survives the full-analysis scene
    // reconstruction. Its public admission boundary fixes the heard past.
    // A frame can already have shown a later producer-clock event than the
    // heard admission boundary. Preserve that actual frontier as well.
    // A missing prior snapshot still cannot admit invented full-analysis past.
    const prior = historyCandidates.get(session.previous);
    committedThroughMs = Math.max(session.stateKey.handoffStartMs, prior?.producerThroughMs ?? -Infinity);
    preserved = prior?.candidates.filter(candidate => candidate.eventAtMs <= committedThroughMs) ?? [];
  }
  const candidates = buildHighlightCandidates({ ...evidence, preserved, committedThroughMs });
  return remember({ evidence, candidates, producerThroughMs: committedThroughMs });
}

export class HighlightReel {
  constructor() {
    this.frames = [];
    this.selections = Object.freeze([]);
    this._initialized = false;
    this._candidateInput = null;
    this._observed = new Set();
    this._captureFailed = new Set();
    this._lastCaptureMs = -Infinity;
    this._thumbCanvas = null;
  }

  canCapture(eventAtMs) {
    return this.frames.length < MAX_FRAMES && eventAtMs - this._lastCaptureMs >= MIN_GAP_MS;
  }

  /** Observe heard time after composition. Producer windows are half-open:
   * Hype and Fracture currently run on the simulation/source clock, which
   * can lead heard time by output latency. Both actual times are retained.
   * Backseeks cannot change a recorded decision or manufacture a new event. */
  notify(candidates, canvas, heardTimeMs, { frameTimeMs = heardTimeMs,
    producerTimeMs = heardTimeMs, isVisible = () => true } = {}) {
    if (!this._initialized) {
      this.selections = Object.freeze(selectHighlightCandidates(candidates).map(candidate => Object.freeze({ ...candidate, status: 'pending' })));
      this._initialized = true;
    } else if (candidates !== this._candidateInput) {
      const past = this.selections.filter(candidate => candidate.eventAtMs <= producerTimeMs || candidate.status !== 'pending');
      const future = candidates.filter(candidate => candidate.eventAtMs > producerTimeMs);
      this.selections = Object.freeze(selectHighlightCandidates([...past, ...future])
        .map(candidate => candidate.status ? candidate : Object.freeze({ ...candidate, status: 'pending' })));
    }
    this._candidateInput = candidates;
    let captured = false;
    const next = this.selections.map(candidate => {
      if (candidate.status !== 'pending' || producerTimeMs < candidate.visibleStartMs) return candidate;
      if (producerTimeMs >= candidate.visibleEndMs) {
        const status = this._captureFailed.has(candidate.id) ? 'failed'
          : this._observed.has(candidate.id) ? 'rejected' : 'missed';
        return Object.freeze({ ...candidate, status, observedAtMs: heardTimeMs, observedFrameMs: frameTimeMs });
      }
      this._observed.add(candidate.id);
      if (!isVisible(candidate)) return candidate;
      if (!this.capture(canvas, heardTimeMs, candidate.label, candidate, frameTimeMs)) {
        this._captureFailed.add(candidate.id);
        return candidate;
      }
      captured = true;
      return Object.freeze({ ...candidate, status: 'captured', observedAtMs: heardTimeMs,
        observedFrameMs: frameTimeMs, capturedAtMs: frameTimeMs });
    });
    if (next.some((candidate, index) => candidate !== this.selections[index])) this.selections = Object.freeze(next);
    if (this.selections.every(candidate => candidate.status !== 'pending')) this._releaseCanvas();
    return captured;
  }

  capture(canvas, heardTimeMs, label, candidate = null, frameTimeMs = heardTimeMs) {
    const eventAtMs = candidate?.eventAtMs ?? heardTimeMs;
    if (!this.canCapture(eventAtMs)) return false;
    try {
      if (!this._thumbCanvas) {
        this._thumbCanvas = document.createElement('canvas');
        this._thumbCanvas.width = THUMB_W; this._thumbCanvas.height = THUMB_H;
      }
      const ctx = this._thumbCanvas.getContext('2d');
      ctx.drawImage(canvas, 0, 0, THUMB_W, THUMB_H);
      const dataUrl = this._thumbCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
      this.frames.push({ dataUrl, atMs: heardTimeMs, label, eventAtMs,
        eventId: candidate?.id ?? null, category: candidate?.category ?? null, capturedAtMs: frameTimeMs });
      this._lastCaptureMs = eventAtMs;
      if (this.frames.length === MAX_FRAMES) this._releaseCanvas();
      return true;
    } catch {
      this._releaseCanvas();
      return false;
    }
  }

  _releaseCanvas() {
    if (this._thumbCanvas) { this._thumbCanvas.width = 0; this._thumbCanvas.height = 0; }
    this._thumbCanvas = null;
  }
}
