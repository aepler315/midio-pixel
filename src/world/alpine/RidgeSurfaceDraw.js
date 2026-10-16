import { hexLerp, hexToRgb } from '../../utils/color.js';

/** Project an inferred strip-space point through the same live crest as the fill. */
export function projectSurfacePoint({ sx, depth01 }, { geom, stripWidth, terrain }) {
  if (!geom?.pts?.length || !Number.isFinite(sx) || !Number.isFinite(depth01)) return null;
  if (terrain && (sx < 0 || sx > stripWidth)) return null;
  const pts = geom.pts;
  if (sx < pts[0].stripX || sx > pts[pts.length - 1].stripX) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (pts[m].stripX < sx) lo = m; else hi = m;
  }
  const a = pts[lo], b = pts[hi], t = (sx - a.stripX) / Math.max(1e-9, b.stripX - a.stripX);
  const x = a.x + (b.x - a.x) * t;
  const crest = a.y + (b.y - a.y) * t;
  const dy = (a.dy || 0) + ((b.dy || 0) - (a.dy || 0)) * t;
  return { x, y: crest + depth01 * (geom.bottomY + dy - crest) };
}

export function surfaceCopies(width, minSx, maxSx, terrain) {
  if (terrain) return [0];
  const first = Math.floor(minSx / width), last = Math.floor(maxSx / width);
  const offsets = [];
  for (let i = first; i <= last; i++) offsets.push(i * width);
  return offsets;
}

function clipEdge(vertices, boundary, keep) {
  const out = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    const insideA = keep(a.sx), insideB = keep(b.sx);
    if (insideA) out.push(a);
    if (insideA !== insideB && a.sx !== b.sx) {
      const t = (boundary - a.sx) / (b.sx - a.sx);
      out.push({ sx: boundary, depth01: a.depth01 + (b.depth01 - a.depth01) * t });
    }
  }
  return out;
}

function projectedPath(ctx, vertices, offset, projection) {
  const pts = projection.geom.pts;
  const minSx = pts[0].stripX, maxSx = pts.at(-1).stripX;
  let clipped = clipEdge(vertices.map(v => ({ sx: v.sx + offset, depth01: v.depth01 })), minSx, x => x >= minSx);
  clipped = clipEdge(clipped, maxSx, x => x <= maxSx);
  if (clipped.length < 3) return false;
  const segments = [];
  for (let i = 0; i < clipped.length; i++) {
    const a = clipped[i], b = clipped[(i + 1) % clipped.length];
    const n = Math.max(1, Math.ceil(Math.abs(b.sx - a.sx) / 16));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      const p = projectSurfacePoint({ sx: a.sx + (b.sx - a.sx) * t,
        depth01: a.depth01 + (b.depth01 - a.depth01) * t }, projection);
      if (p) segments.push(p);
    }
  }
  if (segments.length < 3) return false;
  ctx.beginPath();
  ctx.moveTo(segments[0].x, segments[0].y);
  for (let i = 1; i < segments.length; i++) ctx.lineTo(segments[i].x, segments[i].y);
  ctx.closePath();
  return true;
}

function normalize3(v) {
  if (!v) return null;
  const len = Math.hypot(v.x || 0, v.y || 0, v.z || 0);
  if (!(len > 1e-8)) return null;
  return { x: (v.x || 0) / len, y: (v.y || 0) / len, z: (v.z || 0) / len };
}

function clampUnit(n) {
  return Math.max(-1, Math.min(1, Number.isFinite(n) ? n : 0));
}

/** Matte identity stays when the key light is centered, missing, or dark. */
export function resolveFacetTone({ facet, palette, lightDirection }) {
  const contrast = Number.isFinite(palette?.intrinsicContrast) ? palette.intrinsicContrast : 1;
  const tone = clampUnit((facet?.intrinsicTone || 0) * contrast);
  const mag = Math.abs(tone);
  const baseColor = tone >= 0
    ? hexLerp(palette.base, palette.faceLight, mag)
    : hexLerp(palette.base, palette.faceShade, mag);
  let directionalAlpha = 0;
  let directionalColor = baseColor;
  const intensity = lightDirection && Number.isFinite(lightDirection.intensity)
    ? Math.max(0, lightDirection.intensity) : 0;
  if (lightDirection && intensity > 0) {
    const normal = normalize3(facet?.normal || { x: facet?.normalX || 0, y: -0.2, z: 0.8 });
    const light = normalize3(lightDirection);
    if (normal && light) {
      const dot = Math.max(-1, Math.min(1, normal.x * light.x + normal.y * light.y + normal.z * light.z));
      const sun = dot * 0.5 + 0.5;
      directionalAlpha = Math.min(0.08, 0.08 * intensity) * (0.35 + 0.65 * Math.abs(dot));
      directionalColor = hexLerp(palette.faceShade, palette.faceLight, sun);
      return {
        baseColor,
        directionalColor,
        directionalAlpha,
      };
    }
  }
  return { baseColor, directionalColor, directionalAlpha };
}

function itemCenter(item) {
  if (Number.isFinite(item?.sx)) return item.sx;
  if (Number.isFinite(item?.sx0) && Number.isFinite(item?.sx1)) return (item.sx0 + item.sx1) * 0.5;
  const verts = item?.vertices || item?.points || [];
  if (!verts.length) return 0;
  let sum = 0;
  for (const v of verts) sum += v.sx;
  return sum / verts.length;
}

function itemOverlaps(item, window) {
  if (!window) return true;
  if (Number.isFinite(item?.sx)) return item.sx >= window.min && item.sx <= window.max;
  if (Number.isFinite(item?.sx0)) return item.sx1 >= window.min && item.sx0 <= window.max;
  const verts = item?.vertices || item?.points || [];
  if (!verts.length) return false;
  let lo = Infinity, hi = -Infinity;
  for (const v of verts) { if (v.sx < lo) lo = v.sx; if (v.sx > hi) hi = v.sx; }
  return hi >= window.min && lo <= window.max;
}

function pickSpatial(items, window, slots) {
  if (!(slots > 0) || !items?.length) return [];
  const visible = items.filter((item) => itemOverlaps(item, window));
  if (!visible.length) return [];
  const span = Math.max(1e-9, (window?.max ?? 1) - (window?.min ?? 0));
  const bins = new Array(slots).fill(null);
  const binOf = (item) => {
    let b = Math.floor(((itemCenter(item) - (window?.min ?? 0)) / span) * slots);
    if (b < 0) b = 0;
    if (b >= slots) b = slots - 1;
    return b;
  };
  const place = (list) => {
    const ranked = [...list].sort((a, b) => (b.importance || 0) - (a.importance || 0)
      || String(a.id).localeCompare(String(b.id)));
    for (const item of ranked) {
      const b = binOf(item);
      if (!bins[b]) bins[b] = item;
    }
  };
  place(visible.filter((item) => item.structural));
  place(visible.filter((item) => !item.structural));
  return bins.filter(Boolean);
}

function optionalAlpha(transition) {
  if (!transition) return 1;
  if (transition.immediate) return 0;
  const age = Number.isFinite(transition.ageMs) ? transition.ageMs : 0;
  if (age >= 120) return 1;
  return 1 - age / 120;
}

/**
 * Reserve paired A/B slots inside the draw cap. Seam weight does not change
 * which source intervals are selected.
 */
export function selectVisibleSurface({ sides, sourceWindows, budget, qualityTransition }) {
  const cap = Math.max(0, budget?.facetsPerLayer ?? 0);
  const gullyCap = Math.max(0, budget?.gulliesPerLayer ?? 0);
  const standCap = Math.max(0, budget?.standsPerLayer ?? 0);
  const active = (sides || []).filter((side) => side?.surface);
  const paired = active.length >= 2;
  const facetSlots = paired ? Math.floor(cap / 2) : cap;
  const gullySlots = paired ? Math.floor(gullyCap / 2) : gullyCap;
  const standSlots = paired ? Math.floor(standCap / 2) : standCap;
  const detail = optionalAlpha(qualityTransition);
  const take = (key, slots, structuralAlpha) => {
    const out = [];
    for (const side of active) {
      const window = sourceWindows?.[side.sideId] || { min: -Infinity, max: Infinity };
      for (const item of pickSpatial(side.surface[key] || [], window, slots)) {
        out.push({
          sideId: side.sideId, id: item.id,
          alpha: item.structural ? structuralAlpha : detail,
        });
      }
    }
    return out;
  };
  return {
    facets: take('facets', facetSlots, 1),
    gullies: take('gullies', gullySlots, detail),
    stands: take('stands', standSlots, 1),
  };
}

function ensureId(item, prefix, index) {
  return item.id ? item : { ...item, id: `${prefix}:${index}` };
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(4)})`;
}

function lightDirectionFrom(light, geom) {
  if (!light || !Number.isFinite(light.x)) return null;
  const centerX = (geom.pts[0].x + geom.pts.at(-1).x) * 0.5;
  const halfWidth = Math.max(1, (geom.pts.at(-1).x - geom.pts[0].x) * 0.5);
  const lx = (light.x - centerX) / halfWidth;
  return { x: lx, y: -0.65, z: 0.45, intensity: Math.max(0, light.intensity ?? 1) };
}

function paletteOrFallback(palette) {
  return palette || {
    base: '#5c6255', faceLight: '#788071', faceShade: '#343d3a', gully: '#26332f', intrinsicContrast: 1,
  };
}

function drawTaperedGully(ctx, gully, offset, projection, color) {
  const pts = gully.points.map((p) => projectSurfacePoint({ sx: p.sx + offset, depth01: p.depth01 }, projection));
  if (pts.some((p) => !p)) return;
  const widths = gully.widthsSource || [gully.widthPx || 1.4];
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  for (let i = pts.length - 1; i >= 0; i--) {
    const w = widths[Math.min(i, widths.length - 1)] || 1;
    ctx.lineTo(pts[i].x + w, pts[i].y + w * 0.6);
  }
  ctx.closePath();
  ctx.fillStyle = rgba(color, 0.45);
  ctx.fill();
}

function copyItem(item, offset) {
  if (!offset) return item;
  const shifted = { ...item, id: `${item.id}@${offset}` };
  if (Number.isFinite(item.sx)) shifted.sx = item.sx + offset;
  if (Number.isFinite(item.sx0)) shifted.sx0 = item.sx0 + offset;
  if (Number.isFinite(item.sx1)) shifted.sx1 = item.sx1 + offset;
  if (item.vertices) shifted.vertices = item.vertices.map((p) => ({ ...p, sx: p.sx + offset }));
  if (item.points) shifted.points = item.points.map((p) => ({ ...p, sx: p.sx + offset }));
  return shifted;
}

export function drawRidgeSurface(ctx, {
  surface, geom, terrain = false, policy, budget, light, alpha = 1, palette = null,
  coverColor = null,
  sideId = 'A', sharedHandoff = false, qualityTransition = null,
  drawFaces = true, drawCover = true,
}) {
  if (!surface || !geom?.pts?.length) return;
  const projection = { geom, stripWidth: surface.width, terrain };
  const offsets = surfaceCopies(surface.width, geom.pts[0].stripX, geom.pts.at(-1).stripX, terrain);
  const sourceWindow = { min: geom.pts[0].stripX, max: geom.pts.at(-1).stripX };
  const copies = (items, prefix) => offsets.flatMap((offset) =>
    (items || []).map((item, i) => copyItem(ensureId(item, prefix, i), offset)));
  const facets = copies(surface.facets, 'face');
  const gullies = copies(surface.gullies, 'gully');
  const stands = copies(surface.stands, 'stand');
  const owned = { ...surface, facets, gullies, stands };
  const sideBudget = sharedHandoff ? {
    facetsPerLayer: Math.floor((budget?.facetsPerLayer ?? 0) / 2),
    gulliesPerLayer: Math.floor((budget?.gulliesPerLayer ?? 0) / 2),
    standsPerLayer: Math.floor((budget?.standsPerLayer ?? 0) / 2),
  } : budget;
  const selected = selectVisibleSurface({
    sides: [{ sideId, surface: owned, seamWeight: 1 }],
    sourceWindows: { [sideId]: sourceWindow },
    budget: sideBudget,
    qualityTransition,
  });
  const facetAlpha = new Map(selected.facets.filter((item) => item.sideId === sideId).map((item) => [item.id, item.alpha]));
  const gullyAlpha = new Map(selected.gullies.filter((item) => item.sideId === sideId).map((item) => [item.id, item.alpha]));
  const standAlpha = new Map(selected.stands.filter((item) => item.sideId === sideId).map((item) => [item.id, item.alpha]));
  const tones = paletteOrFallback(palette);
  const lightDirection = lightDirectionFrom(light, geom);
  const inherited = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
  ctx.save();
  if (!drawFaces) facetAlpha.clear();
  if (!drawCover) { gullyAlpha.clear(); standAlpha.clear(); }
  for (const facet of facets) {
    const weight = facetAlpha.get(facet.id);
    if (weight == null) continue;
    if (!projectedPath(ctx, facet.vertices, 0, projection)) continue;
    const tone = resolveFacetTone({ facet, palette: tones, lightDirection });
    ctx.globalAlpha = inherited * alpha * weight;
    ctx.fillStyle = tone.baseColor;
    ctx.fill();
    if (tone.directionalAlpha > 0.004) {
      ctx.globalAlpha = inherited * alpha * weight * tone.directionalAlpha;
      ctx.fillStyle = tone.directionalColor;
      ctx.fill();
    }
  }
  for (const gully of gullies) {
    const weight = gullyAlpha.get(gully.id);
    if (weight == null) continue;
    ctx.globalAlpha = inherited * alpha * weight;
    if (gully.widthsSource) drawTaperedGully(ctx, gully, 0, projection, tones.gully || '#1c2824');
    else if (gully.points) {
      const points = gully.points.map((p) => projectSurfacePoint({ sx: p.sx, depth01: p.depth01 }, projection));
      if (points.some((p) => !p)) continue;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.lineWidth = gully.widthPx || 1.4;
      ctx.strokeStyle = rgba(tones.gully || '#14201c', 0.5);
      ctx.stroke();
    }
  }
  if ((policy?.canopy ?? 1) > 0.2) for (const stand of stands) {
    const weight = standAlpha.get(stand.id);
    if (weight == null) continue;
    ctx.globalAlpha = inherited * alpha * weight * 0.9;
    if (stand.vertices?.length) {
      if (!projectedPath(ctx, stand.vertices, 0, projection)) continue;
      ctx.fillStyle = coverColor || (stand.kind === 'broadleaf' ? '#1d3a2c'
        : stand.kind === 'scrub' ? '#3d4632'
          : stand.kind === 'grass' || stand.kind === 'mat' ? '#4a5338'
            : '#163228');
      ctx.fill();
    } else if (Number.isFinite(stand.sx)) {
      const p = projectSurfacePoint({ sx: stand.sx, depth01: stand.depth01 }, projection);
      if (!p) continue;
      ctx.fillStyle = `rgba(9,27,23,${(0.22).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, stand.widthPx * 0.5, stand.heightPx * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
