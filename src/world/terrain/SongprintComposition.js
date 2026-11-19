// Rank silhouettes and specific summit pairs in the authored camera's frame.
// Asset dimensions, lake and camera remain fixed by the stage template.
import { TILE_CELLS } from '../alpine/TerrainTiles.js';
import { cameraPoseAt, projectPoint } from './SceneTravel.js';
import { slotOrigin, stageFloorHeight } from './StageFloor.js';
import { outlineDistance } from './SongprintTerrain.js';
import { smoothstep } from '../../utils/math.js';

const ASPECT = 16 / 9;

export function compositionTarget(song, home) {
  // Merge near-neighbor bins so a single narrow harmonic peak does not
  // dictate an entire mountain. The song still supplies most of the shape.
  return song.map((value, i) => {
    const left = song[i - 1] ?? value, right = song[i + 1] ?? value;
    const broader = .18 * left + .64 * value + .18 * right;
    return .84 * broader + .16 * home[i] / 255;
  });
}

export function summitSpacing(target) {
  let left = 0, right = 0;
  for (let i = 0; i < target.length / 2; i++) {
    left += target[i];
    right += target[target.length - i - 1];
  }
  return (right - left) / (target.length / 2);
}

export function summitCandidate(template, slot, piece, measure, target, hero, mirrored) {
  const pose = cameraPoseAt({ camera: template.camera }, .5);
  const tileM = template.grid.cellSizeM * TILE_CELLS;
  const origin = slotOrigin(slot, piece.tiles);
  const [u, v] = measure.summit;
  const lowX = template.grid.originM[0] + origin[0] * tileM;
  const x = lowX + (mirrored ? piece.tiles[0] * tileM - u : u);
  const z = template.grid.originM[1] + origin[1] * tileM + v;
  const baseY = stageFloorHeight(template, x, z);
  const summit = projectPoint(pose, ASPECT, [x, baseY + piece.peakReliefM, z]);
  const left = projectPoint(pose, ASPECT, [lowX, baseY, z]);
  const right = projectPoint(pose, ASPECT, [lowX + piece.tiles[0] * tileM, baseY, z]);
  const left01 = left ? (left.x + 1) / 2 : 0, right01 = right ? (right.x + 1) / 2 : 1;
  const local = outlineDistance(target, measure.outline, { left: left01, right: right01, mirrored });
  const whole = hero ? outlineDistance(target, measure.outline, { mirrored }) : 0;
  let shape = hero ? .68 * whole + .32 * local : local;
  if (hero) {
    // Distinguish a broad ridge from a narrow summit. A pointwise fit alone
    // can pick the same intermediate shape for very different recordings.
    const breadth = (ridge, unit) => ridge.reduce((sum, height) => sum + smoothstep(.43, .77, height / unit), 0) / ridge.length;
    const occupied = breadth(measure.outline, 255);
    const desired = breadth(target, 1);
    const cover = Math.max(0, Math.min(1, right01) - Math.max(0, left01));
    // A lower, sparser contour leaves more open sky around the principal.
    const desiredCoverage = .12 + .37 * desired;
    const coverageError = (cover - desiredCoverage) * (.45 + occupied);
    shape += .45 * (occupied - desired) ** 2 + 1.8 * coverageError ** 2;
  }
  const framing = summit ? Math.max(0, Math.abs(summit.x) - .60) : 1;
  return {
    slot, piece, mirrored, summit, shape,
    prominence: summit ? piece.peakReliefM / summit.depth : 0,
    score: shape + (hero ? .55 : .10) * framing ** 2,
  };
}

export function summitPairScore(hero, companion, balance) {
  if (!hero.summit || !companion.summit || hero.slot === companion.slot || companion.slot.row === 'front') return null;
  const lead = hero.summit.x, next = companion.summit.x;
  const spread = Math.abs(lead - next);
  if (Math.max(Math.abs(lead), Math.abs(next)) > .87 || spread < .16 || spread > 1.14) return null;
  const ratio = companion.prominence / hero.prominence;
  if (ratio < .37 || ratio > 1.18) return null;

  // Seek a shoulder whose angular relief is subordinate to the principal,
  // with enough open sky between them to read two peaks. Broad song shapes
  // shift the preferred side and spacing without dictating the exact frame.
  const balancePenalty = .28 * Math.max(0, -Math.sign(next - lead) * balance);
  const spacing = .40 + .45 * Math.abs(balance);
  return .25 * (spread - spacing) ** 2 + .36 * (ratio - .7) ** 2 + balancePenalty;
}
