// The range grows from partly built relief to its source elevation with the song.
// Every point shares F(y) = baseM + rise01 * (y - baseM), independently of
// camera direction and distance. Terrain, rivers, forest and cast use the
// same base and progress, including reflected draws.
import { clamp01 } from '../../utils/math.js';

/** Relief share at the song's first beat, skipping the first third of the build. */
export const LAND_RISE_START = 1 / 3;
/** Pace in silence, against 1 + energy at full energy. */
export const LAND_RISE_QUIET_PACE = 0.6;
/** Share of the climb spent easing to a stop on the complete range. */
export const LAND_RISE_LANDING = 0.15;
/** The rise completes no earlier than this share of the music. */
export const LAND_RISE_MIN_END = 0.6;
/** Minimum time to finish the remaining climb after re-analysis. */
export const LAND_RISE_CATCH_UP_MS = 8000;
const STEP_MS = 250;

/** Slots a composed stage's rise can address: the floor (index 0) and up to
 *  eight massif slots (song range composition, Phase 4). */
export const SLOT_RISE_SLOTS = 9;

/** Shared vertical transform. uLandRise holds (1 - rise01, baseM).
 *  A zero sink preserves the source geometry and normals exactly. */
export const LAND_RISE_GLSL = /* glsl */`
  uniform vec2 uLandRise;
  float riseLift(vec3 p) {
    if (uLandRise.x <= 0.0) return 0.0;
    return -uLandRise.x * (p.y - uLandRise.y);
  }
  vec3 riseGrad(vec3 p) {
    if (uLandRise.x <= 0.0) return vec3(0.0);
    return vec3(0.0, -uLandRise.x, 0.0);
  }
  // Inverse-transpose normal, multiplied by the vertical stretch before
  // normalization so even the completely flat transform stays finite.
  vec3 gradNormal(vec3 n, vec3 g) {
    if (uLandRise.x <= 0.0) return n;
    float k = max(0.0, 1.0 + g.y);
    vec3 moved = vec3(k * n.x - g.x * n.y, n.y, k * n.z - g.z * n.y);
    return dot(moved, moved) > 1e-12 ? normalize(moved) : vec3(0.0, 1.0, 0.0);
  }
  vec3 risenNormal(vec3 n, vec3 p) { return gradNormal(n, riseGrad(p)); }
  // The source horizon's tangents contract by the same vertical stretch.
  vec3 stretchedLight(vec3 L, float k) {
    return k < 1.0 ? normalize(vec3(L.x, L.y / max(k, 1e-3), L.z)) : L;
  }
`;

/** LAND_RISE_GLSL for a composed stage's vertex shaders (song range
 *  composition, Phase 4): the sink varies by position. uSlotOwner holds each
 *  stage tile's slot index (0 = floor), uSlotSink each slot's 1 - rise01 and
 *  uSlotFrame (originX, originZ, tile size m, active). The sink is
 *  interpolated bilinearly between tile centres, so neighbouring slots rising
 *  at different rates stay joined (pieces meet the floor at zero relief), and
 *  riseGrad carries its horizontal derivatives into the normals. uLandRise.x
 *  stays the song-global sink, the slots' mean, for the gate and for the
 *  fragment's global effects. Vertex stage only: the fragment reads the local
 *  rise from vRiseGrad and spends no uniform or sampler on it. */
export const SLOT_LAND_RISE_GLSL = /* glsl */`
  uniform vec2 uLandRise;
  uniform sampler2D uSlotOwner;
  uniform float uSlotSink[${SLOT_RISE_SLOTS}];
  uniform vec4 uSlotFrame;
  float slotSinkAt(ivec2 t, ivec2 n) {
    int k = int(texelFetch(uSlotOwner, clamp(t, ivec2(0), n - 1), 0).r * 255.0 + 0.5);
    return uSlotSink[clamp(k, 0, ${SLOT_RISE_SLOTS - 1})];
  }
  // xy: d(sink)/dx, d(sink)/dz; z: sink.
  vec3 slotSink(vec3 p) {
    ivec2 n = textureSize(uSlotOwner, 0);
    vec2 q = (p.xz - uSlotFrame.xy) / uSlotFrame.z - 0.5;
    vec2 c = floor(q), f = q - c;
    ivec2 i = ivec2(c);
    float s00 = slotSinkAt(i, n), s10 = slotSinkAt(i + ivec2(1, 0), n);
    float s01 = slotSinkAt(i + ivec2(0, 1), n), s11 = slotSinkAt(i + ivec2(1, 1), n);
    float a = mix(s00, s10, f.x), b = mix(s01, s11, f.x);
    return vec3(mix(s10 - s00, s11 - s01, f.y) / uSlotFrame.z, (b - a) / uSlotFrame.z, mix(a, b, f.y));
  }
  float riseLift(vec3 p) {
    if (uLandRise.x <= 0.0) return 0.0;
    return -slotSink(p).z * (p.y - uLandRise.y);
  }
  vec3 riseGrad(vec3 p) {
    if (uLandRise.x <= 0.0) return vec3(0.0);
    vec3 s = slotSink(p);
    float above = p.y - uLandRise.y;
    return vec3(-s.x * above, -s.z, -s.y * above);
  }
  // Inverse-transpose normal, multiplied by the vertical stretch before
  // normalization so even the completely flat transform stays finite.
  vec3 gradNormal(vec3 n, vec3 g) {
    if (uLandRise.x <= 0.0) return n;
    float k = max(0.0, 1.0 + g.y);
    vec3 moved = vec3(k * n.x - g.x * n.y, n.y, k * n.z - g.z * n.y);
    return dot(moved, moved) > 1e-12 ? normalize(moved) : vec3(0.0, 1.0, 0.0);
  }
  vec3 risenNormal(vec3 n, vec3 p) { return gradNormal(n, riseGrad(p)); }
  // The source horizon's tangents contract by the same vertical stretch.
  vec3 stretchedLight(vec3 L, float k) {
    return k < 1.0 ? normalize(vec3(L.x, L.y / max(k, 1e-3), L.z)) : L;
  }
`;

/** A vertex shader with the composed stage's per-slot rise in place of the
 *  shared one. Throws when the source does not include LAND_RISE_GLSL. */
export function slotRiseVertex(source) {
  if (!source.includes(LAND_RISE_GLSL)) throw new Error('vertex shader does not include LAND_RISE_GLSL');
  return source.replace(LAND_RISE_GLSL, SLOT_LAND_RISE_GLSL);
}

/** Metres added to a point's height. The eye argument preserves callers'
 *  positional API; the shared base determines the vertical transform. */
export function landRiseLift(x, y, z, eye, sink, baseM = 0) {
  return sink > 0 ? -sink * (y - baseM) : 0;
}

/** Drawn height. Horizontal distance preserves the sampling API. */
export function risenHeight(y, r, rise) {
  return rise?.sink > 0 ? y - rise.sink * (y - rise.baseM) : y;
}

/** The affine map is monotone in source height over the supported rise. */
export function risenFloor(y, x0, z0, x1, z1, rise) {
  return risenHeight(y, 0, rise);
}

const sinkSpan = (rise) => (Number.isFinite(rise?.sinkLo) && Number.isFinite(rise?.sinkHi) ? [rise.sinkLo, rise.sinkHi] : null);
const risenWith = (y, sink, baseM) => y - sink * (y - baseM);

/** Lowest drawn height of source height `y` under `rise`. A composed
 *  stage's rise ({ sinkLo, sinkHi }: its slots' sinks) bounds every slot;
 *  otherwise this is risenHeight. Box bottoms take this. */
export function risenLow(y, rise) {
  const span = rise?.sink > 0 ? sinkSpan(rise) : null;
  return span ? Math.min(risenWith(y, span[0], rise.baseM), risenWith(y, span[1], rise.baseM)) : risenHeight(y, 0, rise);
}

/** Highest drawn height of `y` under `rise`; box tops take this. */
export function risenHigh(y, rise) {
  const span = rise?.sink > 0 ? sinkSpan(rise) : null;
  return span ? Math.max(risenWith(y, span[0], rise.baseM), risenWith(y, span[1], rise.baseM)) : risenHeight(y, 0, rise);
}

/** A vertical contraction maps the sphere into an ellipsoid inside a
 *  sphere with the original radius and its vertically transformed centre.
 *  Under a stage's slot span the centre's drawn height can be anywhere in
 *  [risenLow, risenHigh]; the radius grows by half that interval. */
export function risenSphere(x, y, z, radius, rise) {
  const span = rise?.sink > 0 ? sinkSpan(rise) : null;
  if (!span) return { y: risenHeight(y, 0, rise), radius };
  const lo = risenLow(y, rise), hi = risenHigh(y, rise);
  return { y: (lo + hi) / 2, radius: radius + (hi - lo) / 2 };
}

/**
 * A composed stage's sink at (x, z), as SLOT_LAND_RISE_GLSL computes it:
 * `grid` is StageAssembly.stageSlotOwners' { owners, tilesX, tilesZ,
 * originM, tileM } and `sinks` each slot index's 1 - rise01. Returns
 * { sink, dx, dz } (dx, dz: its horizontal derivatives per metre).
 */
export function slotSinkAt(grid, sinks, x, z) {
  const { owners, tilesX: nx, tilesZ: nz, originM, tileM } = grid;
  const qx = (x - originM[0]) / tileM - 0.5, qz = (z - originM[1]) / tileM - 0.5;
  const cx = Math.floor(qx), cz = Math.floor(qz), fx = qx - cx, fz = qz - cz;
  const at = (i, j) => sinks[owners[Math.max(0, Math.min(nz - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))]];
  const s00 = at(cx, cz), s10 = at(cx + 1, cz), s01 = at(cx, cz + 1), s11 = at(cx + 1, cz + 1);
  const a = s00 + (s10 - s00) * fx, b = s01 + (s11 - s01) * fx;
  return { sink: a + (b - a) * fz, dx: ((s10 - s00) + ((s11 - s01) - (s10 - s00)) * fz) / tileM, dz: (b - a) / tileM };
}

/** Drawn height of source point (x, y, z) on a composed stage. */
export function stageRisenHeight(grid, sinks, baseM, x, y, z) {
  const { sink } = slotSinkAt(grid, sinks, x, z);
  return sink > 0 ? y - sink * (y - baseM) : y;
}

/** Read the exact shared sink and base, including signed base elevations.
 *  A composed stage (uSlotFrame.w > 0) adds its slots' sink span. */
export function riseFromUniforms(u) {
  const rise = u?.uLandRise?.value;
  if (!(rise?.x > 0)) return null;
  const sinks = u.uSlotFrame?.value?.w > 0 ? u.uSlotSink?.value : null;
  if (!sinks?.length) return { sink: rise.x, baseM: rise.y };
  let sinkLo = Infinity, sinkHi = -Infinity;
  for (const v of sinks) { if (v < sinkLo) sinkLo = v; if (v > sinkHi) sinkHi = v; }
  return { sink: rise.x, baseM: rise.y, sinkLo, sinkHi };
}

const landing = (u) => {
  const L = LAND_RISE_LANDING, a = 1 / (1 - L / 2), x = clamp01(u);
  return x <= 1 - L ? a * x : 1 - a * (1 - x) ** 2 / (2 * L);
};

/**
 * The song's rise, a pure function of heard time. Progress is the music's
 * energy integrated from the first beat (LAND_RISE_QUIET_PACE + energy per
 * unit time) and normalised to reach 1 at endMs: `finaleMs` before the
 * cadence (the camera's closing move), no earlier than LAND_RISE_MIN_END of
 * it. The land eases onto the complete range over the last
 * LAND_RISE_LANDING of the climb.
 *
 * `previous` (an earlier compile's riseProgressAt, with freezeThroughMs) is
 * the handoff when a whole-song analysis replaces the opening one: from the
 * frozen moment the new climb continues from where the old one stood, so
 * the land never jumps or sinks. What is left never finishes faster than
 * over LAND_RISE_CATCH_UP_MS, so a new climb that is over, or a moment from
 * over, at the handoff does not snap the land to the complete range.
 *
 * The land starts one-third built (LAND_RISE_START) and the music builds the
 * rest across the whole song. The opening close-up is released on its own
 * clock (OpeningTimeline.openingZoomRelease01), not by an early surge in
 * height. The rise is a pure function of heard time, so the handoff above and
 * every seek agree, and the land reaches exactly 1 at endMs.
 */
export function compileLandRise({ read = () => 0, durationMs = 0, cadenceMs = durationMs, finaleMs = 0,
  previous = null, freezeThroughMs = -1 } = {}) {
  const grid = riseGrid({ durationMs, cadenceMs, finaleMs });
  if (!grid) return Object.freeze({ endMs: 0, progressAt: () => 1, at: () => 1 });
  const own = climb(grid, read, () => true);
  const progressAt = continueClimb(own, previous, freezeThroughMs);
  const at = (timeMs) => riseAt(progressAt(timeMs));
  return Object.freeze({ endMs: grid.endMs, progressAt, at });
}

const riseAt = (progress) => LAND_RISE_START + (1 - LAND_RISE_START) * landing(progress);

/** The climb's clock: it ends `finaleMs` before the cadence, no earlier than
 *  LAND_RISE_MIN_END of it, in STEP_MS steps. Null for a song with no length. */
function riseGrid({ durationMs = 0, cadenceMs = durationMs, finaleMs = 0 }) {
  const duration = Math.max(0, Number(durationMs) || 0);
  if (!(duration > 0)) return null;
  const cadence = Number.isFinite(cadenceMs) && cadenceMs > 0 ? Math.min(duration, cadenceMs) : duration;
  const endMs = Math.max(LAND_RISE_MIN_END * cadence, Math.min(cadence, cadence - Math.max(0, finaleMs)));
  return { endMs, n: Math.max(1, Math.ceil(endMs / STEP_MS)) };
}

/** Progress over [0, endMs]: LAND_RISE_QUIET_PACE + energy integrated over the
 *  steps `owns(timeMs)` accepts, normalised to 1 at endMs. Null when it owns
 *  no step. */
function climb({ endMs, n }, read, owns) {
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * endMs / n;
    // Same association as ever: (sum + pace) + energy.
    sum[i + 1] = owns(t) ? sum[i] + LAND_RISE_QUIET_PACE + clamp01(read(t)) : sum[i];
  }
  if (!(sum[n] > 0)) return null;
  return (timeMs) => {
    const x = clamp01((Number(timeMs) || 0) / endMs) * n, i = Math.min(n - 1, Math.floor(x));
    return (sum[i] + (sum[i + 1] - sum[i]) * (x - i)) / sum[n];
  };
}

/** The handoff: through `freezeThroughMs` the previous climb; after it, the
 *  new climb continues from where the old one stood and never finishes the
 *  rest faster than LAND_RISE_CATCH_UP_MS. */
function continueClimb(own, previous, freezeThroughMs) {
  if (!(typeof previous === 'function' && freezeThroughMs >= 0)) return own;
  const from = clamp01(previous(freezeThroughMs)), base = own(freezeThroughMs);
  return (timeMs) => {
    if (timeMs <= freezeThroughMs) return clamp01(previous(timeMs));
    if (from >= 1) return 1;
    const paced = (timeMs - freezeThroughMs) / LAND_RISE_CATCH_UP_MS;
    const k = base >= 1 ? paced : Math.min(paced, (own(timeMs) - base) / (1 - base));
    return clamp01(from + (1 - from) * clamp01(k));
  };
}

/** Rows of a stage template, back to front. */
export const STAGE_ROWS = Object.freeze(['horizon', 'back', 'front']);
/** Largest gap between neighbouring slots' windows in the staggered build. */
export const STAGE_RISE_STAGGER = 0.08;

/** Stage slots [{ slotId, row }] in back-to-front order (row, then id). */
export function stageSlotOrder(slots = []) {
  const row = (s) => { const i = STAGE_ROWS.indexOf(s.row); return i < 0 ? STAGE_ROWS.length : i; };
  return [...slots].sort((a, b) => row(a) - row(b) || String(a.slotId).localeCompare(String(b.slotId)));
}

/** The chorus group: the repeated label with the highest mean energy (more
 *  occurrences, then earlier first appearance, break ties), as
 *  SectionRoles.js finds it. Null when no label repeats. */
export function chorusLabel(sections, read) {
  const groups = new Map();
  sections.forEach((s, i) => {
    const g = groups.get(s.label) || { label: s.label, count: 0, energy: 0, first: i };
    let e = 0, c = 0;
    for (let t = s.startMs; t < s.endMs; t += STEP_MS) { e += clamp01(read(t)); c++; }
    g.count++; g.energy += e / Math.max(1, c);
    groups.set(s.label, g);
  });
  const best = [...groups.values()].filter((g) => g.count >= 2)
    .sort((a, b) => b.energy / b.count - a.energy / a.count || b.count - a.count || a.first - b.first)[0];
  return best ? best.label : null;
}

/**
 * Per-slot rise for a composed stage (song range composition, Phase 4), a
 * pure function of heard time like compileLandRise and on the same clock.
 *
 *   slots      [{ slotId, row }], any order (stageSlotOrder sorts them)
 *   principal  the principal massif's slotId
 *   sections   trusted sections with labels ({ startMs, endMs, label })
 *
 * Every slot starts at LAND_RISE_START. With a chorus group, the principal
 * climbs during the chorus group's sections; the other slots, back to
 * front, take the remaining labels in order of first appearance (a label
 * per slot, cycling whichever list is shorter) and climb during theirs.
 * Time outside every section, and any label no other slot owns, belongs to
 * the principal. Within an owned section progress integrates
 * LAND_RISE_QUIET_PACE + energy, normalised so every slot stands complete by
 * endMs; a slot that owns no time before endMs makes up its whole climb over
 * the final stretch. With one slot this is compileLandRise exactly.
 *
 * Without a chorus group (the opening analysis, or a song whose labels
 * never repeat) the slots rise back to front from the scalar curve, each
 * over its own staggered window of it.
 *
 * `previous` (an earlier compile's progressAt, (slotId, t) => progress) or,
 * when the earlier score had no stage, `previousScalar` (its scalar
 * riseProgressAt) and `freezeThroughMs` hand off exactly as
 * compileLandRise does, slot by slot: no slot drops, and none finishes its
 * rest faster than LAND_RISE_CATCH_UP_MS.
 *
 * Returns { endMs, mode, slotIds (back to front), labels (slotId -> labels),
 * progressAt(slotId, t), at(slotId, t), slotsAt(t) (slotId -> rise01),
 * meanAt(t) }.
 */
export function compileStageRise({ slots = [], principal = null, sections = [], read = () => 0, durationMs = 0,
  cadenceMs = durationMs, finaleMs = 0, previous = null, previousScalar = null, freezeThroughMs = -1 } = {}) {
  const ordered = stageSlotOrder(slots), slotIds = ordered.map((s) => s.slotId);
  if (!slotIds.length) throw new Error('a stage rise needs at least one slot');
  const lead = slotIds.includes(principal) ? principal : slotIds[0];
  const grid = riseGrid({ durationMs, cadenceMs, finaleMs });
  if (!grid) {
    const done = Object.freeze(Object.fromEntries(slotIds.map((id) => [id, 1])));
    return Object.freeze({ endMs: 0, mode: 'none', slotIds, labels: {}, progressAt: () => 1, at: () => 1, slotsAt: () => done, meanAt: () => 1 });
  }
  const labeled = sections.filter((s) => s && s.label != null && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .map((s) => ({ startMs: s.startMs, endMs: s.endMs, label: s.label }));
  const chorus = labeled.length ? chorusLabel(labeled, read) : null;
  const own = new Map(), labels = {};
  let mode;
  if (chorus == null) {
    mode = 'stagger';
    const scalar = climb(grid, read, () => true), K = slotIds.length;
    const d = K > 1 ? Math.min(STAGE_RISE_STAGGER, 0.5 / (K - 1)) : 0;
    slotIds.forEach((id, k) => {
      const a = k * d, b = 1 - (K - 1 - k) * d;
      own.set(id, K === 1 ? scalar : (t) => clamp01((scalar(t) - a) / (b - a)));
      labels[id] = [];
    });
  } else {
    mode = 'structure';
    const others = slotIds.filter((id) => id !== lead);
    const rest = [];
    for (const s of labeled) if (s.label !== chorus && !rest.includes(s.label)) rest.push(s.label);
    const owners = new Map([[chorus, new Set([lead])]]);
    const S = others.length, L = rest.length;
    rest.forEach((label, j) => owners.set(label, new Set(S ? (L >= S ? [others[j % S]] : others.filter((_, i) => i % L === j)) : [lead])));
    if (!L) for (const id of others) owners.get(chorus).add(id);
    for (const id of slotIds) labels[id] = [...owners].filter(([, set]) => set.has(id)).map(([label]) => label);
    const ownerAt = (t) => {
      const s = labeled.find((x) => t >= x.startMs && t < x.endMs);
      return s ? owners.get(s.label) : null;
    };
    const stretch = Math.min(LAND_RISE_CATCH_UP_MS, grid.endMs / 4);
    for (const id of slotIds) {
      const climbed = climb(grid, read, (t) => { const set = ownerAt(t); return set ? set.has(id) : id === lead; });
      own.set(id, climbed || ((t) => clamp01((t - (grid.endMs - stretch)) / stretch)));
    }
  }
  const before = (id) => (typeof previous === 'function' ? (t) => previous(id, t)
    : typeof previousScalar === 'function' ? previousScalar : null);
  const progress = new Map(slotIds.map((id) => [id, continueClimb(own.get(id), before(id), freezeThroughMs)]));
  const progressAt = (id, t) => (progress.get(id) || progress.get(lead))(t);
  const at = (id, t) => riseAt(progressAt(id, t));
  const slotsAt = (t) => Object.freeze(Object.fromEntries(slotIds.map((id) => [id, at(id, t)])));
  const meanAt = (t) => { let sum = 0; for (const id of slotIds) sum += at(id, t); return sum / slotIds.length; };
  return Object.freeze({ endMs: grid.endMs, mode, slotIds, labels: Object.freeze(labels), progressAt, at, slotsAt, meanAt });
}
