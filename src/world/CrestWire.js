// The live wire along the top of every ridge.
//
// Each range's crest carries a thin glowing line that rides its skyline as a
// travelling wave: a smooth sine when the music is quiet, sharpening into a
// zigzag as it gets loud, and buzzing -- a fast shiver of its amplitude --
// on every kick. Its colour is picked against what it sits between: the
// range's own body below and whatever is behind it above (the sky, or the
// next range back), so the wire always reads, whichever palette the biome
// has.
//
// Pure maths plus one draw helper; BiomeManager supplies the crest polyline
// (the same live, danced curve the old rim stroke used), the colours and
// the music.
import { clamp01 } from '../utils/math.js';
import { hexToRgb, rgbToHex, rgbToHsl, hslToRgb } from '../utils/color.js';

// Per range: wavelength and resting amplitude in px, and how fast the wave
// travels (rad/s). Farther ranges get a finer, calmer wire -- the same
// far-is-calmer rule the dance follows (MountainChoreo.DANCE_LAYERS).
export const WIRE_LAYERS = {
  L2: { wavelength: 13, amp: 1.6, speed: 5.0 },
  L3: { wavelength: 17, amp: 2.2, speed: 5.8 },
  L4: { wavelength: 22, amp: 2.9, speed: 6.6 },
  L5: { wavelength: 28, amp: 3.6, speed: 7.4 },
  massif: { wavelength: 34, amp: 4.0, speed: 2.4 },
};
// How far loudness and a kick can push the amplitude past its resting size.
const LOUD_GAIN = 1.3;
const KICK_GAIN = 1.4;
// The buzz: a fast flutter of the amplitude, strongest right on the kick.
export const BUZZ_HZ = 13;
const BUZZ_DEPTH = 0.45;
// Resampling step along the crest: fine enough for the shortest wavelength.
export const WIRE_STEP_PX = 3;
// The glow is the wide additive halo. Intensity is the pass alpha, footprint
// is the stroke width. Both are a fraction of the original halo.
export const GLOW_INTENSITY = 0.45;
export const GLOW_FOOTPRINT = 0.70;
const GLOW_PASSES = [
  [14 * GLOW_FOOTPRINT, 0.07 * GLOW_INTENSITY],
  [6 * GLOW_FOOTPRINT, 0.18 * GLOW_INTENSITY],
];
// One brightness packet crosses a crest every this many beats.
export const CREST_WAVE_BEATS = 2;
// Front ridges lead; the ranges behind them follow, so the packets do not
// all sit on the same column.
export const CREST_WAVE_PHASE = { L5: 0, L4: 0.18, L3: 0.36, L2: 0.54, massif: 0.72 };

/** Absolute musical position from analyzed downbeats. Unlike dividing song
 * time by a live kick-interval estimate, this stays continuous at tempo
 * changes and gives the same result after a seek or during an export. */
export class CrestBeatClock {
  constructor(barGrid = []) {
    this.segments = [];
    // MIDI's preceding meter includes its endpoint; the next meter then
    // emits that downbeat again. Keep the later meter, not an extra bar.
    const bars = barGrid.filter((bar, i) => bar.ms !== barGrid[i + 1]?.ms);
    let beat = 0, beatSec = 0.5;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const beats = bar.numerator > 0 ? bar.numerator : 4;
      const duration = (bars[i + 1]?.ms - bar.ms) / 1000;
      if (duration > 0) beatSec = duration / beats;
      this.segments.push({ sec: bar.ms / 1000, beat, beatSec });
      beat += beats;
    }
  }

  at(tSec) {
    if (!this.segments.length) return tSec / 0.5;
    let lo = 0, hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].sec <= tSec) lo = mid;
      else hi = mid - 1;
    }
    const s = this.segments[lo];
    return s.beat + (tSec - s.sec) / s.beatSec;
  }
}

/** Triangle wave in [-1, 1] with the same phase as Math.sin. */
function tri(phase) {
  return (2 / Math.PI) * Math.asin(Math.sin(phase));
}

/**
 * The wire's vertical offset (px) at screen x and time tSec.
 * `sharp` 0..1 morphs sine -> zigzag; `amp` is the amplitude in px already
 * scaled for loudness and the kick (wireAmplitude).
 */
export function wireOffset(x, tSec, { wavelength, speed }, amp, sharp) {
  const phase = (x / wavelength) * Math.PI * 2 - tSec * speed;
  const s = clamp01(sharp);
  return amp * (Math.sin(phase) * (1 - s) + tri(phase) * s);
}

/**
 * The wire's amplitude (px) this frame: resting size, grown by loudness
 * (0..1) and the kick envelope (0..1), with the buzz riding on top.
 */
export function wireAmplitude(cfg, loud, kick, tSec, intensity = 1) {
  const drive = clamp01(intensity);
  const base = cfg.amp * (1 + LOUD_GAIN * clamp01(loud) * drive + KICK_GAIN * clamp01(kick) * drive);
  const buzz = 1 + BUZZ_DEPTH * drive * clamp01(0.35 + kick) * Math.sin(tSec * BUZZ_HZ * Math.PI * 2);
  return base * buzz;
}

/**
 * A pulse traveling left to right along a crest, 0..1. It crosses once
 * every CREST_WAVE_BEATS beats and breathes once per beat. `phase01` offsets
 * a layer so the packets do not stack.
 */
export function crestWave01(x, x0, x1, tSec, beatSec, phase01 = 0, beatPosition = tSec / beatSec) {
  if (!Number.isFinite(beatPosition) || !(x1 > x0)) return 0;
  let u = (beatPosition / CREST_WAVE_BEATS + phase01) % 1;
  if (u < 0) u += 1;
  const center = x0 + u * (x1 - x0);
  const sigma = Math.max(12, (x1 - x0) * 0.085);
  const d = (x - center) / sigma;
  const bump = Math.exp(-0.5 * d * d);
  const pulse = 0.55 + 0.45 * Math.cos(beatPosition * Math.PI * 2);
  // Fade before wrapping, so a bright packet cannot teleport from the
  // right edge to the left in one frame. Smoothstep also softens its speed
  // of brightening, while leaving most of the crossing at full strength.
  const edge = Math.min(1, u / 0.08, (1 - u) / 0.08);
  return bump * pulse * edge * edge * (3 - 2 * edge);
}

/** Relative luminance (WCAG), 0..1. */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// A hue is only worth complementing when the colour has some: below this
// saturation a silhouette is grey and its hue is noise.
const HUE_MIN_SAT = 0.15;

/**
 * A wire colour that stands out from both `body` (the range under it) and
 * `behind` (what is above it), and can glow: fully saturated, kept in a
 * luminous lightness band, on the complement of the body's hue -- or of
 * what is behind it when the body is grey, or of `accent` (the biome's
 * glow colour) when both are. Within the band it takes the lightness with
 * the best worst-case contrast against the two; ties go brighter.
 */
export function wireColor(body, behind, accent = '#4fd8ff') {
  const hsl = (hex) => { const { r, g, b } = hexToRgb(hex); return rgbToHsl(r, g, b); };
  const b0 = hsl(body), b1 = hsl(behind);
  const hue = b0.s >= HUE_MIN_SAT ? (b0.h + 180) % 360
    : b1.s >= HUE_MIN_SAT ? (b1.h + 180) % 360
      : hsl(accent).h;
  let best = null, bestScore = -Infinity;
  for (let l = 0.8; l >= 0.45 - 1e-9; l -= 0.05) {
    const rgb = hslToRgb(hue, 1, l);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    const score = Math.min(contrastRatio(hex, body), contrastRatio(hex, behind));
    if (score > bestScore + 1e-6) { best = hex; bestScore = score; }
  }
  return best;
}

/** The crest polyline resampled every `step` px of x, linearly. */
export function resampleCrest(pts, step = WIRE_STEP_PX) {
  const out = [];
  if (!pts || pts.length < 2) return out;
  let j = 0;
  for (let x = pts[0].x; x <= pts[pts.length - 1].x; x += step) {
    while (j < pts.length - 2 && pts[j + 1].x < x) j++;
    const a = pts[j], b = pts[j + 1];
    const f = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0;
    out.push({ x, y: a.y + (b.y - a.y) * f });
  }
  return out;
}

/**
 * Stroke the wire along `pts` (a crest polyline, left to right).
 * { cfg, color, amp, sharp, tSec, alpha, glow } -- `glow` false skips the
 * wide additive passes (the cheap rung).
 */
export function drawCrestWire(ctx, pts, {
  cfg, color, amp, sharp, tSec, alpha = 1, glow = true, beatSec = 0, wavePhase = 0,
  beatPosition = tSec / beatSec,
}) {
  const line = resampleCrest(pts);
  if (line.length < 2 || !(alpha > 0.01)) return;
  const x0 = line[0].x;
  const x1 = line[line.length - 1].x;
  let peak = 0;
  for (const p of line) {
    const env = crestWave01(p.x, x0, x1, tSec, beatSec, wavePhase, beatPosition);
    if (env > peak) peak = env;
    p.env = env;
    p.y += wireOffset(p.x, tSec, cfg, amp, sharp) * (1 + 0.9 * env);
  }
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(line[0].x, line[0].y);
    for (let i = 1; i < line.length; i++) ctx.lineTo(line[i].x, line[i].y);
  };
  ctx.save();
  ctx.lineJoin = sharp > 0.5 ? 'miter' : 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  if (glow) {
    // Ambient glow: wide, faint, additive, so it lifts whatever is behind it.
    ctx.globalCompositeOperation = 'lighter';
    for (const [lw, a] of GLOW_PASSES) {
      ctx.globalAlpha = a * alpha;
      ctx.lineWidth = lw;
      path();
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = 0.95 * alpha;
  ctx.lineWidth = 1.6;
  path();
  ctx.stroke();
  // The beat packet: a short brighter span riding the same crest, so the
  // pulse reads as a wave running along the line rather than the whole
  // ridge flashing at once.
  if (Number.isFinite(beatPosition) && peak > 0.2) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 * alpha * peak;
    ctx.lineWidth = 3.2 * GLOW_FOOTPRINT;
    ctx.beginPath();
    let drawing = false;
    for (const p of line) {
      if (p.env < 0.35) { drawing = false; continue; }
      if (!drawing) { ctx.moveTo(p.x, p.y); drawing = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
