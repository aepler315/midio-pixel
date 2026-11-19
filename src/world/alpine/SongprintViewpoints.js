// Evaluate existing camera paths against the same measured crests that
// Returning Summits uses for framing. Keep only compact scores after planning.
import { projectPoint, scenePoseAt } from '../terrain/SceneTravel.js';
import { pathPoseAt } from '../terrain/ShotPath.js';
import { seenFrom } from './LineOfSight.js';

const ASPECT = 16 / 9;
const RAIL_STEPS = 24;

function visiblePoint(data, pose, point) {
  const result = projectPoint(pose, ASPECT, point);
  if (!result || Math.abs(result.x) >= .85 || Math.abs(result.y) >= .8) return null;
  return seenFrom(data, pose.eyeM, [point[0], point[1] + 2, point[2]]) ? result : null;
}

function viewpointScore(data, pose, landmarks, index) {
  const summit = visiblePoint(data, pose, landmarks[index].pointM);
  if (!summit) return 0;
  const framing = 1 - Math.max(Math.abs(summit.x) / .85, Math.abs(summit.y - .12) / .92);
  // Prefer a second crest alongside the target, far enough apart on screen
  // to show the relationship rather than overlapping the same silhouette.
  let ridge = 0;
  for (const neighbour of [landmarks[index - 1], landmarks[index + 1]]) {
    if (!neighbour) continue;
    const side = visiblePoint(data, pose, neighbour.pointM);
    if (side) ridge = Math.max(ridge, Math.min(1, Math.abs(side.x - summit.x) / .25));
  }
  return .35 + .45 * framing + .2 * ridge;
}

/** Visible sampling stations on the stage's existing, terrain-covered rail.
 * The result is indexed in the same order as the Songprint landmarks. */
export function songprintRailStations(data, view, landmarks) {
  const stations = landmarks.map(() => []);
  if (!landmarks.length) return stations;
  for (let i = 0; i <= RAIL_STEPS; i++) {
    const progress01 = i / RAIL_STEPS;
    const pose = scenePoseAt(view, { progress01 });
    for (let index = 0; index < landmarks.length; index++) {
      const score = viewpointScore(data, pose, landmarks, index);
      if (score > 0) stations[index].push({ progress01, score });
    }
  }
  return stations;
}

/** Visible curated shot payoffs, indexed in the same order as the
 * Songprint landmarks. The caller already owns the prepared terrain. */
export function songprintShotPayoffs(data, library, landmarks) {
  const payoffs = landmarks.map(() => []);
  if (!landmarks.length) return payoffs;
  for (const shot of library.shots) {
    const pose = pathPoseAt(shot.path, shot.payoffS);
    for (let index = 0; index < landmarks.length; index++) {
      const score = viewpointScore(data, pose, landmarks, index);
      if (score > 0) payoffs[index].push({ id: shot.id, score });
    }
  }
  return payoffs;
}
