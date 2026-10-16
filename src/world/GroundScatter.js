// Ground scatter: the frontmost plane's small detail -- the layer of loose
// surface material (pebbles, shards, tufts, splinters) rushing past right
// under the camera.
//
// Why this layer exists: measured against a live frame, the ground band
// carried roughly a third the local contrast of the sky and mountain bands
// (~1.7 vs ~5.0 and ~4.3). That is depth cueing running backwards -- the
// NEAREST plane had the LEAST texture, so the surface Midio actually runs
// along read as a flat slab while everything behind it was dense with
// detail. drawForeground held only three soft veil ellipses and NearField's
// big landmark occluders (roughly one per 2000px of scrolled space), so
// there was no small-scale frontmost detail at all, and nothing anywhere in
// the frame that conveyed ground speed.
//
// Two things follow from "closer than everything else":
//
//   • It scrolls FASTEST (SCATTER_RATIO, above NearField's 1.42 and the
//     characters' 1.00). That difference is the entire speed cue.
//   • It sits LOWER in frame than the terrain surface. Ground nearer the
//     camera projects further down, so these ride their own baseline below
//     groundY rather than being glued to the terrain contour -- which is
//     also what keeps them off the play line entirely: they are scenery
//     under Midio's feet, never obstacles in front of him.
//
// Geometry here is pure and seeded (tests exercise it directly); GroundScatter
// only turns it into strokes.
import { mulberry32, hashSeed, clamp01 } from '../utils/math.js';

/** Faster than NearField (1.42) and the characters (1.00): this is the
 *  closest thing to the camera in the scene, so it must outrun everything. */
export const SCATTER_RATIO = 1.72;
/** World-space spacing between scatter slots. Dense on purpose -- this is
 *  loose surface material, not landmarks; sparse pebbles read as debris
 *  someone placed rather than as ground texture. At a wider spacing the
 *  band only fits ~18 props across a 1280 stage, which leaves visible gaps
 *  and reads as scattered objects. This fits ~80 across the stage, which is
 *  the point where the eye stops counting individual pieces and starts
 *  reading the band as a textured surface. */
export const SCATTER_SPACING_PX = 17;
/** How far into its own slot a prop may wander, so the spacing never reads
 *  as a repeating comb. */
export const SCATTER_JITTER = 0.62;
/** Fraction of slots that actually carry a prop. */
export const SCATTER_FILL = 0.82;

export const SCATTER_KINDS = ['pebble', 'shard', 'tuft', 'splinter'];

export function scatterBiomeLayers(from, to, progress) {
  if (!to || from === to) return [{ biomeKey: from, alpha: 1 }];
  const t = clamp01(progress);
  return [{ biomeKey: from, alpha: 1 - t }, { biomeKey: to, alpha: t }];
}

/**
 * The deterministic spec for one scatter slot. Pure: slot `i` under a given
 * song seed is always the same prop, so a replay lays the same ground down.
 *
 * `depth01` is this prop's own sub-depth within the band (0 = further back
 * and higher in frame, 1 = closest and lowest). It drives size, darkness and
 * a slight extra parallax, so the band has internal thickness instead of
 * being one flat row of stamps.
 *
 * @returns {?{kind:string, sizePx:number, xOff:number, depth01:number,
 *   lean:number, flip:boolean}} null for an empty slot
 */
export function scatterSlot(songSeed, i, stratified = false) {
  const rand = mulberry32(hashSeed(`${songSeed}:scatter:${i}`));
  if (rand() > SCATTER_FILL) return null;
  // Fixed stratified depth lanes keep each slot's parallax speed known before
  // searching for visible indices. A single expanding min/max window would
  // examine thousands of invisible slots late in a long recording.
  const depth01 = stratified ? ((i % 16 + 16) % 16 + 0.5) / 16 : clamp01(rand());
  return {
    kind: SCATTER_KINDS[Math.floor(rand() * SCATTER_KINDS.length) % SCATTER_KINDS.length],
    // Nearer props are bigger. The range stays small: this is grit, and
    // anything large enough to read as an object belongs to NearField.
    // Kept under the slot spacing so a dense band still reads as separate
    // pieces of material rather than merging into one dark smear.
    sizePx: 3 + 13 * depth01 + rand() * 3,
    xOff: (rand() - 0.5) * SCATTER_SPACING_PX * SCATTER_JITTER,
    depth01,
    lean: (rand() - 0.5) * 0.6,
    flip: rand() < 0.5,
  };
}

/**
 * Every scatter prop currently on screen, in screen space, near-to-far last
 * so a caller painting in order gets correct overlap.
 *
 * @param {object} o
 * @param {number} o.worldX        the world scroll position
 * @param {number} o.canvasW       stage width
 * @param {number} o.baselineY     where the scatter band's own floor sits
 * @param {number} o.bandH         how tall the band is (props spread across it)
 * @param {string|number} o.songSeed
 * @param {number} [o.ratio]       scroll ratio (defaults to SCATTER_RATIO)
 * @param {number} [o.kick]        0..1 beat envelope; lifts props slightly
 */
export function visibleScatter({
  worldX, canvasW, baselineY, bandH, songSeed, ratio = SCATTER_RATIO, kick = 0, biomeKey = null,
}) {
  if (!(canvasW > 0) || !(bandH > 0)) return [];
  // A margin either side so props enter and leave off-screen rather than
  // popping in at the edges.
  const margin = 60;
  const out = [];
  const lanes = biomeKey ? 16 : 1;
  for (let lane = 0; lane < lanes; lane++) {
    const depth = (lane + .5) / 16;
    const scroll = biomeKey ? worldX * ratio * (.94 + .12 * depth) : worldX * ratio;
    const lo = (scroll - margin) / SCATTER_SPACING_PX;
    const hi = (scroll + canvasW + margin) / SCATTER_SPACING_PX;
    const first = biomeKey ? lane + 16 * Math.ceil((lo - lane) / 16) : Math.floor(lo);
    for (let i = first; i <= hi; i += lanes) {
      const spec = scatterSlot(songSeed, i, !!biomeKey);
      if (!spec) continue;
      // Nearer props (depth01 -> 1) also scroll a touch faster still: internal
      // parallax inside the band itself.
      const ownScroll = worldX * ratio * (0.94 + 0.12 * spec.depth01);
      const x = i * SCATTER_SPACING_PX + spec.xOff - ownScroll;
      if (x < -margin || x > canvasW + margin) continue;
      // Nearer = lower in frame. The kick lift is tiny and scales with depth
      // so the front row answers the beat hardest, matching how every other
      // layer in the scene reacts.
      const y = baselineY - bandH * (1 - spec.depth01) - kick * (1.5 + 2.5 * spec.depth01);
      const vocab = biomeKey === 'RAINFOREST' || biomeKey === 'TAIGA'
        ? ['tuft', 'pebble', 'tuft', 'shard']
        : biomeKey === 'ICEFIELD' || biomeKey === 'DESERT' || biomeKey === 'CANYON'
          ? ['pebble', 'shard', 'shard', 'pebble'] : SCATTER_KINDS;
      out.push({ ...spec, kind: vocab[SCATTER_KINDS.indexOf(spec.kind)], x, y });
    }
  }
  // Far (small depth01) first so near props paint over them.
  out.sort((a, b) => a.depth01 - b.depth01);
  return out;
}

/** Silhouette path for one prop, centered on the origin, in its own local
 *  space. Split out so the shape vocabulary is testable without a canvas. */
export function scatterPath(kind, s) {
  switch (kind) {
    case 'shard':
      return [
        { x: -s * 0.30, y: 0 }, { x: -s * 0.10, y: -s * 0.95 },
        { x: s * 0.16, y: -s * 0.55 }, { x: s * 0.34, y: 0 },
      ];
    case 'tuft':
      // A few blades fanning from a common root.
      return [
        { x: -s * 0.40, y: 0 }, { x: -s * 0.22, y: -s * 0.72 },
        { x: -s * 0.06, y: -s * 0.30 }, { x: s * 0.04, y: -s * 1.00 },
        { x: s * 0.14, y: -s * 0.34 }, { x: s * 0.30, y: -s * 0.62 },
        { x: s * 0.42, y: 0 },
      ];
    case 'splinter':
      return [
        { x: -s * 0.55, y: 0 }, { x: -s * 0.12, y: -s * 0.34 },
        { x: s * 0.50, y: -s * 0.12 }, { x: s * 0.30, y: 0 },
      ];
    case 'pebble':
    default:
      return [
        { x: -s * 0.46, y: 0 }, { x: -s * 0.34, y: -s * 0.34 },
        { x: 0, y: -s * 0.46 }, { x: s * 0.36, y: -s * 0.32 },
        { x: s * 0.48, y: 0 },
      ];
  }
}

export class GroundScatter {
  constructor(songSeed) {
    this.songSeed = songSeed;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {{width:number, height:number}} canvas stage dims
   * @param {number} worldX
   * @param {object} env {groundY, color, kick, ratio, alpha}
   */
  draw(ctx, canvas, worldX, env = {}) {
    const groundY = env.groundY ?? canvas.height * 0.75;
    // The band hangs BELOW the terrain surface (closer ground projects
    // lower in frame) and fills the visible ground strip. Anchoring its TOP
    // exactly at groundY matters twice over: nothing floats above the
    // terrain line where it would read as debris in mid-air, and the band
    // reaches down through the part of the ground that is otherwise
    // emptiest. Capped so it stops around where the HUD strip begins rather
    // than spending props underneath it.
    const room = Math.max(24, canvas.height - groundY);
    const bandH = Math.min(150, room * 0.48);
    const baselineY = groundY + bandH;
    const props = visibleScatter({
      worldX,
      canvasW: canvas.width,
      baselineY,
      bandH,
      songSeed: this.songSeed,
      ratio: env.ratio ?? SCATTER_RATIO,
      kick: env.kick ?? 0,
      biomeKey: env.biomeKey,
    });
    if (!props.length) return;

    const alpha = env.alpha ?? 1;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const p of props) {
      // Closer props are darker and more opaque -- the same "closer = darker"
      // convention NearField's occluders already establish, so the two
      // foreground layers read as one continuous near field.
      ctx.globalAlpha = alpha * (0.5 + 0.45 * p.depth01);
      ctx.fillStyle = env.color || 'rgba(7,10,20,0.92)';
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.lean * 0.25);
      if (p.flip) ctx.scale(-1, 1);
      const pts = scatterPath(p.kind, p.sizePx);
      ctx.beginPath();
      pts.forEach((pt, k) => { if (k === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
}
