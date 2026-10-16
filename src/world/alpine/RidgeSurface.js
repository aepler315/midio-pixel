import { landscapePolicy } from './LandscapePolicy.js';

function randomFrom(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function emptySurface(width, biomeKey) {
  return { version: 2, width: width || 0, biomeKey, byteLength: 128, facets: [], gullies: [], stands: [], valleys: [] };
}

function smoothCopy(vals, step) {
  const radius = Math.max(1, Math.round(24 / Math.max(step, 1e-6)));
  const out = new Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    let sum = 0, n = 0;
    const a = Math.max(0, i - radius), b = Math.min(vals.length - 1, i + radius);
    for (let j = a; j <= b; j++) { sum += vals[j]; n++; }
    out[i] = sum / n;
  }
  return out;
}

function normalize3(x, y, z) {
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-8)) return { x: 0, y: 0, z: 1 };
  return { x: x / len, y: y / len, z: z / len };
}

/** Walk from a crest minimum out to the saddles where the slope reverses. */
function saddlesAround(smooth, i) {
  let l = i, lo = smooth[i];
  while (l > 0 && smooth[l - 1] >= smooth[l]) { l--; lo = Math.max(lo, smooth[l]); }
  let r = i, ro = smooth[i];
  while (r < smooth.length - 1 && smooth[r + 1] >= smooth[r]) { r++; ro = Math.max(ro, smooth[r]); }
  return { left: l, right: r, prominence: Math.min(lo, ro) - smooth[i] };
}

function selectSummits(smooth, step) {
  const found = [];
  for (let i = 1; i < smooth.length - 1; i++) {
    if (!(smooth[i] < smooth[i - 1] && smooth[i] <= smooth[i + 1])) continue;
    const span = saddlesAround(smooth, i);
    if (!(span.prominence > 0)) continue;
    found.push({ i, ...span });
  }
  found.sort((a, b) => b.prominence - a.prominence || a.i - b.i);
  const minPx = 64;
  const kept = [];
  for (const peak of found) {
    if (kept.length >= 24) break;
    if (kept.some((k) => Math.abs(k.i - peak.i) * step < minPx)) continue;
    kept.push(peak);
  }
  kept.sort((a, b) => a.i - b.i);
  return kept;
}

function face(id, intervalId, vertices, facing, tone, importance, material) {
  return {
    id, intervalId, vertices,
    normal: normalize3(facing * 0.62, -0.22, 0.75),
    material, intrinsicTone: tone, importance, structural: true,
  };
}

function slopeFace(sx0, sx1, id, intervalId, facing, tone, importance, material, width) {
  const lo = Math.max(0, Math.min(width, Math.min(sx0, sx1)));
  const hi = Math.max(0, Math.min(width, Math.max(sx0, sx1)));
  const crest = facing < 0 ? hi : lo;
  const foot = facing < 0 ? lo : hi;
  const flank = foot + (crest - foot) * 0.25;
  const deepFlank = foot + (crest - foot) * 0.66;
  return face(id, intervalId, [
    { sx: crest, depth01: 0 },
    { sx: foot, depth01: 0.04 },
    { sx: flank, depth01: 0.18 },
    { sx: deepFlank, depth01: 0.43 },
    { sx: crest, depth01: 0.24 },
  ], facing, tone, importance, material);
}

function coverKind(policy) {
  if (policy.cover === 'broadleaf') return 'broadleaf';
  if (policy.cover === 'scrub') return 'scrub';
  if (policy.cover === 'grass' || policy.cover === 'mat') return policy.cover === 'mat' ? 'mat' : 'grass';
  if (policy.cover === 'ice' || policy.cover === 'sand' || policy.cover === 'stone') return policy.cover;
  return 'conifer';
}

function coverVertices(sx, widthSrc, kind, rand, stripWidth, valley01, depthScale) {
  const low = kind === 'grass' || kind === 'mat' || kind === 'scrub';
  const top = low ? 0.11 : 0.035;
  const foot = (low ? 0.25 : 0.22) + 0.04 * valley01;
  const segments = kind === 'conifer' ? 11 : kind === 'broadleaf' ? 9 : 7;
  const verts = [];
  const phase = rand() * Math.PI * 2;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const edge = Math.abs(t * 2 - 1);
    const crown = Math.sin(t * Math.PI) * (0.018 + 0.012 * Math.sin(t * Math.PI * 3 + phase));
    const irregularity = (rand() - 0.5) * (low ? 0.012 : 0.024);
    verts.push({
      sx: Math.max(0, Math.min(stripWidth, sx + widthSrc * (t - 0.5))),
      depth01: Math.max(0.005, (top + 0.055 * edge - crown + irregularity) * depthScale),
    });
  }
  verts.push({ sx: Math.min(stripWidth, sx + widthSrc * 0.32), depth01: foot * depthScale });
  verts.push({ sx: Math.min(stripWidth, sx + widthSrc * 0.06), depth01: (foot + 0.025) * depthScale });
  verts.push({ sx: Math.max(0, sx - widthSrc * 0.30), depth01: (foot - 0.015) * depthScale });
  return verts;
}

function accountBytes(surface) {
  const facet = surface.facets.reduce((n, f) => n + 180 + f.vertices.length * 48, 0);
  const gully = surface.gullies.reduce((n, g) => n + 140 + g.points.length * 40 + g.widthsSource.length * 16, 0);
  const stand = surface.stands.reduce((n, s) => n + 160 + s.vertices.length * 40, 0);
  return 256 + facet + gully + stand + surface.valleys.length * 120;
}

/**
 * Version 2 descriptors. The sampled skyline is never written.
 * Faces, cover, gullies and edge variation use separate salts.
 */
export function buildRidgeSurface({ seed, biomeKey, layerKey, width, ridgeYs, step, bottomY }) {
  if (!ridgeYs?.length || !(width > 0) || !(step > 0) || !(bottomY > 0)) return emptySurface(width, biomeKey);
  const policy = landscapePolicy(biomeKey);
  const key = `${seed}:${biomeKey}:${layerKey}`;
  const faceRand = randomFrom(`${key}:surface:facets`);
  const coverRand = randomFrom(`${key}:surface:cover`);
  const gullyRand = randomFrom(`${key}:surface:gullies`);
  const edgeRand = randomFrom(`${key}:surface:edge`);
  const vals = Array.from(ridgeYs);
  const smooth = smoothCopy(vals, step);
  let hi = -Infinity, lo = Infinity;
  for (const y of smooth) { if (y > hi) hi = y; if (y < lo) lo = y; }
  const extent = hi - lo;
  const sxAt = (i) => Math.max(0, Math.min(width, i * step));
  const facets = [];
  const gullies = [];
  const stands = [];
  const valleys = [];
  const covered = [];
  const material = policy.cover === 'ice' ? 'ice' : policy.cover === 'sand' ? 'sand' : 'stone';

  if (extent >= 7) {
    const minProm = Math.max(5, extent * 0.075);
    for (const peak of selectSummits(smooth, step)) {
      if (peak.prominence < minProm) continue;
      const peakSx = sxAt(peak.i);
      const leftSx = sxAt(peak.left);
      const rightSx = sxAt(peak.right);
      const intervalId = `${Math.round(leftSx)}-${Math.round(rightSx)}`;
      const importance = peak.prominence / Math.max(extent, 1);
      const tone = Math.max(0.35, Math.min(0.7, 0.4 + importance * 0.3));
      if (peakSx - leftSx >= 12) {
        facets.push(slopeFace(leftSx, peakSx, `${key}:face:${intervalId}:L`, intervalId, -1, -tone, importance, material, width));
      }
      if (rightSx - peakSx >= 12) {
        facets.push(slopeFace(peakSx, rightSx, `${key}:face:${intervalId}:R`, intervalId, 1, tone, importance, material, width));
      }
      // A narrow summit still owns a crest vertex so an off-grid peak is not dropped.
      if (peakSx - leftSx < 12 && rightSx - peakSx < 12) {
        facets.push(face(`${key}:face:${intervalId}:P`, intervalId, [
          { sx: peakSx, depth01: 0 },
          { sx: Math.max(0, peakSx - 18), depth01: 0.45 },
          { sx: Math.min(width, peakSx + 18), depth01: 0.45 },
        ], faceRand() < 0.5 ? -1 : 1, tone, importance, material));
      }
      covered.push([leftSx, rightSx]);
      valleys.push({
        id: `${key}:valley:${intervalId}`, sx0: leftSx, sx1: rightSx,
        depth01: 0.53, importance,
      });
      if (gullies.length < 32 && rightSx - leftSx > 36) {
        const gx = (leftSx + rightSx) * 0.5;
        const sway = (gullyRand() - 0.5) * Math.min(24, (rightSx - leftSx) * 0.15);
        gullies.push({
          id: `${key}:gully:${intervalId}`,
          points: [
            { sx: Math.max(0, Math.min(width, gx)), depth01: 0.08 },
            { sx: Math.max(0, Math.min(width, gx + sway)), depth01: 0.46 },
            { sx: Math.max(0, Math.min(width, gx + sway * 0.4)), depth01: 0.82 },
          ],
          widthsSource: [2.4 + gullyRand(), 1.2, 0.35],
        });
      }
    }
  }

  const claimed = (sx) => covered.some(([a, b]) => sx >= a && sx <= b);
  const panelSpan = Math.max(180, step * 48, Math.ceil(width / 40));
  const panelTop = (sx) => 0.05 + 0.015 * Math.sin(sx / 237);
  const panelFoot = (sx) => 0.29 + 0.04 * Math.sin(sx / 390 + 1);
  for (let x = 0; x < width && facets.length < 40; x += panelSpan) {
    const next = Math.min(width, x + panelSpan);
    const mid = (x + next) * 0.5;
    if (claimed(mid)) continue;
    const intervalId = `panel:${Math.round(x)}`;
    const tone = (facets.length % 2 === 0 ? 1 : -1) * 0.08;
    facets.push(face(`${key}:panel:${intervalId}`, intervalId, [
      { sx: x, depth01: panelTop(x) },
      { sx: next, depth01: panelTop(next) },
      { sx: next, depth01: panelFoot(next) },
      { sx: x, depth01: panelFoot(x) },
    ], tone < 0 ? -1 : 1, tone, 0.15, material));
  }

  const kind = coverKind(policy);
  if (policy.canopy > 0.2 && kind !== 'sand' && kind !== 'stone' && kind !== 'ice') {
    const spacing = Math.max(kind === 'grass' || kind === 'mat' ? 190 : 130, width / 46);
    const depthScale = { L2: 0.75, L3: 0.88, L4: 1, L5: 1.05 }[layerKey] || 1;
    for (let sx = spacing * 0.45; sx < width - 40 && stands.length < 48;
      sx += spacing * (0.68 + coverRand() * 0.76)) {
      const i = Math.min(smooth.length - 2, Math.max(1, Math.round(sx / step)));
      const slope = Math.abs(smooth[i + 1] - smooth[i - 1]) / (2 * step);
      const valley01 = extent > 1 ? Math.max(0, Math.min(1, (smooth[i] - lo) / extent)) : 0.5;
      const chance = Math.min(1, policy.canopy * (0.55 + 0.5 * valley01));
      if (slope > 0.55 || coverRand() > chance) continue;
      const widthSrc = (kind === 'broadleaf' ? 105 : kind === 'conifer' ? 85 : 65)
        + coverRand() * (kind === 'conifer' ? 65 : 50);
      const at = Math.max(widthSrc * 0.5, Math.min(width - widthSrc * 0.5,
        sx + (coverRand() - 0.5) * spacing * 0.45));
      const intervalId = `cover:${Math.round(at)}`;
      stands.push({
        id: `${key}:stand:${intervalId}`, intervalId,
        vertices: coverVertices(at, widthSrc, kind, edgeRand, width, valley01, depthScale),
        kind, edgeSeed: Math.floor(edgeRand() * 1e9), structural: true,
      });
    }
  }

  const surface = { version: 2, width, biomeKey, byteLength: 0, facets, gullies, stands, valleys };
  surface.byteLength = accountBytes(surface);
  return surface;
}

/** Sum of descriptor bytes for every surface in the active A/B strip sets. */
export function aggregateSurfaceBytes(surfaces) {
  let total = 0;
  for (const surface of surfaces || []) total += surface?.byteLength || 0;
  return total;
}
