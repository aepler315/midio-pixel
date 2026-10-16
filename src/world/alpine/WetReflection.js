// Range v2 wet reflections (plan §6.3, Task 12): the ACTUAL performer layers
// captured this frame (PerformerCapture), mirrored into the rock stage's
// pools. Receiver-local: each pool shows only the part of each body's mirror
// image that falls inside its exact polygon, intersected with the slab top
// holding it (rock occlusion). Nothing is reflected anywhere else.
//
// Geometry. Water is level and lies dropPx below the support line C (the
// riser steps between the contact and the slab holding the pool), so a body
// mirrors about the water plane W = C + dropPx: a point h px above W appears
// about h px below it. A planar mirror seen from afar keeps the image's
// height (only the pool itself is foreshortened); SQUASH < 1 is the small
// shortening of the virtual image lying slightly farther than the body. An airborne body is higher above W, so its image drops the same
// amount further below -- height reads correctly without a special case. Distortion
// is a bounded horizontal wobble in strips, pure in heard time (a paused or
// re-seeked frame draws the same image). Pulses/ripples stay GroundResponse's.

export const SQUASH = 0.92;
export const MAX_WOBBLE_PX = 1.6;
const STRIPS = 20;

/** Horizontal extent of a polygon. */
function spanX(poly) {
  let lo = Infinity, hi = -Infinity;
  for (const q of poly) { lo = Math.min(lo, q.x); hi = Math.max(hi, q.x); }
  return [lo, hi];
}

function tracePolygon(ctx, poly) {
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
}

/** Opacity of a reflection before per-strip falloff: restrained, damped by
 *  water roughness and by how far the body is off the ground. */
export function reflectionAlpha(layer, pool, { roughness = 0.25 } = {}) {
  const lift = Math.min(1, Math.max(0, (layer.airbornePx || 0) / 180));
  return 0.62 * (pool.alpha ?? 1) * (1 - 0.55 * roughness) * (1 - 0.6 * lift);
}

/** The strip offsets (device px) of the wobble at heard time `tSec`. */
export function wobbleOffsets(tSec, seed, amp, n = STRIPS) {
  const out = new Float32Array(n);
  if (!(amp > 0)) return out;
  for (let j = 0; j < n; j++) out[j] = amp * Math.sin(j * 1.7 + tSec * 2.3 + seed) * (0.4 + 0.6 * j / Math.max(1, n - 1));
  return out;
}

/**
 * Plan §7 interface.
 *   ctx        stage context under the fixed-ground transform (the one the
 *              layers were captured under)
 *   frame      RangeFrame (frameId, timeMs)
 *   layers     PerformerCapture layers; only those of this frame are used
 *   receivers  { pools: [{ id, polygon, surfacePolygon, alpha }] }
 *   occlusion  optional extra polygon every reflection is clipped to
 * Each layer used here is released once (its reflection consumer), whether
 * or not any pool shows it.
 */
export function drawWetReflections(ctx, { frame, layers, receivers, occlusion = null, quality = 0, capture = null }) {
  const live = (layers || []).filter((l) => l && l.visible && l.frameId === frame?.frameId);
  const pools = (receivers?.pools || []).filter((p) => p.polygon?.length > 2 && (p.alpha ?? 1) > 0.001);
  let drawn = 0;
  if (live.length && pools.length && quality < 6) {
    const tSec = (frame.timeMs || 0) / 1000;
    const wobble = quality >= 4 ? 0 : MAX_WOBBLE_PX;
    for (const pool of pools) {
      const [pl, pr] = spanX(pool.polygon);
      for (const layer of live) {
        const b = layer.bounds;
        if (b.x + b.w < pl || b.x > pr || !Number.isFinite(layer.contactY)) continue;
        const { a, d, f } = layer.transform;
        const cDev = d * (layer.contactY + (pool.dropPx || 0)) + f;
        // Where the mirror image lands must reach the pool at all.
        const imgTop = cDev, imgBottom = cDev + (cDev - layer.device.y) * SQUASH;
        const poolTopDev = d * Math.min(...pool.polygon.map((q) => q.y)) + f;
        const poolBottomDev = d * Math.max(...pool.polygon.map((q) => q.y)) + f;
        if (imgBottom < poolTopDev || imgTop > poolBottomDev) continue;
        ctx.save();
        // Clip in stage (logical) space: the exact pool, then the slab top
        // holding it, then any extra occluder -- successive clips intersect.
        ctx.beginPath(); tracePolygon(ctx, pool.polygon); ctx.clip();
        if (pool.surfacePolygon?.length > 2) { ctx.beginPath(); tracePolygon(ctx, pool.surfacePolygon); ctx.clip(); }
        if (occlusion?.length > 2) { ctx.beginPath(); tracePolygon(ctx, occlusion); ctx.clip(); }
        // Mirror in device space about the water plane: y' = W (1 + SQUASH) - SQUASH y.
        ctx.setTransform(1, 0, 0, -SQUASH, 0, cDev * (1 + SQUASH));
        const base = reflectionAlpha(layer, pool);
        const { x, y, w, h } = layer.device;
        const n = Math.min(STRIPS, Math.max(1, Math.ceil(h / 4)));
        const offs = wobbleOffsets(tSec, (layer.id?.length || 0) * 1.3 + pl * 0.01, wobble * a, n);
        const sh = h / n;
        for (const { canvas: src, op } of layer.segments) {
          const k = op === 'lighter' ? 0.7 : 1;
          ctx.globalCompositeOperation = op;
          for (let j = 0; j < n; j++) {
            const sy = j * sh;
            // Farther from the mirror line (the body's top) fades first.
            const fall = 1 - 0.65 * ((h - sy) / h);
            ctx.globalAlpha = Math.max(0, base * k * fall);
            ctx.drawImage(src, 0, sy, w, sh, x + offs[j], y + sy, w, sh);
          }
        }
        ctx.restore();
        drawn++;
      }
    }
  }
  if (capture) for (const l of layers || []) capture.release(l);
  return drawn;
}
