import { projectSurfacePoint, surfaceCopies } from './RidgeSurfaceDraw.js';
import { hexToRgb } from '../../utils/color.js';

function valleySpan(valley) {
  if (Number.isFinite(valley?.sx0) && Number.isFinite(valley?.sx1)) {
    return { sx0: Math.min(valley.sx0, valley.sx1), sx1: Math.max(valley.sx0, valley.sx1), sx: (valley.sx0 + valley.sx1) * 0.5 };
  }
  if (Number.isFinite(valley?.sx)) return { sx0: valley.sx, sx1: valley.sx, sx: valley.sx };
  return null;
}

function gapOpen(far, near, x) {
  if (!near?.pts?.length) return true;
  let lo = 0;
  let hi = near.pts.length - 1;
  if (x <= near.pts[0].x || x >= near.pts[hi].x) return true;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (near.pts[mid].x < x) lo = mid;
    else hi = mid;
  }
  const a = near.pts[lo];
  const b = near.pts[hi];
  const t = (x - a.x) / Math.max(1e-9, b.x - a.x);
  const nearY = a.y + (b.y - a.y) * t;
  return far.y + 6 < nearY;
}

/** Fog sits in a saddle interval. A fully covered gap produces no bank. */
export function valleyFogPatches({
  surface, geom, terrain, moisture, nowMs = 0, phraseLift = 0, maxBanks = 4, nearGeom = null, seam = null,
}) {
  if (!surface || !geom?.pts?.length || moisture < .35 || maxBanks < 1) return [];
  const patches = [];
  const offsets = surfaceCopies(surface.width, geom.pts[0].stripX, geom.pts.at(-1).stripX, terrain);
  for (const offset of offsets) for (const valley of surface.valleys || []) {
    const span = valleySpan(valley);
    if (!span) continue;
    const p = projectSurfacePoint({ sx: span.sx + offset, depth01: valley.depth01 ?? 0.4 },
      { geom, stripWidth: surface.width, terrain });
    if (!p) continue;
    if (seam && (p.x < seam.min || p.x > seam.max)) continue;
    if (!gapOpen(p, nearGeom, p.x)) continue;
    const drift = Math.sin(nowMs / 13000 + span.sx) * 5;
    const widthPx = Math.max(24, span.sx1 - span.sx0);
    patches.push({
      id: `${valley.id}:${offset}`,
      x: p.x + drift,
      y: p.y,
      rx: Math.min(160, widthPx * 0.35),
      ry: 14,
      alpha: Math.min(.12, moisture * .11) * (1 - Math.min(.25, Math.max(0, phraseLift) * .25)),
    });
    if (patches.length >= maxBanks) return patches;
  }
  return patches;
}

export function drawValleyFog(ctx, patches, color, alpha = 1) {
  ctx.save();
  const { r, g, b } = hexToRgb(color);
  const inherited = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
  for (const patch of patches) {
    ctx.save();
    ctx.translate(patch.x, patch.y);
    ctx.scale(1, patch.ry / Math.max(1, patch.rx));
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, patch.rx);
    const a = Math.min(.12, patch.alpha * alpha * inherited);
    gradient.addColorStop(0, `rgba(${r},${g},${b},${a})`);
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, patch.rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
