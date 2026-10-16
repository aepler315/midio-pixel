// Near-forest conifer assets (natural-rendering Task 2). Replaces the star
// whorls (a flat fan of 5-6 spokes per tier) with irregular branch sprays:
// each branch is a tapered, drooping ribbon of foliage with a smaller
// crossed ribbon for depth from the side, so a crown has visible negative
// space between branches and reads as branching structure, not a stack of
// plates.
//
// Provenance: authored procedurally here (original work under the
// repository licence). There is no external mesh, texture or loader. The
// assets are fully determined by (family, variant, lod) through a fixed
// seeded generator, so every client and every export builds the same
// geometry; nothing is randomised per frame or per instance on the CPU.
//
// Coordinate contract (ForestGL MESH_VERT maps these per tree):
//   position.xz  foliage: a fraction of the species' crown half-width at the
//                vertex's own height (|xz| <= ~1.1); trunk: unit circle.
//   position.y   foliage: 0..1 between the crown base and the top; trunk:
//                0..1 of the tree height.
//   normal       xz = outward lighting direction (y is set by the shader).
//   aBranch      x = branch key (each branch's own rotation/length jitter
//                per tree), y = along-branch coordinate (needle serration
//                phase), z = coverage/shade (0 axis .. 1 ragged edge),
//                w = 1 foliage / 0 trunk.
//
// Families: 0 = high-crown pine (lodgepole: sparse tiers, short upturned
// sprays, more sky through the crown); 1 = fuller spruce/fir (dense drooping
// tiers). Species 0 uses family 0; species 1-3 use family 1. Variants are
// asymmetric versions of a family, assigned by tree id (variantFor).

export const FOREST_FAMILIES = 2;
export const FOREST_VARIANTS = 3;
export const FOREST_ASSET_VERSION = 1;

/** Family of a placed species (instance column 5). */
export function familyFor(species) { return species < 0.5 ? 0 : 1; }

/** Stable variant of a tree from its id (instance column 6, 0..1). Uses a
 *  different digit of the id than the quality keep-fraction does, so the
 *  subset kept at a rung is spread evenly across variants. */
export function variantFor(id) {
  const v = Math.floor(((id * 7919.0) % 1) * FOREST_VARIANTS);
  return Math.max(0, Math.min(FOREST_VARIANTS - 1, Number.isFinite(v) ? v : 0));
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-LOD and per-family authoring parameters.
const LODS = [
  // lod 0: within the detail ring (large on screen).
  { tiers: [11, 14], branches: [4, 6], stations: 4, crossed: true, trunkSides: 8, widthScale: 1 },
  // lod 1: the mesh ring (tens of pixels tall): fewer, simpler sprays.
  // Fewer, broader sprays keep the crown's mass (and the detail ring's
  // silhouette) at a tenth of the triangles.
  { tiers: [8, 9], branches: [4, 5], stations: 2, crossed: false, trunkSides: 6, widthScale: 1.55 },
];
const FAMILIES = [
  // High-crown pine: short tufted sprays, little droop, slight upturn.
  { droop: [0.015, 0.035], upturn: 0.035, length: [0.62, 1.0], width: [0.16, 0.24], top: 0.9, bottom: 0.06, gap: 0.5 },
  // Spruce/fir: long, drooping, overlapping skirts.
  { droop: [0.05, 0.09], upturn: 0.012, length: [0.78, 1.06], width: [0.18, 0.26], top: 0.93, bottom: 0.02, gap: 0.25 },
];

/**
 * Build one asset as plain arrays (no THREE needed).
 * @returns {{ position: Float32Array, normal: Float32Array, branch: Float32Array,
 *   index: Uint16Array, stats: { vertices: number, triangles: number, branches: number,
 *   bounds: { min: number[], max: number[] }, family: number, variant: number, lod: number } }}
 */
export function buildConiferAsset({ family = 1, variant = 0, lod = 0 } = {}) {
  const L = LODS[Math.max(0, Math.min(1, lod | 0))], F = FAMILIES[Math.max(0, Math.min(1, family | 0))];
  const rand = rng(0x9e3779b9 ^ (family * 7349 + variant * 131 + lod * 17 + FOREST_ASSET_VERSION * 1000003));
  const lerp = (a, b, t) => a + (b - a) * t;
  const range = ([a, b]) => lerp(a, b, rand());
  const pos = [], nor = [], br = [], idx = [];
  const vertex = (x, y, z, nx, ny, nz, key, along, cov, part) => {
    const l = Math.hypot(nx, ny, nz) || 1;
    // Foliage never reaches below the crown base (the shader's y01 = 0).
    if (part === 1) y = Math.max(0.005, y);
    pos.push(x, y, z); nor.push(nx / l, ny / l, nz / l); br.push(key, along, cov, part);
    return pos.length / 3 - 1;
  };
  // Trunk: tapered prism to a leader; the shader sets its radius and taper.
  const sides = L.trunkSides;
  for (let k = 0; k < 2; k++) for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
    vertex(x, k, z, x, 0.005, z, 0, i / sides, 0, 0);
  }
  for (let i = 0; i < sides; i++) { const j = (i + 1) % sides; idx.push(i, i + sides, j, j, i + sides, j + sides); }

  // Foliage tiers: irregular spacing, an irregular number of branches per
  // tier at irregular azimuths, each with its own length, droop and width.
  const tiers = Math.round(range(L.tiers));
  let branchCount = 0;
  const tierBranches = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < tiers; k++) {
    const u = tiers > 1 ? k / (tiers - 1) : 0;
    const y0 = lerp(F.bottom, F.top, u) + (rand() - 0.5) * 0.5 / tiers;
    const n = Math.round(range(L.branches) - (u > 0.8 ? 1 : 0));
    const twist = k * golden + rand() * 0.6;
    const before = branchCount;
    for (let i = 0; i < n; i++) {
      // A gap: some sprays are missing, leaving sky through the crown.
      if (i > 0 && rand() < F.gap * 0.35) continue;
      const azimuth = twist + ((i + (rand() - 0.5) * 0.55) / n) * Math.PI * 2;
      const dx = Math.cos(azimuth), dz = Math.sin(azimuth), px = -dz, pz = dx;
      const length = range(F.length) * (u > 0.85 ? 0.7 : 1);
      const droop = range(F.droop) * (0.6 + 0.8 * (1 - u));
      const width = range(F.width) * (u > 0.85 ? 0.75 : 1) * L.widthScale;
      // Each branch rotates and stretches per tree with its own key.
      const key = u + i * 0.0173 + 0.0003 * branchCount;
      const r0 = 0.03;
      const S = L.stations;
      const station = (t) => {
        const r = r0 + (length - r0) * t;
        const y = Math.max(0.03, y0 - droop * Math.pow(t, 1.6) + F.upturn * Math.max(0, t - 0.7) * 3.3);
        // Spray half-width: narrow at the trunk, full along the middle,
        // a rounded tip.
        const w = width * Math.pow(Math.sin(Math.PI * (0.12 + 0.82 * t)), 0.75) * (0.55 + 0.45 * t);
        return { r, y, w };
      };
      // Horizontal spray ribbon: left edge, axis, right edge per station.
      const base = pos.length / 3;
      for (let s = 0; s <= S; s++) {
        const t = s / S, { r, y, w } = station(t);
        const along = branchCount * 0.5 + t;
        const axisCov = 0.25 + 0.45 * t;
        for (const side of [-1, 0, 1]) {
          const x = dx * r + px * w * side, z = dz * r + pz * w * side;
          // Edges sag a little below the axis: a spray is a shallow arch.
          const yy = y - Math.abs(side) * w * 0.12;
          vertex(x, yy, z, dx + px * side * 0.55, 0.35, dz + pz * side * 0.55, key, along, side === 0 ? axisCov : 1, 1);
        }
      }
      for (let s = 0; s < S; s++) {
        const a = base + s * 3, b = a + 3;
        idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
      }
      if (L.crossed) {
        // A smaller upright ribbon along the same axis: sprays have
        // thickness when seen edge-on from the camera's height.
        const vbase = pos.length / 3;
        for (let s = 0; s <= S; s++) {
          const t = s / S, { r, y, w } = station(t);
          const along = branchCount * 0.5 + t + 0.25;
          const h = w * 0.32;
          for (const side of [-1, 0, 1]) {
            vertex(dx * r, y + h * side, dz * r, dx, 0.35 + side * 0.4, dz, key, along, side === 0 ? 0.3 + 0.4 * t : 1, 1);
          }
        }
        for (let s = 0; s < S; s++) {
          const a = vbase + s * 3, b = a + 3;
          idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
        }
      }
      branchCount++;
    }
    tierBranches.push(branchCount - before);
  }
  // A leader tuft above the last tier: two crossed narrow cards.
  for (let q = 0; q < 2; q++) {
    const a = q * Math.PI / 2, dx = Math.cos(a), dz = Math.sin(a), b = pos.length / 3;
    for (const [y, half] of [[0.9, 0.22], [1.0, 0.03]]) for (const side of [-1, 1]) {
      vertex(dx * half * side, y, dz * half * side, dx * side, 0.35, dz * side, 1.07 + q * 0.01, 9 + q * 0.5 + y, y > 0.95 ? 0.6 : 1, 1);
    }
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  const position = new Float32Array(pos);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) for (let c = 0; c < 3; c++) {
    min[c] = Math.min(min[c], position[i + c]); max[c] = Math.max(max[c], position[i + c]);
  }
  return {
    position, normal: new Float32Array(nor), branch: new Float32Array(br), index: new Uint16Array(idx),
    stats: { vertices: position.length / 3, triangles: idx.length / 3, branches: branchCount, tierBranches, bounds: { min, max }, family, variant, lod },
  };
}

let assetBytes = null;
/** Upper bound of GPU bytes one forest's base assets take (all built). */
export function forestAssetBytes() {
  if (assetBytes == null) assetBytes = coniferAssetCatalog().reduce((n, a) => n + a.bytes, 0);
  return assetBytes;
}

/** The whole set's metadata (for diagnostics and the asset test). */
export function coniferAssetCatalog() {
  const out = [];
  for (let lod = 0; lod < 2; lod++) for (let family = 0; family < FOREST_FAMILIES; family++) for (let variant = 0; variant < FOREST_VARIANTS; variant++) {
    const { stats } = buildConiferAsset({ family, variant, lod });
    out.push({ ...stats, bytes: stats.vertices * (3 + 3 + 4) * 4 + stats.triangles * 3 * 2 });
  }
  return out;
}
