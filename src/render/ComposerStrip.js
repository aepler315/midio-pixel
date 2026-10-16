// Full-song seekbar: the entire track as a mountain-range silhouette of
// musical energy, with a sweeping playhead. Replaces the old Mario Paint
// four-bar page strip.
//
//   F3  — toggle section labels (how BiomeManager / SongForm / lyrics
//         labeled each stretch of the song)
//   click strip — seek playback
//   click a labeled section — open a detail overlay for debugging
//
// Pure helpers stay DOM-free for tests; draw() needs canvas 2D.
import { Role } from '../core/NoteEvent.js';
import { clamp, clamp01 } from '../utils/math.js';

// Slim transport strip — reads as part of the HUD, not a second game.
const STRIP_H = 72;
const STRIP_PAD = 14;
const STRIP_BOTTOM = 10;
const MOUNTAIN_INSET_X = 2;
const MOUNTAIN_SAMPLES = 320;

// Quiet palette (matches #e8e6f0 / #ffd76a HUD language without the candy).
const C = {
  panel: 'rgba(8, 7, 14, 0.78)',
  panelEdge: 'rgba(255, 255, 255, 0.07)',
  ridge: 'rgba(232, 230, 240, 0.42)',
  mountainTop: 'rgba(200, 190, 230, 0.38)',
  mountainMid: 'rgba(90, 80, 130, 0.42)',
  mountainBase: 'rgba(18, 16, 28, 0.88)',
  played: 'rgba(4, 3, 10, 0.38)',
  boundary: 'rgba(255, 255, 255, 0.12)',
  select: 'rgba(255, 215, 106, 0.12)',
  selectEdge: 'rgba(255, 215, 106, 0.55)',
  playhead: 'rgba(255, 236, 200, 0.95)',
  playheadGlow: 'rgba(255, 200, 120, 0.35)',
  time: 'rgba(232, 230, 240, 0.45)',
  timeNow: 'rgba(255, 215, 106, 0.85)',
  label: 'rgba(255, 230, 180, 0.9)',
  labelMuted: 'rgba(200, 205, 220, 0.55)',
  detailBg: 'rgba(10, 9, 16, 0.94)',
  detailEdge: 'rgba(255, 255, 255, 0.1)',
  detailTitle: 'rgba(255, 215, 106, 0.92)',
  detailKey: 'rgba(160, 165, 185, 0.75)',
  detailVal: 'rgba(232, 230, 240, 0.9)',
  font: 'system-ui, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "SF Mono", Consolas, monospace',
};

// Kept for tests / diatonic helpers that other modules still import.
export const STAFF_ROWS = 13;

const SEMITONE_TABLE = [
  [0, false], [0, true], [1, false], [1, true], [2, false], [3, false],
  [3, true], [4, false], [4, true], [5, false], [5, true], [6, false],
];

/** Weighted pitch-class histogram; argmax = estimated tonic. */
export function estimateTonicPc(timeline) {
  const weight = new Array(12).fill(0);
  let any = false;
  for (const evt of timeline || []) {
    if (evt.role === Role.RHYTHM) continue;
    const pc = ((evt.pitch % 12) + 12) % 12;
    weight[pc] += (evt.durMs || 90) * Math.max(0.05, evt.vel ?? 0.5);
    any = true;
  }
  if (!any) return 0;
  let best = 0;
  for (let pc = 1; pc < 12; pc++) if (weight[pc] > weight[best]) best = pc;
  return best;
}

export function diatonicIndex(pitch, tonicPc) {
  const rel = pitch - tonicPc;
  const octave = Math.floor(rel / 12);
  const semitone = rel - octave * 12;
  const [degree, accidental] = SEMITONE_TABLE[semitone];
  return { step: octave * 7 + degree, accidental };
}

export function iconFor(evt) {
  if (evt.role === Role.RHYTHM) return evt.kick ? 'wheel' : 'drum';
  if (evt.role === Role.MELODY) return 'star';
  if (evt.role === Role.BASS) return 'heart';
  return 'flower';
}

export function popBump(dtMs) {
  const u = (dtMs - 30) / 80;
  return dtMs > -80 && dtMs < 200 ? Math.exp(-u * u) : 0;
}

export function stratifyCap(events, cap, pageStartMs, pageMs, slots = 32) {
  if (events.length <= cap) return events;
  const buckets = Array.from({ length: slots }, () => []);
  for (const evt of events) {
    const s = clamp(Math.floor(((evt.tMs - pageStartMs) / pageMs) * slots), 0, slots - 1);
    buckets[s].push(evt);
  }
  for (const b of buckets) b.sort((a, c) => c.vel - a.vel);
  const kept = [];
  for (let round = 0; kept.length < cap; round++) {
    let took = 0;
    for (const b of buckets) {
      if (round < b.length && kept.length < cap) { kept.push(b[round]); took++; }
    }
    if (took === 0) break;
  }
  return kept.sort((a, b) => a.tMs - b.tMs);
}

/** Form label integer → A, B, C, … */
export function formLetter(label) {
  if (!Number.isFinite(label) || label < 0) return '?';
  let n = Math.floor(label);
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Build a 0..1 height field for the whole song from note density + kicks.
 * Pure — tests can call without canvas.
 */
export function buildSongMountain(timeline, durationMs, samples = MOUNTAIN_SAMPLES) {
  const n = Math.max(8, samples | 0);
  const raw = new Float32Array(n);
  const dur = Math.max(1, durationMs || 1);
  for (const e of timeline || []) {
    const t = e.tMs || 0;
    if (t < 0 || t > dur + 50) continue;
    const i = clamp(Math.floor((t / dur) * n), 0, n - 1);
    const v = Math.max(0.05, e.vel ?? 0.5);
    raw[i] += (e.kick ? 2.2 : e.role === Role.RHYTHM ? 1.1 : 0.85) * v;
    // Short notes still paint a shoulder so sparse songs have silhouette.
    if (i + 1 < n) raw[i + 1] += 0.25 * v;
    if (i > 0) raw[i - 1] += 0.15 * v;
  }
  // Box blur (2 passes) for a continuous mountain range, not a comb.
  const smooth = new Float32Array(n);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? raw : smooth;
    const dst = pass === 0 ? smooth : raw;
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -3; k <= 3; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        s += src[j];
        c++;
      }
      dst[i] = s / c;
    }
  }
  const heights = passMaxNorm(raw);
  return heights;
}

function passMaxNorm(arr) {
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  const out = new Float32Array(arr.length);
  if (max <= 1e-9) {
    for (let i = 0; i < arr.length; i++) out[i] = 0.08 + 0.04 * Math.sin(i * 0.2);
    return out;
  }
  for (let i = 0; i < arr.length; i++) out[i] = clamp01(arr[i] / max);
  return out;
}

export class ComposerStrip {
  /**
   * @param {object[]} timeline
   * @param {object[]} barGrid
   * @param {number} durationMs
   * @param {object[]} [holds]
   * @param {object[]} [sections] BiomeManager.sections after form + lyric fuse
   */
  constructor(timeline, barGrid, durationMs, holds = [], sections = null, audioOverview = null) {
    this.timeline = timeline || [];
    this.barGrid = barGrid || [];
    this.durationMs = Math.max(1, durationMs || 1);
    this.holds = holds || [];
    this.sections = sections || [];
    this.mountain = audioOverview?.length ? audioOverview : buildSongMountain(this.timeline, this.durationMs, MOUNTAIN_SAMPLES);
    /** True when `durationMs` is a nominal guess rather than a measured
     *  length -- set by the live-listening path, where the song has not
     *  finished happening yet. Only affects how the clock is labelled. */
    this.estimatedDuration = false;

    // Legacy fields some tests still poke.
    let barMs = 500;
    if (this.barGrid.length >= 2) {
      const gaps = [];
      for (let i = 1; i < this.barGrid.length; i++) gaps.push(this.barGrid[i].ms - this.barGrid[i - 1].ms);
      gaps.sort((a, b) => a - b);
      barMs = gaps[Math.floor(gaps.length / 2)] || 500;
    }
    this.barMs = barMs;
    this.pageMs = 4 * barMs;
    this.pages = [];
    this.tonicPc = estimateTonicPc(this.timeline);
    this.sMid = 0;

    this.showLabels = false;
    this.selectedSection = -1; // index into sections, or -1
    this._layoutCache = null;
  }

  setSections(sections) {
    this.sections = sections || [];
    if (this.selectedSection >= this.sections.length) this.selectedSection = -1;
  }

  toggleLabels() {
    this.showLabels = !this.showLabels;
    return this.showLabels;
  }

  pageIndexAt(nowMs) { return Math.max(0, Math.floor(nowMs / this.pageMs)); }
  playheadFrac(nowMs) {
    return clamp01(nowMs / this.durationMs);
  }

  staffRow() { return Math.floor(STAFF_ROWS / 2); }
  rowInfo() { return { row: this.staffRow(), accidental: false, ledger: false }; }

  /** Layout in stage pixels (logical 1280×720 space when drawn through stage transform). */
  layout(canvas) {
    const x0 = STRIP_PAD;
    const h = STRIP_H;
    const y0 = canvas.height - h - STRIP_BOTTOM;
    const w = canvas.width - x0 * 2;
    // Inner mountain rect (padding for time row + edge breathing room).
    const mx0 = x0 + MOUNTAIN_INSET_X;
    const mw = w - MOUNTAIN_INSET_X * 2;
    const my0 = y0 + 4;
    const mh = h - 18; // leave baseline for time
    this._layoutCache = { x0, y0, w, h, mx0, mw, my0, mh };
    return this._layoutCache;
  }

  /** Map time → x within the mountain track. */
  _xAt(tMs, L) {
    const dur = Math.max(1, this.durationMs);
    return L.mx0 + clamp01(tMs / dur) * L.mw;
  }

  /** Hit-test stage coords. Returns null outside strip. */
  hitTest(stageX, stageY, canvas) {
    const L = this.layout(canvas);
    if (stageX < L.x0 || stageX > L.x0 + L.w || stageY < L.y0 || stageY > L.y0 + L.h) {
      if (this.selectedSection >= 0) {
        const panel = this._detailPanelRect(L);
        if (stageX >= panel.x && stageX <= panel.x + panel.w
          && stageY >= panel.y && stageY <= panel.y + panel.h) {
          return { type: 'detail', sectionIndex: this.selectedSection };
        }
      }
      return null;
    }
    const u = clamp01((stageX - L.mx0) / Math.max(1, L.mw));
    const tMs = u * this.durationMs;
    return { type: 'strip', tMs, sectionIndex: this.sectionIndexAt(tMs), u };
  }

  sectionIndexAt(tMs) {
    const secs = this.sections;
    if (!secs.length) return -1;
    for (let i = 0; i < secs.length; i++) {
      if (tMs >= secs[i].startMs && tMs < secs[i].endMs) return i;
    }
    return secs.length - 1;
  }

  _detailPanelRect(L) {
    const w = Math.min(340, L.w * 0.42);
    const h = 132;
    return {
      x: L.x0 + 6,
      y: L.y0 - h - 6,
      w,
      h,
    };
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {{width:number,height:number}} canvas
   * @param {number} nowMs
   * @param {{ showLabels?: boolean }} [opts]
   */
  draw(ctx, canvas, nowMs, opts = {}) {
    if (opts.showLabels != null) this.showLabels = !!opts.showLabels;
    const L = this.layout(canvas);
    const { x0, y0, w, h, mx0, mw, my0, mh } = L;
    const uNow = this.playheadFrac(nowMs);
    const px = mx0 + uNow * mw;
    const baseY = my0 + mh;

    ctx.save();

    // Plate — soft glass, hairline edge (no gold picture-frame).
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, 8);
    ctx.fillStyle = C.panel;
    ctx.fill();
    ctx.strokeStyle = C.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Clip mountain + overlays into the plate interior.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x0 + 1, y0 + 1, w - 2, h - 2, 7);
    ctx.clip();

    // Mountain fill
    this._drawMountain(ctx, L, baseY);

    // Section structure (boundaries + selection) — under playhead, over fill
    this._drawSections(ctx, L, baseY);

    // Played region: cool the past without crushing the silhouette
    if (uNow > 0.002) {
      ctx.fillStyle = C.played;
      ctx.fillRect(mx0, my0, Math.max(0, px - mx0), mh);
    }

    // Ridge outline on top of wash so the skyline stays sharp
    this._drawMountainRidge(ctx, L, baseY);

    // Labels sit above the mountain, below the playhead
    if (this.showLabels) this._drawLabels(ctx, L);

    // Playhead — thin luminous needle, no cartoon chevron
    this._drawPlayhead(ctx, px, my0, baseY);

    ctx.restore(); // clip

    // Time: current left, duration right — outside the mountain clip, on the baseline
    ctx.font = `10px ${C.mono}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.timeNow;
    ctx.textAlign = 'left';
    ctx.fillText(formatClock(nowMs), x0 + 10, y0 + h - 6);
    ctx.fillStyle = C.time;
    ctx.textAlign = 'right';
    // Live listening cannot know how long the song is -- it is watching one
    // happen. The nominal length it runs its arc against is a guess, and a
    // guess drawn in the same type as a measured duration is a lie the rest
    // of this readout does not tell.
    ctx.fillText(
      (this.estimatedDuration ? '~' : '') + formatClock(this.durationMs),
      x0 + w - 10, y0 + h - 6,
    );

    if (this.analysisOpening) {
      ctx.textAlign = 'center';
      ctx.fillStyle = C.time;
      ctx.fillText(this.analysisOpening.failed ? 'Full-song analysis failed · reload song to retry' : 'Analyzing full song…',
        x0 + w / 2, y0 + h - 6, Math.max(1, w - 140));
    }

    if (this.selectedSection >= 0 && this.selectedSection < this.sections.length) {
      this._drawSectionDetail(ctx, L, this.sections[this.selectedSection], this.selectedSection);
    }

    ctx.restore();
  }

  _drawMountain(ctx, L, baseY) {
    const { mx0, mw, my0, mh } = L;
    const n = this.mountain.length;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(mx0, baseY);
      for (let i = 0; i < n; i++) {
        const x = mx0 + (i / Math.max(1, n - 1)) * mw;
        const y = baseY - this.mountain[i] * mh * 0.88;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(mx0 + mw, baseY);
      ctx.closePath();
    };
    path();
    const g = ctx.createLinearGradient(0, my0, 0, baseY);
    g.addColorStop(0, C.mountainTop);
    g.addColorStop(0.55, C.mountainMid);
    g.addColorStop(1, C.mountainBase);
    ctx.fillStyle = g;
    ctx.fill();
  }

  _drawMountainRidge(ctx, L, baseY) {
    const { mx0, mw, mh } = L;
    const n = this.mountain.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = mx0 + (i / Math.max(1, n - 1)) * mw;
      const y = baseY - this.mountain[i] * mh * 0.88;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = C.ridge;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  _drawSections(ctx, L, baseY) {
    const secs = this.sections;
    if (!secs.length) return;
    const { my0, mh } = L;

    for (let i = 0; i < secs.length; i++) {
      const s = secs[i];
      const xa = this._xAt(s.startMs, L);
      const xb = this._xAt(s.endMs, L);
      const sw = Math.max(1, xb - xa);

      if (this.selectedSection === i) {
        ctx.fillStyle = C.select;
        ctx.fillRect(xa, my0, sw, mh);
        // Top accent bar only — no full gold frame
        ctx.fillStyle = C.selectEdge;
        ctx.fillRect(xa, my0, sw, 2);
      }

      if (i > 0) {
        // Hairline section cut
        ctx.strokeStyle = C.boundary;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(xa) + 0.5, my0 + 2);
        ctx.lineTo(Math.round(xa) + 0.5, baseY - 2);
        ctx.stroke();
      }
    }
  }

  _drawPlayhead(ctx, px, top, bot) {
    // Soft bloom
    ctx.strokeStyle = C.playheadGlow;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(px, top + 1);
    ctx.lineTo(px, bot - 1);
    ctx.stroke();
    // Core needle
    ctx.strokeStyle = C.playhead;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(px, top + 1);
    ctx.lineTo(px, bot - 1);
    ctx.stroke();
    // Small cap
    ctx.fillStyle = C.playhead;
    ctx.beginPath();
    ctx.arc(px, top + 3, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawLabels(ctx, L) {
    const secs = this.sections;
    if (!secs.length) return;
    const { my0 } = L;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `600 9px ${C.font}`;

    for (let i = 0; i < secs.length; i++) {
      const s = secs[i];
      const xa = this._xAt(s.startMs, L);
      const xb = this._xAt(s.endMs, L);
      const sw = xb - xa;
      if (sw < 22) continue;

      const mid = (xa + xb) / 2;
      const letter = formLetter(s.label);
      const kind = s.kind || s.lyricKind || '';
      // Prefer form letter; append kind only when the band is wide enough.
      let text = letter;
      if (kind && sw >= 56) text = `${letter}  ${kind}`;
      else if (kind && sw >= 36) text = `${letter}·${kind.slice(0, 3)}`;

      // Soft shadow + glyph — no solid label bricks
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(text, mid + 0.5, my0 + 5.5, sw - 6);
      ctx.fillStyle = this.selectedSection === i ? C.label : C.labelMuted;
      ctx.fillText(text, mid, my0 + 5, sw - 6);
    }
  }

  _drawSectionDetail(ctx, L, sec, index) {
    const panel = this._detailPanelRect(L);
    const { x, y, w, h } = panel;
    const letter = formLetter(sec.label);
    const biome = typeof sec.profile === 'string' ? sec.profile : (sec.profile?.name || '—');
    const kind = sec.kind || sec.lyricKind || null;
    const conf = sec.lyricConfidence ?? sec.confidence;
    const valence = sec.lyricValence ?? sec.valence;
    const intensity = sec.lyricIntensity ?? sec.intensity;
    const rows = [
      ['time', `${formatClock(sec.startMs)} – ${formatClock(sec.endMs)}  (${formatDur(sec.endMs - sec.startMs)})`],
      ['form', letter],
      ['biome', biome],
      ['enter', sec.transition || '—'],
      ['lyric', kind ? `${kind}  ·  conf ${fmt(conf)}` : '—'],
      ['feel', `val ${fmt(valence)}   int ${fmt(intensity)}   hue ${fmt(sec.hueBias, 0)}°`],
    ];

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fillStyle = C.detailBg;
    ctx.fill();
    ctx.strokeStyle = C.detailEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
    // Left accent — selected section indicator, not a full gold border
    ctx.fillStyle = C.selectEdge;
    ctx.fillRect(x, y + 10, 2, h - 20);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 11px ${C.font}`;
    ctx.fillStyle = C.detailTitle;
    ctx.fillText(`Section ${index + 1}`, x + 14, y + 18);

    const keyX = x + 14;
    const valX = x + 58;
    const row0 = y + 36;
    const rowH = 14;
    for (let i = 0; i < rows.length; i++) {
      const [k, v] = rows[i];
      const yy = row0 + i * rowH;
      ctx.font = `10px ${C.font}`;
      ctx.fillStyle = C.detailKey;
      ctx.fillText(k, keyX, yy);
      ctx.font = `10px ${C.mono}`;
      ctx.fillStyle = C.detailVal;
      ctx.fillText(v, valX, yy, w - (valX - x) - 12);
    }
    ctx.restore();
  }
}

function formatClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function formatDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function fmt(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Number(v).toFixed(digits);
}
