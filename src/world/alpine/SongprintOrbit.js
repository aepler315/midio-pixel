import { projectPoint, scenePoseAt } from '../terrain/SceneTravel.js';
import { clamp01, smoothstep } from '../../utils/math.js';
import { DEFORM_PAD_M } from './RangeCamera.js';
import { STAGE_KIND } from './StageAssembly.js';
import { terrainHeightAt } from './TerrainMesh.js';

const ASPECT = 16 / 9;
const FLIGHT_CLEARANCE_M = DEFORM_PAD_M + 140;
const MARGIN_M = 420;
const GROUND_PROBES = 192;
const SWEEPS = [.88, .67, .44];
const mix = (a, b, t) => a + (b - a) * t;
const blend = (a, b, t) => a.map((value, i) => mix(value, b[i], t));
const softenLimit = (a, b) => {
  const u = Math.max(0, 1 - Math.abs(a - b) / MARGIN_M);
  return Math.min(a, b) - MARGIN_M * u * u / 4;
};

function station(route, progress01) {
  const angle = route.bearing + route.sweep * progress01;
  const [x, , z] = route.pivotM;
  const dx = Math.cos(angle), dz = Math.sin(angle);
  const { min, max } = route.bounds;
  const roomX = (dx > 0 ? max[0] - MARGIN_M - x : x - min[0] - MARGIN_M) / Math.max(1e-6, Math.abs(dx));
  const roomZ = (dz > 0 ? max[2] - MARGIN_M - z : z - min[2] - MARGIN_M) / Math.max(1e-6, Math.abs(dz));
  // Start closer by moving the eye inward. Pull away as the coast and the
  // neighboring mountains come into view, without changing focal length.
  const wanted = route.homeRadiusM * mix(.69, .87, smoothstep(0, .79, progress01));
  const radius = softenLimit(wanted, softenLimit(roomX, roomZ));
  return [x + radius * dx, route.flightM, z + radius * dz];
}

const framed = point => point && Math.abs(point.x) < .9 && Math.abs(point.y) < .8;

function surveySupports(data, principal, companion) {
  const parts = data.manifest.source?.provenance?.composition?.pieces ?? [];
  return (data.manifest.landmarks ?? []).flatMap(({ localM, name }, i) => {
    const slotId = parts[i]?.slotId;
    if (!localM || !slotId || slotId === principal.slotId || slotId === companion.slotId) return [];
    const [x, z] = localM;
    const y = terrainHeightAt(data, x, z);
    return Number.isFinite(y) ? [{ name, slotId, pointM: [x, y, z] }] : [];
  });
}

/** A bounded arc around the survey's lead/companion group. The data is a
 * composed stage, whose retained tiles cover both the original rail and
 * its off-axis views. Catalog DEMs can have holes beyond their baked rail. */
export function compileSongprintOrbit(data, view, waterLevelM = null) {
  const pair = view.songprintComposition, bounds = data?.manifest?.boundsM;
  if (!pair || data?.manifest?.kind !== STAGE_KIND || !bounds) return null;
  const { principal, companion } = pair;
  const home = scenePoseAt(view, { progress01: .5 });
  const pivotM = blend(principal.pointM, companion.pointM, .44);
  const dx = home.eyeM[0] - pivotM[0], dz = home.eyeM[2] - pivotM[2];
  const homeRadiusM = Math.hypot(dx, dz);
  if (homeRadiusM < 3000) return null;
  const baseM = Number.isFinite(waterLevelM) ? waterLevelM : bounds.min[1];
  const supports = surveySupports(data, principal, companion);
  let best = null;
  for (const extent of SWEEPS) for (const sign of [-1, 1]) {
    const route = { pivotM, bounds, homeRadiusM, bearing: Math.atan2(dz, dx), sweep: sign * extent,
      flightM: Math.max(home.eyeM[1], baseM + 330), principal, companion, support: null };
    let minRadius = Infinity, usable = true;
    for (let i = 0; i <= GROUND_PROBES; i++) {
      const [x, , z] = station(route, i / GROUND_PROBES);
      const terrain = terrainHeightAt(data, x, z);
      if (!Number.isFinite(terrain)) { usable = false; break; }
      minRadius = Math.min(minRadius, Math.hypot(x - pivotM[0], z - pivotM[2]));
      // The sampled envelope leaves room for relief between probe stations.
      route.flightM = Math.max(route.flightM, terrain + FLIGHT_CLEARANCE_M + 60);
    }
    if (!usable || minRadius < homeRadiusM * .55) continue;
    const views = [0, .3, .58, .82, 1].map(p => ({ eyeM: station(route, p), targetM: pivotM, fovYDeg: home.fovYDeg }));
    const both = views.filter(pose => [principal, companion].every(crest => framed(projectPoint(pose, ASPECT, crest.pointM))));
    if (!both.length) continue;
    let discovery = 0;
    for (const candidate of supports) {
      const samples = views.map(pose => projectPoint(pose, ASPECT, candidate.pointM));
      const values = samples.slice(2).map((p, i) => framed(p)
        ? .55 * Math.abs(p.x) + .45 * Math.min(1, Math.abs(p.x - (samples[0]?.x ?? 0)) / 1.2) + .08 * i : 0);
      const score = Math.max(...values);
      if (score > discovery) { discovery = score; route.support = candidate; }
    }
    const score = extent + .27 * both.length / views.length + .24 * discovery
      - .7 * Math.max(0, route.flightM - baseM - 600) / homeRadiusM;
    if (!best || score > best.score) best = { score, route };
  }
  return best?.route ?? null;
}

/** Sample the world-space route with any listener crop retained.
 * Clearance also applies at this exact station and during the late handoff. */
export function songprintOrbitPose(pose, route, movement, { baseM, rise01, slotRise01, heightAt, waterLevelM,
  landmarks = [], cue = null } = {}) {
  const gain = clamp01(movement.gain);
  if (!gain) return pose;
  const progress01 = clamp01(movement.progress01);
  const raised = anchor => {
    const [x, height, z] = anchor.pointM;
    return [x, baseM + (height - baseM) * (slotRise01?.[anchor.slotId] ?? rise01), z];
  };
  let targetM = blend(raised(route.principal), raised(route.companion), mix(.37, .54, smoothstep(.17, .88, progress01)));
  if (route.support) targetM = blend(targetM, raised(route.support), .34 * smoothstep(.18, .78, progress01));
  // Already-scored recurring motifs may glance at their crest. Keep the
  // turn deliberately small so the arc remains the obvious camera move.
  for (const { landmark01, weight } of cue?.targets ?? []) {
    const anchor = landmarks[Math.min(landmarks.length - 1, Math.floor(landmark01 * landmarks.length))];
    if (anchor) targetM = blend(targetM, raised(anchor), .065 * weight);
  }
  targetM[1] = baseM + .63 * (targetM[1] - baseM) + 35;
  const eyeM = blend(pose.eyeM, station(route, progress01), gain);
  const soil = heightAt(eyeM[0], eyeM[2]);
  if (!Number.isFinite(soil)) return pose;
  const ground = (x, z) => Math.max(heightAt(x, z), waterLevelM ?? -Infinity);
  const oldClearance = Math.max(0, Math.min(FLIGHT_CLEARANCE_M, pose.eyeM[1] - ground(pose.eyeM[0], pose.eyeM[2])));
  const clearance = mix(Number.isFinite(oldClearance) ? oldClearance : 0, FLIGHT_CLEARANCE_M, gain);
  eyeM[1] = Math.max(eyeM[1], Math.max(soil, waterLevelM ?? -Infinity) + clearance);
  return { ...pose, eyeM, targetM: blend(pose.targetM, targetM, gain), songprintOrbit: {
    progress01, gain, pivotM: route.pivotM, sweepRad: route.sweep,
    principalSlot: route.principal.slotId, companionSlot: route.companion.slotId, supportSlot: route.support?.slotId ?? null,
  } };
}
