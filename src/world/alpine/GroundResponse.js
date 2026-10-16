export function sampleWetResponse({ nowMs = 0, hits = [], x = 0, reducedFlash = false }) {
  let sum = 0;
  for (const hit of hits) {
    const age = (nowMs - hit.tMs) / 1000;
    if (age < 0 || age > 2 || !Number.isFinite(hit.x)) continue;
    const reach = Math.max(0, 1 - Math.abs(hit.x - x) / 120);
    sum += Math.exp(-age / .45) * reach * Math.max(0, hit.strength || 0);
  }
  return Math.min(reducedFlash ? .35 : 1, sum * (reducedFlash ? .35 : 1));
}

/** Query the existing sorted conductor timeline; no seek-dependent event log. */
export function recentConductorHits(timeline = [], nowMs = 0) {
  if (!timeline?.length) return [];
  let lo = 0, hi = timeline.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid].tMs <= nowMs) lo = mid + 1; else hi = mid;
  }
  const hits = [];
  for (let i = lo - 1; i >= 0 && nowMs - timeline[i].tMs <= 2000 && hits.length < 8; i--) {
    const event = timeline[i];
    if (!event.kick || !Number.isFinite(event.tMs)) continue;
    const vel = Math.max(0, event.vel ?? 1);
    hits.push({ id: `${i}`, tMs: event.tMs, strength: Math.min(1, vel > 1 ? vel / 127 : vel) });
  }
  return hits;
}

function polygonBox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of poly) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Small edge responses in fixed-ground coordinates; owns no full-screen canvas. */
export class GroundResponse {
  constructor() { this.disposed = false; }

  draw(ctx, { receivers, lights = [], nowMs = 0, hits = [], reducedFlash = false, reducedMotion = false, quality = 0 } = {}) {
    if (this.disposed || quality >= 6 || !receivers) return;
    if (reducedMotion) hits = [];
    const { wetMasks = [], litEdges = [] } = receivers;
    if ((!wetMasks.length && !litEdges.length) || (!lights.length && !hits.length)) return;
    ctx.save();
    for (const edge of litEdges.slice(0, 24)) {
      const cx = edge.x + edge.widthPx * .5;
      let illumination = 0;
      for (const light of lights.slice(0, 3)) {
        const distance = Math.hypot(light.x - cx, light.y - edge.y);
        illumination += Math.max(0, 1 - distance / 96) * Math.max(0, light.intensity || 0);
      }
      const wet = wetMasks.some(mask => mask.x === edge.x && !mask.polygon);
      // Each receiver evaluates the same conductor event at its own center.
      // Past performer positions are not reconstructed from current poses.
      const localHits = wet ? hits.map(hit => ({ ...hit, x: cx })) : [];
      const pulse = wet ? sampleWetResponse({ nowMs, hits: localHits, x: cx, reducedFlash }) : 0;
      const opacity = Math.min(.12, (illumination * .10 + pulse * .07)
        * (reducedFlash ? .35 : 1) * (edge.alpha ?? 1));
      if (opacity < .005) continue;
      ctx.strokeStyle = `rgba(218,231,220,${opacity.toFixed(3)})`;
      ctx.lineWidth = wet ? 1.4 : 1;
      ctx.beginPath(); ctx.moveTo(edge.x + 2, edge.y + 3);
      ctx.lineTo(edge.x + edge.widthPx - 2, edge.y + 3); ctx.stroke();
    }
    for (const mask of wetMasks.slice(0, 6)) {
      const maskAlpha = mask.alpha ?? 1;
      if (!(maskAlpha > .001)) continue;
      ctx.save(); ctx.beginPath();
      // Exact receivers: a pool polygon when the ground provides one (Range
      // v2 rock stage), the legacy patch rectangle otherwise.
      if (mask.polygon?.length > 2) {
        ctx.moveTo(mask.polygon[0].x, mask.polygon[0].y);
        for (const q of mask.polygon.slice(1)) ctx.lineTo(q.x, q.y);
        ctx.closePath();
      } else ctx.rect(mask.x, mask.y + 2, mask.widthPx, mask.depthPx);
      ctx.clip();
      for (const hit of hits.slice(0, 2)) {
        const age = (nowMs - hit.tMs) / 1000;
        if (age < 0 || age > 2) continue;
        const opacity = Math.min(.07, Math.exp(-age / .45) * .07 * maskAlpha * Math.min(1, Math.max(0, hit.strength ?? 1))
          * (reducedFlash ? .35 : 1));
        if (opacity < .003) continue;
        ctx.strokeStyle = `rgba(212,229,224,${opacity.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const box = mask.polygon?.length > 2 ? polygonBox(mask.polygon) : { x: mask.x, y: mask.y, w: mask.widthPx, h: mask.depthPx };
        ctx.ellipse(box.x + box.w * .5, box.y + box.h * .5,
          4 + age * 22, 2 + age * 4, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  dispose() { this.disposed = true; }
}
