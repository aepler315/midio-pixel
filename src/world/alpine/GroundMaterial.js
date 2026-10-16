import { sampleTerrainCurve } from '../TerrainRelief.js';

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function buildGroundPatches({ seed, biomeKey, worldX, viewWidth, moisture }) {
  const patches = [];
  const start = Math.floor((worldX - 128) / 256);
  const end = Math.ceil((worldX + viewWidth + 128) / 256);
  for (let sector = start; sector <= end; sector++) for (let i = 0; i < 3; i++) {
    const id = `${seed}:${biomeKey}:${sector}:${i}`;
    const amount = hash(`${id}:chance`);
    if (amount > .48) continue;
    const wx = sector * 256 + 12 + hash(`${id}:x`) * 232;
    if (wx < worldX - 128 || wx > worldX + viewWidth + 128) continue;
    const widthPx = 16 + hash(`${id}:width`) * 74;
    let kind = 'ledge';
    if (biomeKey === 'ICEFIELD') kind = 'snow';
    else if (biomeKey === 'DESERT' || biomeKey === 'CANYON' || biomeKey === 'CHAPARRAL' || biomeKey === 'STEPPE') kind = 'soil';
    else if (biomeKey === 'CUSTOM') kind = 'ledge';
    else if (amount < .12 && moisture >= .5) kind = 'pool';
    else if (moisture > .4 && amount < .35) kind = 'moss';
    const depthPx = kind === 'pool'
      ? Math.min(12, 4 + hash(`${id}:d`) * 8)
      : Math.min(36, 6 + hash(`${id}:d`) * 30);
    patches.push({ id, wx, widthPx, depthPx, kind, sector, shapeSeed: hash(`${id}:shape`) });
    if (patches.length >= 24) return patches;
  }
  return patches;
}

/** Interpolate the rendered ground curve by actual sample x. Empty curve → null. */
export function sampleGroundAtX(curve, x) {
  if (!curve?.length || !Number.isFinite(x)) return null;
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!(x > first.x)) return { x: first.x, y: first.y, tx: first.tx, ty: first.ty };
  if (!(x < last.x)) return { x: last.x, y: last.y, tx: last.tx, ty: last.ty };
  let lo = 0;
  let hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const a = curve[lo];
  const b = curve[hi];
  const span = b.x - a.x;
  const t = span === 0 ? 0 : (x - a.x) / span;
  return {
    x,
    y: a.y + (b.y - a.y) * t,
    tx: a.tx + (b.tx - a.tx) * t,
    ty: a.ty + (b.ty - a.ty) * t,
  };
}

/** Contour-following patch. Null when the patch misses the curve. */
export function buildGroundPatchMesh({ patch, curve, worldX, originX }) {
  if (!patch || !curve?.length) return null;
  const x0 = patch.wx - worldX + originX;
  const x1 = x0 + patch.widthPx;
  const left = curve[0].x;
  const right = curve[curve.length - 1].x;
  if (x1 < left || x0 > right) return null;
  const steps = 5;
  const top = [];
  const bottom = [];
  const depthCap = patch.kind === 'pool' ? 12 : 36;
  const depth = Math.min(depthCap, patch.depthPx);
  for (let i = 0; i <= steps; i++) {
    const raw = x0 + (x1 - x0) * (i / steps);
    const x = Math.min(right, Math.max(left, raw));
    const p = sampleGroundAtX(curve, x);
    if (!p) return null;
    const taper = 0.72 + 0.28 * Math.sin((i / steps) * Math.PI);
    const jitter = ((patch.shapeSeed || 0) - 0.5) * 1.5 * Math.sin(i * 1.7);
    top.push({ x: p.x, y: p.y + 1 });
    bottom.push({ x: p.x, y: p.y + 1 + depth * taper + jitter });
  }
  const slope = Math.abs(top[top.length - 1].y - top[0].y) / Math.max(1, patch.widthPx);
  const kind = patch.kind === 'pool' && slope > 0.12 ? 'ledge' : patch.kind;
  const vertices = [...top, ...bottom.reverse()];
  return {
    id: patch.id,
    vertices,
    kind,
    wetMask: kind === 'pool' ? { id: patch.id, vertices: vertices.map((v) => ({ x: v.x, y: v.y })) } : null,
    litEdge: { id: patch.id, vertices: top.map((v) => ({ x: v.x, y: v.y })) },
  };
}

const FALLBACK_COLORS = {
  ledge: 'rgba(48,52,48,0.22)',
  moss: 'rgba(36,68,48,0.24)',
  snow: 'rgba(214,224,224,0.28)',
  soil: 'rgba(92,74,54,0.22)',
  pool: 'rgba(28,58,64,0.34)',
};

export function drawGroundMaterial(ctx, { patches, bars, worldX, originX, policy, alpha = 1, palette = null }) {
  const curve = sampleTerrainCurve(bars);
  const wetMasks = [];
  const litEdges = [];
  if (!curve.length) return { wetMasks, litEdges };
  const colors = palette ? {
    ledge: palette.mineral,
    moss: palette.organic,
    snow: '#d5e0e2',
    soil: palette.shallowShade || palette.base,
    pool: palette.wet,
  } : FALLBACK_COLORS;
  const cap = palette ? 24 : 24;
  let drawn = 0;
  for (const patch of patches) {
    if (drawn >= cap) break;
    const mesh = buildGroundPatchMesh({ patch, curve, worldX, originX });
    if (!mesh) continue;
    drawn += 1;
    ctx.save();
    ctx.globalAlpha = alpha * (mesh.kind === 'pool' ? 0.5 : 0.34);
    ctx.fillStyle = colors[mesh.kind] || colors.ledge;
    ctx.beginPath();
    mesh.vertices.forEach((v, i) => { if (i === 0) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y); });
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (mesh.wetMask && policy?.moisture >= 0.5 && wetMasks.length < 6) {
      wetMasks.push({
        id: patch.id, x: mesh.vertices[0].x, y: mesh.vertices[0].y,
        widthPx: patch.widthPx, depthPx: Math.min(12, patch.depthPx), alpha,
        vertices: mesh.wetMask.vertices,
      });
    }
    if (mesh.kind === 'ledge' || mesh.kind === 'pool') {
      litEdges.push({
        id: patch.id, x: mesh.vertices[0].x, y: mesh.vertices[0].y,
        widthPx: patch.widthPx, alpha, vertices: mesh.litEdge.vertices,
      });
    }
  }
  return { wetMasks, litEdges };
}
