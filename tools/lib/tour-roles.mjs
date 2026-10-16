// Offline musical roles for terrain points. The runtime consumes only the
// assigned roles, tiers and measured suitabilities in the tour package.
import { sampleHeight } from './terrain-source.mjs';
import { percentileRanks } from './tour-points.mjs';

export const TOUR_ROLES = Object.freeze(['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus',
  'bridge', 'solo', 'interlude', 'breakdown', 'drop', 'outro']);
const SCARCE_FIRST = ['drop', 'chorus', 'solo', 'bridge', 'breakdown', 'pre-chorus', 'post-chorus', 'interlude', 'intro', 'outro', 'verse'];
const CHORUS_NAMES = new Set(['Mount Owen', 'Middle Teton', 'Mount Moran', 'Teewinot', 'Teewinot Mountain', 'Mount Saint John', 'Buck Mountain']);
const clamp01 = n => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const bump = (x, centre, width) => Math.exp(-(((x - centre) / width) ** 2));
const distance = (a, b) => Math.hypot(a.localM[0] - b.localM[0], a.localM[2] - b.localM[2]);
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function seesSubject(grid, eye, subject) {
  if (!grid) return eye.bigNeighbourVisible === true;
  const d = distance(eye, subject), y = eye.elevationM + 30;
  for (let at = Math.max(20, grid.cellSizeM); at < d; at += Math.max(20, grid.cellSizeM)) {
    const t = at / d, x = eye.localM[0] + t * (subject.localM[0] - eye.localM[0]);
    const z = eye.localM[2] + t * (subject.localM[2] - eye.localM[2]), h = sampleHeight(grid, x, z);
    if (!Number.isFinite(h) || h > y + t * (subject.elevationM - y)) return false;
  }
  return true;
}

/** Suitability formulas from plan §3.2; ranges and ties are deterministic. */
export function roleSuitabilities(points, { grid = null } = {}) {
  const sharp = percentileRanks(points, 'sharpness'), slope = percentileRanks(points, 'meanSlope300Deg');
  const sky = percentileRanks(points, 'skyOpenness'), views = percentileRanks(points, 'viewshedKm2');
  const big = points.filter(p => p.grandeur >= .8);
  return points.map(point => {
    const p = { ...point }, G = clamp01(p.grandeur);
    let neighbour = null, nearest = Infinity;
    for (const other of big) {
      if (other.id === p.id) continue;
      const d = distance(p, other);
      if (d < nearest || d === nearest && (!neighbour || compareId(other, neighbour) < 0)) { nearest = d; neighbour = other; }
    }
    const delta = neighbour ? neighbour.elevationM - p.elevationM : 0;
    const uphill = neighbour && delta >= 150 && delta <= 700 && p.distanceToCrestM > neighbour.distanceToCrestM ? 1 : .4;
    const visible = neighbour && seesSubject(grid, p, neighbour) ? 1 : 0;
    const aspect = ((p.faceAspectDeg || 0) - 90 + 540) % 360 - 180;
    const contrast = clamp01((Math.abs(aspect) - 90) / 90);
    const shelf = bump(p.meanSlope300Deg || 0, 0, 8) * bump(p.sharpness || 0, 0, .1);
    const crestDistance = p.distanceToCrestM || 0;
    p.bigNeighbourId = neighbour?.id || null;
    p.bigNeighbourVisible = !!visible;
    const scores = {
      intro: (1 - G) * views.get(p.id) * bump(crestDistance, 8000, 4000) * (['butte', 'lake'].includes(p.type) ? 1 : .7),
      verse: bump(G, .5, .15) * (['subpeak', 'summit'].includes(p.type) ? 1 : 0) * bump(Math.log10(Math.max(1, p.prominenceM || 0)), 2, .6),
      'pre-chorus': bump(G, .6, .15) * (neighbour ? bump(nearest, 0, 2500) : 0) * uphill,
      chorus: bump(G, .85, .12) * (p.name ? 1 : .6),
      'post-chorus': bump(G, .6, .15) * (neighbour ? bump(nearest, 0, 3000) : 0) * visible,
      bridge: bump(G, .6, .2) * Math.max(p.side === 'west' ? 1 : 0, p.cirqueLake ? 1 : 0, p.type === 'canyon' ? 1 : 0, contrast),
      solo: sharp.get(p.id) ** 2 * slope.get(p.id) * (G >= .45 ? 1 : 0),
      interlude: p.type === 'col' ? bump(G, .45, .2) : .5 * shelf,
      breakdown: (1 - G) * sky.get(p.id) * (['lake', 'canyon', 'col'].includes(p.type) ? 1 : 0),
      drop: G ** 3 * (p.prominenceM >= 150 ? 1 : 0),
      outro: (1 - G) * views.get(p.id) * (.6 + .4 * clamp01(p.waterWithin2km)) * bump(crestDistance, 9000, 6000),
    };
    p.suit = Object.fromEntries(TOUR_ROLES.map(role => [role, clamp01(scores[role])]));
    return p;
  });
}

function choosePrimaries(candidates, role, count, spacing) {
  const chorusCount = list => list.filter(p => CHORUS_NAMES.has(p.name)).length;
  const requiredChorusNames = role === 'chorus' && chorusCount(candidates) >= 2 ? 2 : 0;
  const search = (start, selected) => {
    const remaining = count - selected.length;
    if (!remaining) return new Set(selected.map(p => p.northSouthThird)).size >= 2
      && chorusCount(selected) >= requiredChorusNames ? selected : null;
    const available = [];
    for (let i = start; i < candidates.length; i++) {
      if (selected.every(p => distance(p, candidates[i]) >= spacing)) available.push(i);
    }
    if (available.length < remaining || new Set([...selected.map(p => p.northSouthThird), ...available.map(i => candidates[i].northSouthThird)]).size < 2) return null;
    if (chorusCount(selected) + chorusCount(available.map(i => candidates[i])) < requiredChorusNames) return null;
    for (const i of available) {
      const next = [...selected, candidates[i]];
      if (remaining === 1 && new Set(next.map(p => p.northSouthThird)).size < 2) continue;
      const result = search(i + 1, next);
      if (result) return result;
    }
    return null;
  };
  return search(0, []);
}

/** Scarce-first primary pools; remaining points get one backup/scenery role. */
export function assignRoles(input, { grid = null, tunables = {}, excludedStationPairs = new Set() } = {}) {
  const backupAllowlist = tunables.backupPointIds ? new Set(tunables.backupPointIds) : null;
  if (new Set(input.map(p => p.id)).size !== input.length) throw new Error('duplicate tour point id');
  const primaryCount = tunables.primariesPerRole ?? 4, maxBackups = tunables.maxBackupsPerRole ?? 14;
  if (!(Number.isInteger(primaryCount) && primaryCount >= 2 && Number.isInteger(maxBackups) && maxBackups >= 0)) throw new Error('bad tour tier counts');
  const scored = roleSuitabilities(input, { grid });
  const points = scored.map((p, i) => {
    // Explicit authoring scores can be supplied for tier review. Otherwise
    // every score comes from the measured terrain properties above.
    if (input[i].suit) {
      if (!TOUR_ROLES.every(role => Number.isFinite(input[i].suit[role]) && input[i].suit[role] >= 0 && input[i].suit[role] <= 1)) throw new Error(`bad suitability ${p.id}`);
      p.suit = { ...input[i].suit };
    }
    return p;
  }).sort(compareId);
  const lowZ = grid?.originM[1] ?? Math.min(...points.map(p => p.localM[2]));
  const highZ = grid ? lowZ + (grid.height - 1) * grid.cellSizeM : Math.max(...points.map(p => p.localM[2]));
  for (const p of points) p.northSouthThird = Math.max(0, Math.min(2, Math.floor((p.localM[2] - lowZ) / Math.max(1, highZ - lowZ) * 3)));
  const taken = new Set(), roles = {};
  for (const role of SCARCE_FIRST) {
    const candidates = points.filter(p => !taken.has(p.id) && p.suit[role] > 0 && !excludedStationPairs.has(`${role}:${p.id}`)).sort((a, b) =>
      (role === 'drop' ? +(b.name === 'Grand Teton') - +(a.name === 'Grand Teton') : 0)
      || b.suit[role] - a.suit[role] || compareId(a, b));
    const spacing = role === 'drop' ? tunables.dropSpacingM ?? 1500 : tunables.primarySpacingM ?? 2500;
    const primary = choosePrimaries(candidates, role, primaryCount, spacing);
    if (!primary) throw new Error(`${role}: cannot choose ${primaryCount} primary points with ${spacing} m spacing in two thirds of the range`);
    for (const p of primary) { taken.add(p.id); p.role = role; p.tier = 'primary'; }
    roles[role] = { primaries: primary.map(p => p.id), backups: [] };
  }
  for (const p of points) if (!taken.has(p.id)) {
    p.role = TOUR_ROLES.reduce((best, role) => p.suit[role] > p.suit[best] ? role : best, TOUR_ROLES[0]);
    p.tier = 'scenery';
  }
  for (const role of TOUR_ROLES) {
    const primary = points.filter(p => p.role === role && p.tier === 'primary');
    const minimum = .5 * Math.min(...primary.map(p => p.suit[role])), selected = [...primary];
    const candidates = points.filter(p => p.role === role && p.tier === 'scenery' && p.suit[role] >= minimum && !excludedStationPairs.has(`${role}:${p.id}`))
      .sort((a, b) => b.suit[role] - a.suit[role] || compareId(a, b));
    for (const p of candidates) {
      if (roles[role].backups.length >= maxBackups) break;
      if (backupAllowlist && !backupAllowlist.has(p.id)) continue;
      if (!selected.every(other => distance(p, other) >= 800)) continue;
      p.tier = 'backup'; selected.push(p); roles[role].backups.push(p.id);
    }
  }
  return { points, roles: Object.fromEntries(TOUR_ROLES.map(role => [role, roles[role]])),
    stats: { primaries: points.filter(p => p.tier === 'primary').length,
      backups: points.filter(p => p.tier === 'backup').length, scenery: points.filter(p => p.tier === 'scenery').length } };
}
